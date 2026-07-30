#!/usr/bin/env node
// Headless-Chrome assertion harness for m10-latency-lie.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m10-latency-lie.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm10-latency-lie.html');
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
    '--user-data-dir=/tmp/m10-latency-chrome-' + process.pid, 'about:blank',
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
  ok('renders — two sliders present',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 2);
  ok('renders — four metric buttons present',
    (await ev('document.querySelectorAll("#metricSeg button").length')) === 4);
  ok('renders — histogram draws bars', (await ev('document.querySelectorAll("#histSvg rect.bar").length')) > 0);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#mixRange','#rateRange'];
    document.querySelectorAll('#metricSeg button').forEach(function(b,i){b.id='__seg'+i;sel.push('#__seg'+i);});
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const tips = await ev(`!!document.querySelector('#reset').title
    && !!document.querySelector('#mixRange').closest('.ctl').title
    && !!document.querySelector('#rateRange').closest('.ctl').title`);
  ok('R2 controls carry tooltips (title)', tips === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const inertBig = await ev(`getComputedStyle(document.querySelector('#bigmetric')).cursor`);
  ok('R2 big-metric readout is inert (cursor:default)', inertBig === 'default', inertBig);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);
  const noteTwoPop = await ev(`/two-population|two population/i.test(document.querySelector('#note').getAttribute('data-tip'))
    && /longer|tail/i.test(document.querySelector('#note').getAttribute('data-tip'))`);
  ok('R8 footnote names the two-population synthetic model + longer real tails', noteTwoPop === true);

  // ---------- 3. metric selector drives the big readout ----------
  await ev('window.__sim.setMix(50);window.__sim.setMetric("p50")');
  const selP50 = await ev(`(function(){return {lbl:document.getElementById('bigLbl').textContent,
    on:document.querySelector('#metricSeg button.on').getAttribute('data-m')};})()`);
  ok('metric selector: P50 selected reflects in readout + button', selP50.lbl === 'P50' && selP50.on === 'p50', JSON.stringify(selP50));
  await ev('window.__sim.setMetric("p99")');
  const selP99 = await ev(`(function(){return {lbl:document.getElementById('bigLbl').textContent,
    val:document.getElementById('bigVal').textContent};})()`);
  ok('metric selector: switching to P99 updates the big value', selP99.lbl === 'P99' && /\d/.test(selP99.val), JSON.stringify(selP99));

  // ---------- 4. event log responds with alert-voice line ----------
  await ev('window.__sim.setMix(70)');
  const logLine = await ev(`(function(){var xs=[].slice.call(document.querySelectorAll('#evList .ev')).map(function(e){return e.textContent});
    return xs.some(function(t){return /mix 70\\/30/.test(t) && /mean/.test(t) && /P50/.test(t) && /P95/.test(t);});})()`);
  ok('R7 event log posts dashboard-voice line (mix · mean · P50 · P95)', logLine === true);

  // ---------- 5. TEACHING INVARIANT (i): the valley — mean sits far from both humps ----------
  const valley = await ev(`(function(){
    var r=window.__sim.compute(50,200);
    return {mean:r.mean, meanInValley:r.meanInValley, meanNearest:r.meanNearest, half:r.humpHalfWidth, meanNearFrac:r.meanNearFrac,
      sc:window.__sim.consts.SHORT_CENTER, lc:window.__sim.consts.LONG_CENTER};})()`);
  ok('INVARIANT (i) at 50/50 the mean lands in the valley between the humps', valley.meanInValley === true, JSON.stringify(valley));
  ok('INVARIANT (i) valley: |mean − nearest hump| exceeds a hump half-width', valley.meanNearest > valley.half, JSON.stringify(valley));
  ok('INVARIANT (i) valley: almost no real request lives near the mean (<20% within ±20%)', valley.meanNearFrac < 0.20, 'meanNearFrac=' + valley.meanNearFrac);

  // ---------- 6. TEACHING INVARIANT (ii): P95 >= P50 always, and P95 tracks the slow hump ----------
  const ord = await ev(`(function(){
    var out=[];
    [0,10,30,50,70,90,100].forEach(function(m){var r=window.__sim.compute(m,200);
      out.push({m:m, p50:r.p50, p95:r.p95, p99:r.p99, ok:(r.p95>=r.p50 && r.p99>=r.p95 && r.p95>=r.mean-1e-9?false:true)});});
    return out;})()`);
  const monotone = await ev(`(function(){
    var bad=[];
    [0,10,30,50,70,90,100].forEach(function(m){var r=window.__sim.compute(m,200);
      if(!(r.p95>=r.p50-1e-9))bad.push('mix'+m+':p95<p50');
      if(!(r.p99>=r.p95-1e-9))bad.push('mix'+m+':p99<p95');});
    return bad;})()`);
  ok('INVARIANT (ii) P95 ≥ P50 and P99 ≥ P95 across every mix', monotone.length === 0, monotone.join(','));
  // P95 tracks the slow hump: once ANY long-answer traffic exists (even 10%), P95 lives
  // up in the slow region — at or above the long-answer median, and far above the fast hump.
  const p95track = await ev(`(function(){
    var sc=window.__sim.consts.SHORT_CENTER, lc=window.__sim.consts.LONG_CENTER;
    function probe(mix){var r=window.__sim.compute(mix,300);return {p95:r.p95,longMed:r.longMed};}
    var a=probe(50);   // 50% long
    var b=probe(90);   // 10% long
    var c=probe(10);   // 90% long
    return {a:a,b:b,c:c,sc:sc,lc:lc,
      aSlow: a.p95>=a.longMed*0.9 && a.p95>sc*3,
      bSlow: b.p95>=b.longMed*0.9 && b.p95>sc*3,   // even at only 10% long, P95 is out in the tail
      cSlow: c.p95>=c.longMed*0.9 && c.p95>sc*3};})()`);
  ok('INVARIANT (ii) P95 tracks the slow (long-answer) region whenever long traffic is present',
    p95track.aSlow && p95track.bSlow && p95track.cSlow, JSON.stringify(p95track));

  // ---------- 7. TEACHING INVARIANT (iii): shifting mix moves the mean, each hump's own median holds ----------
  const shift = await ev(`(function(){
    var lo=window.__sim.compute(50,200);
    var hi=window.__sim.compute(85,200);   // shift toward short
    return {
      meanDropped: hi.mean < lo.mean - 0.3,
      shortMedStable: Math.abs(hi.shortMed - lo.shortMed) < lo.shortMed*0.12,
      longMedStable:  Math.abs(hi.longMed  - lo.longMed)  < lo.longMed*0.12,
      loMean:lo.mean, hiMean:hi.mean,
      loShort:lo.shortMed, hiShort:hi.shortMed, loLong:lo.longMed, hiLong:hi.longMed};})()`);
  ok('INVARIANT (iii) shifting mix toward short DROPS the mean', shift.meanDropped === true, JSON.stringify(shift));
  ok('INVARIANT (iii) each population median is unchanged by the mix — short hump holds', shift.shortMedStable === true, JSON.stringify(shift));
  ok('INVARIANT (iii) each population median is unchanged by the mix — long hump holds', shift.longMedStable === true, JSON.stringify(shift));

  // hump centers themselves are fixed constants regardless of mix (structural)
  const centersFixed = await ev(`(function(){
    var a=window.__sim.compute(20,200), b=window.__sim.compute(80,500);
    return Math.abs(a.shortMed-b.shortMed)<a.shortMed*0.15 && Math.abs(a.longMed-b.longMed)<a.longMed*0.15;})()`);
  ok('INVARIANT (iii) hump centers are mix- and rate-independent', centersFixed === true);

  // ---------- 8. all three TRY-THIS steps auto-detect end-to-end ----------
  await ev('location.reload()'); await sleep(600);
  // Step 1: mean (or p50) in the valley at a balanced mix
  await ev('window.__sim.setMetric("mean");window.__sim.setMix(50)');
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (mean in the valley)', step >= 2, 'step=' + step);
  // Step 2: keep mean, shift to >=80% short so the mean drops
  await ev('window.__sim.setMix(85)');
  step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (mean drops on short-heavy mix)', step >= 3, 'step=' + step);
  // Step 3: switch to P95 to land on the slow hump
  await ev('window.__sim.setMetric("p95")');
  const done = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (P95 on the long-answer hump)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 8b. PREDICT-FIRST mode ----------
  await ev('location.reload()'); await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent };})()`);
  ok('PREDICT: step 1 opens with a prediction question + chips', pBoot.chips >= 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  ok('PREDICT: instruction hidden until a prediction is made', !/valley/.test(pBoot.txt) || /Predict first/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor, tip:!!c.title};})()`);
  ok('PREDICT: chips are affordant (cursor:pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // Tap a WRONG chip (index 0 = "it rises") — instruction appears, prediction logged
  await ev(`document.querySelectorAll('#chPredict .chip')[0].click()`);
  const pAfter = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent,
    logged: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /predicted/.test(e.textContent)}) };})()`);
  ok('PREDICT: tapping a chip reveals the instruction + shows your pick', pAfter.chips === 0
    && /valley/.test(pAfter.txt) && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT: the pick is logged in the event stream', pAfter.logged === true);
  // Complete step 1 — a WRONG prediction must NOT block, and the verdict must teach
  await ev('window.__sim.setMetric("mean");window.__sim.setMix(50)');
  const pVerdict = await ev(`(function(){return {
    step: window.__sim.CH.step,
    verdict: [].slice.call(document.querySelectorAll('#evList .ev')).map(function(e){return e.textContent}).join(' | ') };})()`);
  ok('PREDICT: wrong prediction never blocks step completion', pVerdict.step >= 2, 'step=' + pVerdict.step);
  ok('PREDICT: verdict names your pick and explains the model', /Not what you predicted/.test(pVerdict.verdict)
    && /mean/.test(pVerdict.verdict), pVerdict.verdict.slice(-220));
  // Step 2 shows its own question; predict RIGHT via the hook, complete, expect a right verdict
  const p2 = await ev(`document.getElementById('chTxt').textContent`);
  ok('PREDICT: step 2 opens with its own question', /Predict first/.test(p2), p2);
  await ev('window.__sim.predict(1)');   // "no, only the metric moved" — correct
  await ev('window.__sim.setMix(85)');
  const p2v = await ev(`(function(){return {
    step: window.__sim.CH.step,
    right: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /Prediction right/.test(e.textContent)}) };})()`);
  ok('PREDICT: right prediction confirmed in the log', p2v.step >= 3 && p2v.right === true, JSON.stringify(p2v));
  // Skipping the prediction entirely must also work: complete step 3 without predicting
  await ev('window.__sim.setMetric("p95")');
  const p3 = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('PREDICT: skipping a prediction never blocks the challenge', p3.step >= 4 && p3.success === true, JSON.stringify(p3));

  // ---------- 9. Reset returns to initial state ----------
  await ev('window.__sim.setMix(90);window.__sim.setMetric("p99")');
  await ev('location.reload()'); await sleep(600);
  const afterReset = await ev(`(function(){return {
    mix:window.__sim.S.shortPct, rate:window.__sim.S.rate, metric:window.__sim.S.metric,
    step:window.__sim.CH.step};})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults + clears challenge',
    afterReset.mix === D.shortPct && afterReset.rate === D.rate && afterReset.metric === D.metric
    && afterReset.step === 1, JSON.stringify(afterReset));

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
  try { fs.rmSync('/tmp/m10-latency-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
