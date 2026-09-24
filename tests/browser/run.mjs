// tests/browser/run.mjs - Isolated browser checks for the unpacked extension.
//
// Safety properties (do not weaken):
//   * Fresh temporary Chrome profile; never touches the everyday Chrome profile.
//   * All hostnames except the local fixture server resolve to NOTFOUND, so nothing
//     (including Tidal) can be contacted. The fake Tidal host maps to 127.0.0.1.
//   * --mute-audio: the synthetic tone never reaches speakers/headphones.
//   * Only synthetic fixtures (generated sine tones, fake Tidal DOM) are used.
//
// Usage: node browser/run.mjs <unpackedDir> [--label name]
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extDir = realpathSync(resolve(process.argv[2] || join(here, '../../build/unpacked')));
const labelIdx = process.argv.indexOf('--label');
const label = labelIdx > 0 ? process.argv[labelIdx + 1] : 'run';
const outDir = join(here, '../results', label);
mkdirSync(outDir, { recursive: true });

const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

// Unpacked extension IDs are derived from the absolute path.
function unpackedId(path) {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const EXT_ID = unpackedId(extDir);

// ---------- synthetic audio ----------
function toneWav({ seconds = 20, rate = 48000, freqs = [60, 1000, 8000], amp = 0.05 } = {}) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of freqs) s += amp * Math.sin(2 * Math.PI * f * i / rate);
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}
const WAV = toneWav();

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/tone.wav') {
    // Range support is required for the media element to be seekable.
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = +m[1], end = m[2] ? +m[2] : WAV.length - 1;
      res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${WAV.length}` });
      return res.end(WAV.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': WAV.length });
    return res.end(WAV);
  }
  const file = url.pathname === '/' ? 'media.html' : url.pathname.startsWith('/playlist') ? 'fake-tidal.html' : url.pathname.slice(1);
  const p = join(here, '../fixtures', file);
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const MEDIA_URL = `http://127.0.0.1:${PORT}/media.html`;
const TIDAL_URL = `http://fake-tidal.com:${PORT}/fake-tidal.html`;

// ---------- browser ----------
const profile = mkdtempSync(join(tmpdir(), 'tme-profile-'));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--allowlisted-extension-id=${EXT_ID}`,
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--host-resolver-rules=MAP fake-tidal.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,MediaRouter',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check'
  ],
  viewport: { width: 1000, height: 800 }
});

const results = [];
function record(id, title, status, evidence, level = 'installed-browser') {
  results.push({ id, title, status, level, evidence });
  console.log(`${status.padEnd(8)} ${id.padEnd(22)} ${title}${evidence ? `\n         ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluate an expression inside the extension's offscreen document over raw CDP.
async function evalOffscreen(expression) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const t = list.find((x) => x.url === `chrome-extension://${EXT_ID}/offscreen.html`);
  if (!t) return { missing: true };
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const reply = new Promise((r) => { ws.onmessage = (m) => r(JSON.parse(m.data)); });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await reply;
  ws.close();
  if (msg.result?.exceptionDetails) return { error: msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text };
  return { value: msg.result?.result?.value };
}

async function openPopup() {
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.accept(d.type() === 'prompt' ? 'Harness Preset' : undefined); });
  await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await sleep(1200);
  return { page, errors, dialogs };
}

function sendFrom(page, msg) {
  return page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => r(res ?? { lastError: chrome.runtime.lastError?.message }))), msg);
}

try {
  // ---- W-LOAD: extension loads and service worker starts ----
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const swOk = sw && sw.url().startsWith(`chrome-extension://${EXT_ID}/`);
  const swErrors = [];
  record('W-LOAD', 'Unpacked build loads; service worker starts', swOk ? 'PASS' : 'FAIL',
    { extensionId: EXT_ID, serviceWorker: sw?.url() || null });

  // ---- open synthetic pages ----
  const tidal = await context.newPage();
  const tidalErrors = [];
  tidal.on('pageerror', (e) => tidalErrors.push(String(e)));
  await tidal.goto(TIDAL_URL);
  await sleep(800);

  // ---- W-POPUP-RENDER ----
  const { page: popup, errors: popupErrors, dialogs } = await openPopup();
  const presetCount = await popup.locator('#preset-select option').count();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.screenshot({ path: join(outDir, 'popup-default.png') });
  record('W-POPUP-RENDER', 'Popup renders, state loads, presets populate', popupErrors.length === 0 && presetCount >= 8 ? 'PASS' : 'FAIL',
    { presetCount, pageErrors: popupErrors, screenshot: `results/${label}/popup-default.png` });

  // ---- W-TRACK-INFO: metadata scraped from the footer only ----
  await sleep(1500);
  const shownTitle = await popup.locator('#player-title').textContent();
  const shownArtist = await popup.locator('#player-artist').textContent();
  record('W-TRACK-INFO', 'Popup shows track metadata from the Tidal footer',
    shownTitle === 'Synthetic Tone' && shownArtist === 'Test Generator' ? 'PASS' : 'FAIL', { shownTitle, shownArtist });

  // ---- W-TRANSPORT-SCOPE: Play/Prev/Next/Fav hit the footer, never the decoy card ----
  await popup.click('#player-btn-play'); await sleep(500);
  await popup.click('#player-btn-next'); await sleep(400);
  await popup.click('#player-btn-prev'); await sleep(400);
  await popup.click('#player-btn-fav'); await sleep(400);
  const clicks = await tidal.evaluate(() => window.clicks);
  const playing = await tidal.evaluate(() => !document.getElementById('a').paused);
  record('W-TRANSPORT-SCOPE', 'Transport commands target footer controls only (decoy untouched)',
    clicks.decoy === 0 && clicks.footerPlay === 1 && clicks.next === 1 && clicks.prev === 1 && clicks.fav === 1 && playing ? 'PASS' : 'FAIL',
    { clicks, playing });

  // ---- W-SKIP-25 (tone is 20 s, so +25% = +5 s) ----
  await tidal.evaluate(() => { const a = document.getElementById('a'); a.currentTime = 2; });
  await sleep(2200); // let the popup's 1 s poll observe the new position
  const before = await tidal.evaluate(() => document.getElementById('a').currentTime);
  await popup.click('#player-btn-skip-fwd'); await sleep(300);
  const after = await tidal.evaluate(() => document.getElementById('a').currentTime);
  const delta = after - before;
  record('W-SKIP-25', '+25% skip seeks forward ~25% of duration (20 s tone => ~5 s)',
    delta > 4.2 && delta < 5.8 ? 'PASS' : 'FAIL', { before, after, delta: +delta.toFixed(2) });

  // ---- W-THEME-KEEPS-LAYOUT ----
  await popup.click('#btn-size-toggle');
  await popup.click('#btn-theme-toggle');
  const bodyClass = await popup.evaluate(() => document.body.className);
  record('W-THEME-KEEPS-LAYOUT', 'Cycling theme keeps Wide/Micro layout classes',
    bodyClass.includes('size-wide') ? 'PASS' : 'FAIL', { bodyClass });
  await popup.evaluate(() => { document.body.className = ''; });

  // ---- W-PRESET-RESET-SAFE: "Reset" on a custom preset must not delete custom presets ----
  dialogs.length = 0;
  await popup.click('#btn-save-preset'); // prompt auto-answered "Harness Preset"
  await sleep(500);
  await popup.click('#btn-save-preset'); // second custom preset: "Harness Preset" again -> overwrite; make a distinct one
  await sleep(300);
  const savedNames = await popup.evaluate(() => Object.keys(presets));
  await popup.selectOption('#preset-select', 'Harness Preset');
  await popup.click('.eq-nudge-btn[data-target="slider-bass"][data-action="up"]');
  await sleep(200);
  await popup.click('#btn-reset-defaults');
  await sleep(600);
  const storedAfterReset = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('presets', (d) => r(Object.keys(d.presets || {})))));
  record('W-PRESET-RESET-SAFE', 'Reset while a custom preset is selected keeps all custom presets',
    savedNames.includes('Harness Preset') && storedAfterReset.includes('Harness Preset') ? 'PASS' : 'FAIL',
    { savedNames, storedAfterReset, dialogs: [...dialogs] });

  // ---- W-STAGE-BYPASS-SYNC: A/B bypass state survives a slider move and popup reopen ----
  // Direct element clicks: the drawer overlay covers the sliders by design.
  const clickEl = (pg, sel) => pg.evaluate((q) => document.querySelector(q).click(), sel);
  await clickEl(popup, '#btn-open-router');
  await sleep(300);
  await clickEl(popup, '#toggle-stage-eq');
  await sleep(200);
  await clickEl(popup, '.eq-nudge-btn[data-target="slider-mid"][data-action="up"]');
  await sleep(400);
  const storedBypass = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('currentParams', (d) => r(d.currentParams?.stageBypass || null))));
  const { page: popup2 } = await openPopup();
  const reopenedLabel = await popup2.locator('#toggle-stage-eq').textContent();
  record('W-STAGE-BYPASS-SYNC', 'EQ-stage bypass persists after a slider move and shows as BYPASS on reopen',
    storedBypass?.eq === true && /BYPASS/.test(reopenedLabel) ? 'PASS' : 'FAIL', { storedBypass, reopenedLabel });
  await popup2.close();
  // restore: un-bypass so later audio checks run the full chain
  await clickEl(popup, '#toggle-stage-eq');
  await sendFrom(popup, { type: 'UPDATE_AUDIO_PARAMS', params: { stageBypass: { hpf: false, eq: false, comp: false, gain: false } } });
  await clickEl(popup, '#btn-open-router');
  await popup.bringToFront();

  // ---- W-CAPTURE-START: tab capture + DSP graph (synthetic tone, muted output) ----
  const media = await context.newPage();
  await media.goto(MEDIA_URL);
  await media.evaluate(() => document.getElementById('a').play());
  await sleep(700);
  const mediaTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, MEDIA_URL.split('?')[0]);
  const startRes = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
  await sleep(600);
  const graph = await evalOffscreen(`({ isCapturing, ctx: audioCtx && audioCtx.state, dsp: dspPathGain && dspPathGain.gain.value, direct: directPassThroughGain && directPassThroughGain.gain.value, tracks: currentStream && currentStream.getAudioTracks().map(t => t.readyState) })`);
  const captureOk = startRes?.success === true && graph.value?.isCapturing === true && graph.value?.ctx === 'running';
  record('W-CAPTURE-START', 'EQ attaches to the synthetic tab; offscreen DSP graph runs',
    captureOk ? 'PASS' : (String(startRes?.error || '').includes('invoked') ? 'BLOCKED' : 'FAIL'),
    { startRes, graph, note: 'Uses --allowlisted-extension-id to stand in for the toolbar click, which automation cannot perform.' });

  if (captureOk) {
    // ---- W-AUDIO-BASS: objective spectrum check at 60 Hz vs 1 kHz (post-limiter) ----
    const measure = `(async () => {
      const an = audioCtx.createAnalyser(); an.fftSize = 16384; an.smoothingTimeConstant = 0;
      masterLimiter.connect(an); const bypassAn = audioCtx.createAnalyser(); bypassAn.fftSize = 16384; bypassAn.smoothingTimeConstant = 0;
      directPassThroughGain.connect(bypassAn);
      await new Promise(r => setTimeout(r, 700));
      const bins = (a) => { const d = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(d); const hz = audioCtx.sampleRate / a.fftSize;
        const at = (f) => Math.max(...[-2,-1,0,1,2].map(k => d[Math.round(f / hz) + k]));
        const t = new Float32Array(a.fftSize); a.getFloatTimeDomainData(t); let peak = 0; for (const v of t) peak = Math.max(peak, Math.abs(v));
        return { hz60: +at(60).toFixed(1), hz1k: +at(1000).toFixed(1), hz8k: +at(8000).toFixed(1), peak: +peak.toFixed(3) }; };
      const r = { chain: bins(an) }; an.disconnect(); masterLimiter.disconnect(an); directPassThroughGain.disconnect(bypassAn);
      return r; })()`;
    await sendFrom(popup, { type: 'UPDATE_AUDIO_PARAMS', params: { bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, pitch: 1, autoBalance: false, bypass: false, stageBypass: { hpf: false, eq: false, comp: false, gain: false } } });
    await sleep(400);
    const flat = await evalOffscreen(measure);
    await sendFrom(popup, { type: 'UPDATE_AUDIO_PARAMS', params: { bass: 10, hpf: 20, mid: 0, high: 0, gain: 1, pitch: 1, autoBalance: false, bypass: false } });
    await sleep(400);
    const boosted = await evalOffscreen(measure);
    const f = flat.value?.chain, b = boosted.value?.chain;
    const lift60 = b && f ? b.hz60 - f.hz60 : null;
    const lift1k = b && f ? b.hz1k - f.hz1k : null;
    record('W-AUDIO-BASS', 'Bass +10 dB lifts 60 Hz relative to 1 kHz (objective FFT, post-limiter)',
      lift60 !== null && lift60 > 6 && Math.abs(lift1k) < 2 ? 'PASS' : 'FAIL', { flat: f, boosted: b, lift60: lift60?.toFixed(1), lift1k: lift1k?.toFixed(1) }, 'objective-audio');

    await sendFrom(popup, { type: 'UPDATE_AUDIO_PARAMS', params: { bass: 0, hpf: 200, mid: 0, high: 0, gain: 1, pitch: 1, autoBalance: false, bypass: false } });
    await sleep(500);
    const hpf = (await evalOffscreen(measure)).value?.chain;
    const cut60 = hpf && f ? f.hz60 - hpf.hz60 : null;
    record('W-AUDIO-HPF', 'HPF at 200 Hz attenuates 60 Hz by >15 dB (objective FFT)',
      cut60 !== null && cut60 > 15 ? 'PASS' : 'FAIL', { flat: f, hpf200: hpf, cut60: cut60?.toFixed(1) }, 'objective-audio');

    await sendFrom(popup, { type: 'UPDATE_AUDIO_PARAMS', params: { bass: 14, hpf: 20, mid: 6, high: 6, gain: 2.5, pitch: 1, autoBalance: false, bypass: false } });
    await sleep(500);
    const hot = (await evalOffscreen(measure)).value?.chain;
    record('W-AUDIO-LIMITER', 'Worst-case settings (bass +14, mid/high +6, 250%) stay near/below 0 dBFS after limiter',
      hot && hot.peak <= 1.05 ? 'PASS' : 'FAIL', { hot, note: 'peak is linear sample peak at limiter output; 1.0 = 0 dBFS' }, 'objective-audio');

    // ---- W-CAPTURE-STOP ----
    const stopRes = await sendFrom(popup, { type: 'STOP_CAPTURE' });
    await sleep(500);
    const afterStop = await evalOffscreen(`({ isCapturing, ctx: audioCtx ? audioCtx.state : null, stream: !!currentStream })`);
    const state = await sendFrom(popup, { type: 'GET_STATE' });
    const audible = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).audible, mediaTabId);
    record('W-CAPTURE-STOP', 'Stop releases stream + AudioContext; state reports OFF',
      stopRes?.success && afterStop.value?.isCapturing === false && !afterStop.value?.stream && state.isCapturing === false ? 'PASS' : 'FAIL',
      { stopRes, afterStop, stateIsCapturing: state.isCapturing, tabAudibleAfterStop: audible });

    // ---- W-CAPTURE-RESTART ----
    const re = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
    await sleep(500);
    const reGraph = await evalOffscreen(`({ isCapturing, ctx: audioCtx && audioCtx.state })`);
    record('W-CAPTURE-RESTART', 'EQ can be re-attached after stop', re?.success && reGraph.value?.isCapturing ? 'PASS' : 'FAIL', { re, reGraph });

    // ---- W-TAB-CLOSE-CLEANUP ----
    await media.close();
    await sleep(1200);
    const afterClose = await evalOffscreen(`({ isCapturing, stream: !!currentStream, ctx: audioCtx ? audioCtx.state : null })`);
    const stateAfterClose = await sendFrom(popup, { type: 'GET_STATE' });
    record('W-TAB-CLOSE-CLEANUP', 'Closing the captured tab releases capture and reports OFF',
      stateAfterClose.isCapturing === false && afterClose.value?.stream !== true ? 'PASS' : 'FAIL', { afterClose, stateIsCapturing: stateAfterClose.isCapturing });

    // ---- W-TAB-CLOSE-AFTER-SW-RESTART: in-memory capturedTabId lost after worker restart ----
    const media2 = await context.newPage();
    await media2.goto(MEDIA_URL + '?2');
    await media2.evaluate(() => document.getElementById('a').play());
    await sleep(500);
    const media2Id = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, MEDIA_URL + '?2');
    const s2 = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: media2Id });
    await sleep(400);
    // Simulate worker suspension by clearing the in-memory variable (what a real restart does).
    await sw.evaluate(() => { capturedTabId = null; });
    await media2.close();
    await sleep(1200);
    const after2 = await evalOffscreen(`({ isCapturing, stream: !!currentStream })`);
    const st2 = await sendFrom(popup, { type: 'GET_STATE' });
    record('W-TAB-CLOSE-AFTER-SW-RESTART', 'Tab close after worker restart still cleans up capture',
      s2?.success && st2.isCapturing === false && after2.value?.stream !== true ? 'PASS' : 'FAIL', { s2, after2, stateIsCapturing: st2.isCapturing });
  } else {
    for (const id of ['W-AUDIO-BASS', 'W-AUDIO-HPF', 'W-AUDIO-LIMITER', 'W-CAPTURE-STOP', 'W-CAPTURE-RESTART', 'W-TAB-CLOSE-CLEANUP', 'W-TAB-CLOSE-AFTER-SW-RESTART']) {
      record(id, 'depends on W-CAPTURE-START', 'BLOCKED', null);
    }
  }

  // ---- W-FALLBACK-WINDOW: the window used when Document PiP is unavailable ----
  const fbPage = await context.newPage();
  const fbErrors = [];
  fbPage.on('pageerror', (e) => fbErrors.push(String(e)));
  const fbUrl = await sw.evaluate(() => typeof FALLBACK_WINDOW_URL !== 'undefined' ? FALLBACK_WINDOW_URL : 'miniplayer.html');
  await fbPage.goto(`chrome-extension://${EXT_ID}/${fbUrl}`);
  await sleep(1500);
  const fbTitle = await fbPage.locator('#player-title').first().textContent().catch(() => null);
  await fbPage.screenshot({ path: join(outDir, 'fallback-window.png') });
  record('W-FALLBACK-WINDOW', 'Fallback mini-player window loads without script errors and shows the track',
    fbErrors.length === 0 && fbTitle === 'Synthetic Tone' ? 'PASS' : 'FAIL', { url: fbUrl, pageErrors: fbErrors, fbTitle });
  await fbPage.close();

  // ---- W-PLAYLISTS-HONESTY / W-LAB-HONESTY (no Tidal session exists in this profile) ----
  await popup.click('#tab-btn-playlists');
  await sleep(1500);
  const plText = await popup.locator('#popup-playlist-container').innerText();
  const plHtml = await popup.locator('#popup-playlist-container').innerHTML();
  const escaped = plText.includes('<b>Bold</b> & Co');
  record('W-PLAYLIST-ESCAPE', 'Playlist titles render as text (no HTML injection)', escaped ? 'PASS' : 'FAIL',
    { visibleText: plText.slice(0, 200), htmlHasBoldTag: /<b>Bold<\/b>/.test(plHtml) });

  await popup.click('#tab-btn-lab');
  await sleep(2000);
  await popup.click('.lab-pill[data-op="union"]');
  await sleep(1500);
  const labRows = await popup.locator('#lab-table-body tr').allInnerTexts();
  const labNotice = await popup.locator('#lab-data-notice').innerText().catch(() => '');
  dialogs.length = 0;
  await popup.click('#lab-btn-create');
  await sleep(800);
  const createDialog = dialogs.join(' | ');
  const fakeSuccess = /Successfully created/i.test(createDialog);
  record('W-LAB-HONESTY', 'Without a Tidal session, Lab does not fabricate tracks/BPM/key or report fake playlist creation',
    !fakeSuccess && !labRows.some((r) => /Deep Tech Groove|Sub-Bass Odyssey/.test(r)) ? 'PASS' : 'FAIL',
    { labRowsSample: labRows.slice(0, 3), labNotice, createDialog });

  await popup.screenshot({ path: join(outDir, 'popup-lab.png') });
  record('W-NO-PAGE-ERRORS', 'No uncaught errors in popup / fake Tidal page during run',
    popupErrors.length === 0 && tidalErrors.length === 0 ? 'PASS' : 'FAIL', { popupErrors, tidalErrors });
} catch (e) {
  record('HARNESS', 'Harness exception', 'FAIL', String(e?.stack || e));
} finally {
  const info = existsSync(join(extDir, 'BUILD_INFO.json')) ? JSON.parse(readFileSync(join(extDir, 'BUILD_INFO.json'), 'utf8')) : {};
  const summary = {
    label, ranAt: new Date().toISOString(), extensionDir: extDir, extensionId: EXT_ID,
    browser: context.browser()?.version?.() || 'Chrome for Testing (chromium-1208)',
    build: { version: info.version, commit: info.sourceCommit, dirty: info.sourceDirty, fingerprint: info.fingerprint },
    counts: results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {}),
    results
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(summary, null, 2));
  console.log('\n', summary.counts, `-> tests/results/${label}/results.json`);
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
