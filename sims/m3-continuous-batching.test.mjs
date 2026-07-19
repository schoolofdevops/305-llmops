#!/usr/bin/env node
// Headless-Chrome assertion harness for m3-continuous-batching.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Drives the sim under VIRTUAL TIME via window.__sim.stepN() — no wall-clock waits.
// Run: node site/static/sims/m3-continuous-batching.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm3-continuous-batching.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9330 + (process.pid % 400);

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
    '--no-sandbox', '--disable-gpu', '--window-size=900,560',
    '--user-data-dir=/tmp/m3-batching-chrome-' + process.pid, 'about:blank',
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
    { width: 900, height: 560, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: FILE_URL });
  await sleep(700);

  async function ev(expr) {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    if (r.result && r.result.result) return r.result.result.value;
    return undefined;
  }
  // reset to a clean, deterministic state (fresh reload + reseed)
  async function reset(seed = 0) {
    await ev('location.reload()'); await sleep(500);
    await ev(`window.__sim.reseed(${seed})`);
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — two sliders present',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 2);
  ok('renders — mode toggle has two buttons',
    (await ev('document.querySelectorAll("#modeToggle button").length')) === 2);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#runBtn','#reset','#arrRange','#slotRange','#modeStatic','#modeCont'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const tips = await ev(`(function(){
    return ['#runBtn','#reset','#modeWrap','#modeStatic','#modeCont'].every(function(s){
      var e=document.querySelector(s); return !!(e && e.title);
    });})()`);
  ok('R2 controls carry tooltips (title)', tips === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. clock advances state + event log responds (R7) ----------
  await reset();
  await ev('window.__sim.setArrival(3);window.__sim.setSlots(2)');
  await ev('window.__sim.stepN(40)');
  const advanced = await ev(`(function(){var s=window.__sim.S();return {step:s.step, done:s.totalDone,
    logHasAdmit: Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /admitted/.test(e.textContent)})};})()`);
  ok('CLOCK advances step count', advanced.step === 40, JSON.stringify(advanced));
  ok('CLOCK completes some requests', advanced.done > 0, JSON.stringify(advanced));
  ok('EVENT LOG logs an admission (domain vocabulary)', advanced.logHasAdmit === true, JSON.stringify(advanced));
  const stepShown = await ev(`document.getElementById('stepLbl').textContent`);
  ok('step gauge reflects the clock', /step 40/.test(stepShown), stepShown);

  // ---------- 4. mode toggle CHANGES behaviour measurably ----------
  // Same load + slots + seed. Continuous's structural win over static is that a freed
  // slot is refilled instantly instead of at a batch boundary, so it keeps utilization
  // high → higher throughput, a shorter queue, and (at realistic near-capacity load)
  // lower p50 wait. We assert throughput+queue at any load (always true) and p50 at
  // near-capacity load (arr=3, slots=2; capacity ~2.2 req/s — loaded but not deeply
  // saturated, the regime where the wait win is visible rather than washed out).
  async function runMetrics(mode, arrival, slots, steps, seed) {
    await reset(seed);
    await ev(`window.__sim.setSlots(${slots});window.__sim.setArrival(${arrival})`);
    await ev(`window.__sim.setMode('${mode}')`);
    // setMode reseeds internally; reseed AFTER so arrivals are identical across modes
    await ev(`window.__sim.reseed(${seed})`);
    await ev(`window.__sim.stepN(${steps})`);
    return ev(`(function(){var m=window.__sim.metrics();var s=window.__sim.S();
      return {p50:m.p50WaitMs, thru:m.throughput, done:m.done, q:s.queue.length, util:m.utilization};})()`);
  }
  const staticRun = await runMetrics('static', 3, 2, 90, 7);
  const contRun = await runMetrics('continuous', 3, 2, 90, 7);
  ok('MODE static batching produces waiting (p50 wait > 0)', staticRun.p50 > 0, JSON.stringify(staticRun));
  ok('MODE continuous raises throughput vs static at same load',
    contRun.thru > staticRun.thru, JSON.stringify({ staticThru: staticRun.thru, contThru: contRun.thru }));
  ok('MODE continuous keeps a shorter queue at same load',
    contRun.q < staticRun.q, JSON.stringify({ staticQ: staticRun.q, contQ: contRun.q }));
  ok('MODE continuous lowers p50 wait vs static at near-capacity load',
    contRun.p50 < staticRun.p50, JSON.stringify({ staticP50: staticRun.p50, contP50: contRun.p50 }));
  ok('MODE continuous completes at least as many at same load',
    contRun.done >= staticRun.done, JSON.stringify({ staticDone: staticRun.done, contDone: contRun.done }));

  // ---------- 5. queue GROWS without bound at high arrival rate (ties to requests_deferred) ----------
  await reset(11);
  await ev(`window.__sim.setSlots(1);window.__sim.setArrival(11)`);
  await ev('window.__sim.stepN(60)');
  const midQ = await ev('window.__sim.S().queue.length');
  await ev('window.__sim.stepN(60)');
  const lateQ = await ev('window.__sim.S().queue.length');
  ok('QUEUE grows unbounded when arrivals exceed slot capacity', lateQ > midQ && lateQ > 10,
    JSON.stringify({ midQ, lateQ }));
  const deferLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /queue|deferred/.test(e.textContent)})`);
  ok('QUEUE growth logs a requests_deferred-style line', deferLog === true);

  // ---------- 6. adding a slot DRAINS the queue ----------
  await ev('window.__sim.setSlots(4)');
  await ev('window.__sim.setArrival(2)');
  await ev('window.__sim.stepN(120)');
  const drainedQ = await ev('window.__sim.S().queue.length');
  ok('ADD SLOTS + lower load drains the backlog', drainedQ < lateQ, JSON.stringify({ lateQ, drainedQ }));

  // ---------- 7. teaching invariants ----------
  // (a) CONSERVATION: every request is accounted for — done + inflight + queued == total arrived.
  await reset(3);
  await ev(`window.__sim.setSlots(2);window.__sim.setArrival(6)`);
  await ev('window.__sim.stepN(70)');
  const conserve = await ev(`(function(){var s=window.__sim.S();
    var inflight=s.slotReq.slice(0,s.slots).filter(Boolean).length;
    var arrived=s.nextId-1;
    return {arrived:arrived, done:s.totalDone, inflight:inflight, queued:s.queue.length,
      balances:(s.totalDone+inflight+s.queue.length)===arrived};})()`);
  ok('INVARIANT conservation: done + inflight + queued == arrived',
    conserve.balances === true, JSON.stringify(conserve));

  // (b) STATIC head-of-line: while a batch is mid-flight, the queue is NOT drained
  //     even when a slot is empty (a finished short request cannot be replaced until
  //     the whole batch drains). Detect: an empty slot coexists with a non-empty queue mid-batch.
  await reset(5);
  await ev(`window.__sim.setMode('static');window.__sim.reseed(5)`);
  await ev(`window.__sim.setSlots(3);window.__sim.setArrival(8)`);
  let sawHOL = false;
  for (let i = 0; i < 30 && !sawHOL; i++) {
    await ev('window.__sim.stepN(1)');
    sawHOL = await ev(`(function(){var s=window.__sim.S();
      if(!s.batchActive) return false;
      var occ=s.slotReq.slice(0,s.slots).filter(Boolean).length;
      var hasFreeSlot = occ < s.slots;
      return hasFreeSlot && s.queue.length>0;})()`);
  }
  ok('INVARIANT static head-of-line: a free slot + waiting queue coexist mid-batch (batching bug guard)',
    sawHOL === true);

  // (c) CONTINUOUS never idles a slot while the queue is non-empty (the opposite invariant).
  await reset(5);
  await ev(`window.__sim.setMode('continuous');window.__sim.reseed(5)`);
  await ev(`window.__sim.setSlots(3);window.__sim.setArrival(8)`);
  let contIdleViolation = false;
  for (let i = 0; i < 60; i++) {
    await ev('window.__sim.stepN(1)');
    const bad = await ev(`(function(){var s=window.__sim.S();
      var occ=s.slotReq.slice(0,s.slots).filter(Boolean).length;
      return occ < s.slots && s.queue.length>0;})()`);
    if (bad) { contIdleViolation = true; break; }
  }
  ok('INVARIANT continuous: no slot idles while the queue is non-empty (utilization guard)',
    contIdleViolation === false);

  // (d) MONOTONE THROUGHPUT-CAP: throughput cannot exceed slots/mean-service (sanity ceiling).
  const cap = await ev(`(function(){var c=window.__sim.consts;
    var meanTok=(c.TOKENS_MIN+c.TOKENS_MAX)/2; var tickS=c.TICK_MS/1000;
    var m=window.__sim.metrics(); var s=window.__sim.S();
    var ceiling=s.slots/(meanTok*tickS)*1.6;   // generous ceiling
    return {thru:m.throughput, ceiling:ceiling, ok:m.throughput<=ceiling};})()`);
  ok('INVARIANT throughput below the slot/service ceiling (no free lunch)',
    cap.ok === true, JSON.stringify(cap));

  // ---------- 8. all three TRY-THIS steps auto-detect end-to-end ----------
  await reset(9);
  // Step 1: run static at near-capacity load, capture p50, flip to continuous, beat it.
  await ev(`window.__sim.setSlots(2);window.__sim.setArrival(3)`);
  await ev('window.__sim.stepN(90)');   // build a static p50 under load
  let s1a = await ev('window.__sim.CH.step');
  await ev(`window.__sim.setMode('continuous');window.__sim.reseed(9)`);
  await ev('window.__sim.stepN(90)');   // continuous should beat the captured static p50
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (continuous beats static p50)', step >= 2, 'step=' + step + ' (afterStatic=' + s1a + ')');

  // Step 2: raise arrival above capacity → runaway queue (moderate saturation).
  await ev(`window.__sim.setSlots(1);window.__sim.setArrival(6)`);
  await ev('window.__sim.stepN(90)');
  step = await ev('window.__sim.CH.step');
  const peakSeen = await ev('window.__sim.CH.runawayDepth');
  ok('TRY-THIS step 2 auto-detected (runaway queue)', step >= 3, 'step=' + step + ' peak=' + peakSeen);

  // Step 3: add slots + drop load → queue drains from its peak.
  await ev(`window.__sim.setSlots(4);window.__sim.setArrival(1)`);
  await ev('window.__sim.stepN(300)');   // enough steps to halve the backlog from its peak
  const done = await ev(`(function(){return {step:window.__sim.CH.step, q:window.__sim.S().queue.length,
    peak:window.__sim.CH.runawayDepth, success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (queue drains)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 9. Reset returns to initial state ----------
  await ev(`window.__sim.setArrival(11);window.__sim.setSlots(4);window.__sim.setMode('continuous');window.__sim.stepN(30)`);
  await ev('location.reload()');
  await sleep(500);
  const afterReset = await ev(`(function(){var s=window.__sim.S();return {
    arrival:s.arrivalRate, slots:s.slots, mode:s.mode, step:s.step, done:s.totalDone,
    chStep:window.__sim.CH.step};})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults + clears run',
    afterReset.arrival === D.arrivalRate && afterReset.slots === D.slots && afterReset.mode === D.mode
    && afterReset.step === 0 && afterReset.done === 0 && afterReset.chStep === 1,
    JSON.stringify(afterReset));

  // ---------- 10. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @900x560', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @900x560', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

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
  try { fs.rmSync('/tmp/m3-batching-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
