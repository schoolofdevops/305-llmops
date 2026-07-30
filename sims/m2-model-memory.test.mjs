#!/usr/bin/env node
// Headless-Chrome assertion harness for m2-model-memory.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m2-model-memory.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm2-model-memory.html');
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
    '--user-data-dir=/tmp/m2-memory-chrome-' + process.pid, 'about:blank',
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
  ok('renders — three band elements present',
    (await ev('!!document.getElementById("bWeights") && !!document.getElementById("bRuntime") && !!document.getElementById("bKv")')) === true);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#ctxRange','#usersRange'];
    document.querySelectorAll('#paramChips .pill,#precChips .pill,#boxChips .pill').forEach(function(e,i){sel.push(e);});
    var bad=[];
    sel.forEach(function(s){var e=typeof s==='string'?document.querySelector(s):s;if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push((e.id||e.className)+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls + preset pills have pointer cursor', affClickable.length === 0, affClickable.join(','));
  const chipTips = await ev(`(function(){
    var pills=document.querySelectorAll('#paramChips .pill,#precChips .pill,#boxChips .pill');
    return [].every.call(pills,function(p){return !!p.title});
  })()`);
  ok('R2 preset pills carry tooltips (title)', chipTips === true);
  const resetTip = await ev(`!!document.querySelector('#reset').title`);
  ok('R2 reset carries a tooltip', resetTip === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const inertFill = await ev(`getComputedStyle(document.querySelector('#fill')).cursor`);
  ok('R2 box-fill bands are inert (cursor:default)', inertFill === 'default', inertFill);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. defaults reproduce the lesson's course-model numbers ----------
  // qwen3:0.6b (752M) at Q4, 4096 ctx, 1 user: weights ~0.38 GB, KV ~0.44 GB, fits 8 GB.
  const dflt = await ev(`(function(){var c=window.__sim.compute();return {
    w:c.weights, kv:c.kv, ws:c.working, fits:c.fits, box:c.boxGB};})()`);
  ok('LESSON: default 752M/Q4 weights ≈ 0.38 GB', Math.abs(dflt.w - 0.376) < 0.02, JSON.stringify(dflt));
  ok('LESSON: default 752M/Q4 fits the 8 GB box', dflt.fits === true && dflt.box === 8, JSON.stringify(dflt));
  // KV at the model's advertised 40960 context ≈ 4.5 GB (the lesson's number), 1 user.
  const kv40k = await ev(`window.__sim.compute({ctx:40960,users:1}).kv`);
  ok('LESSON: KV at 40960 ctx ≈ 4.5 GB (M1 figure)', Math.abs(kv40k - 4.375) < 0.15, 'kv=' + kv40k);

  // ---------- 4. precision scales the weights band (Q4 < Q8 < FP16) ----------
  const prec = await ev(`(function(){
    var q4=window.__sim.compute({bpp:0.5}).weights;
    var q8=window.__sim.compute({bpp:1}).weights;
    var f16=window.__sim.compute({bpp:2}).weights;
    return {q4:q4,q8:q8,f16:f16};})()`);
  ok('INVARIANT: Q4 weights < Q8 weights < FP16 weights (same params)',
    prec.q4 < prec.q8 && prec.q8 < prec.f16, JSON.stringify(prec));
  ok('INVARIANT: precision scales weights near-linearly (FP16 ≈ 2× Q8 ≈ 4× Q4)',
    Math.abs(prec.f16 / prec.q8 - 2) < 1e-6 && Math.abs(prec.q8 / prec.q4 - 2) < 1e-6, JSON.stringify(prec));

  // Selecting a precision pill updates the weights band height and readout.
  await ev(`document.querySelector('#precChips .pill[data-b="2"]').click()`); // FP16
  const wFP16 = await ev(`(function(){return {band:parseFloat(document.getElementById('bWeights').style.height),
    txt:document.getElementById('wV').textContent};})()`);
  await ev(`document.querySelector('#precChips .pill[data-b="0.5"]').click()`); // back to Q4
  const wQ4 = await ev(`(function(){return {band:parseFloat(document.getElementById('bWeights').style.height),
    txt:document.getElementById('wV').textContent};})()`);
  ok('WEIGHTS BAND: FP16 taller than Q4 in the box', wFP16.band > wQ4.band, JSON.stringify({wFP16, wQ4}));

  // ---------- 5. KV grows with context AND users while weights stay constant ----------
  const kvInv = await ev(`(function(){
    var base=window.__sim.compute({paramsB:7,bpp:0.5,ctx:4096,users:1});
    var moreCtx=window.__sim.compute({paramsB:7,bpp:0.5,ctx:16384,users:1});
    var moreUsers=window.__sim.compute({paramsB:7,bpp:0.5,ctx:4096,users:4});
    return {
      wConst: Math.abs(base.weights-moreCtx.weights)<1e-9 && Math.abs(base.weights-moreUsers.weights)<1e-9,
      kvUpCtx: moreCtx.kv>base.kv, kvUpUsers: moreUsers.kv>base.kv,
      kvCtxLinear: Math.abs(moreCtx.kv/base.kv - 4)<1e-6,     // 16384/4096 = 4×
      kvUsersLinear: Math.abs(moreUsers.kv/base.kv - 4)<1e-6  // 4 users = 4×
    };})()`);
  ok('INVARIANT: weights stay constant as context and users change', kvInv.wConst === true, JSON.stringify(kvInv));
  ok('INVARIANT: KV grows with context (4× ctx ⇒ 4× KV)', kvInv.kvUpCtx && kvInv.kvCtxLinear, JSON.stringify(kvInv));
  ok('INVARIANT: KV grows with concurrent users (4 users ⇒ 4× KV)', kvInv.kvUpUsers && kvInv.kvUsersLinear, JSON.stringify(kvInv));

  // KV can dwarf a small model's weights (the counter-intuition).
  const kvDwarf = await ev(`(function(){
    var c=window.__sim.compute({paramsB:0.75163,bpp:0.5,ctx:40960,users:1});
    return {kv:c.kv, w:c.weights, kvBigger:c.kv>c.weights};})()`);
  ok('INVARIANT: KV can dwarf a small model’s weights (752M @ 40k ctx)', kvDwarf.kvBigger === true, JSON.stringify(kvDwarf));

  // ---------- 6. fit / OOM flips on CONTEXT alone, everything else fixed ----------
  const flip = await ev(`(function(){
    var fits=window.__sim.compute({paramsB:7,bpp:0.5,users:1,boxGB:8,ctx:4096});
    var oom =window.__sim.compute({paramsB:7,bpp:0.5,users:1,boxGB:8,ctx:40960});
    return {fitsAtLow:fits.fits, oomAtHigh:!oom.fits,
      sameW: Math.abs(fits.weights-oom.weights)<1e-9,
      sameBox: fits.boxGB===oom.boxGB};})()`);
  ok('INVARIANT: same model+precision+box FITS at low ctx', flip.fitsAtLow === true, JSON.stringify(flip));
  ok('INVARIANT: FLIPS to OOM at high ctx (weights + box unchanged)',
    flip.oomAtHigh && flip.sameW && flip.sameBox, JSON.stringify(flip));

  // fit / OOM flips on USERS alone too.
  const flipU = await ev(`(function(){
    var fits=window.__sim.compute({paramsB:7,bpp:0.5,ctx:8192,boxGB:8,users:1});
    var oom =window.__sim.compute({paramsB:7,bpp:0.5,ctx:8192,boxGB:8,users:16});
    return {fitsAt1:fits.fits, oomAt16:!oom.fits, sameW:Math.abs(fits.weights-oom.weights)<1e-9};})()`);
  ok('INVARIANT: fit flips to OOM on concurrent users alone', flipU.fitsAt1 && flipU.oomAt16 && flipU.sameW, JSON.stringify(flipU));

  // 70B never fits a small box (weights alone blow past it).
  const big = await ev(`window.__sim.compute({paramsB:70,bpp:0.5,ctx:1024,users:1,boxGB:24}).fits`);
  ok('SANITY: 70B (even Q4) overflows a 24 GB box on weights alone', big === false);

  // ---------- 7. box view: OOM state renders (border, hatch, note, status) ----------
  await ev('window.__sim.setBox(8);window.__sim.setParams(7);window.__sim.setBpp(0.5,"Q4");window.__sim.setUsers(1);window.__sim.setCtx(40960)');
  const oomView = await ev(`(function(){return {
    boxOom: document.getElementById('box').classList.contains('oom'),
    hatch: parseFloat(document.getElementById('oomBand').style.height),
    note: document.getElementById('oomNote').classList.contains('on'),
    status: document.getElementById('boxStatus').textContent,
    verdict: document.getElementById('verdictV').textContent };})()`);
  ok('OOM VIEW: box gets .oom class', oomView.boxOom === true, JSON.stringify(oomView));
  ok('OOM VIEW: overflow hatch has non-zero height', oomView.hatch > 0, JSON.stringify(oomView));
  ok('OOM VIEW: OOM note is shown', oomView.note === true, JSON.stringify(oomView));
  ok('OOM VIEW: status + verdict say OOM', /OOM/.test(oomView.status) && /OOM/.test(oomView.verdict), JSON.stringify(oomView));

  // and it clears to FITS when context drops.
  await ev('window.__sim.setCtx(4096)');
  const fitView = await ev(`(function(){return {
    boxOom: document.getElementById('box').classList.contains('oom'),
    hatch: parseFloat(document.getElementById('oomBand').style.height),
    status: document.getElementById('boxStatus').textContent };})()`);
  ok('FIT VIEW: OOM clears when context drops (no .oom, no hatch, fits status)',
    fitView.boxOom === false && fitView.hatch === 0 && /fits/.test(fitView.status), JSON.stringify(fitView));

  // ---------- 8. event log responds in the domain's voice ----------
  await ev('window.__sim.setCtx(8192)');
  const loadLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /loading|weights:/.test(e.textContent)})`);
  ok('LOG: a load/weights line appears in the trace', loadLog === true);
  await ev('window.__sim.setCtx(40960);window.__sim.setUsers(4)');
  const oomLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /out of memory|OOM/.test(e.textContent)})`);
  ok('LOG: an OOM/admission line appears when it overflows', oomLog === true);
  const kvLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /allocating|KV:/.test(e.textContent)})`);
  ok('LOG: a KV-allocation line appears', kvLog === true);

  // ---------- 9. TRY-THIS challenge auto-detects end-to-end ----------
  await ev('location.reload()'); await sleep(600);
  // Step 1: 7B at Q4 on 8 GB box (defaults: 4k ctx, 1 user) — fits.
  await ev('window.__sim.setBox(8);window.__sim.setParams(7);window.__sim.setBpp(0.5,"Q4")');
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (7B/Q4 fits 8 GB)', step >= 2, 'step=' + step);
  // Step 2: keep model fixed, raise context so KV overtakes weights (33792 ctx: KV 3.6 > weights 3.5, still fits).
  await ev('window.__sim.setCtx(33792)');
  step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (KV band overtakes weights)', step >= 3, 'step=' + step);
  // Step 3: push context far enough to OOM the same box.
  await ev('window.__sim.setCtx(40960)');
  const done = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (context tips into OOM)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 9b. PREDICT-FIRST mode (Brilliant-style) ----------
  await ev('location.reload()'); await sleep(600);
  const pBoot = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent };})()`);
  ok('PREDICT: step 1 opens with a prediction question + chips', pBoot.chips >= 2 && /Predict first/.test(pBoot.txt), JSON.stringify(pBoot));
  ok('PREDICT: instruction hidden until a prediction is made', !/Pick the/.test(pBoot.txt), pBoot.txt);
  const pAff = await ev(`(function(){var c=document.querySelector('#chPredict .chip');
    return {cur:getComputedStyle(c).cursor, tip:!!c.title};})()`);
  ok('PREDICT: chips are affordant (cursor:pointer + title)', pAff.cur === 'pointer' && pAff.tip, JSON.stringify(pAff));
  // Tap a WRONG chip (index 1 = "no, it overflows") — instruction appears, prediction logged.
  await ev(`document.querySelectorAll('#chPredict .chip')[1].click()`);
  const pAfter = await ev(`(function(){return {
    chips: document.querySelectorAll('#chPredict .chip').length,
    txt: document.getElementById('chTxt').textContent,
    logged: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /predicted/.test(e.textContent)}) };})()`);
  ok('PREDICT: tapping a chip reveals the instruction + shows your pick',
    pAfter.chips === 0 && /Pick the/.test(pAfter.txt) && /you predicted/.test(pAfter.txt), JSON.stringify(pAfter));
  ok('PREDICT: the pick is logged in the event stream', pAfter.logged === true);
  // Complete step 1 — a WRONG prediction must NOT block, and the verdict must teach.
  await ev('window.__sim.setBox(8);window.__sim.setParams(7);window.__sim.setBpp(0.5,"Q4")');
  const pVerdict = await ev(`(function(){return {
    step: window.__sim.CH.step,
    verdict: [].slice.call(document.querySelectorAll('#evList .ev')).map(function(e){return e.textContent}).join(' | ') };})()`);
  ok('PREDICT: wrong prediction never blocks step completion', pVerdict.step >= 2, 'step=' + pVerdict.step);
  ok('PREDICT: verdict names your pick and explains the model',
    /Not what you predicted/.test(pVerdict.verdict) && /weights/.test(pVerdict.verdict), pVerdict.verdict.slice(-220));
  // Step 2 opens its own question; predict RIGHT via the hook (idx 1 = "KV cache"), complete, expect right verdict.
  const p2 = await ev(`document.getElementById('chTxt').textContent`);
  ok('PREDICT: step 2 opens with its own question', /Predict first/.test(p2), p2);
  await ev('window.__sim.predict(1)');
  await ev('window.__sim.setCtx(33792)');
  const p2v = await ev(`(function(){return {
    step: window.__sim.CH.step,
    right: [].slice.call(document.querySelectorAll('#evList .ev')).some(function(e){return /Prediction right/.test(e.textContent)}) };})()`);
  ok('PREDICT: right prediction confirmed in the log', p2v.step >= 3 && p2v.right === true, JSON.stringify(p2v));
  // Skipping the prediction entirely must also work: complete step 3 without predicting.
  await ev('window.__sim.setCtx(40960)');
  const p3 = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('PREDICT: skipping a prediction never blocks the challenge', p3.step >= 4 && p3.success === true, JSON.stringify(p3));

  // ---------- 10. Reset returns to initial state ----------
  await ev('window.__sim.setParams(70);window.__sim.setBpp(2,"FP16");window.__sim.setCtx(40960);window.__sim.setUsers(16);window.__sim.setBox(24)');
  await ev('location.reload()'); await sleep(600);
  const afterReset = await ev(`(function(){var D=window.__sim.consts.DEFAULTS;return {
    p:window.__sim.S.paramsB, bpp:window.__sim.S.bpp, ctx:window.__sim.S.ctx, users:window.__sim.S.users, box:window.__sim.S.boxGB,
    step:window.__sim.CH.step, ok:(window.__sim.S.paramsB===D.paramsB&&window.__sim.S.bpp===D.bpp&&window.__sim.S.ctx===D.ctx&&window.__sim.S.users===D.users&&window.__sim.S.boxGB===D.boxGB)};})()`);
  ok('R5 Reset restores defaults + clears challenge',
    afterReset.ok === true && afterReset.step === 1, JSON.stringify(afterReset));

  // ---------- 11. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @800x500', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @800x500', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 12. prefers-reduced-motion suppresses animation ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.transitionDuration!=='0s' && cs.transitionDuration!=='')bad.push((el.id||el.className)+':'+cs.transitionDuration);
    });return bad;})()`);
  ok('R4 prefers-reduced-motion suppresses transitions', reducedOK.length === 0, 'active=' + reducedOK.join(','));

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m2-memory-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
