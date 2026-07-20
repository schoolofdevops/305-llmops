#!/usr/bin/env node
// Headless-Chrome assertion harness for m8-kv-capacity.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Run: node site/static/sims/m8-kv-capacity.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm8-kv-capacity.html');
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
    '--user-data-dir=/tmp/m8-kv-chrome-' + process.pid, 'about:blank',
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
  ok('renders — two sliders + budget slider present',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 3);
  ok('renders — model + quant segmented selectors present',
    (await ev('document.querySelectorAll("#modelSeg button").length')) === 4 &&
    (await ev('document.querySelectorAll("#quantSeg button").length')) === 3);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#budgetRange','#ctxRange','#usersRange','#modelSeg button','#quantSeg button'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    return bad;
  })()`);
  ok('R2 interactive controls have pointer/help cursor', affClickable.length === 0, affClickable.join(','));
  const ctlTips = await ev(`(function(){
    var bad=[];
    document.querySelectorAll('#controls .ctl').forEach(function(c){if(!c.title)bad.push('ctl-no-title');});
    if(!document.querySelector('#reset').title)bad.push('reset');
    return bad;})()`);
  ok('R2 controls carry tooltips (title)', ctlTips.length === 0, ctlTips.join(','));
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 readout panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const inertScale = await ev(`getComputedStyle(document.querySelector('#scale')).cursor`);
  ok('R2 legend/scale is inert (cursor:default)', inertScale === 'default', inertScale);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present', noteTip === true);

  // ---------- 3. FORMULA spot-check: the course-table number ----------
  // 0.6B @ 2048 ctx × 1 user KV must equal 112 KiB × 2048 = 224 MiB exactly.
  const kvCheck = await ev(`(function(){
    var r=window.__sim.compute({model:0,quant:1,ctx:2048,users:1,budgetIdx:1});
    var MiB=window.__sim.consts.MiB;
    return {kvMiB:r.kv/MiB, over:r.over};})()`);
  ok('FORMULA 0.6B@2048×1user KV == 224 MiB (course table)',
    Math.abs(kvCheck.kvMiB - 224) < 0.01, JSON.stringify(kvCheck));
  ok('FORMULA course node fits (0.6B@2048×1user on 8 GB not OOM)', kvCheck.over === false);
  // per-token KV is exactly 112 KiB for the course model
  const perTok = await ev(`window.__sim.consts.MODELS[0].kvPerTok / window.__sim.consts.KiB`);
  ok('FORMULA per-token KV == 112 KiB (2×28×8×128×2 bytes)', perTok === 112, 'perTok=' + perTok);
  // KV is linear in ctx and in users (conservation of the KV term)
  const linear = await ev(`(function(){
    var a=window.__sim.compute({model:0,quant:1,ctx:2048,users:1});
    var b=window.__sim.compute({model:0,quant:1,ctx:4096,users:1});
    var c=window.__sim.compute({model:0,quant:1,ctx:2048,users:2});
    return {ctxDouble: Math.abs(b.kv-2*a.kv)<1, usersDouble: Math.abs(c.kv-2*a.kv)<1};})()`);
  ok('FORMULA KV scales linearly with context', linear.ctxDouble === true);
  ok('FORMULA KV scales linearly with concurrency', linear.usersDouble === true);
  // total is exactly weights+runtime+KV (three-term sum)
  const sum = await ev(`(function(){
    var r=window.__sim.compute({model:0,quant:1,ctx:2048,users:4});
    return Math.abs(r.total-(r.weights+r.runtime+r.kv))<1;})()`);
  ok('FORMULA total == weights + runtime + KV (three-term sum)', sum === true);
  // weights band moves with quant only (Q4 < Q8 < FP16), KV unchanged
  const quantMove = await ev(`(function(){
    var q4=window.__sim.compute({model:0,quant:0,ctx:2048,users:1});
    var q8=window.__sim.compute({model:0,quant:1,ctx:2048,users:1});
    var f16=window.__sim.compute({model:0,quant:2,ctx:2048,users:1});
    return {order: q4.weights<q8.weights && q8.weights<f16.weights,
            kvSame: q4.kv===q8.kv && q8.kv===f16.kv};})()`);
  ok('FORMULA quant moves weights band only (Q4<Q8<FP16, KV fixed)',
    quantMove.order && quantMove.kvSame, JSON.stringify(quantMove));

  // ---------- 4. readout shows the live numbers ----------
  await ev('window.__sim.setModel(0);window.__sim.setQuant(1);window.__sim.setCtx(2048);window.__sim.setUsers(1);window.__sim.setBudgetIdx(1)');
  const kvShown = await ev(`document.getElementById('kvV').textContent`);
  ok('readout KV cell shows 224 MB for the course node', /224\s*MB/.test(kvShown), kvShown);

  // ---------- 5. OOM state fires when the box is blown ----------
  // One 40960-ctx user (~4.4 GB KV + weights + runtime ≈ 5.4 GB) blows the 4 GB node.
  await ev('window.__sim.setModel(0);window.__sim.setQuant(1);window.__sim.setBudgetIdx(0);window.__sim.setUsers(1);window.__sim.setCtx(40960)');
  await sleep(400); // let the band height transition settle before measuring
  const oom = await ev(`(function(){return {
    over: window.__sim.isOver(),
    boxOOM: document.getElementById('box').classList.contains('oom'),
    pill: document.getElementById('statusPill').textContent,
    overBand: parseFloat(getComputedStyle(document.getElementById('bOver')).height)>0,
    log: Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /OOMKilled/.test(e.textContent)})
  };})()`);
  ok('OOM: single 40960-ctx user blows the 8 GB box (over=true)', oom.over === true, JSON.stringify(oom));
  ok('OOM: box turns red (box.oom class)', oom.boxOOM === true);
  ok('OOM: status pill reads OOMKilled', oom.pill === 'OOMKilled', oom.pill);
  ok('OOM: overflow band is rendered', oom.overBand === true);
  ok('OOM: kubelet log fires a pod OOMKilled line', oom.log === true);
  // and it clears when the box fits again
  await ev('window.__sim.setCtx(2048)');
  const recover = await ev(`(function(){return {over:window.__sim.isOver(),
    pill:document.getElementById('statusPill').textContent};})()`);
  ok('OOM clears when KV shrinks back (Running again)', recover.over === false && recover.pill === 'Running',
    JSON.stringify(recover));

  // ---------- 6. max-users readout matches the budget math ----------
  const maxU = await ev(`(function(){
    var r=window.__sim.compute({model:0,quant:1,ctx:2048,users:1,budgetIdx:1});
    // adding one more than maxUsers must overflow; maxUsers itself must fit
    var atMax=window.__sim.compute({model:0,quant:1,ctx:2048,users:r.maxUsers,budgetIdx:1});
    var overMax=window.__sim.compute({model:0,quant:1,ctx:2048,users:r.maxUsers+1,budgetIdx:1});
    return {maxUsers:r.maxUsers, atMaxFits:!atMax.over, oneMoreOver:overMax.over};})()`);
  ok('MAX-USERS: computed ceiling fits, one more overflows (0.6B@2048 on 8 GB)',
    maxU.atMaxFits === true && maxU.oneMoreOver === true && maxU.maxUsers > 1, JSON.stringify(maxU));

  // ---------- 7. TEACHING INVARIANT: trade context for users holds the box ----------
  // Halving ctx and doubling users leaves the KV term identical -> same total.
  const trade = await ev(`(function(){
    var a=window.__sim.compute({model:0,quant:1,ctx:8192,users:4});
    var b=window.__sim.compute({model:0,quant:1,ctx:4096,users:8});
    return {kvEqual: Math.abs(a.kv-b.kv)<1, totalEqual: Math.abs(a.total-b.total)<1};})()`);
  ok('INVARIANT: halve ctx + double users == same KV (context traded for concurrency)',
    trade.kvEqual === true && trade.totalEqual === true, JSON.stringify(trade));
  // and a bigger model raises BOTH weights and per-user KV
  const bigger = await ev(`(function(){
    var s=window.__sim.compute({model:0,quant:1,ctx:2048,users:1});
    var b=window.__sim.compute({model:3,quant:1,ctx:2048,users:1});
    return {weightsUp:b.weights>s.weights, kvUp:b.kv>s.kv};})()`);
  ok('INVARIANT: bigger model raises both weights and per-token KV', bigger.weightsUp && bigger.kvUp);

  // ---------- 8. all three TRY-THIS steps auto-detect end-to-end ----------
  await ev('location.reload()');
  await sleep(600);
  // Step 1: on the course node, drive users up to the ceiling (max users, still fits)
  await ev(`(function(){
    var r=window.__sim.compute({model:0,quant:1,ctx:2048,users:1,budgetIdx:1});
    window.__sim.setUsers(r.maxUsers);
  })()`);
  await sleep(60);
  let step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 1 auto-detected (max users on the course node)', step >= 2, 'step=' + step);
  // Step 2: back to 1 user, ctx to max, drop to the 4 GB node -> OOM
  await ev('window.__sim.setUsers(1);window.__sim.setCtx(40960);window.__sim.setBudgetIdx(0)');
  await sleep(60);
  step = await ev('window.__sim.CH.step');
  ok('TRY-THIS step 2 auto-detected (40960 ctx OOMs the 4 GB box)', step >= 3, 'step=' + step);
  // Step 3: trade context for users from the step-2 anchor (40960 × 1). Halve ctx,
  // double users, and land inside the box. From 40960@1 the anchor is stored; go to a
  // fitting point that is <= anchor/2 ctx AND >= anchor*2 users. Use 2048 ctx × 2 users.
  await ev('window.__sim.setCtx(2048);window.__sim.setUsers(2)');
  await sleep(60);
  const done = await ev(`(function(){return {step:window.__sim.CH.step,
    success:document.getElementById('challenge').classList.contains('success')};})()`);
  ok('TRY-THIS step 3 auto-detected (trade context for users)', done.step >= 4, JSON.stringify(done));
  ok('CHALLENGE completes: success banner shown', done.success === true, JSON.stringify(done));

  // ---------- 9. Reset returns to initial state ----------
  await ev('window.__sim.setCtx(40960);window.__sim.setUsers(32);window.__sim.setModel(3)');
  await ev('location.reload()');
  await sleep(600);
  const afterReset = await ev(`(function(){var D=window.__sim.consts.DEFAULTS;return {
    ok: window.__sim.S.budgetIdx===D.budgetIdx && window.__sim.S.model===D.model &&
        window.__sim.S.quant===D.quant && window.__sim.S.ctx===D.ctx && window.__sim.S.users===D.users,
    step: window.__sim.CH.step, over: window.__sim.isOver(),
    kv: document.getElementById('kvV').textContent};})()`);
  ok('R5 Reset restores the course-node defaults + clears challenge',
    afterReset.ok === true && afterReset.step === 1 && afterReset.over === false && /224\s*MB/.test(afterReset.kv),
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
  try { fs.rmSync('/tmp/m8-kv-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
