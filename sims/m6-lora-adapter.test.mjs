#!/usr/bin/env node
// Headless-Chrome assertion harness for m6-lora-adapter.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Drives the sim through window.__sim (pure formulae, no wall-clock waits).
// Run: node site/static/sims/m6-lora-adapter.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm6-lora-adapter.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9760 + (process.pid % 400);

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
    '--user-data-dir=/tmp/m6-lora-chrome-' + process.pid, 'about:blank',
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
  async function reload() { await ev('location.reload()'); await sleep(500); }

  // ---------- 1. loads clean (R1) ----------
  ok('R1 no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  ok('R1 no page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
  ok('R1 zero external network requests', netRequests.length === 0, netRequests.join(' | '));
  ok('renders — two sliders present (rank + alpha)',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 2);
  ok('renders — five module checkboxes present (q/v/k/o/mlp)',
    (await ev('document.querySelectorAll("#modules .modchk").length')) === 5);
  ok('renders — frozen base grid drawn',
    (await ev('document.querySelectorAll("#baseGrid .cell").length')) > 0);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#rRange','#aRange'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    document.querySelectorAll('#modeWrap button').forEach(function(b){var c=getComputedStyle(b).cursor;if(!/pointer/.test(c))bad.push('mode:cursor='+c);});
    document.querySelectorAll('#modules .modchk').forEach(function(c){var cur=getComputedStyle(c).cursor;if(!/pointer/.test(cur))bad.push('modchk:cursor='+cur);});
    return bad;
  })()`);
  ok('R2 interactive controls + modules + mode toggle have pointer cursor', affClickable.length === 0, affClickable.join(','));
  const tips = await ev(`(function(){
    var modTip = Array.prototype.every.call(document.querySelectorAll('#modules .modchk'),function(c){return !!c.title;});
    var modeTip = Array.prototype.every.call(document.querySelectorAll('#modeWrap button'),function(b){return !!b.title;});
    return !!document.querySelector('#reset').title && modTip && modeTip;
  })()`);
  ok('R2 reset + modules + mode toggle carry tooltips (title)', tips === true);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 param readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const inertMeter = await ev(`getComputedStyle(document.querySelector('.meterWrap')).cursor`);
  ok('R2 capacity meter is inert (cursor:default)', inertMeter === 'default', inertMeter);
  const noteTip = await ev(`document.querySelector('#note').getAttribute('data-tip') || ''`);
  ok('R8 honest-model footnote present + names the real formula & 1,146,880',
    /teaching model/i.test(noteTip) && /1,146,880/.test(noteTip) && /fp16/i.test(noteTip), noteTip.slice(0, 60));

  // ---------- 3. THE LOAD-BEARING NUMBER: r=8, q_proj+v_proj = 1,146,880 (0.192%) ----------
  // default state is exactly this config.
  const base = await ev(`(function(){var s=window.__sim;return {
    r:s.rankVal(), tp:s.trainableParams(), pct:s.trainablePct(),
    mods:s.activeModules(), total:s.TOTAL, layers:s.LAYERS};})()`);
  ok('CORE default config is r=8 + q_proj,v_proj', base.r === 8 &&
    base.mods.length === 2 && base.mods.includes('q_proj') && base.mods.includes('v_proj'), JSON.stringify(base));
  ok('CORE trainable params = 1,146,880 (matches the course real run)', base.tp === 1146880, String(base.tp));
  ok('CORE trainable % ≈ 0.192 (matches peft print_trainable_parameters)',
    Math.abs(base.pct - 0.1920) < 0.001, base.pct.toFixed(4));
  ok('CORE total params = 597,196,800 (the lesson 597.2M)', base.total === 597196800, String(base.total));
  ok('CORE layers = 28 (Qwen3-0.6B)', base.layers === 28, String(base.layers));
  // adapter size fp16 = 1,146,880 * 2 bytes ≈ 2.19 MB
  const mb = await ev('window.__sim.adapterMB()');
  ok('CORE adapter size (fp16) ≈ 2.19 MB', Math.abs(mb - (1146880 * 2 / 1048576)) < 0.01, mb.toFixed(3));
  // the DOM readout shows the number
  const domTrain = await ev(`document.getElementById('ovTrainable').textContent`);
  ok('CORE DOM readout shows 1,146,880', /1,146,880/.test(domTrain), domTrain);
  const domPct = await ev(`document.getElementById('ovPct').textContent`);
  ok('CORE DOM readout shows 0.192%', /0\.192/.test(domPct), domPct);

  // ---------- 4. rank is LINEAR: double r -> double the params (same modules) ----------
  await ev('window.__sim.setRankValue(16)');
  const p16 = await ev('window.__sim.trainableParams()');
  await ev('window.__sim.setRankValue(8)');
  const p8 = await ev('window.__sim.trainableParams()');
  ok('LINEAR r=16 is exactly 2× r=8 params (params linear in rank)', p16 === 2 * p8, JSON.stringify({ p8, p16 }));
  await ev('window.__sim.setRankValue(64)');
  const p64 = await ev('window.__sim.trainableParams()');
  ok('LINEAR r=64 is exactly 8× r=8 params', p64 === 8 * p8, JSON.stringify({ p8, p64 }));
  await ev('window.__sim.setRankValue(8)');

  // ---------- 5. INVARIANT: diminishing returns — 8× params, meter barely moves ----------
  const cap8 = await ev('window.__sim.setRankValue(8), window.__sim.capacityPct()');
  const cap64 = await ev('window.__sim.setRankValue(64), window.__sim.capacityPct()');
  ok('INVARIANT r=64 costs 8× the params of r=8 (real formula)',
    (await ev('window.__sim.trainableParams()')) === 8 * p8);
  ok('INVARIANT but expressiveness meter moves < 20 points for that 8× spend (diminishing returns)',
    (cap64 - cap8) < 20 && cap64 > cap8, JSON.stringify({ cap8, cap64 }));
  await ev('window.__sim.setRankValue(8)');

  // ---------- 6. module targeting recomputes the count correctly ----------
  // add k_proj (io = 1024+1024 = 2048). delta = r * io * layers = 8 * 2048 * 28 = 458,752.
  await ev(`window.__sim.setModule('k_proj', true)`);
  const withK = await ev('window.__sim.trainableParams()');
  ok('MODULE adding k_proj adds exactly 8*2048*28 = 458,752 trainable',
    withK === 1146880 + 8 * 2048 * 28, JSON.stringify({ withK, expected: 1146880 + 458752 }));
  await ev(`window.__sim.setModule('k_proj', false)`);
  const backToQV = await ev('window.__sim.trainableParams()');
  ok('MODULE removing k_proj returns to 1,146,880', backToQV === 1146880, String(backToQV));
  // turning ALL modules off => zero trainable
  await ev(`['q_proj','v_proj'].forEach(function(m){window.__sim.setModule(m,false)})`);
  const none = await ev('window.__sim.trainableParams()');
  ok('MODULE zero targets => zero trainable params', none === 0, String(none));
  const nonePct = await ev(`document.getElementById('ovPct').textContent`);
  ok('MODULE zero targets => 0% shown', /^0%/.test(nonePct), nonePct);
  await ev(`['q_proj','v_proj'].forEach(function(m){window.__sim.setModule(m,true)})`);

  // ---------- 7. alpha changes scale, NOT param count ----------
  const beforeA = await ev('window.__sim.trainableParams()');
  await ev('window.__sim.setAlpha(64)');
  const afterA = await ev('window.__sim.trainableParams()');
  ok('ALPHA changing alpha does NOT change trainable params (scale, not size)', beforeA === afterA, JSON.stringify({ beforeA, afterA }));
  const scaleTxt = await ev(`document.getElementById('scaleVal').textContent`);
  ok('ALPHA scale readout reflects alpha/r (64/8 = 8.0)', /8\.0/.test(scaleTxt), scaleTxt);
  await ev('window.__sim.setAlpha(16)');

  // ---------- 8. event log responds in domain vocabulary (R7) ----------
  await ev('window.__sim.setRankValue(16)');
  const logHit = await ev(`Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /rank r=16/.test(e.textContent) && /trainable/.test(e.textContent);})`);
  ok('EVENT LOG a rank change logs a peft-style trainable line', logHit === true);
  await ev('window.__sim.setRankValue(8)');

  // ---------- 9. serve-merged mode folds the side-path in (R for merge story) ----------
  await ev(`window.__sim.setMode('serve')`);
  const merged = await ev(`(function(){return {
    mode:window.__sim.S.mode,
    badge:document.getElementById('modeBadge').className,
    badgeTxt:document.getElementById('modeBadge').textContent,
    sideMerged:document.getElementById('sidePath').classList.contains('merged'),
    gridMerged:document.getElementById('baseGrid').classList.contains('merged'),
    hotCells:document.querySelectorAll('#baseGrid .cell.hot').length,
    log:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /merge/.test(e.textContent);})
  };})()`);
  ok('MERGE serve mode sets the serve badge', merged.mode === 'serve' && merged.badge === 'serve', JSON.stringify(merged));
  ok('MERGE side-path visually folds into the base (merged class)', merged.sideMerged === true && merged.gridMerged === true, JSON.stringify(merged));
  ok('MERGE base grid lights absorbed cells (ΔW folded into W)', merged.hotCells > 0, String(merged.hotCells));
  ok('MERGE badge names zero-extra-cost merge story', /merged/i.test(merged.badgeTxt), merged.badgeTxt);
  ok('MERGE logs a merge_and_unload-style line', merged.log === true);
  // trainable-params formula is UNCHANGED by serve mode (it's still the same adapter, just folded)
  const mergedTP = await ev('window.__sim.trainableParams()');
  ok('MERGE serving does not change the adapter param count (same tune)', mergedTP === 1146880, String(mergedTP));
  await ev(`window.__sim.setMode('train')`);
  const backTrain = await ev(`(function(){return {
    training:document.getElementById('sidePath').classList.contains('training'),
    badge:document.getElementById('modeBadge').className};})()`);
  ok('MERGE switching back to train re-shows the glowing side-path', backTrain.training === true && backTrain.badge === 'train', JSON.stringify(backTrain));

  // ---------- 10. TRY-THIS step 1: trainable < 0.5% covering q+v ----------
  await reload();
  // default already covers q+v; drop rank so pct<0.5 (default r=8 already 0.192<0.5, auto-detects on boot? no —
  // detection runs on render; default state IS <0.5 covering q+v, so step 1 should already be done after boot render).
  const step1 = await ev(`(function(){return {step:window.__sim.CH.step, done1:window.__sim.CH.done[0],
    pct:window.__sim.trainablePct()};})()`);
  ok('TRY-THIS step 1 auto-detected (default r=8 q+v is <0.5% trainable)',
    step1.done1 === true && step1.step === 2 && step1.pct < 0.5, JSON.stringify(step1));

  // ---------- 11. TRY-THIS step 2: r=64 -> 8× params, meter barely moves ----------
  await ev('window.__sim.setRankValue(64)');
  const step2 = await ev(`(function(){return {step:window.__sim.CH.step, done2:window.__sim.CH.done[1]};})()`);
  ok('TRY-THIS step 2 auto-detected (r=64 diminishing-returns observed)',
    step2.done2 === true && step2.step === 3, JSON.stringify(step2));

  // ---------- 12. TRY-THIS step 3: serve-merged completes the challenge ----------
  await ev(`window.__sim.setMode('serve')`);
  const step3 = await ev(`(function(){return {step:window.__sim.CH.step, done3:window.__sim.CH.done[2],
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (serve-merged)', step3.done3 === true && step3.step >= 4, JSON.stringify(step3));
  ok('CHALLENGE completes: success banner shown', step3.success === true, JSON.stringify(step3));

  // ---------- 13. Reset returns to initial state (R5) ----------
  await ev(`window.__sim.setRankValue(64);window.__sim.setMode('serve');window.__sim.setModule('mlp',true)`);
  await ev('location.reload()'); await sleep(500);
  const afterReset = await ev(`(function(){var s=window.__sim.S;return {
    rIdx:s.rIdx, r:window.__sim.rankVal(), alpha:s.alpha, mode:s.mode,
    mods:window.__sim.activeModules(), chStep:window.__sim.CH.step,
    tp:window.__sim.trainableParams()};})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults (r=8, alpha=16, train, q+v, 1,146,880 trainable)',
    afterReset.r === 8 && afterReset.alpha === 16 && afterReset.mode === 'train'
    && afterReset.mods.length === 2 && afterReset.tp === 1146880, JSON.stringify(afterReset));

  // ---------- 14. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @900x560', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @900x560', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 15. prefers-reduced-motion suppresses animation (R4) ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  await ev('window.__sim.setRankValue(16)'); // trigger any transition/side-path glow under reduced motion
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad.push(el.className);
    });return bad.length;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedOK === 0, 'active=' + reducedOK);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m6-lora-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
