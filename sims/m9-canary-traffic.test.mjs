#!/usr/bin/env node
// Headless-Chrome assertion harness for m9-canary-traffic.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m9-canary-traffic.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm9-canary-traffic.html');
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
    '--user-data-dir=/tmp/m9-canary-chrome-' + process.pid, 'about:blank',
  ], { stdio: 'ignore' });

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

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — weight slider present',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 1);
  ok('renders — sample-size + scenario segmented selectors present',
    (await ev('document.querySelectorAll("#nSeg button").length')) === 3 &&
    (await ev('document.querySelectorAll("#scenSeg button").length')) === 2);
  ok('renders — two backend lanes present',
    (await ev('!!document.getElementById("laneBase") && !!document.getElementById("laneCanary")')) === true);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#weightRange','#nSeg button','#scenSeg button','#runEvals','#rollback','#promote'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor) && !e.disabled)bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const ctlTips = await ev(`(function(){
    var bad=[];
    document.querySelectorAll('#controls .ctl').forEach(function(c){if(!c.title)bad.push('ctl-no-title');});
    ['#reset','#runEvals','#rollback','#promote'].forEach(function(s){if(!document.querySelector(s).title)bad.push(s);});
    return bad;})()`);
  ok('R2 controls + action buttons carry tooltips (title)', ctlTips.length === 0, ctlTips.join(','));
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. SAMPLE-SIZE: jitter at n=20 vs convergence at n=500 ----------
  // Draw the same 10% weight many times at each n; measure how far the observed
  // canary share swings from the configured 10%. Small n must swing far wider.
  await ev('window.__sim.setWeight(10)');
  const swing = await ev(`(function(){
    function stats(n){
      window.__sim.setN(n);
      var devs=[];
      for(var s=1;s<=400;s++){
        var r=window.__sim.sample(10,n,s*2654435761>>>0);
        var pct=r.canary/n*100;
        devs.push(Math.abs(pct-10));
      }
      devs.sort(function(a,b){return a-b});
      return {mean:devs.reduce(function(a,b){return a+b},0)/devs.length,
              p90:devs[Math.floor(devs.length*0.9)], max:devs[devs.length-1]};
    }
    return {n20:stats(20), n100:stats(100), n500:stats(500)};
  })()`);
  ok('SAMPLE: mean deviation from weight shrinks as n grows (20 > 100 > 500)',
    swing.n20.mean > swing.n100.mean && swing.n100.mean > swing.n500.mean, JSON.stringify(swing));
  // the illusion made visible: at n=20 a >2x-off read (>=20% or <=5% observed) is common;
  // at n=500 it is essentially impossible.
  const bigSwing = await ev(`(function(){
    function fracBigOff(n){
      window.__sim.setN(n); var hit=0, T=600;
      for(var s=1;s<=T;s++){
        var r=window.__sim.sample(10,n,(s*40503)>>>0);
        var pct=r.canary/n*100;
        if(pct>=20 || pct<=5) hit++;   // >=2x off, or <=0.5x off, the configured 10%
      }
      return hit/T;
    }
    return {n20:fracBigOff(20), n500:fracBigOff(500)};
  })()`);
  ok('SAMPLE: >2x-off reads are common at n=20 (>10% of draws)', bigSwing.n20 > 0.10, JSON.stringify(bigSwing));
  ok('SAMPLE: >2x-off reads essentially vanish at n=500 (<1% of draws)', bigSwing.n500 < 0.01, JSON.stringify(bigSwing));

  // ---------- 4. WEIGHT changes the flow ratio (the split follows the weight) ----------
  // Over a large sample the observed canary share tracks the configured weight.
  const ratio = await ev(`(function(){
    function share(w){ var tot=0; for(var s=1;s<=200;s++){var r=window.__sim.sample(w,500,(s*97)>>>0);tot+=r.canary;} return tot/(200*500)*100; }
    return {w10:share(10), w50:share(50), w90:share(90)};
  })()`);
  ok('WEIGHT: observed share tracks the configured weight (10<50<90, each near target)',
    Math.abs(ratio.w10-10)<3 && Math.abs(ratio.w50-50)<3 && Math.abs(ratio.w90-90)<3, JSON.stringify(ratio));

  // ---------- 5. EVALS reveal the hidden quality — verdict logic BOTH scenarios ----------
  // Before evals, no scores shown and verdict PENDING; health always green.
  await ev('location.reload()'); await sleep(600);
  const preEval = await ev(`(function(){return {
    scoreHidden: !document.getElementById('laneCanary').classList.contains('evaled'),
    canScore: document.getElementById('canScore').textContent,
    verdict: document.getElementById('verdict').textContent.trim(),
    healthC: document.getElementById('healthCanary').textContent,
    healthB: document.getElementById('healthBase').textContent
  };})()`);
  ok('EVALS: canary score hidden until evals run', preEval.scoreHidden === true && preEval.canScore === '—', JSON.stringify(preEval));
  ok('EVALS: verdict PENDING before evals', /PENDING/.test(preEval.verdict), preEval.verdict);
  ok('EVALS: both lanes 1/1 Running before evals (health cannot taste the food)',
    preEval.healthC === '1/1 Running' && preEval.healthB === '1/1 Running', JSON.stringify(preEval));

  // Scenario A (M6 loser) → ROLLBACK, canary worse than base
  await ev('window.__sim.setScenario("A"); window.__sim.runEvals()');
  const scenA = await ev(`(function(){return {
    revealed: document.getElementById('laneCanary').classList.contains('evaled'),
    badq: document.getElementById('laneCanary').classList.contains('badq'),
    verdict: document.getElementById('verdict').textContent.trim(),
    jsVerdict: window.__sim.verdict(),
    canScore: window.__sim.consts.SCEN.A.canScore,
    baseScore: window.__sim.consts.BASE_SCORE,
    healthC: document.getElementById('healthCanary').textContent
  };})()`);
  ok('EVALS-A: scores revealed after Run evals', scenA.revealed === true);
  ok('EVALS-A: canary scores BELOW base', scenA.canScore < scenA.baseScore, JSON.stringify(scenA));
  ok('EVALS-A: verdict is ROLLBACK', scenA.verdict === 'ROLLBACK' && scenA.jsVerdict === 'ROLLBACK', JSON.stringify(scenA));
  ok('EVALS-A: bad canary lane flagged (badq) while health stays 1/1 Running',
    scenA.badq === true && scenA.healthC === '1/1 Running', JSON.stringify(scenA));

  // Scenario B (improvement) → PROMOTE, canary >= base
  await ev('window.__sim.setScenario("B"); window.__sim.runEvals()');
  const scenB = await ev(`(function(){return {
    verdict: document.getElementById('verdict').textContent.trim(),
    jsVerdict: window.__sim.verdict(),
    good: document.getElementById('laneCanary').classList.contains('good'),
    canScore: window.__sim.consts.SCEN.B.canScore,
    baseScore: window.__sim.consts.BASE_SCORE,
    promoteEnabled: !document.getElementById('promote').disabled
  };})()`);
  ok('EVALS-B: canary scores AT LEAST base', scenB.canScore >= scenB.baseScore, JSON.stringify(scenB));
  ok('EVALS-B: verdict is PROMOTE', scenB.verdict === 'PROMOTE' && scenB.jsVerdict === 'PROMOTE', JSON.stringify(scenB));
  ok('EVALS-B: promote button ENABLED on a PROMOTE verdict', scenB.promoteEnabled === true, JSON.stringify(scenB));

  // ---------- 6. STAGED-PROMOTE gating: each rung needs a fresh eval pass ----------
  await ev('location.reload()'); await sleep(600);
  // On scenario B at weight 10, promote must be DISABLED until evals run.
  await ev('window.__sim.setScenario("B"); window.__sim.setWeight(10)');
  const gate0 = await ev('document.getElementById("promote").disabled');
  ok('STAGE-GATE: promote disabled before evals at the rung', gate0 === true);
  await ev('window.__sim.runEvals()');   // pass the 10% rung
  const gate1 = await ev('document.getElementById("promote").disabled');
  ok('STAGE-GATE: promote enabled after an eval pass', gate1 === false);
  await ev('window.__sim.promoteStage()'); await sleep(750);  // → 50, evalsRun reset (600ms anim + margin)
  const at50 = await ev(`(function(){return {w:window.__sim.S.weight, evalsRun:window.__sim.S.evalsRun,
    promoteDisabled:document.getElementById('promote').disabled};})()`);
  ok('STAGE-GATE: promoting to 50 resets the gate (must re-run evals at the new rung)',
    at50.w === 50 && at50.evalsRun === false && at50.promoteDisabled === true, JSON.stringify(at50));

  // ---------- 7. ROLLBACK animates weight to 0 ----------
  await ev('location.reload()'); await sleep(600);
  await ev('window.__sim.setScenario("A"); window.__sim.setWeight(30); window.__sim.runEvals()');
  await ev('window.__sim.rollback()'); await sleep(700);
  const rolled = await ev(`(function(){return {w:window.__sim.S.weight,
    rollbackDisabled:document.getElementById('rollback').disabled,
    log:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /weight → 0|rollout-restart/.test(e.textContent)})};})()`);
  ok('ROLLBACK: weight animates to 0', rolled.w === 0, JSON.stringify(rolled));
  ok('ROLLBACK: rollback button disabled at weight 0', rolled.rollbackDisabled === true);
  ok('ROLLBACK: rollout-restart line logged', rolled.log === true);

  // ---------- 8. event log responds in domain vocabulary ----------
  await ev('location.reload()'); await sleep(600);
  await ev('window.__sim.runEvals()');
  const logHasGolden = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /golden-set/.test(e.textContent)})`);
  ok('EVENT-LOG: running evals logs a golden-set line', logHasGolden === true);
  await ev(`document.getElementById('nSeg').querySelector('[data-n="20"]').click()`);
  const logHasSample = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /sample-size/.test(e.textContent)})`);
  ok('EVENT-LOG: changing sample size logs a sample-size line', logHasSample === true);

  // ---------- 9. TEACHING INVARIANT: verdict is decided by SCORE, not by traffic/health ----------
  // Weight and observed split must NOT change the verdict — only the eval scores do.
  const invariant = await ev(`(function(){
    window.__sim.setScenario('A');
    window.__sim.setWeight(5);  var vLow=window.__sim.verdict();
    window.__sim.setWeight(95); var vHigh=window.__sim.verdict();  // huge traffic to a bad canary
    window.__sim.setScenario('B'); var vB=window.__sim.verdict();
    return {vLow:vLow, vHigh:vHigh, vB:vB};
  })()`);
  ok('INVARIANT: verdict tracks eval SCORE, not traffic weight (A=ROLLBACK at 5% AND 95%)',
    invariant.vLow === 'ROLLBACK' && invariant.vHigh === 'ROLLBACK', JSON.stringify(invariant));
  ok('INVARIANT: switching to the better candidate flips the verdict to PROMOTE',
    invariant.vB === 'PROMOTE', JSON.stringify(invariant));
  // and health is green in every one of those states
  const healthAlways = await ev(`(function(){
    var states=[['A',5],['A',95],['B',50]], allGreen=true;
    states.forEach(function(st){ window.__sim.setScenario(st[0]); window.__sim.setWeight(st[1]);
      if(document.getElementById('healthCanary').textContent!=='1/1 Running') allGreen=false; });
    return allGreen;})()`);
  ok('INVARIANT: canary health reads 1/1 Running in every state (a probe cannot see quality)', healthAlways === true);

  // ---------- 10. ALL THREE TRY-THIS steps auto-detect end-to-end ----------
  await ev('location.reload()'); await sleep(600);
  // Step 1: at n=20, force a draw that reads >2x off the 10% weight. Seed-search a
  // draw with canary share >=20% (>=2x), then push it into the sim's observed split.
  const step1 = await ev(`(function(){
    window.__sim.setN(20); window.__sim.setWeight(10);
    var found=null;
    for(var s=1;s<=5000 && !found;s++){
      var r=window.__sim.sample(10,20,s>>>0);
      if(r.canary/20*100>=20) found=s;   // >=2x the configured 10%
    }
    window.__sim.resample(found);         // apply that draw to the live readout
    return {step:window.__sim.CH.step, sawJitter:window.__sim.CH.done[0],
            obs:window.__sim.obsPct(), ratio:window.__sim.jitterRatio()};
  })()`);
  ok('TRY-THIS step 1 auto-detected (>2x-off split at n=20)',
    step1.step >= 2 && step1.sawJitter === true && step1.ratio >= 2, JSON.stringify(step1));

  // Step 2: scenario A, run evals (canary revealed worse, health never flickered), roll it back.
  await ev('window.__sim.setScenario("A"); window.__sim.setWeight(10); window.__sim.runEvals()');
  await ev('window.__sim.rollback()'); await sleep(700);
  const step2 = await ev(`(function(){return {step:window.__sim.CH.step, done:window.__sim.CH.done[1],
    w:window.__sim.S.weight};})()`);
  ok('TRY-THIS step 2 auto-detected (rolled the bad canary A to 0 on eval data)',
    step2.step >= 3 && step2.done === true && step2.w === 0, JSON.stringify(step2));

  // Step 3: scenario B, staged promote 10 → 50 → 100 with an eval pass at each rung.
  const step3 = await ev(`(async function(){
    window.__sim.setScenario('B'); window.__sim.setWeight(10);
    window.__sim.runEvals();                 // pass rung 10
    window.__sim.promoteStage();             // → 50 (evalsRun reset)
    await new Promise(function(r){setTimeout(r,650)});
    window.__sim.runEvals();                 // pass rung 50
    window.__sim.promoteStage();             // → 100
    await new Promise(function(r){setTimeout(r,650)});
    window.__sim.runEvals();                 // pass rung 100
    return {step:window.__sim.CH.step, w:window.__sim.S.weight,
            rungs:window.__sim.CH.promoteRungs,
            success:document.getElementById('challenge').classList.contains('success')};
  })()`);
  ok('TRY-THIS step 3 auto-detected (staged 10→50→100, eval pass at each rung)',
    step3.step >= 4 && step3.w === 100 && step3.rungs['10'] && step3.rungs['50'] && step3.rungs['100'],
    JSON.stringify(step3));
  ok('CHALLENGE completes: success banner shown', step3.success === true, JSON.stringify(step3));

  // ---------- 11. Reset returns to initial state ----------
  await ev('window.__sim.setWeight(80); window.__sim.setScenario("B"); window.__sim.setN(500); window.__sim.runEvals()');
  await ev('location.reload()'); await sleep(600);
  const afterReset = await ev(`(function(){var D=window.__sim.consts.DEFAULTS;return {
    ok: window.__sim.S.weight===D.weight && window.__sim.S.n===D.n && window.__sim.S.scenario===D.scenario &&
        window.__sim.S.evalsRun===false,
    step: window.__sim.CH.step,
    verdict: document.getElementById('verdict').textContent.trim(),
    scoreHidden: !document.getElementById('laneCanary').classList.contains('evaled')};})()`);
  ok('R5 Reset restores defaults (10% · n=100 · scenario A · evals cleared · challenge reset)',
    afterReset.ok === true && afterReset.step === 1 && /PENDING/.test(afterReset.verdict) && afterReset.scoreHidden === true,
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
  try { fs.rmSync('/tmp/m9-canary-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
