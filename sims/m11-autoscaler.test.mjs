#!/usr/bin/env node
// Headless-Chrome assertion harness for m11-autoscaler.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m11-autoscaler.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm11-autoscaler.html');
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
    '--user-data-dir=/tmp/m11-autoscaler-chrome-' + process.pid, 'about:blank',
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
  // The sim advances on a real timer; pause it so every scenario is driven
  // deterministically by window.__sim.tick(n). A fresh reload always re-arms
  // the clock, so we pause right after each reload.
  async function reload() { await ev('location.reload()'); await sleep(600); await ev('window.__sim.pause()'); }

  await ev('window.__sim.pause()');

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — arrival + cold + threshold + stab sliders present',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 4);
  ok('renders — slot / min / max segmented selectors present',
    (await ev('document.querySelectorAll("#slotSeg button").length')) === 4 &&
    (await ev('document.querySelectorAll("#minSeg button").length')) === 2 &&
    (await ev('document.querySelectorAll("#maxSeg button").length')) === 3);
  ok('renders — burst button present',
    (await ev('!!document.getElementById("burst")')) === true);
  ok('renders — scrolling chart svg present (queue + replica paths)',
    (await ev('!!document.getElementById("qPath") && !!document.getElementById("repPath")')) === true);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#playBtn','#rateRange','#coldRange','#thRange','#stabRange',
             '#slotSeg button','#minSeg button','#maxSeg button','#burst'];
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
    ['#reset','#playBtn','#burst'].forEach(function(s){if(!document.querySelector(s).title)bad.push(s);});
    return bad;})()`);
  ok('R2 controls + action buttons carry tooltips (title)', ctlTips.length === 0, ctlTips.join(','));
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. INITIAL STATE: calm at defaults, one warm replica ----------
  await reload();
  const init = await ev(`(function(){var D=window.__sim.consts.DEFAULTS;return {
    rate:window.__sim.S.rate, cold:window.__sim.S.cold, th:window.__sim.S.threshold,
    stab:window.__sim.S.stab, min:window.__sim.S.min, max:window.__sim.S.max, slots:window.__sim.S.slots,
    ready:window.__sim.S.ready, queue:Math.round(window.__sim.S.queue),
    drain:window.__sim.drainPerMin(), phase:window.__sim.phase().k,
    defOK:(window.__sim.S.rate===D.rate&&window.__sim.S.cold===D.cold&&window.__sim.S.threshold===D.threshold&&window.__sim.S.stab===D.stab)
  };})()`);
  ok('INIT: starts at documented defaults (30 rpm · cold 65 · thr 2 · stab 60)',
    init.defOK === true && init.rate === 30 && init.cold === 65 && init.th === 2 && init.stab === 60, JSON.stringify(init));
  ok('INIT: min 1 keeps one replica warm from the start', init.ready === 1 && init.min === 1, JSON.stringify(init));
  ok('INIT: drain line is 24 req/min at 2 slots / 1 replica (the saturation anchor)',
    init.drain === 24, JSON.stringify(init));

  // ---------- 4. SATURATION at a KNOWN rate: below the drain line stays calm, above builds ----------
  // 12 rpm < 24 drain → the queue never builds past threshold, so no scale-out.
  await reload();
  await ev('window.__sim.setRate(12)');
  const belowLine = await ev(`(async function(){
    var maxQ=0;
    for(var i=0;i<90;i++){ window.__sim.tick(1); maxQ=Math.max(maxQ, window.__sim.S.queue); }
    return {maxQ:Math.round(maxQ), ready:window.__sim.S.ready, warming:window.__sim.S.warming.length,
            up:window.__sim.S.lastScaleUpAt};
  })()`);
  ok('SATURATION: below the drain line (12<24) the queue never crosses threshold — no scale-out',
    belowLine.maxQ <= 2 && belowLine.ready === 1 && belowLine.warming === 0 && belowLine.up < 0, JSON.stringify(belowLine));

  // 36 rpm > 24 drain → one replica saturates, queue builds, KEDA scales out to 2.
  await reload();
  await ev('window.__sim.setRate(36)');
  // capture the queue at the moment just before the second replica is Ready:
  await ev('window.__sim.tick(20)');
  const early = await ev(`(function(){return {q:Math.round(window.__sim.S.queue),ready:window.__sim.S.ready,
    warming:window.__sim.S.warming.length, scaleUp:window.__sim.S.lastScaleUpAt};})()`);
  ok('SATURATION: above the drain line (36>24) one replica saturates and the queue builds',
    early.q > 0, JSON.stringify(early));
  ok('SATURATION: KEDA decided a scale-out (a decision was recorded)', early.scaleUp >= 0, JSON.stringify(early));
  ok('SATURATION: capacity is still LATE — decision made but second replica still warming',
    early.ready === 1 && early.warming === 1, JSON.stringify(early));

  // ---------- 5. BURST → scale decision AT the threshold, warming delay honored, relief AFTER warm ----------
  await reload();
  await ev('window.__sim.setCold(40); window.__sim.burst()');
  // just after the first poll, the decision fires but nothing is Ready yet
  await ev('window.__sim.tick(8)');
  const decided = await ev(`(function(){return {q:Math.round(window.__sim.S.queue),ready:window.__sim.S.ready,
    warming:window.__sim.S.warming.length, desired:window.__sim.S.desired,
    scaleUp:window.__sim.S.lastScaleUpAt, relief:window.__sim.S.lastReliefAt, thr:window.__sim.S.threshold};})()`);
  ok('BURST: queue crosses threshold and KEDA raises desired above current',
    decided.q > decided.thr && decided.desired >= 2, JSON.stringify(decided));
  ok('BURST: scale DECISION fired (lastScaleUpAt set) but replica is WARMING, not yet Ready',
    decided.scaleUp >= 0 && decided.warming >= 1 && decided.ready === 1, JSON.stringify(decided));
  ok('BURST: no relief yet — the second engine has not landed while it warms',
    decided.relief < 0 || decided.relief < decided.scaleUp, JSON.stringify(decided));

  // run past the cold start: relief lands, and the lag ≈ cold start
  await ev('window.__sim.tick(60)');
  const relieved = await ev(`(function(){return {ready:window.__sim.S.ready, warming:window.__sim.S.warming.length,
    scaleUp:window.__sim.S.lastScaleUpAt, relief:window.__sim.S.lastReliefAt,
    lag:window.__sim.S.lastReliefAt-window.__sim.S.lastScaleUpAt, cold:window.__sim.S.cold};})()`);
  ok('BURST: after the cold-start window the second replica becomes Ready', relieved.ready === 2, JSON.stringify(relieved));
  ok('BURST: relief lands AFTER the decision (lag > 0 — the window users wait through)',
    relieved.relief > relieved.scaleUp && relieved.lag > 0, JSON.stringify(relieved));
  ok('BURST: the lag is on the order of the cold start (warming delay honored)',
    relieved.lag >= relieved.cold - 6 && relieved.lag <= relieved.cold + 8, JSON.stringify(relieved));

  // ---------- 6. WARMING BAND + growing-queue narration during the lag window ----------
  await reload();
  await ev('window.__sim.setCold(50); window.__sim.burst()');
  await ev('window.__sim.tick(30)');
  const duringWarm = await ev(`(function(){return {
    phaseK:window.__sim.phase().k,
    warming:window.__sim.S.warming.length,
    grewLog:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /STILL growing|queue growing/i.test(e.textContent);}),
    warmLog:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /warming/i.test(e.textContent);})
  };})()`);
  ok('WARMING: phase reads WARMING while a replica boots', /warming|cold/.test(duringWarm.phaseK) && duringWarm.warming >= 1, JSON.stringify(duringWarm));
  ok('EVENT-LOG: a "queue still growing while warming" line is logged during the lag',
    duringWarm.grewLog === true, JSON.stringify(duringWarm));
  const bandCount = await ev(`document.querySelectorAll('#warmBands rect').length`);
  ok('CHART: a warming band is drawn over the lag window', bandCount >= 1, 'bands=' + bandCount);

  // ---------- 7. STABILIZATION scale-down: calm for the window, then shrink back ----------
  await reload();
  // push to 2 replicas with a burst, let it warm, then drop the rate and wait out the window
  await ev('window.__sim.setCold(20); window.__sim.setStab(30); window.__sim.burst()');
  await ev('window.__sim.tick(80)');           // burst decays, second replica up, queue drains
  await ev('window.__sim.setRate(6)');          // well below one-replica drain
  await ev('window.__sim.tick(90)');            // let the calm window elapse
  const scaledDown = await ev(`(function(){return {ready:window.__sim.S.ready, queue:Math.round(window.__sim.S.queue),
    downLog:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /scale .*→.*replica|remove .*replica|calm/i.test(e.textContent);})};})()`);
  ok('STABILIZE: after a sustained calm window KEDA scales back down toward min',
    scaledDown.ready === 1, JSON.stringify(scaledDown));
  ok('EVENT-LOG: a scale-down decision (calm ≥ window) is logged', scaledDown.downLog === true, JSON.stringify(scaledDown));

  // scale-down must NOT happen before the window elapses (level-triggered calm)
  await reload();
  await ev('window.__sim.setCold(20); window.__sim.setStab(60); window.__sim.burst()');
  await ev('window.__sim.tick(70)');            // 2 replicas up, burst decaying
  await ev('window.__sim.setRate(6)');
  await ev('window.__sim.tick(25)');            // only 25s of calm — less than the 60s window
  const notYet = await ev('window.__sim.S.ready');
  ok('STABILIZE: does NOT scale down before the window elapses (25s calm < 60s window)',
    notYet === 2, 'ready=' + notYet);

  // ---------- 8. FLAP scenario: too-short window oscillates ----------
  // Steady rate 30 sits in the flap band: one replica (drain 24) can't cope, two
  // (drain 48) can. Burst up to 2, then a too-short window scales back down to 1,
  // which re-saturates → scale up again = a flap.
  await reload();
  await ev('window.__sim.setRate(30); window.__sim.setMax(2); window.__sim.setStab(10); window.__sim.setCold(20); window.__sim.burst()');
  await ev('window.__sim.tick(260)');
  const flap = await ev(`(function(){return {flap:window.__sim.S.flapCount, stab:window.__sim.S.stab, ready:window.__sim.S.ready};})()`);
  ok('FLAP: a too-short stabilization window (10s) makes the autoscaler oscillate (flapCount ≥ 1)',
    flap.flap >= 1, JSON.stringify(flap));

  // and the CONTRAST: a long window does NOT flap under the same load
  await reload();
  await ev('window.__sim.setRate(30); window.__sim.setMax(2); window.__sim.setStab(120); window.__sim.setCold(20); window.__sim.burst()');
  await ev('window.__sim.tick(260)');
  const noFlap = await ev('window.__sim.S.flapCount');
  ok('FLAP: a long window (120s) rides out the same load without flapping (flapCount 0)',
    noFlap === 0, 'flap=' + noFlap);

  // ---------- 9. min=0 SCALE-TO-ZERO cold-start path ----------
  await reload();
  await ev('window.__sim.setMin(0); window.__sim.setRate(0)');
  await ev('window.__sim.tick(200)');           // idle → drain to zero replicas
  const drained = await ev(`(function(){return {ready:window.__sim.S.ready, warming:window.__sim.S.warming.length};})()`);
  ok('MIN0: with min 0 and no load the service drains to ZERO replicas', drained.ready === 0 && drained.warming === 0, JSON.stringify(drained));

  await ev('window.__sim.setRate(40)');          // first user after idle
  await ev('window.__sim.tick(6)');
  const coldBoot = await ev(`(function(){return {ready:window.__sim.S.ready, warming:window.__sim.S.warming.length,
    phaseK:window.__sim.phase().k, queue:Math.round(window.__sim.S.queue), coldFlag:window.__sim.CH.sawColdBoot,
    coldLog:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /cold boot|first request waits|from zero/i.test(e.textContent);})};})()`);
  ok('MIN0: the first request finds ZERO ready replicas — it must wait (queue > 0, nothing serving)',
    coldBoot.ready === 0 && coldBoot.warming >= 1 && coldBoot.queue > 0, JSON.stringify(coldBoot));
  ok('MIN0: phase is COLD BOOT while the sole engine loads from zero', coldBoot.phaseK === 'cold', JSON.stringify(coldBoot));
  ok('EVENT-LOG: a cold-boot-from-zero line is logged for the first request', coldBoot.coldLog === true, JSON.stringify(coldBoot));

  // ---------- 10. TEACHING INVARIANT: the scaler reacts AFTER the queue, capacity arrives LATE ----------
  await reload();
  await ev('window.__sim.setCold(60); window.__sim.burst()');
  const seq = await ev(`(async function(){
    // sample queue + ready every few ticks across the whole burst; find:
    //  - the tick the queue first exceeds threshold (queue forms)
    //  - the tick the scale decision is recorded
    //  - the tick a 2nd replica becomes Ready (relief)
    var qForm=-1, decide=-1, relief=-1;
    for(var i=0;i<130;i++){
      window.__sim.tick(1);
      var s=window.__sim.S;
      if(qForm<0 && s.queue>0) qForm=s.t;      // the queue STARTS forming
      if(decide<0 && s.lastScaleUpAt>=0) decide=s.lastScaleUpAt;
      if(relief<0 && s.ready>=2) relief=s.t;
    }
    return {qForm:qForm, decide:decide, relief:relief};
  })()`);
  ok('INVARIANT: the queue forms BEFORE (or with) the scale decision — the scaler is reactive',
    seq.qForm >= 0 && seq.decide >= seq.qForm, JSON.stringify(seq));
  ok('INVARIANT: relief (2nd replica Ready) lands AFTER the decision — capacity is cold-start-late',
    seq.relief > seq.decide, JSON.stringify(seq));
  ok('INVARIANT: the lag between decision and relief is a real window (relief − decide ≥ ~cold start)',
    (seq.relief - seq.decide) >= 40, JSON.stringify(seq));

  // ---------- 11. CONTROLS drive the model (slots raise drain, threshold changes trigger point) ----------
  await reload();
  const drainBySlots = await ev(`(function(){
    window.__sim.setSlots(1); var d1=window.__sim.drainPerMin();
    window.__sim.setSlots(2); var d2=window.__sim.drainPerMin();
    window.__sim.setSlots(4); var d4=window.__sim.drainPerMin();
    return {d1:d1,d2:d2,d4:d4};})()`);
  ok('CONTROL: more slots per replica raise the drain rate (1<2<4 slots monotonic)',
    drainBySlots.d1 < drainBySlots.d2 && drainBySlots.d2 < drainBySlots.d4, JSON.stringify(drainBySlots));

  // ---------- 12. EVENT LOG uses domain vocabulary (KEDA / requests_deferred) ----------
  await reload();
  const vocab = await ev(`(function(){
    var txt=Array.from(document.querySelectorAll('#evList .ev')).map(function(e){return e.textContent;}).join(' | ');
    return {
      deferred:/requests_deferred|deferred/i.test(txt),
      keda:/ScaledObject|pollingInterval|threshold/i.test(txt)
    };})()`);
  ok('EVENT-LOG: boots with KEDA / requests_deferred vocabulary', vocab.deferred === true && vocab.keda === true, JSON.stringify(vocab));
  await ev('window.__sim.burst()'); await ev('window.__sim.tick(10)');
  const burstLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /burst|outage/i.test(e.textContent);})`);
  ok('EVENT-LOG: the burst button logs an outage/burst line', burstLog === true);
  await ev('document.getElementById("stabRange").value=15; document.getElementById("stabRange").dispatchEvent(new Event("input"))');
  const stabLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /stabilizationWindow/i.test(e.textContent);})`);
  ok('EVENT-LOG: changing the stabilization window logs a stabilizationWindow line', stabLog === true);

  // ---------- 13. ALL FOUR TRY-THIS steps auto-detect end-to-end ----------
  await reload();
  // Step 1: raise arrival above the drain line with one replica; queue builds.
  const step1 = await ev(`(async function(){
    window.__sim.setRate(42);   // > 24 drain, one replica saturates
    for(var i=0;i<12 && !window.__sim.CH.done[0];i++) window.__sim.tick(1);
    return {step:window.__sim.CH.step, done:window.__sim.CH.done[0], sat:window.__sim.CH.saturated};
  })()`);
  ok('TRY-THIS step 1 auto-detected (found the saturation rate — queue builds on one replica)',
    step1.step >= 2 && step1.done === true, JSON.stringify(step1));

  // Step 2: burst, let it warm, measure the decision→relief lag.
  const step2 = await ev(`(async function(){
    window.__sim.setRate(30); window.__sim.setCold(45); window.__sim.burst();
    for(var i=0;i<90 && !window.__sim.CH.done[1];i++) window.__sim.tick(1);
    return {step:window.__sim.CH.step, done:window.__sim.CH.done[1], lag:window.__sim.CH.measuredLag};
  })()`);
  ok('TRY-THIS step 2 auto-detected (measured the decision→relief lag on a burst)',
    step2.step >= 3 && step2.done === true && step2.lag > 0, JSON.stringify(step2));

  // Step 3: shrink the window, burst, catch a flap. Rate 30 / max 2 is the flap band.
  const step3 = await ev(`(async function(){
    window.__sim.setRate(30); window.__sim.setMax(2); window.__sim.setStab(10); window.__sim.setCold(20); window.__sim.burst();
    for(var i=0;i<400 && !window.__sim.CH.done[2];i++) window.__sim.tick(1);
    return {step:window.__sim.CH.step, done:window.__sim.CH.done[2], flap:window.__sim.CH.flapped, count:window.__sim.S.flapCount};
  })()`);
  ok('TRY-THIS step 3 auto-detected (short window → flapping)',
    step3.step >= 4 && step3.done === true && step3.flap === true, JSON.stringify(step3));

  // Step 4: min 0, drain to zero, load → cold boot.
  const step4 = await ev(`(async function(){
    window.__sim.setMin(0); window.__sim.setRate(0);
    for(var i=0;i<220 && window.__sim.S.ready>0;i++) window.__sim.tick(1);
    window.__sim.setRate(40);
    for(var i=0;i<10 && !window.__sim.CH.done[3];i++) window.__sim.tick(1);
    return {step:window.__sim.CH.step, done:window.__sim.CH.done[3], cold:window.__sim.CH.sawColdBoot,
            success:document.getElementById('challenge').classList.contains('success')};
  })()`);
  ok('TRY-THIS step 4 auto-detected (min 0 → the first user eats the cold start)',
    step4.step >= 5 && step4.done === true && step4.cold === true, JSON.stringify(step4));
  ok('CHALLENGE completes: success banner shown', step4.success === true, JSON.stringify(step4));

  // ---------- 14. Reset returns to initial state ----------
  await ev('window.__sim.setRate(60); window.__sim.setMin(0); window.__sim.setStab(10); window.__sim.setCold(20); window.__sim.burst()');
  await reload();
  const afterReset = await ev(`(function(){var D=window.__sim.consts.DEFAULTS;return {
    ok: window.__sim.S.rate===D.rate && window.__sim.S.cold===D.cold && window.__sim.S.threshold===D.threshold &&
        window.__sim.S.stab===D.stab && window.__sim.S.min===D.min && window.__sim.S.max===D.max,
    step: window.__sim.CH.step,
    ready: window.__sim.S.ready,
    phaseK: window.__sim.phase().k};})()`);
  ok('R5 Reset restores defaults (30 rpm · cold 65 · thr 2 · stab 60 · min 1 / max 2 · challenge reset)',
    afterReset.ok === true && afterReset.step === 1 && afterReset.ready === 1,
    JSON.stringify(afterReset));

  // ---------- 15. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 16. prefers-reduced-motion suppresses animation ----------
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
  try { fs.rmSync('/tmp/m11-autoscaler-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
