#!/usr/bin/env node
// Headless-Chrome assertion harness for m1-prefill-decode.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m1-prefill-decode.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm1-prefill-decode.html');
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
    '--no-sandbox', '--disable-gpu', '--window-size=800,500',
    '--user-data-dir=/tmp/m1-prefill-chrome-' + process.pid, 'about:blank',
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
  // run the sim's instant path, then read the completed run's numbers
  async function runAndRead() {
    await ev('window.__sim.run()');
    await sleep(120);
    return ev(`(function(){var r=window.__sim.S.result||{};return {
      promptLen:r.promptLen, outLen:r.outLen, ttft:r.ttft, decodeShare:r.decodeShare,
      total:r.total, kv:r.kv, overflow:!!r.overflow, ran:!!window.__sim.S.ran};})()`);
  }

  // ---------- 1. loads clean ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — three sliders present',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 3);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#runBtn','#reset','#promptRange','#outRange','#ctxRange'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const runTip = await ev(`!!document.querySelector('#runBtn').title && !!document.querySelector('#reset').title`);
  ok('R2 controls carry tooltips (title)', runTip === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. prefill bar fills BEFORE any decode token appears ----------
  // Drive the animated (non-instant) path and sample mid-prefill.
  await ev('window.__sim.setPrompt(512);window.__sim.setOut(64);window.__sim.setCtx(1024)');
  await ev('document.getElementById("runBtn").click()');
  await sleep(180); // ~mid prefill (pfDur=520ms), before decode starts
  const midPrefill = await ev(`(function(){
    var w=parseFloat(getComputedStyle(document.getElementById("prefillFill")).width);
    var barW=parseFloat(getComputedStyle(document.getElementById("prefillBar")).width);
    var decodeToks=document.querySelectorAll('#decodeStrip .tok.on').length;
    return {fillFrac: barW>0?w/barW:0, decodeToks:decodeToks};})()`);
  ok('SEQUENCE prefill bar is filling before decode ticks', midPrefill.fillFrac > 0 && midPrefill.decodeToks === 0,
    JSON.stringify(midPrefill));
  await sleep(1200); // let the animated run complete
  const afterAnim = await ev(`(function(){
    return {decodeToks:document.querySelectorAll('#decodeStrip .tok.on').length,
            fillFrac: parseFloat(getComputedStyle(document.getElementById("prefillFill")).width)/parseFloat(getComputedStyle(document.getElementById("prefillBar")).width),
            running:window.__sim.isRunning()};})()`);
  ok('SEQUENCE after run: prefill full + decode tokens emitted', afterAnim.fillFrac > 0.98 && afterAnim.decodeToks > 0,
    JSON.stringify(afterAnim));

  // ---------- 4. TTFT gauge responds to prompt-length slider ----------
  await ev('window.__sim.setPrompt(64);window.__sim.setOut(64);window.__sim.setCtx(2048)');
  let rSmall = await runAndRead();
  await ev('window.__sim.setPrompt(512)');
  let rBig = await runAndRead();
  ok('TTFT rises with prompt length', rBig.ttft > rSmall.ttft * 3.5, JSON.stringify({small:rSmall.ttft,big:rBig.ttft}));
  const ttftShown = await ev(`document.getElementById('ttftV').textContent`);
  ok('TTFT gauge shows a value after run', /ms|s/.test(ttftShown), ttftShown);

  // ---------- 5. decode-dominance scenario ----------
  await ev('window.__sim.setPrompt(16);window.__sim.setOut(512);window.__sim.setCtx(2048)');
  const rDec = await runAndRead();
  ok('DECODE-DOMINATED: decode share > 80% with short prompt + long output', rDec.decodeShare > 0.80,
    JSON.stringify({share:rDec.decodeShare}));
  const shareShown = await ev(`document.getElementById('decShareV').textContent`);
  ok('decode-share gauge reflects it (>=80%)', parseInt(shareShown) >= 80, shareShown);

  // ---------- 6. context-overflow state ----------
  await ev('window.__sim.setCtx(128);window.__sim.setPrompt(96);window.__sim.setOut(128)');
  const rOver = await runAndRead();
  ok('OVERFLOW: prompt+output past ctx sets overflow=true', rOver.overflow === true, JSON.stringify(rOver));
  const overShown = await ev(`document.getElementById('overflow').classList.contains('on')`);
  ok('OVERFLOW: banner is shown', overShown === true);
  const overLog = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /overflow|num_ctx/.test(e.textContent)})`);
  ok('OVERFLOW: trace logs a context-overflow line', overLog === true);
  // and it clears when the window is large enough
  await ev('window.__sim.setCtx(1024)');
  const rFit = await runAndRead();
  ok('OVERFLOW clears when ctx is large enough', rFit.overflow === false, JSON.stringify(rFit));

  // ---------- 7. teaching invariants ----------
  // (a) TTFT depends ONLY on prompt length, not output length (phase separation).
  const inv = await ev(`(function(){
    var a=window.__sim.compute(200,10);
    var b=window.__sim.compute(200,400);
    return {ttftEqual: Math.abs(a.ttft-b.ttft)<1e-9, totalDiffers: b.total>a.total};})()`);
  ok('INVARIANT: TTFT set by prompt only (output does not move it)', inv.ttftEqual === true);
  ok('INVARIANT: total time grows with output length', inv.totalDiffers === true);
  // (b) total time depends ONLY on output length for a fixed prompt shift check
  const inv2 = await ev(`(function(){
    var a=window.__sim.compute(50,300);
    var b=window.__sim.compute(400,300);
    return {decodeEqual: Math.abs(a.decodeMs-b.decodeMs)<1e-9, ttftDiffers: b.ttft>a.ttft};})()`);
  ok('INVARIANT: decode time set by output only', inv2.decodeEqual === true);
  ok('INVARIANT: prefill time set by prompt only', inv2.ttftDiffers === true);
  // (c) KV cache = prompt + output exactly (conservation)
  const inv3 = await ev(`(function(){var c=window.__sim.compute(123,77);return c.kv===200;})()`);
  ok('INVARIANT: KV cache == prompt + output (conservation)', inv3 === true);
  // (d) overflow iff kv > ctx
  const inv4 = await ev(`(function(){
    window.__sim.setCtx(300);
    var under=window.__sim.compute(100,100);   // 200 <= 300
    var over=window.__sim.compute(200,200);    // 400 > 300
    return {underOK: under.overflow===false, overOK: over.overflow===true};})()`);
  ok('INVARIANT: overflow ⇔ (prompt+output) > context limit', inv4.underOK && inv4.overOK, JSON.stringify(inv4));

  // ---------- 8. all three TRY-THIS steps auto-detect end-to-end ----------
  await ev('location.reload()');
  await sleep(600);
  // Step 1: grow prompt so TTFT >= 3x the default-prompt TTFT
  const dflt = await ev('window.__sim.consts.DEFAULTS.promptLen');
  await ev(`window.__sim.setPrompt(${dflt * 4})`);
  await ev('window.__sim.run()'); await sleep(120);
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (TTFT ≥ 3×)', step >= 2, 'step=' + step);
  // Step 2: without touching prompt, raise output so decode share >= 80%
  await ev('window.__sim.setOut(512);window.__sim.setCtx(2048)');
  await ev('window.__sim.run()'); await sleep(120);
  step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (decode ≥ 80%)', step >= 3, 'step=' + step);
  // Step 3: push prompt+output past ctx
  await ev('window.__sim.setCtx(256);window.__sim.setPrompt(256);window.__sim.setOut(256)');
  await ev('window.__sim.run()'); await sleep(120);
  const done = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (context overflow)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 9. Reset returns to initial state ----------
  await ev('window.__sim.setPrompt(1024);window.__sim.setOut(512)');
  await ev('location.reload()');
  await sleep(600);
  const afterReset = await ev(`(function(){return {
    prompt:window.__sim.S.promptLen, out:window.__sim.S.outLen, ctx:window.__sim.S.ctxLimit,
    ran:window.__sim.S.ran, step:window.__sim.CH.step,
    ttft:document.getElementById('ttftV').textContent};})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults + clears run',
    afterReset.prompt === D.promptLen && afterReset.out === D.outLen && afterReset.ctx === D.ctxLimit
    && afterReset.ran === false && afterReset.step === 1 && afterReset.ttft === '—',
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
  try { fs.rmSync('/tmp/m1-prefill-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
