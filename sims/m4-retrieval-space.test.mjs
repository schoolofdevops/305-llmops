#!/usr/bin/env node
// Headless-Chrome assertion harness for m4-retrieval-space.html
// Zero runtime deps: hand-rolled CDP client over Node built-ins (http + ws frames).
// Chrome 150+: uses PUT /json/new?<url> and launch flag --remote-allow-origins=*.
// Drives the sim through window.__sim (pure retrieve, no wall-clock waits).
// Run: node site/static/sims/m4-retrieval-space.test.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, 'm4-retrieval-space.html');
const FILE_URL = pathToFileURL(HTML).href;
const PORT = 9740 + (process.pid % 400);

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
    '--user-data-dir=/tmp/m4-retrieval-chrome-' + process.pid, 'about:blank',
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
  ok('renders — two sliders present (k + chunk size)',
    (await ev('document.querySelectorAll("#controls input[type=range]").length')) === 2);
  ok('renders — query chips present',
    (await ev('document.querySelectorAll("#queryChips .chip").length')) >= 7);
  ok('renders — 20 chunk dots plotted at default chunk size',
    (await ev('window.__sim.dotsFor(0).length')) === 20);
  ok('test hook exposed', (await ev('typeof window.__sim')) === 'object');

  // ---------- 2. affordance sanity (R2) ----------
  const affClickable = await ev(`(function(){
    var sel=['#reset','#kRange','#csRange'];
    var bad=[];
    sel.forEach(function(s){var e=document.querySelector(s);if(!e){bad.push(s+':missing');return;}
      var cs=getComputedStyle(e);
      if(!/pointer|help/.test(cs.cursor))bad.push(s+':cursor='+cs.cursor);
    });
    // chips are clickable
    var chips=document.querySelectorAll('#queryChips .chip');
    chips.forEach(function(c){var cur=getComputedStyle(c).cursor;if(!/pointer/.test(cur))bad.push('chip:cursor='+cur);});
    return bad;
  })()`);
  ok('R2 interactive controls + chips have pointer cursor', affClickable.length === 0, affClickable.join(','));
  const tips = await ev(`(function(){
    var chipTip = Array.prototype.every.call(document.querySelectorAll('#queryChips .chip'),function(c){return !!c.title;});
    return !!document.querySelector('#reset').title && chipTip;
  })()`);
  ok('R2 reset + chips carry tooltips (title)', tips === true);
  // dots are cursor:help (tooltip-only affordance)
  const dotCursor = await ev(`(function(){var d=document.querySelector('#plot .dot');return d?getComputedStyle(d).cursor:'none';})()`);
  ok('R2 chunk dots are cursor:help (hover-to-inspect)', dotCursor === 'help', dotCursor);
  const inertLog = await ev(`getComputedStyle(document.querySelector('#evList')).cursor`);
  ok('R2 event log is inert (cursor:default)', inertLog === 'default', inertLog);
  const inertReadout = await ev(`getComputedStyle(document.querySelector('#readout')).cursor`);
  ok('R2 ranked-results panel is inert (cursor:default)', inertReadout === 'default', inertReadout);
  const noteTip = await ev(`!!document.querySelector('#note').getAttribute('data-tip')`);
  ok('R8 honest-model footnote present (768-D disclosure)',
    noteTip === true && /768/.test(await ev(`document.querySelector('#note').getAttribute('data-tip')`)));

  // ---------- 3. a query retrieves + logs (R7) ----------
  await ev(`window.__sim.pick('q-5xx')`);
  const afterPick = await ev(`(function(){
    var rows=document.querySelectorAll('#ranked .rrow').length;
    var q=!!document.querySelector('#plot .qdot');
    var lines=document.querySelectorAll('#links line').length;
    var log=Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /retrieve/.test(e.textContent);});
    return {rows:rows, qdot:q, lines:lines, log:log};})()`);
  ok('RETRIEVE renders k ranked rows', afterPick.rows === 3, JSON.stringify(afterPick));
  ok('RETRIEVE places a query dot in the plot', afterPick.qdot === true);
  ok('RETRIEVE draws a distance line per hit', afterPick.lines === 3, JSON.stringify(afterPick));
  ok('EVENT LOG logs a retrieve line (domain vocabulary)', afterPick.log === true);
  // the 500-errors query lands in the networking cluster (payments-5xx diagnosis is there)
  const top1_5xx = await ev(`window.__sim.top1().dot.c`);
  ok('RETRIEVE 500-errors query top-1 is in networking cluster (semantic hit)', top1_5xx === 'net', top1_5xx);

  // ---------- 4. k slider changes the highlighted count ----------
  await ev('window.__sim.setK(1)');
  const k1 = await ev(`(function(){return {rows:document.querySelectorAll('#ranked .rrow').length,
    hits:document.querySelectorAll('#plot .dot.hit').length, lines:document.querySelectorAll('#links line').length};})()`);
  ok('K=1 highlights exactly one chunk', k1.rows === 1 && k1.hits === 1 && k1.lines === 1, JSON.stringify(k1));
  await ev('window.__sim.setK(5)');
  const k5 = await ev(`(function(){return {rows:document.querySelectorAll('#ranked .rrow').length,
    hits:document.querySelectorAll('#plot .dot.hit').length, lines:document.querySelectorAll('#links line').length};})()`);
  ok('K=5 highlights exactly five chunks', k5.rows === 5 && k5.hits === 5 && k5.lines === 5, JSON.stringify(k5));
  await ev('window.__sim.setK(3)');

  // ---------- 5. off-topic query fires the no-close-match warning ----------
  await ev(`window.__sim.pick('q-bread')`);
  const off = await ev(`(function(){return {
    warnOn:document.getElementById('warnBox').classList.contains('on'),
    warnTxt:document.getElementById('warnBox').textContent,
    allFar:window.__sim.allFar(),
    top1cd:window.__sim.top1().cd,
    log:Array.from(document.querySelectorAll('#evList .ev')).some(function(e){return /NO CLOSE MATCH/.test(e.textContent);})
  };})()`);
  ok('OFF-TOPIC query fires no-close-match warning', off.warnOn === true && off.allFar === true, JSON.stringify(off));
  ok('OFF-TOPIC best distance is large (>=0.85)', off.top1cd >= 0.85, JSON.stringify(off));
  ok('OFF-TOPIC warning text names the bad-retrieval smell', /no close match/i.test(off.warnTxt));
  ok('OFF-TOPIC logs a NO CLOSE MATCH trace line', off.log === true);
  // and an ON-topic query does NOT warn
  await ev(`window.__sim.pick('q-failover')`);
  const onOk = await ev(`document.getElementById('warnBox').classList.contains('on')`);
  ok('ON-TOPIC query does NOT warn (warning is specific to far retrieval)', onOk === false);

  // ---------- 6. chunk-size regroups the dots (precision vs context) ----------
  const nFine = await ev('window.__sim.dotsFor(0).length');
  const nMed  = await ev('window.__sim.dotsFor(1).length');
  const nCoarse = await ev('window.__sim.dotsFor(2).length');
  ok('CHUNK SIZE fine(100) yields the most dots', nFine === 20, String(nFine));
  ok('CHUNK SIZE medium(300) merges into fewer dots', nMed < nFine && nMed > nCoarse, JSON.stringify({nFine,nMed,nCoarse}));
  ok('CHUNK SIZE coarse(800) yields the fewest (blobs)', nCoarse < nMed, JSON.stringify({nMed,nCoarse}));
  // the DOM plot reflects the regroup when the slider moves
  await ev('window.__sim.setCs(0)');
  const domFine = await ev(`document.querySelectorAll('#plot .dot').length`);
  await ev('window.__sim.setCs(2)');
  const domCoarse = await ev(`document.querySelectorAll('#plot .dot').length`);
  ok('CHUNK SIZE slider actually regroups the plotted dots', domFine === 20 && domCoarse < domFine,
    JSON.stringify({domFine, domCoarse}));
  // INVARIANT: chunk merges are conservative — every base chunk belongs to exactly one blob at each grain
  const conserve = await ev(`(function(){
    function chk(cs){var seen={};var d=window.__sim.dotsFor(cs);var total=0;
      d.forEach(function(b){b.members.forEach(function(m){if(seen[m])return 'dup';seen[m]=1;total++;});});
      return total;}
    return {fine:chk(0),med:chk(1),coarse:chk(2)};})()`);
  ok('INVARIANT chunk conservation: all 20 base chunks present at every grain (no loss/dup)',
    conserve.fine === 20 && conserve.med === 20 && conserve.coarse === 20, JSON.stringify(conserve));

  // ---------- 7. coarse blob blurs two distinct topics (the 800-tok teaching point) ----------
  const blobMix = await ev(`(function(){
    var d=window.__sim.dotsFor(2);
    var mixed=d.filter(function(b){return b.mixed;});
    return {count:mixed.length, ids:mixed.map(function(b){return b.id;}),
      clusters:mixed.map(function(b){return b.clusters;})};})()`);
  ok('COARSE(800) produces a mixed blob spanning >1 cluster (topic-blur)',
    blobMix.count >= 1 && blobMix.clusters[0] && blobMix.clusters[0].length >= 2, JSON.stringify(blobMix));
  // and at fine grain, NO dot is mixed (distinct topics stay separate)
  const fineMixed = await ev(`window.__sim.dotsFor(0).filter(function(b){return b.mixed;}).length`);
  ok('INVARIANT fine(100) has zero mixed blobs (topics stay distinct)', fineMixed === 0, String(fineMixed));

  // ---------- 8. TRY-THIS step 1: wrong-cluster query, fixed by rephrase ----------
  await reload();
  // the wrong-cluster query at k=1 lands in the WRONG (non-deploy) cluster
  await ev('window.__sim.setK(1)');
  await ev(`window.__sim.pick('q-connrefused')`);
  const wrong = await ev(`(function(){var t=window.__sim.top1();return {c:t.dot.c, id:t.dot.id};})()`);
  ok('TRY-THIS-1 wrong-cluster query top-1 is NOT in the deploy cluster at k=1',
    wrong.c !== 'dep', JSON.stringify(wrong));
  // picking it revealed the rephrase chip
  const rephraseShown = await ev(`!!document.querySelector('[data-q="q-connrefused-fix"]')`);
  ok('TRY-THIS-1 picking wrong query reveals the rephrase chip', rephraseShown === true);
  // the rephrase lands in deploy and completes step 1
  await ev(`window.__sim.pick('q-connrefused-fix')`);
  const fixed = await ev(`(function(){return {c:window.__sim.top1().dot.c, step:window.__sim.CH.step,
    done1:window.__sim.CH.done[0]};})()`);
  ok('TRY-THIS-1 rephrase top-1 lands in the deploy cluster', fixed.c === 'dep', JSON.stringify(fixed));
  ok('TRY-THIS step 1 auto-detected', fixed.done1 === true && fixed.step === 2, JSON.stringify(fixed));

  // ---------- 9. TRY-THIS step 2: off-topic warning advances the challenge ----------
  await ev(`window.__sim.pick('q-bread')`);
  const step2 = await ev(`(function(){return {step:window.__sim.CH.step, done2:window.__sim.CH.done[1],
    warn:document.getElementById('warnBox').classList.contains('on')};})()`);
  ok('TRY-THIS step 2 auto-detected (off-topic warning)', step2.done2 === true && step2.step === 3, JSON.stringify(step2));

  // ---------- 10. TRY-THIS step 3: chunk 800 puts a mixed blob in the top-k ----------
  await ev('window.__sim.setCs(2)');       // coarse
  await ev('window.__sim.setK(5)');        // widen so the blob is surely in top-k
  // pick a query whose neighbourhood includes the merged infra blob
  await ev(`window.__sim.pick('q-5xx')`);
  const step3 = await ev(`(function(){
    var r=window.__sim.retrieve();
    var blur=r.topk.filter(function(t){return t.dot.mixed;});
    return {step:window.__sim.CH.step, done3:window.__sim.CH.done[2],
      success:document.getElementById('challenge').classList.contains('success'),
      blurInTopK:blur.length};})()`);
  ok('TRY-THIS step 3: coarse retrieval surfaces a mixed blob in top-k', step3.blurInTopK >= 1, JSON.stringify(step3));
  ok('TRY-THIS step 3 auto-detected', step3.done3 === true && step3.step >= 4, JSON.stringify(step3));
  ok('CHALLENGE completes: success banner shown', step3.success === true, JSON.stringify(step3));

  // ---------- 11. Reset returns to initial state (R5) ----------
  await ev(`window.__sim.setK(5);window.__sim.setCs(0);window.__sim.pick('q-tls')`);
  await ev('location.reload()'); await sleep(500);
  const afterReset = await ev(`(function(){var s=window.__sim.S;return {
    k:s.k, cs:s.cs, query:s.query, chStep:window.__sim.CH.step,
    rows:document.querySelectorAll('#ranked .rrow').length,
    qdot:!!document.querySelector('#plot .qdot'),
    warn:document.getElementById('warnBox').classList.contains('on')};})()`);
  const D = await ev('window.__sim.consts.DEFAULTS');
  ok('R5 Reset restores defaults + clears the query',
    afterReset.k === D.k && afterReset.cs === D.cs && afterReset.query === null
    && afterReset.chStep === 1 && afterReset.rows === 0 && afterReset.qdot === false
    && afterReset.warn === false, JSON.stringify(afterReset));

  // ---------- 12. no scroll at embed size ----------
  const scroll = await ev('({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,cw:window.innerWidth,ch:window.innerHeight})');
  ok('NO horizontal scroll @900x560', scroll.sw <= scroll.cw + 1, JSON.stringify(scroll));
  ok('NO vertical scroll @900x560', scroll.sh <= scroll.ch + 1, JSON.stringify(scroll));

  // ---------- 13. prefers-reduced-motion suppresses animation (R4) ----------
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(120);
  await ev(`window.__sim.pick('q-5xx')`); // trigger the qdot pop animation under reduced motion
  const reducedOK = await ev(`(function(){
    var bad=[];document.querySelectorAll('*').forEach(function(el){
      var cs=getComputedStyle(el);
      if(cs.animationName!=='none'&&cs.animationDuration!=='0s')bad.push(el.className);
    });return bad.length;})()`);
  ok('R4 prefers-reduced-motion suppresses animations', reducedOK === 0, 'active=' + reducedOK);

  cdp.close();
  child.kill('SIGKILL');
  try { fs.rmSync('/tmp/m4-retrieval-chrome-' + process.pid, { recursive: true, force: true }); } catch {}

  console.log(results.join('\n'));
  console.log(`\n${PASS}/${PASS + FAIL} assertions passed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
