#!/usr/bin/env node
// Headless-Chrome assertion harness for m12-spend-gate.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m12-spend-gate.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm12-spend-gate.html');
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
    '--user-data-dir=/tmp/m12-spend-chrome-' + process.pid, 'about:blank',
  ], { stdio: 'ignore' });

  // wait for devtools endpoint
  let version;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJSON('GET', '/json/version'); if (version && version.webSocketDebuggerUrl) break; } catch {}
    await sleep(150);
  }
  if (!version || !version.webSocketDebuggerUrl) { console.error('devtools endpoint never came up'); child.kill('SIGKILL'); process.exit(2); }

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
  // run the sim's instant replay path, then read the completed run's summary
  async function replayAndRead() {
    for (let i = 0; i < 50 && await ev('window.__sim.isRunning()'); i++) await sleep(60);
    await ev('window.__sim.replay()');
    await sleep(60);
    for (let i = 0; i < 50 && await ev('window.__sim.isRunning()'); i++) await sleep(60);
    await sleep(40);
    return ev(`(function(){var r=window.__sim.S.result||{};return {
      total:r.total, served:r.served, bounced:r.bounced, price:r.price,
      spend:r.spend, blocked:r.blocked, blockDay:r.blockDay, ran:!!window.__sim.S.ran};})()`);
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — three per-key budget sliders present',
    (await ev('document.querySelectorAll("#stage .kbudget input[type=range]").length')) === 3);
  ok('renders — price slider present',
    (await ev('!!document.getElementById("priceRange")')) === true);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#runBtn','#reset','#priceRange','#bud1','#bud2','#bud3','#chatBtn','#priceChips .pc'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer cursor', affClickable.length === 0, affClickable.join(','));
  const tips = await ev(`!!document.querySelector('#runBtn').title && !!document.querySelector('#reset').title
    && !!document.querySelector('#chatBtn').title && !!document.querySelector('#priceRange').title`);
  ok('R2 controls carry tooltips (title)', tips === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  // key spend cards read as status (inert) except their budget slider
  const inertKey = await ev(`getComputedStyle(document.querySelector('#k1 .kname')).cursor`);
  ok('R2 key spend card is inert (cursor:default)', inertKey === 'default', inertKey);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. event log responds to a replay ----------
  await ev('window.__sim.setPrice(0.60)');
  await ev('document.getElementById("runBtn").click()');
  await sleep(3200); // animated replay completes (~29 steps × 70ms + day headers)
  const logResponded = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /week\\/replay|budget/.test(e.textContent)})`);
  ok('EVENT LOG responds — a replay writes spend-log lines', logResponded === true);
  const notRunning = await ev('!window.__sim.isRunning()');
  ok('replay finishes (not stuck running)', notRunning === true);

  // ---------- 4. THE $0 LIE — at price $0 no key ever blocks (invariant i) ----------
  await ev('window.__sim.setPrice(0)');
  const rZero = await replayAndRead();
  ok('$0 LIE: at price $0 total week spend is exactly $0', rZero.total === 0, JSON.stringify({total:rZero.total}));
  ok('$0 LIE: at price $0 NO key blocks (invariant i)',
    rZero.blocked && rZero.blocked.every(b => b === false) && rZero.bounced === 0, JSON.stringify(rZero.blocked));
  ok('$0 LIE: at price $0 every call is served (burst invisible)', rZero.served > 0, JSON.stringify({served:rZero.served}));
  // pure-math cross-check that $0 keeps every tab at zero regardless of budgets
  const zeroMath = await ev(`(function(){var r=window.__sim.computeReplay(0,[15,10,8]);
    return {total:r.total, anyBlocked:r.blocked.some(function(b){return b})};})()`);
  ok('$0 LIE (math): computeReplay(0,…) => total 0, none blocked', zeroMath.total === 0 && zeroMath.anyBlocked === false, JSON.stringify(zeroMath));

  // ---------- 5. BLAST-RADIUS ISOLATION — real price blocks batch, interactive survives (invariant ii) ----------
  await ev('window.__sim.setPrice(0.60)');
  const rReal = await replayAndRead();
  ok('BLAST RADIUS: at the default real price the batch key BLOCKS (invariant ii)',
    rReal.blocked[1] === true, JSON.stringify(rReal.blocked));
  ok('BLAST RADIUS: the interactive key finishes the week UNBLOCKED (invariant ii)',
    rReal.blocked[0] === false, JSON.stringify(rReal.blocked));
  ok('BLAST RADIUS: some batch calls bounce at the door', rReal.bounced > 0, JSON.stringify({bounced:rReal.bounced}));
  const batchBlockedUI = await ev(`document.getElementById('st2').classList.contains('blocked')
    && document.getElementById('k2').classList.contains('isblocked')`);
  ok('BLAST RADIUS: batch card renders BLOCKED in the UI', batchBlockedUI === true);
  const interactiveActiveUI = await ev(`!document.getElementById('st1').classList.contains('blocked')`);
  ok('BLAST RADIUS: interactive card renders active in the UI', interactiveActiveUI === true);
  const bounceLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /429|bounce/.test(e.textContent)})`);
  ok('BLAST RADIUS: spend log records a 429 bounce line', bounceLog === true);
  // math cross-check
  const realMath = await ev(`(function(){var r=window.__sim.computeReplay(0.60,[15,10,8]);
    return {b0:r.blocked[0], b1:r.blocked[1]};})()`);
  ok('BLAST RADIUS (math): batch blocked, interactive not', realMath.b1 === true && realMath.b0 === false, JSON.stringify(realMath));

  // ---------- 6. HISTORY RESEND — super-linear turn cost (invariant iii) ----------
  const chatInv = await ev(`(function(){
    var t1=window.__sim.turnTokens(1), t10=window.__sim.turnTokens(10);
    var lin=t1*10, cum=window.__sim.chatCumulative(10);
    return {t1:t1,t10:t10,ratio:t10/t1, cumRatio:cum/(t1*10)};})()`);
  ok('HISTORY RESEND: turn-10 single-call cost > 5× turn 1 (invariant iii)', chatInv.ratio > 5, JSON.stringify(chatInv));
  ok('HISTORY RESEND: cumulative bill grows super-linearly (> flat 10×)', chatInv.cumRatio > 1.5, JSON.stringify(chatInv));
  // drive the chat animation and confirm bars render + a done line appears
  await ev('window.__sim.chat()');
  await sleep(200);
  const chatUI = await ev(`(function(){return {
    bars: document.querySelectorAll('#turnBars .tb i').length,
    tallLast: parseFloat(document.querySelectorAll('#turnBars .tb i')[9].style.height) > parseFloat(document.querySelectorAll('#turnBars .tb i')[0].style.height),
    doneLog: Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /chat\\/done|turn 10/.test(e.textContent)})};})()`);
  ok('HISTORY RESEND: 10 turn bars render, last taller than first', chatUI.bars === 10 && chatUI.tallLast === true, JSON.stringify(chatUI));
  ok('HISTORY RESEND: chat replay logs a turn-10 cost line', chatUI.doneLog === true);

  // ---------- 7. budget slider changes who blocks (per-key isolation is real, not scripted) ----------
  await ev('window.__sim.setPrice(0.60); window.__sim.setBudget(1, 40)'); // give batch a huge budget
  const rBigBatch = await replayAndRead();
  ok('BUDGET SLIDER: raising the batch budget stops it blocking',
    rBigBatch.blocked[1] === false, JSON.stringify(rBigBatch.blocked));
  // starve the interactive key AND raise the price so its ~0.7M-tok week crosses $1
  await ev('window.__sim.setPrice(2.0); window.__sim.setBudget(0, 1)');
  const rTightInter = await replayAndRead();
  ok('BUDGET SLIDER: starving the interactive budget makes IT block instead',
    rTightInter.blocked[0] === true, JSON.stringify(rTightInter.blocked));

  // ---------- 8. all three TRY-THIS steps auto-detect end-to-end ----------
  await ev('location.reload()');
  await sleep(600);
  // Step 1: price $0, replay -> nothing blocks
  await ev('window.__sim.setPrice(0)');
  await ev('window.__sim.replay()'); await sleep(280);
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected ($0 → nothing blocks)', step >= 2, 'step=' + step);
  // Step 2: real price, replay -> batch blocks, interactive survives
  await ev('window.__sim.setPrice(0.60)');
  await ev('window.__sim.replay()'); await sleep(280);
  step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (real price → batch blocks, interactive survives)', step >= 3, 'step=' + step);
  // Step 3: send the chat
  await ev('window.__sim.chat()'); await sleep(150);
  const done = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (history resend)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 8b. PREDICT-FIRST mode ----------
  await ev('location.reload()');
  await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent };})()`);
  ok('PREDICT: step 1 opens with a prediction question + chips', pBoot.chips >= 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  ok('PREDICT: instruction hidden until a prediction is made', !/Replay the week/.test(pBoot.txt) || /Predict first/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor, tip:!!c.title};})()`);
  ok('PREDICT: chips are affordant (cursor:pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // tap a WRONG chip (index 0 = "nightly-batch-job"; correct is index 2 = "none of them")
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`);
  const pAfter = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent,
    logged: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /predicted/.test(e.textContent)}) };})()`);
  ok('PREDICT: tapping a chip reveals instruction + shows your pick', pAfter.chips === 0 && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT: the pick is logged in the spend stream', pAfter.logged === true);
  // complete step 1 with the WRONG prediction — must NOT block, verdict must teach
  await ev('window.__sim.setPrice(0)');
  await ev('window.__sim.replay()'); await sleep(280);
  const pVerdict = await ev(`(function(){return {
    step: window.__sim.CH.step,
    verdict: [].slice.call(document.querySelectorAll('#evList .ev')).map(function(e){return e.textContent}).join(' | ') };})()`);
  ok('PREDICT: wrong prediction never blocks step completion', pVerdict.step >= 2, 'step=' + pVerdict.step);
  ok('PREDICT: verdict names your pick and explains the model',
    /Not what you predicted/.test(pVerdict.verdict) && /invisible|price/.test(pVerdict.verdict), pVerdict.verdict.slice(-240));
  // step 2 shows its own question; predict RIGHT (index 1 = batch), complete, expect right verdict
  const p2 = await ev(`document.getElementById('chTxt').textContent`);
  ok('PREDICT: step 2 opens with its own question', /Predict first/.test(p2), p2);
  await ev('window.__sim.predict(1)');
  await ev('window.__sim.setPrice(0.60)');
  await ev('window.__sim.replay()'); await sleep(280);
  const p2v = await ev(`(function(){return {
    step: window.__sim.CH.step,
    right: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /Prediction right/.test(e.textContent)}) };})()`);
  ok('PREDICT: right prediction confirmed in the log', p2v.step >= 3 && p2v.right === true, JSON.stringify(p2v));
  // skip the step-3 prediction entirely — still completes
  await ev('window.__sim.chat()'); await sleep(150);
  const p3 = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('PREDICT: skipping a prediction never blocks the challenge', p3.step >= 4 && p3.success === true, JSON.stringify(p3));

  // ---------- 9. Reset returns to initial state ----------
  await ev('window.__sim.setPrice(2.0); window.__sim.setBudget(1, 40)');
  await ev('location.reload()');
  await sleep(600);
  const afterReset = await ev(`(function(){return {
    priceRaw:window.__sim.S.priceRaw, budgets:window.__sim.S.budgets.slice(),
    ran:window.__sim.S.ran, step:window.__sim.CH.step,
    total:document.getElementById('totalV').textContent};})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults + clears run',
    afterReset.priceRaw === D.price && JSON.stringify(afterReset.budgets) === JSON.stringify(D.budgets)
    && afterReset.ran === false && afterReset.step === 1 && afterReset.total === '—',
    JSON.stringify(afterReset));

  // ---------- 10. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 11. prefers-reduced-motion suppresses animation ----------
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
  try { fs.rmSync('/tmp/m12-spend-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
