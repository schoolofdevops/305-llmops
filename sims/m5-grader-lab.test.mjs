#!/usr/bin/env node
// Headless-Chrome assertion harness for m5-grader-lab.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m5-grader-lab.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm5-grader-lab.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9730 + (process.pid % 400);

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!CHROME) { console.error('No Chrome/Chromium found'); process.exit(2); }

let PASS = 0, FAIL = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; results.push('  PASS  ' + name); }
  else { FAIL++; results.push('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

// ---- minimal CDP over WebSocket (RFC6455 client, no deps) ----
function httpJSON(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method,
      headers: { 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve(b); }
      });
    });
    req.on('error', reject); req.end();
  });
}
function connectWS(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `Origin: http://127.0.0.1:${PORT}\r\n\r\n`);
    });
    let handshaken = false; let buf = Buffer.alloc(0);
    const listeners = new Map(); let idc = 1; const evwaiters = [];
    function send(method, params = {}, sessionId) {
      const id = idc++; const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      sock.write(encodeFrame(JSON.stringify(msg)));
      return new Promise(res => listeners.set(id, res));
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        handshaken = true; buf = buf.slice(idx + 4);
        resolve({ send, onEvent: (m, cb) => evwaiters.push({ m, cb }), close: () => sock.destroy() });
      }
      let f;
      while ((f = decodeFrame(buf))) {
        buf = f.rest;
        if (f.opcode === 8) { sock.destroy(); break; }
        if (f.opcode === 1 || f.opcode === 2) {
          let m; try { m = JSON.parse(f.payload.toString()); } catch { continue; }
          if (m.id && listeners.has(m.id)) { listeners.get(m.id)(m); listeners.delete(m.id); }
          if (m.method) evwaiters.filter(w => w.m === m.method).forEach(w => w.cb(m.params));
        }
      }
    });
    sock.on('error', reject);
  });
}
function encodeFrame(str) {
  const p = Buffer.from(str); const len = p.length;
  const mask = crypto.randomBytes(4); let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f; const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f; let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask; if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.slice(off, off + len);
  if (masked) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i & 3]; payload = o; }
  return { opcode, payload, rest: buf.slice(off + len) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    '--no-sandbox', '--disable-gpu', '--window-size=800,500',
    '--user-data-dir=/tmp/m5-grader-chrome-' + process.pid, 'about:blank',
  ], { stdio: 'ignore' });

  // wait for devtools endpoint
  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJSON('GET', '/json/version'); if (version && version.webSocketDebuggerUrl) break; } catch {}
    await sleep(150);
  }
  if (!version || !version.webSocketDebuggerUrl) { console.error('devtools endpoint never came up'); child.kill('SIGKILL'); process.exit(2); }

  // open a fresh tab for the file:// url (PUT for Chrome 150+)
  const tab = await httpJSON('PUT', '/json/new?' + encodeURIComponent(FILE_URL));
  const cdp = await connectWS(tab.webSocketDebuggerUrl);

  const consoleErrors = [], pageErrors = [], netRequests = [];
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  cdp.onEvent('Runtime.consoleAPICalled', p => { if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args)); });
  cdp.onEvent('Runtime.exceptionThrown', p => pageErrors.push(p.exceptionDetails && p.exceptionDetails.text));
  cdp.onEvent('Network.requestWillBeSent', p => {
    const u = p.request.url;
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('about:')) netRequests.push(u);
  });

  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 800, height: 500, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: FILE_URL });
  await sleep(700);

  async function ev(expr) {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    if (r.result && r.result.result) return r.result.result.value;
    return undefined;
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — three grader columns present',
    (await ev('document.querySelectorAll("#cols .gcol").length')) === 3);
  ok('renders — six candidate answers loaded',
    (await ev('window.__sim.consts.count')) === 6);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#runBtn','#reset','#prevBtn','#nextBtn','#thrRange'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const runTip = await ev(`!!document.querySelector('#runBtn').title && !!document.querySelector('#reset').title
    && !!document.querySelector('#nextBtn').title`);
  ok('R2 controls carry tooltips (title)', runTip === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertQa = await ev(`getComputedStyle(document.querySelector('#qText')).cursor`);
  ok('R2 question/reference panel is inert (cursor:default)', inertQa === 'default', inertQa);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);
  const footMentions = await ev(`/Jaccard|token-overlap/.test(document.querySelector('#note').getAttribute('data-tip'))
    && /scripted rubric|not a real model/.test(document.querySelector('#note').getAttribute('data-tip'))`);
  ok('R8 footnote is honest about similarity + judge', footMentions === true);

  // ---------- 3. event log responds to selecting a candidate ----------
  await ev('window.__sim.setCand(3)');
  const selLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /candidate 4 selected/.test(e.textContent)})`);
  ok('R7 event log narrates candidate selection', selLog === true);

  // ---------- 4. grading produces a per-column verdict + eval-runner case line ----------
  await ev('window.__sim.setCand(0)');   // verbatim
  await ev('window.__sim.gradeNow()');
  const v0 = await ev(`(function(){var r=window.__sim.S.result;return {
    exact:r.exact, simPass:r.simPass, judgePass:r.judgePass, correct:r.correct,
    exactV:document.getElementById('exactV').textContent,
    simV:document.getElementById('simV').textContent,
    judgeV:document.getElementById('judgeV').textContent };})()`);
  ok('GRADE verbatim: all three graders PASS a word-for-word correct answer',
    v0.exact && v0.simPass && v0.judgePass && v0.correct === true, JSON.stringify(v0));
  ok('GRADE columns show PASS/FAIL verdicts',
    /PASS/.test(v0.exactV) && /PASS/.test(v0.simV) && /PASS/.test(v0.judgeV), JSON.stringify(v0));
  const caseLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /case 1/.test(e.textContent)&&/exact=/.test(e.textContent)&&/sim=/.test(e.textContent)&&/judge=/.test(e.textContent)})`);
  ok('R7 eval-runner logs a case line (exact/sim/judge)', caseLog === true);

  // ---------- 5. TEACHING INVARIANT (i): correct paraphrase FAILS exact, PASSES sim@default + judge ----------
  await ev('window.__sim.setCand(1)');   // paraphrase
  await ev('window.__sim.gradeNow()');
  const vPara = await ev(`(function(){var r=window.__sim.S.result;return {
    exact:r.exact, sim:r.sim, thr:r.thr, simPass:r.simPass, judgePass:r.judgePass, correct:r.correct };})()`);
  ok('INVARIANT i: correct paraphrase is actually correct', vPara.correct === true, JSON.stringify(vPara));
  ok('INVARIANT i: paraphrase FAILS exact-phrase (false fail)', vPara.exact === false, JSON.stringify(vPara));
  ok('INVARIANT i: paraphrase PASSES similarity at default threshold', vPara.simPass === true, JSON.stringify(vPara));
  ok('INVARIANT i: paraphrase PASSES the judge', vPara.judgePass === true, JSON.stringify(vPara));
  const falseFailLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /FALSE FAIL/.test(e.textContent)})`);
  ok('INVARIANT i: eval log names the FALSE FAIL', falseFailLog === true);

  // ---------- 6. TEACHING INVARIANT (ii): a WRONG candidate PASSES exact (false pass) ----------
  const falsePassIdx = await ev(`(function(){
    for(var i=0;i<window.__sim.consts.count;i++){var r=window.__sim.grade(i,0.3);
      if(r.exact===true && r.correct===false)return i;}
    return -1;})()`);
  ok('INVARIANT ii: some wrong candidate PASSES exact-phrase (false pass exists)', falsePassIdx >= 0, 'idx=' + falsePassIdx);
  await ev(`window.__sim.setCand(${falsePassIdx})`);
  await ev('window.__sim.gradeNow()');
  const vFp = await ev(`(function(){var r=window.__sim.S.result;return {exact:r.exact,correct:r.correct};})()`);
  ok('INVARIANT ii: graded false-pass candidate shows exact PASS on a wrong answer',
    vFp.exact === true && vFp.correct === false, JSON.stringify(vFp));
  const falsePassLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /FALSE PASS/.test(e.textContent)})`);
  ok('INVARIANT ii: eval log names the FALSE PASS', falsePassLog === true);

  // ---------- 7. TEACHING INVARIANT (iii): raising the threshold flips a sim PASS to FAIL ----------
  const flip = await ev(`(function(){
    // find a candidate whose sim passes at a low threshold AND sits low enough that
    // raising the threshold above it stays inside the slider's 0..0.9 range.
    var lo=0.05, idx=-1, simScore=0;
    for(var i=0;i<window.__sim.consts.count;i++){var r=window.__sim.grade(i,lo);
      if(r.simPass && r.sim>lo && r.sim<0.85){idx=i;simScore=r.sim;break;}}
    if(idx<0)return {found:false};
    var hiThr=Math.min(0.9, simScore+0.1);
    var passLow=window.__sim.grade(idx,lo).simPass;      // passes when threshold below its score
    var failHigh=window.__sim.grade(idx,hiThr).simPass;  // fails when threshold above
    return {found:true, idx:idx, simScore:simScore, hiThr:hiThr, passLow:passLow, failHigh:failHigh};
  })()`);
  ok('INVARIANT iii: a candidate passes similarity at a low threshold', flip.found && flip.passLow === true, JSON.stringify(flip));
  ok('INVARIANT iii: raising threshold past its Jaccard score flips PASS -> FAIL (deterministic)',
    flip.found && flip.failHigh === false, JSON.stringify(flip));
  // and it is reflected live in the UI when the slider moves
  await ev(`window.__sim.setCand(${flip.idx})`);
  await ev(`window.__sim.setThr(0.05)`);
  await ev('window.__sim.gradeNow()');
  const uiPass = await ev(`document.getElementById('simV').textContent`);
  await ev(`window.__sim.setThr(${flip.hiThr})`);
  const uiFail = await ev(`document.getElementById('simV').textContent`);
  ok('INVARIANT iii: similarity verdict updates live as the threshold slider moves',
    /PASS/.test(uiPass) && /FAIL/.test(uiFail), JSON.stringify({ uiPass, uiFail }));

  // ---------- 8. TEACHING INVARIANT (iv): judge verdicts are deterministic under the seed ----------
  const jdet = await ev(`(function(){
    var a=[],b=[];
    for(var i=0;i<window.__sim.consts.count;i++){a.push(window.__sim.grade(i,0.3).judgePass);}
    for(var j=0;j<window.__sim.consts.count;j++){b.push(window.__sim.grade(j,0.3).judgePass);}
    var same=a.every(function(v,k){return v===b[k]});
    var anyMargin=false;
    for(var m=0;m<window.__sim.consts.count;m++){if(window.__sim.grade(m,0.3).judgeMargin)anyMargin=true;}
    return {same:same, verdicts:a, anyMargin:anyMargin};
  })()`);
  ok('INVARIANT iv: judge verdicts are deterministic across repeated grades (seed)', jdet.same === true, JSON.stringify(jdet));
  ok('INVARIANT iv: at least one candidate is a flagged margin case', jdet.anyMargin === true, JSON.stringify(jdet));

  // ---------- 9. graders disagree => the log warns to trust no single grade ----------
  await ev('window.__sim.setCand(1)');   // paraphrase: exact FAIL, sim PASS, judge PASS -> disagreement
  await ev('window.__sim.setThr(0.3)');
  await ev('window.__sim.gradeNow()');
  const disagreeLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /DISAGREE|trust no single/.test(e.textContent)})`);
  ok('DISAGREEMENT: log warns to corroborate when graders disagree', disagreeLog === true);

  // ---------- 10. TRY-THIS challenge auto-detects end to end ----------
  await ev('location.reload()');
  await sleep(600);
  // Step 1: grade candidate 2 (index 1) — correct paraphrase fails exact
  await ev('window.__sim.setCand(1)');
  await ev('window.__sim.gradeNow()'); await sleep(60);
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (paraphrase false-fails exact)', step >= 2, 'step=' + step);
  // Step 2: grade the false-pass candidate (wrong answer that PASSES exact)
  await ev(`window.__sim.setCand(${falsePassIdx})`);
  await ev('window.__sim.gradeNow()'); await sleep(60);
  step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (wrong answer false-passes exact)', step >= 3, 'step=' + step);
  // Step 3: raise threshold past a passing candidate's Jaccard, then grade -> sim flips to FAIL
  await ev(`window.__sim.setCand(${flip.idx})`);
  await ev(`window.__sim.setThr(${flip.hiThr})`);
  await ev('window.__sim.gradeNow()'); await sleep(60);
  const done = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (threshold flips sim PASS -> FAIL)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 10b. PREDICT-FIRST mode ----------
  await ev('location.reload()');
  await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent };})()`);
  ok('PREDICT: step 1 opens with a prediction question + chips', pBoot.chips >= 2 && /Predict first/.test(pBoot.txt),
    JSON.stringify(pBoot));
  ok('PREDICT: instruction hidden until a prediction is made', !/candidate 2/.test(pBoot.txt) || /Predict first/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor, tip:!!c.title};})()`);
  ok('PREDICT: chips are affordant (cursor:pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // Tap the WRONG chip for step 1 (index 0 = "PASS"; correct is "FAIL")
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`);
  const pAfter = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent,
    logged: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /predicted/.test(e.textContent)}) };})()`);
  ok('PREDICT: tapping a chip reveals the instruction + shows your pick', pAfter.chips === 0
    && /candidate 2/.test(pAfter.txt) && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT: the pick is logged in the event stream', pAfter.logged === true);
  // Complete step 1 — wrong prediction must NOT block, verdict must teach
  await ev('window.__sim.setCand(1)');
  await ev('window.__sim.gradeNow()'); await sleep(60);
  const pVerdict = await ev(`(function(){return {
    step: window.__sim.CH.step,
    verdict: [].slice.call(document.querySelectorAll('#evList .ev')).map(function(e){return e.textContent}).join(' | ') };})()`);
  ok('PREDICT: wrong prediction never blocks step completion', pVerdict.step >= 2, 'step=' + pVerdict.step);
  ok('PREDICT: verdict names your pick and explains the model',
    /Not what you predicted/.test(pVerdict.verdict) && /false fail/.test(pVerdict.verdict), pVerdict.verdict.slice(-260));
  // Skipping predictions still lets the challenge finish
  await ev(`window.__sim.setCand(${falsePassIdx})`);
  await ev('window.__sim.gradeNow()'); await sleep(60);
  await ev(`window.__sim.setCand(${flip.idx})`);
  await ev(`window.__sim.setThr(${flip.hiThr})`);
  await ev('window.__sim.gradeNow()'); await sleep(60);
  const p3 = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('PREDICT: skipping a prediction never blocks the challenge', p3.step >= 4 && p3.success === true, JSON.stringify(p3));

  // ---------- 11. Reset returns to initial state ----------
  await ev('window.__sim.setCand(4)');
  await ev('window.__sim.setThr(0.7)');
  await ev('location.reload()');
  await sleep(600);
  const afterReset = await ev(`(function(){return {
    idx:window.__sim.S.idx, thr:window.__sim.S.thr, graded:window.__sim.S.graded,
    step:window.__sim.CH.step, exactV:document.getElementById('exactV').textContent };})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults + clears run',
    afterReset.idx === D.idx && Math.abs(afterReset.thr - D.thr) < 1e-9
    && afterReset.graded === false && afterReset.step === 1 && afterReset.exactV === '—',
    JSON.stringify(afterReset));

  // ---------- 12. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 13. prefers-reduced-motion suppresses animation ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad.push(el.className);
    });return bad.length;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedOK === 0, 'active=' + reducedOK);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m5-grader-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
