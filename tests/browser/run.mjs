// tests/browser/run.mjs - Isolated browser checks for the unpacked extension.
//
// Safety properties (do not weaken):
//   * Fresh temporary Chrome profile; never touches the everyday Chrome profile.
//   * All hostnames except the local fixture server resolve to NOTFOUND, so nothing
//     (including Tidal) can be contacted. The fake Tidal page is served as https://tidal.com:<port> from this
//     machine (tidal.com maps to 127.0.0.1; a throwaway self-signed certificate made per run, accepted by this
//     test browser only), so the Tidal-only page-world script of 1.5.3 runs on it exactly as shipped.
//   * --mute-audio plus --disable-audio-output: the synthetic tone never reaches speakers/headphones.
//   * Only synthetic fixtures (generated sine tones, fake Tidal DOM) are used.
//
// Usage: node browser/run.mjs <unpackedDir> [--label name]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
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

// ---------- synthetic audio (60 s so the 30 s jump has room) ----------
function toneWav({ seconds = 60, rate = 48000, freqs = [60, 1000, 8000], amp = 0.05 } = {}) {
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

const hanging = [];
const serve = (req, res) => {
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
  res.writeHead(200, { 'content-type': file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
  if (url.searchParams.get('hang') === '1') {
    // Whole page delivered, connection held open: the document never finishes loading, so the manifest's
    // document_idle page script never runs. That is the state of a tab whose page script was orphaned.
    res.write(readFileSync(p));
    hanging.push(res);
    return;
  }
  res.end(readFileSync(p));
};
const server = createServer(serve);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const certDir = mkdtempSync(join(tmpdir(), 'tme-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=tidal.com',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
const tlsServer = createHttpsServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, serve);
await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
const TLS_PORT = tlsServer.address().port;
const MEDIA_URL = `http://127.0.0.1:${PORT}/media.html`;
const TIDAL_URL = `https://tidal.com:${TLS_PORT}/fake-tidal.html`;

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
    '--mute-audio', '--disable-audio-output', // --mute-audio alone left the offscreen engine audible on the user's DAC (2026-10-10); no output device at all now
    '--autoplay-policy=no-user-gesture-required',
    `--host-resolver-rules=MAP tidal.com 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    '--ignore-certificate-errors', // the throwaway certificate of the local tidal.com stand-in; every other host is NOTFOUND
    '--no-proxy-server', // a system proxy would resolve tidal.com itself and reach the real site
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,MediaRouter',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check'
  ],
  viewport: { width: 1000, height: 800 }
});

const results = [];
// Every request made by pages and extension documents during the run (privacy check at the end).
const allRequests = [];
const watchRequests = (page) => page.on('request', (r) => allRequests.push(r.url()));
const localOrigins = () => [`http://127.0.0.1:${PORT}/`, `https://tidal.com:${TLS_PORT}/`];
const remoteRequests = () => allRequests.filter((u) => !/^(chrome-extension:|data:|blob:|about:)/.test(u) && !localOrigins().some((o) => u.startsWith(o)));

// Screenshot at the document's own size (the popup is sized by its content).
async function shot(page, name) {
  const { w, h } = await page.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { w: Math.ceil(b.width), h: Math.ceil(b.height) };
  });
  await page.setViewportSize({ width: Math.min(800, Math.max(320, w)), height: Math.min(600, Math.max(100, h)) });
  await sleep(150);
  await page.screenshot({ path: join(outDir, name) });
  return `results/${label}/${name}`;
}

function record(id, title, status, evidence, level = 'installed-browser') {
  results.push({ id, title, status, level, evidence });
  console.log(`${status.padEnd(8)} ${id.padEnd(26)} ${title}${evidence ? `\n         ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluate an expression inside one of the extension's documents (offscreen, side panel) over raw CDP.
const evalOffscreen = (expression) => evalExtensionDoc('offscreen.html', expression);
async function evalExtensionDoc(path, expression) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const t = list.find((x) => x.url === `chrome-extension://${EXT_ID}/${path}`);
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

async function openPopup(path = 'popup.html') {
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.accept(d.type() === 'prompt' ? 'Harness Preset' : undefined); });
  watchRequests(page);
  await page.goto(`chrome-extension://${EXT_ID}/${path}`);
  await sleep(1200);
  return { page, errors, dialogs };
}

function sendFrom(page, msg) {
  return page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => r(res ?? { lastError: chrome.runtime.lastError?.message }))), msg);
}

// R-28 (round 3): the worker accepts a preset-state write only from the screen that wrote last, or from a screen
// showing the stored revision. The harness's direct writes act as one more screen that reads the revision first.
// Slider and switch edits are EDIT_PARAMS / EDIT_DYNAMICS: the engine document answers neither, so every change
// reaches it through the worker's checked queue.
function writeFrom(page, msg) {
  return page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage({ type: 'READ_PRESET_STATE' }, (view) => {
    const viewRev = view && Number.isInteger(view.stateRev) ? view.stateRev : 0;
    chrome.runtime.sendMessage({ ...m, surfaceId: 'harness-direct', viewRev }, (res) => r(res ?? { lastError: chrome.runtime.lastError?.message }));
  })), msg);
}

// The user coming back to a window: Chrome fires focus and visibilitychange, and the screen refreshes from storage
// when another window has written since it painted. Pages driven by the harness do not get these on their own.
async function showSurface(pg) {
  await pg.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(450);
}

// All four Movie labels, with a long badge tooltip, at the page's current width.
async function movieStatusMatrix(page) {
  return page.evaluate(() => {
    const labels = [['off', 'MOVIE'], ['on', 'MOVIE · AUTO'], ['on', 'MOVIE · ON'], ['manual-off', 'MOVIE · OFF']];
    const btn = document.getElementById('btn-movie-mode');
    const title = document.querySelector('.power-title');
    const sw = document.querySelector('.power-switch');
    const badge = document.getElementById('eq-power-status-badge');
    const bar = document.querySelector('.status-bar');
    const saved = {
      badgeText: badge.textContent, badgeTitle: badge.title, badgeCls: badge.className,
      btnCls: btn.className, btnText: btn.textContent
    };
    badge.className = 'power-badge on';
    badge.textContent = '● ON · Synthetic Tone with a very long tab title';
    badge.title = 'Processing the tab "Synthetic Tone with a very long tab title that must stay on one status row"';
    const overlap = (a, b) => a.width > 0 && b.width > 0 && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const rows = labels.map(([cls, text]) => {
      btn.className = 'movie-badge ' + cls;
      btn.textContent = text;
      const br = btn.getBoundingClientRect();
      const tr = title.getBoundingClientRect();
      const sr = sw.getBoundingClientRect();
      const gr = badge.getBoundingClientRect();
      const barR = bar.getBoundingClientRect();
      return {
        text, cls,
        bodyH: +document.body.getBoundingClientRect().height.toFixed(1),
        barH: +barR.height.toFixed(2),
        barSame: true,
        sameLine: Math.abs(br.top - tr.top) < 14 && Math.abs(sr.top - tr.top) < 14 && Math.abs(gr.top - tr.top) < 14,
        noWrap: getComputedStyle(btn).whiteSpace === 'nowrap' && getComputedStyle(title).whiteSpace === 'nowrap' && getComputedStyle(badge).whiteSpace === 'nowrap' && getComputedStyle(bar).flexWrap === 'nowrap',
        btnFits: btn.scrollWidth <= btn.clientWidth + 1,
        titleFits: title.scrollWidth <= title.clientWidth + 1,
        barFits: bar.scrollWidth <= bar.clientWidth + 1,
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        noOverlap: !overlap(br, gr) && !overlap(br, tr) && !overlap(br, sr) && !overlap(gr, sr) && !overlap(tr, sr),
        inside: br.right <= barR.right + 1 && gr.right <= barR.right + 1 && tr.left >= barR.left - 1,
        btnNowrap: getComputedStyle(btn).whiteSpace === 'nowrap' && getComputedStyle(btn).flexShrink === '0',
        titleNowrap: getComputedStyle(title).whiteSpace === 'nowrap',
        badgeMin: getComputedStyle(badge).minWidth
      };
    });
    const h0 = rows.length ? rows[0].barH : 0;
    for (const row of rows) row.barSame = Math.abs(row.barH - h0) < 0.6;
    badge.textContent = saved.badgeText;
    badge.title = saved.badgeTitle;
    badge.className = saved.badgeCls;
    btn.className = saved.btnCls;
    btn.textContent = saved.btnText;
    return rows;
  });
}

function movieMatrixOk(rows, { bodyMax = null, page = false } = {}) {
  return Array.isArray(rows) && rows.length === 4 && rows.every((m) =>
    m.barSame && m.sameLine && m.noWrap && m.btnFits && m.titleFits && m.barFits && m.noOverlap && m.inside
    && m.btnNowrap && m.titleNowrap && m.badgeMin === '0px'
    && (bodyMax == null || m.bodyH < bodyMax)
    && (!page || m.pageFits));
}
const storedParams = (page) => page.evaluate(() => new Promise((r) => chrome.storage.local.get('currentParams', (d) => r(d.currentParams || null))));

try {
  // ---- W-LOAD: extension loads and service worker starts ----
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
  const swOk = sw && sw.url().startsWith(`chrome-extension://${EXT_ID}/`);
  record('W-LOAD', 'Unpacked build loads; service worker starts', swOk ? 'PASS' : 'FAIL',
    { extensionId: EXT_ID, serviceWorker: sw?.url() || null });

  // ---- open synthetic pages ----
  const tidal = await context.newPage();
  const tidalErrors = [];
  tidal.on('pageerror', (e) => tidalErrors.push(String(e)));
  watchRequests(tidal);
  await tidal.goto(TIDAL_URL);
  await sleep(800);

  // ---- W-POPUP-RENDER ----
  const { page: popup, errors: popupErrors, dialogs } = await openPopup();
  // Later popup pages (reopens, the closed-UI check, the orphan tab) must count in W-NO-PAGE-ERRORS too.
  const adopt = (opened) => {
    for (const err of opened.errors) popupErrors.push(err);
    opened.page.on('pageerror', (err) => popupErrors.push(String(err)));
    return opened.page;
  };
  const presetCount = await popup.locator('#preset-select option').count();
  const shotDefault = await shot(popup, 'popup-default.png');
  record('W-POPUP-RENDER', 'Popup renders, state loads, presets populate', popupErrors.length === 0 && presetCount >= 8 ? 'PASS' : 'FAIL',
    { presetCount, pageErrors: popupErrors, screenshot: shotDefault });

  // ---- W-SURFACES-REMOVED: header icons, tabs, floating button, Physics side panel are gone (R-01, R-06, R-13) ----
  const stillPresent = await popup.evaluate(() => ['header.header', '#btn-size-toggle', '#btn-micro-toggle', '#btn-always-on-top', '#btn-undock', '#btn-theme-toggle',
    '#btn-open-router', '#physics-panel', '#toggle-floating-btn', '#tab-btn-playlists', '#tab-btn-lab', '.popup-tab-bar', '.micro-container'].filter((s) => document.querySelector(s)));
  const unsupported = await sw.evaluate(async (u) => {
    const [t] = await chrome.tabs.query({ url: u + '*' });
    const out = {};
    for (const type of ['FETCH_USER_PLAYLISTS', 'TOGGLE_FLOATING_BUTTON', 'TOGGLE_MINIPLAYER']) {
      try { out[type] = (await chrome.tabs.sendMessage(t.id, { type, show: true })) ?? null; } catch (e) { out[type] = { unsupported: true }; }
    }
    return out;
  }, TIDAL_URL.split('?')[0]);
  const floatingInPage = await tidal.evaluate(() => !!document.getElementById('tidal-pip-floating-btn'));
  record('W-SURFACES-REMOVED', 'Header icons, tabs, floating button and side panel are gone; page script ignores their commands',
    stillPresent.length === 0 && !floatingInPage && Object.values(unsupported).every((v) => v === null || v?.unsupported) ? 'PASS' : 'FAIL',
    { stillPresent, floatingInPage, unsupported });

  // ---- W-NO-DEAD-SPACE: rows pack from the top; the popup is only as tall as its content ----
  const space = await popup.evaluate(() => {
    const c = document.querySelector('.controls-area');
    const kids = [...c.children];
    const first = kids[0].getBoundingClientRect(), last = kids[kids.length - 1].getBoundingClientRect();
    const slack = c.getBoundingClientRect().height - (last.bottom - first.top);
    const foot = document.querySelector('.foot').getBoundingClientRect();
    const bodyH = document.body.getBoundingClientRect().height;
    const btn = document.getElementById('btn-movie-mode');
    const title = document.querySelector('.power-title');
    const sw = document.querySelector('.power-switch');
    const bar = document.querySelector('.status-bar');
    const states = [['off', 'MOVIE'], ['on', 'MOVIE · AUTO'], ['manual-off', 'MOVIE · OFF'], ['on', 'MOVIE · ON']];
    const movie = states.map(([cls, text]) => {
      btn.className = 'movie-badge ' + cls;
      btn.textContent = text;
      const br = btn.getBoundingClientRect();
      const tr = title.getBoundingClientRect();
      const sr = sw.getBoundingClientRect();
      return {
        text, cls,
        bodyH: +document.body.getBoundingClientRect().height.toFixed(1),
        sameLine: Math.abs(br.top - tr.top) < 14 && Math.abs(sr.top - tr.top) < 14,
        noShrink: btn.scrollWidth <= btn.clientWidth + 1 && title.scrollWidth <= title.clientWidth + 1,
        inside: br.right <= bar.getBoundingClientRect().right + 1
      };
    });
    btn.className = 'movie-badge off';
    btn.textContent = 'MOVIE';
    return { slack: +slack.toFixed(1), belowRows: +(foot.top - last.bottom).toFixed(1), bodyH: +bodyH.toFixed(1), bodyW: document.body.getBoundingClientRect().width, movie };
  });
  const movieFits = space.movie && space.movie.every((m) => m.bodyH < 600 && m.sameLine && m.noShrink && m.inside);
  // Four Movie labels and a long badge title at every width. The badge may ellipsize; the bar, title and button may not clip.
  const popupWidths = [300, 360, 400, 440, 480];
  const savedViewport = popup.viewportSize() || { width: 1280, height: 720 };
  const popupMovieMatrix = {};
  for (const width of popupWidths) {
    await popup.setViewportSize({ width, height: Math.max(savedViewport.height || 720, 720) });
    await popup.evaluate((w) => { document.body.style.width = w + 'px'; }, width);
    await sleep(80);
    popupMovieMatrix[width] = await movieStatusMatrix(popup);
  }
  await popup.evaluate(() => { document.body.style.width = ''; });
  await popup.setViewportSize(savedViewport);
  const popupMatrixOk = popupWidths.every((w) => movieMatrixOk(popupMovieMatrix[w], { bodyMax: w === 440 ? 600 : null, page: w === 440 }));
  record('W-NO-DEAD-SPACE', 'No empty band above or below the EQ sliders; popup height follows content; all four Movie labels stay on one line at 300–480 px, with a long badge title, and the popup stays under 600 px at 440',
    space.slack < 4 && space.belowRows < 20 && space.bodyH < 600 && space.bodyW === 440 && movieFits && popupMatrixOk ? 'PASS' : 'FAIL',
    { ...space, popupMovieMatrix });

  // ---- W-TRACK-INFO: metadata scraped from the footer only ----
  await sleep(1500);
  const shownTitle = await popup.locator('#player-title').textContent();
  const shownArtist = await popup.locator('#player-artist').textContent();
  record('W-TRACK-INFO', 'Popup shows track metadata from the Tidal footer',
    shownTitle === 'Synthetic Tone' && shownArtist === 'Test Generator' ? 'PASS' : 'FAIL', { shownTitle, shownArtist });

  // ---- W-ART-HIRES: the 80 px thumbnail URL is upgraded to 1280; when that size is missing it steps down to 640 ----
  await sleep(1200);
  const art = await popup.evaluate(() => ({
    cover: document.getElementById('art-cover').getAttribute('src'), slice: document.getElementById('art-slice').getAttribute('src'),
    coverShown: !document.getElementById('art-cover').hidden, naturalW: document.getElementById('art-cover').naturalWidth
  }));
  const artRequests = allRequests.filter((u) => /\/img\/cover\//.test(u)).map((u) => u.replace(/^.*\/img\/cover\//, ''));
  record('W-ART-HIRES', 'Cover art is requested at full size (1280), then falls back to 640 when the big size is missing',
    art.coverShown && /\/640x640\.svg$/.test(art.cover) && art.slice === art.cover && artRequests.includes('1280x1280.svg') && artRequests.includes('640x640.svg') ? 'PASS' : 'FAIL',
    { ...art, artRequests: [...new Set(artRequests)] });

  // ---- W-TRANSPORT-SCOPE: Play/Prev/Next hit the footer, never the decoy card ----
  await popup.click('#player-btn-play'); await sleep(500);
  await popup.click('#player-btn-next'); await sleep(400);
  await popup.click('#player-btn-prev'); await sleep(400);
  const clicks = await tidal.evaluate(() => window.clicks);
  const playing = await tidal.evaluate(() => !window.audioEl.paused);
  record('W-TRANSPORT-SCOPE', 'Transport commands target footer controls only (decoy untouched)',
    clicks.decoy === 0 && clicks.footerPlay === 1 && clicks.next === 1 && clicks.prev === 1 && clicks.fav === 0 && playing ? 'PASS' : 'FAIL',
    { clicks, playing });

  // ---- W-HEART: the heart clicks Tidal's own footer heart and reflects its state ----
  await popup.click('#player-btn-fav'); await sleep(1400);
  const heartClicks = await tidal.evaluate(() => window.clicks.fav);
  const heartOn = await popup.evaluate(() => document.getElementById('player-btn-fav').classList.contains('on'));
  await popup.click('#player-btn-fav'); await sleep(1400);
  const heartOff = await popup.evaluate(() => !document.getElementById('player-btn-fav').classList.contains('on'));
  const heartClicks2 = await tidal.evaluate(() => window.clicks.fav);
  record('W-HEART', 'Heart toggles the footer favourite button and shows its state (on, then off)',
    heartClicks === 1 && heartOn && heartClicks2 === 2 && heartOff ? 'PASS' : 'FAIL', { heartClicks, heartOn, heartClicks2, heartOff });

  // ---- W-JUMP: +30 s and −15 s jumps through the page's seek bar (the media element is out of reach, as on Tidal) ----
  await tidal.evaluate(() => { window.audioEl.currentTime = 2; });
  await sleep(2200); // let the popup's 1 s poll observe the new position (from the footer's time labels)
  const t0 = await tidal.evaluate(() => window.audioEl.currentTime);
  await popup.click('#player-btn-fwd30'); await sleep(400);
  const t1 = await tidal.evaluate(() => window.audioEl.currentTime);
  await sleep(1800);
  await popup.click('#player-btn-back15'); await sleep(400);
  const t2 = await tidal.evaluate(() => window.audioEl.currentTime);
  const seeks = await tidal.evaluate(() => window.clicks.seek);
  const fwd = t1 - t0, back = t2 - t1;
  record('W-JUMP', 'Forward 30 s / back 15 s work through the footer seek bar when no media element is reachable',
    fwd > 28 && fwd < 33 && back > -18.5 && back < -12 && seeks === 2 ? 'PASS' : 'FAIL',
    { t0: +t0.toFixed(2), t1: +t1.toFixed(2), t2: +t2.toFixed(2), fwd: +fwd.toFixed(2), back: +back.toFixed(2), seekBarEvents: seeks, note: 'time labels have 1 s resolution' });

  // ---- W-THEME-DOTS: a theme dot applies the theme and it is remembered ----
  await popup.click('.dot[data-theme="theme-amber"]');
  await sleep(200);
  const themeClass = await popup.evaluate(() => document.body.className);
  const themeStored = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('visualTheme', (d) => r(d.visualTheme))));
  record('W-THEME-DOTS', 'Theme dots switch the theme and remember it',
    themeClass.includes('theme-amber') && themeStored === 'theme-amber' ? 'PASS' : 'FAIL', { themeClass, themeStored });
  await popup.click('.dot[data-theme="theme-cyan"]');

  // ---- W-PRESET-RESET-SAFE: "Reset" on a custom preset must not delete custom presets ----
  dialogs.length = 0;
  await popup.click('#btn-save-preset'); // prompt auto-answered "Harness Preset"
  await sleep(500);
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

  // ---- W-NO-LAYOUT-SHIFT: Saved -> Modified (badge changes, Update appears) must not move the controls ----
  await popup.selectOption('#preset-select', 'Harness Preset');
  await sleep(250);
  const nudgeSel = '.eq-nudge-btn[data-target="slider-high"][data-action="up"]';
  const rectOf = (sel) => popup.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1) }; }, sel);
  const nudgeBefore = await rectOf(nudgeSel);
  const sliderBefore = await rectOf('#slider-bass');
  for (let i = 0; i < 3; i++) { await popup.click(nudgeSel); await sleep(90); }
  const nudgeAfter = await rectOf(nudgeSel);
  const sliderAfter = await rectOf('#slider-bass');
  const badgeText = await popup.locator('#preset-status-badge').textContent();
  const updateShown = await popup.locator('#btn-update-preset').isVisible();
  record('W-NO-LAYOUT-SHIFT', 'Nudging a value (Saved → Modified, Update button appears) does not move the sliders or buttons',
    nudgeBefore.y === nudgeAfter.y && nudgeBefore.x === nudgeAfter.x && sliderBefore.y === sliderAfter.y && /Modified/.test(badgeText) && updateShown ? 'PASS' : 'FAIL',
    { nudgeBefore, nudgeAfter, sliderBefore, sliderAfter, badgeText, updateShown });

  // ---- W-EQ-RANGE-UI (1.5.9, E-03): Bass 0..56 and Mid/High −24..24 on the popup, the side panel and the fallback window
  // (one popup.html). The ends survive nudges, Update, neutral/restore and a reopen; a stored 14 / 6 / 0 preset keeps its
  // numbers. Runs on its own pages and puts the stored presets back exactly as they were. ----
  const getStore = (pg, keys) => pg.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, r)), keys);
  const rangeSnap = await getStore(popup, ['presets', 'currentPreset', 'currentParams']);
  const rp = adopt(await openPopup());
  const rangeOf = (pg) => pg.evaluate(() => Object.fromEntries(['bass', 'mid', 'high'].map((b) => { const el = document.getElementById(`slider-${b}`); return [b, [Number(el.min), Number(el.max), Number(el.step)]]; })));
  const shownOf = (pg) => pg.evaluate(() => Object.fromEntries(['bass', 'mid', 'high'].map((b) => [b, [Number(document.getElementById(`slider-${b}`).value), document.getElementById(`val-${b}`).textContent]])));
  const setSlider = (pg, b, v) => pg.evaluate(([b, v]) => { const el = document.getElementById(`slider-${b}`); el.value = v; el.dispatchEvent(new Event('input')); }, [b, v]);
  const nudge = async (pg, b, dir) => { await pg.click(`.eq-nudge-btn[data-target="slider-${b}"][data-action="${dir}"]`); await sleep(120); };
  await rp.selectOption('#preset-select', 'Harness Preset');
  await sleep(250);
  const rangePopup = await rangeOf(rp);
  await setSlider(rp, 'bass', 55.5); await nudge(rp, 'bass', 'up'); await nudge(rp, 'bass', 'up');
  await setSlider(rp, 'mid', -23.5); await nudge(rp, 'mid', 'down'); await nudge(rp, 'mid', 'down');
  await setSlider(rp, 'high', 24); await nudge(rp, 'high', 'up');
  await sleep(200);
  const endsShown = await shownOf(rp);
  await rp.click('#btn-update-preset');
  await sleep(600);
  const storedEnds = (await getStore(rp, ['presets'])).presets?.['Harness Preset'] || null;
  await rp.dblclick('#val-bass'); await sleep(200);
  const neutralBass = Number(await rp.evaluate(() => document.getElementById('slider-bass').value));
  await rp.dblclick('#val-bass'); await sleep(200);
  const restoredBass = Number(await rp.evaluate(() => document.getElementById('slider-bass').value));
  const oldPreset = { bass: 14, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: true, bypass: false };
  await rp.evaluate((op) => new Promise((r) => chrome.storage.local.get('presets', (d) => chrome.storage.local.set({ presets: { ...(d.presets || {}), 'Old 14-6-0': op } }, r))), oldPreset);
  const other = {};
  for (const [label, path] of [['popup', 'popup.html'], ['panel', 'popup.html?panel=1'], ['window', 'popup.html?undocked=true']]) {
    const pg = adopt(await openPopup(path));
    await pg.selectOption('#preset-select', 'Harness Preset'); await sleep(250);
    const ends = await shownOf(pg);
    await pg.selectOption('#preset-select', 'Old 14-6-0'); await sleep(250);
    other[label] = { range: await rangeOf(pg), ends, old: await shownOf(pg) };
    await pg.close();
  }
  const storedOld = (await getStore(rp, ['presets'])).presets?.['Old 14-6-0'] || null;
  await rp.close();
  await popup.evaluate((snap) => new Promise((r) => chrome.storage.local.set(snap, r)), rangeSnap);
  await sleep(300);
  const wantRange = { bass: [0, 56, 0.5], mid: [-24, 24, 0.5], high: [-24, 24, 0.5] };
  const endsOk = (e) => e.bass[0] === 56 && e.mid[0] === -24 && e.high[0] === 24 && e.bass[1] === '+56.0 dB' && /24\.0 dB$/.test(e.mid[1]) && e.high[1] === '+24.0 dB';
  record('W-EQ-RANGE-UI', 'Doubled-again ranges (1.5.9) on the popup, side panel and fallback window: Bass 0..56, Mid/High −24..24 in 0.5 dB steps; nudges stop at the ends; Update stores 56 / −24 / +24; neutral/restore returns to 56; every surface shows the stored ends after reopening; a stored 14 / 6 / 0 preset shows and stays 14 / 6 / 0',
    JSON.stringify(rangePopup) === JSON.stringify(wantRange) && endsOk(endsShown) && storedEnds?.bass === 56 && storedEnds.mid === -24 && storedEnds.high === 24
      && neutralBass === 0 && restoredBass === 56
      && Object.values(other).every((o) => JSON.stringify(o.range) === JSON.stringify(wantRange) && endsOk(o.ends) && o.old.bass[0] === 14 && o.old.mid[0] === 6 && o.old.high[0] === 0)
      && !!storedOld && Object.keys(storedOld).length === Object.keys(oldPreset).length && Object.entries(oldPreset).every(([k, v]) => storedOld[k] === v) ? 'PASS' : 'FAIL',
    { rangePopup, endsShown, storedEnds, neutralBass, restoredBass, other, storedOld });

  // ---- W-KEYBOARD: Tab reaches every control with a visible focus ring; arrows and Space operate sliders and buttons ----
  await showSurface(popup); // the range pages wrote since the popup painted
  await popup.selectOption('#preset-select', 'Harness Preset');
  await sleep(250);
  const activeId = () => popup.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
  const tabUntil = async (pred, max = 80) => {
    for (let i = 0; i < max; i++) { if (await popup.evaluate(pred)) return i; await popup.keyboard.press('Tab'); await sleep(25); }
    return -1;
  };
  await popup.evaluate(() => document.getElementById('player-btn-fav').focus());
  // The slider's focus ring is drawn on the thumb (a pseudo-element computed style cannot be read), so compare pixels:
  // the same clip around the slider before and after keyboard focus reaches it.
  const sliderBox = await popup.locator('#slider-bass').boundingBox();
  const clip = { x: sliderBox.x - 8, y: sliderBox.y - 8, width: sliderBox.width + 16, height: sliderBox.height + 16 };
  const sliderClipBefore = (await popup.screenshot({ clip })).toString('base64');
  const tabsToSlider = await tabUntil(() => document.activeElement && document.activeElement.id === 'slider-bass');
  const sliderClipFocused = (await popup.screenshot({ clip, path: join(outDir, 'keyboard-focus-slider.png') })).toString('base64');
  const ringPixels = await popup.evaluate(async ([a, b]) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; const ctx = c.getContext('2d');
    ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, c.width, c.height).data;
    ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) n++;
    return n;
  }, [sliderClipBefore, sliderClipFocused]);
  const sliderFocus = await popup.evaluate((n) => {
    const el = document.getElementById('slider-bass');
    return { focusVisible: el.matches(':focus-visible'), thumbRing: n > 40, ringPixels: n, value: el.value };
  }, ringPixels);
  await popup.keyboard.press('ArrowRight');
  await sleep(300);
  const afterArrow = await popup.evaluate(() => document.getElementById('slider-bass').value);
  const storedAfterArrow = (await storedParams(popup))?.bass;
  const tabsToPlus = await tabUntil(() => document.activeElement && document.activeElement.matches('.eq-nudge-btn[data-target="slider-bass"][data-action="up"]'));
  const plusFocus = await popup.evaluate(() => ({ focusVisible: document.activeElement.matches(':focus-visible'), outline: getComputedStyle(document.activeElement).outlineStyle }));
  await popup.keyboard.press('Space');
  await sleep(300);
  const afterSpace = await popup.evaluate(() => document.getElementById('slider-bass').value);
  const tabsToBand = await tabUntil(() => document.activeElement && document.activeElement.matches('.band-tag[data-band="high"]'));
  await popup.keyboard.press('Enter');
  await sleep(300);
  const bandByKey = await popup.evaluate(() => {
    const b = document.querySelector('.band-tag[data-band="high"]');
    return { off: b.classList.contains('off'), pressed: b.getAttribute('aria-pressed') };
  });
  await popup.keyboard.press('Enter'); // back on
  await sleep(200);
  const tabsToSwitch = await tabUntil(() => document.activeElement && document.activeElement.id === 'toggle-stay-open');
  const switchRing = await popup.evaluate(() => getComputedStyle(document.getElementById('toggle-stay-open').nextElementSibling).boxShadow !== 'none');
  const names = await popup.evaluate(() => [...document.querySelectorAll('input[type="range"], button')].filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim())).map((el) => el.id || el.className));
  record('W-KEYBOARD', 'Keyboard: Tab reaches the sliders, buttons and switches with a visible ring; arrows move a slider (saved), Space/Enter press buttons; every control has a name',
    tabsToSlider >= 0 && sliderFocus.focusVisible && sliderFocus.thumbRing && parseFloat(afterArrow) === parseFloat(sliderFocus.value) + 0.5 && storedAfterArrow === parseFloat(afterArrow)
      && tabsToPlus >= 0 && plusFocus.focusVisible && plusFocus.outline === 'solid' && parseFloat(afterSpace) === parseFloat(afterArrow) + 0.5
      && tabsToBand >= 0 && bandByKey.off && bandByKey.pressed === 'false' && tabsToSwitch >= 0 && switchRing && names.length === 0 ? 'PASS' : 'FAIL',
    { tabsToSlider, sliderFocus, afterArrow, storedAfterArrow, tabsToPlus, plusFocus, afterSpace, tabsToBand, bandByKey, tabsToSwitch, switchRing, unnamed: names });
  await popup.evaluate(() => document.activeElement && document.activeElement.blur());

  // ---- W-BAND-SWITCH-SYNC: a band tag switches that stage off, keeps the value, and persists across reopen ----
  const midBefore = await popup.evaluate(() => document.getElementById('slider-mid').value);
  await popup.click('.band-tag[data-band="mid"]');
  await sleep(400);
  const midAfter = await popup.evaluate(() => document.getElementById('slider-mid').value);
  const storedMid = (await storedParams(popup))?.stageBypass;
  const popup2 = adopt(await openPopup());
  const reopened = await popup2.evaluate(() => ({
    tagOff: document.querySelector('.band-tag[data-band="mid"]').classList.contains('off'),
    rowDimmed: document.querySelector('.eq-row[data-band="mid"]').classList.contains('is-off'),
    midValue: document.getElementById('slider-mid').value
  }));
  await popup2.close();
  record('W-BAND-SWITCH-SYNC', 'MID tag switches the band off, keeps its value, and shows as off after reopening',
    storedMid?.mid === true && midBefore === midAfter && reopened.tagOff && reopened.rowDimmed && reopened.midValue === midBefore ? 'PASS' : 'FAIL',
    { midBefore, midAfter, storedMid, reopened });
  await popup.click('.band-tag[data-band="mid"]'); // back on
  await sleep(200);

  // ---- W-PHYSICS-INLINE: both drawings sit on the main screen; with the EQ off the live strip is still (no fake motion) ----
  const phys = await popup.evaluate(async () => {
    const main = document.querySelector('.popup-main').getBoundingClientRect();
    const lc = document.getElementById('live-canvas').getBoundingClientRect();
    const bc = document.getElementById('bode-canvas').getBoundingClientRect();
    const f0 = physics.frames;
    await new Promise((r) => setTimeout(r, 400));
    return { liveW: lc.width, liveH: lc.height, bodeW: bc.width, bodeH: bc.height,
      insideMain: lc.left >= main.left && lc.right <= main.right && bc.left >= main.left && bc.right <= main.right,
      framesWhileOff: physics.frames - f0, idle: physics.frame === null, readout: document.getElementById('physics-readout').textContent };
  });
  record('W-PHYSICS-INLINE', 'Live strip and response curve are on the main screen; nothing animates while the EQ is off',
    phys.insideMain && phys.liveW > 300 && phys.bodeW > 300 && phys.liveH >= 48 && phys.bodeH >= 44 && phys.framesWhileOff === 0 && phys.idle ? 'PASS' : 'FAIL', phys);

  // ---- W-CAPTURE-START: tab capture + DSP graph (synthetic tone, muted output) ----
  const media = await context.newPage();
  watchRequests(media);
  await media.goto(MEDIA_URL);
  await media.evaluate(() => document.getElementById('a').play());
  await sleep(700);
  const mediaTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, MEDIA_URL.split('?')[0]);
  const startRes = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
  await sleep(600);
  const graph = await evalOffscreen(`({ isCapturing, ctx: audioCtx && audioCtx.state, rate: audioCtx && audioCtx.sampleRate, dsp: dspPathGain && dspPathGain.gain.value, direct: directPassThroughGain && directPassThroughGain.gain.value, tracks: currentStream && currentStream.getAudioTracks().map(t => t.readyState) })`);
  const captureOk = startRes?.success === true && graph.value?.isCapturing === true && graph.value?.ctx === 'running';
  record('W-CAPTURE-START', 'EQ attaches to the synthetic tab; offscreen DSP graph runs (the rate follows the Mac\'s output device and is recorded)',
    captureOk ? 'PASS' : (String(startRes?.error || '').includes('invoked') ? 'BLOCKED' : 'FAIL'),
    { startRes, graph, note: 'Uses --allowlisted-extension-id to stand in for the toolbar click, which automation cannot perform.' });

  // ---- W-CLICK-PATH (1.5.2, K-01): the device buffer is the large one and the pitch shifter is parked while no shift is set ----
  if (captureOk) {
    const path = await evalOffscreen(`({ base: audioCtx.baseLatency, primed: pitchPrimed, target: pitchTarget(), wet: pitchWetGain && pitchWetGain.gain.value })`);
    const v = path.value || {};
    record('W-CLICK-PATH', 'Large device buffer (no dropouts when the audio thread is briefly late), pitch shifter parked at 0 st',
      v.base >= 0.01 && v.primed === false && v.target === 0 && v.wet === 0 ? 'PASS' : 'FAIL', path);
  }

  const NONE = { hpf: false, bass: false, mid: false, high: false, gain: false, pitch: false };
  if (captureOk) {
    // Levels are read at the exact tone frequencies from the last 16384 output samples (a Blackman-Harris windowed
    // transform at that one frequency), so they do not depend on FFT bin alignment or on the sample rate the graph
    // happens to run at (it follows the Mac's output device: 48 kHz one day, a 96 kHz DAC the next). 0 dB = a full-scale sine.
    const measure = `(async () => {
      const an = audioCtx.createAnalyser(); an.fftSize = 16384; an.smoothingTimeConstant = 0;
      const tap = (typeof outputSum !== 'undefined' && outputSum) || (typeof outputCeiling !== 'undefined' && outputCeiling) || masterLimiter;
      tap.connect(an);
      await new Promise(r => setTimeout(r, 700));
      const t = new Float32Array(an.fftSize); an.getFloatTimeDomainData(t); let peak = 0; for (const v of t) peak = Math.max(peak, Math.abs(v));
      const N = t.length, fs = audioCtx.sampleRate; const w = new Float32Array(N); let ws = 0;
      for (let n = 0; n < N; n++) { const a = 2 * Math.PI * n / (N - 1); w[n] = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a); ws += w[n]; }
      const at = (f) => { let re = 0, im = 0; const k = 2 * Math.PI * f / fs; for (let n = 0; n < N; n++) { const v = t[n] * w[n]; re += v * Math.cos(k * n); im -= v * Math.sin(k * n); } return 20 * Math.log10(Math.max(2 * Math.hypot(re, im) / ws, 1e-9)); };
      const r = { hz60: +at(60).toFixed(1), hz1k: +at(1000).toFixed(1), hz8k: +at(8000).toFixed(1), hz500: +at(500).toFixed(1), hz2k: +at(2000).toFixed(1), hz3k: +at(3000).toFixed(1), hz180: +at(180).toFixed(1), peak: +peak.toFixed(3), rate: fs, tap: tap === masterLimiter ? 'limiter' : (typeof outputSum !== 'undefined' && tap === outputSum) ? 'output' : 'ceiling' };
      tap.disconnect(an); return r; })()`;
    const measureInput = measure.replace("const tap = (typeof outputSum !== 'undefined' && outputSum) || (typeof outputCeiling !== 'undefined' && outputCeiling) || masterLimiter;", 'const tap = sourceNode;').replace("tap: tap === masterLimiter ? 'limiter' : (typeof outputSum !== 'undefined' && tap === outputSum) ? 'output' : 'ceiling'", "tap: 'source'");
    const setParams = (params) => writeFrom(popup, { type: 'EDIT_PARAMS', params });

    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(400);
    const flat = (await evalOffscreen(measure)).value;
    const source = (await evalOffscreen(measureInput)).value;

    await setParams({ bass: 10, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(400);
    const boosted = (await evalOffscreen(measure)).value;
    const lift60 = boosted && flat ? boosted.hz60 - flat.hz60 : null;
    const lift1k = boosted && flat ? boosted.hz1k - flat.hz1k : null;
    // Two long-standing traits of the default path, part of the sound since 1.0 and frozen with it (A-03): the 20 Hz
    // high-pass sits about +0.5 dB at 60 Hz (Web Audio reads a high-pass filter's Q in dB, so 0.707 is a mild resonance),
    // and the safety limiter adds about +0.17 dB of static makeup gain. Hence 0.3 dB at 1 kHz / 8 kHz and +1.0 dB at 60 Hz.
    record('W-AUDIO-TRANSPARENT', 'Flat settings pass the tone at its original level: input peak 0.15; 1 kHz and 8 kHz within 0.3 dB of the untouched source, 60 Hz within +1.0 / −0.3 dB (the 20 Hz high-pass\'s known bump)',
      flat && source && Math.abs(flat.peak - 0.15) < 0.01 && Math.abs(flat.hz1k - source.hz1k) < 0.3 && Math.abs(flat.hz8k - source.hz8k) < 0.3 && flat.hz60 - source.hz60 < 1.0 && flat.hz60 - source.hz60 > -0.3 ? 'PASS' : 'FAIL',
      { source, flat, hpfBumpAt60Hz: flat && source ? +(flat.hz60 - source.hz60).toFixed(2) : null }, 'objective-audio');
    record('W-AUDIO-BASS', 'Bass +10 dB lifts 60 Hz relative to 1 kHz (objective FFT, final output)',
      lift60 !== null && lift60 > 6 && Math.abs(lift1k) < 2 ? 'PASS' : 'FAIL', { flat, boosted, lift60: lift60?.toFixed(1), lift1k: lift1k?.toFixed(1) }, 'objective-audio');

    // ---- W-LIVE-SPECTRUM: the screen's live strip shows the real audio: tone peaks on the input, the bass lift on the output ----
    await sleep(1800); // the popup notices capture via its 1 s poll, then frames flow at ~15 fps
    const live = await popup.evaluate(async () => {
      const f0 = physics.frames;
      await new Promise((r) => setTimeout(r, 500));
      const fr = physics.frame;
      if (!fr) return { hasFrame: false, framesAdvanced: physics.frames - f0 };
      const idx = (hz) => Math.min(71, Math.floor(Math.log(hz / 20) / Math.log(1000) * 72));
      const i60 = idx(60), i1k = idx(1000), i8k = idx(8000), iQuiet = idx(300);
      return { hasFrame: true, framesAdvanced: physics.frames - f0,
        in60: fr.input[i60], inQuiet: fr.input[iQuiet], in1k: fr.input[i1k], in8k: fr.input[i8k],
        out60: fr.output[i60], out1k: fr.output[i1k], liftShown60: +(fr.output[i60] - fr.input[i60]).toFixed(1), liftShown1k: +(fr.output[i1k] - fr.input[i1k]).toFixed(1) };
    });
    record('W-LIVE-SPECTRUM', 'Live strip is real: input shows the tone peaks (60 Hz, 1 kHz, 8 kHz) and the output shows the +10 dB bass lift at 60 Hz only',
      live.hasFrame && live.framesAdvanced > 3 && live.in60 - live.inQuiet > 20 && live.in1k - live.inQuiet > 20 && live.in8k - live.inQuiet > 20
        && live.liftShown60 > 6 && Math.abs(live.liftShown1k) < 2 ? 'PASS' : 'FAIL', live, 'objective-audio');
    await shot(popup, 'popup-live.png');

    // ---- W-AUDIO-BAND-SWITCH: LOW off keeps the slider at +10 but removes the lift ----
    await setParams({ bass: 10, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: { ...NONE, bass: true } });
    await sleep(400);
    const bassOff = (await evalOffscreen(measure)).value;
    const liftOff = bassOff && flat ? bassOff.hz60 - flat.hz60 : null;
    record('W-AUDIO-BAND-SWITCH', 'With the LOW band switched off, bass +10 dB has no effect (60 Hz back to flat)',
      liftOff !== null && Math.abs(liftOff) < 1 && lift60 > 6 ? 'PASS' : 'FAIL', { flat, bassOff, liftWithBandOff: liftOff?.toFixed(1), liftWithBandOn: lift60?.toFixed(1) }, 'objective-audio');

    await setParams({ bass: 0, hpf: 200, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(500);
    const hpf = (await evalOffscreen(measure)).value;
    const cut60 = hpf && flat ? flat.hz60 - hpf.hz60 : null;
    record('W-AUDIO-HPF', 'HPF at 200 Hz attenuates 60 Hz by >15 dB (objective FFT)',
      cut60 !== null && cut60 > 15 ? 'PASS' : 'FAIL', { flat, hpf200: hpf, cut60: cut60?.toFixed(1) }, 'objective-audio');

    // ---- W-PITCH: Pitch shifts the key, not the speed (P-01, 1.4.0): +12 st moves the 1 kHz tone to 2 kHz and −12 st to
    // 500 Hz at the final output, the page keeps playing at normal speed, and 0 st or the band switch routes around the shifter ----
    const pitchRouting = async () => (await evalOffscreen(`({ available: !!pitchNode, error: pitchError, wet: pitchWetGain && +pitchWetGain.gain.value.toFixed(2), dry: pitchDryGain && +pitchDryGain.gain.value.toFixed(2) })`)).value;
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 12, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(800);
    const up = (await evalOffscreen(measure)).value;
    const upRouting = await pitchRouting();
    const pageRate = await media.evaluate(() => document.getElementById('a').playbackRate);
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: -12, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(800);
    const down = (await evalOffscreen(measure)).value;
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 12, autoBalance: false, bypass: false, stageBypass: { ...NONE, pitch: true } });
    await sleep(500);
    const pitchOff = (await evalOffscreen(measure)).value;
    const offRouting = await pitchRouting();
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(500);
    const zero = (await evalOffscreen(measure)).value;
    const zeroRouting = await pitchRouting();
    const tagFits = await popup.evaluate(() => { const t = document.querySelector('.band-tag[data-band="pitch"]'); return t.scrollWidth <= t.clientWidth + 1; });
    const moved = !!(up && down && flat) && up.hz2k > flat.hz1k - 4 && up.hz1k < flat.hz1k - 15 && down.hz500 > flat.hz1k - 4 && down.hz1k < flat.hz1k - 15;
    const level = !!(up && down) && up.peak > 0.05 && up.peak < 0.35 && down.peak > 0.05 && down.peak < 0.35;
    record('W-PITCH', 'Pitch +12 st moves the 1 kHz tone to 2 kHz and −12 st to 500 Hz (objective FFT, final output) while the page plays at normal speed; the band switch and 0 st route around the shifter; PITCH tag fits',
      moved && level && upRouting?.available === true && upRouting.wet === 1 && upRouting.dry === 0 && pageRate === 1
        && offRouting?.dry === 1 && Math.abs(pitchOff.hz1k - flat.hz1k) < 1 && zeroRouting?.dry === 1 && Math.abs(zero.hz1k - flat.hz1k) < 1 && tagFits ? 'PASS' : 'FAIL',
      { flat, up, down, pitchOff, zero, upRouting, offRouting, zeroRouting, pageRate, tagFits }, 'objective-audio');

    // ---- W-PITCH-RECOVER (1.5.2): a jump across the whole range (−12 to +12 st) can run the shifter dry; it must come
    // back by itself (the unshifted path holds at least 0.5 s, then the shifted path reopens) and end up shifted ----
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: -12, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(1500);
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 12, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(3000);
    const jumped = (await evalOffscreen(measure)).value;
    const jumpedRouting = await pitchRouting();
    const jumpedPrimed = (await evalOffscreen('pitchPrimed')).value;
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(800);
    const parkedAgain = (await evalOffscreen(`({ primed: pitchPrimed, target: pitchTarget(), param: pitchNode && pitchNode.parameters.get('semitones').value })`)).value;
    record('W-PITCH-RECOVER', 'After a jump from −12 to +12 st the shifted path is open again within 3 s and the tone is at 2 kHz; back at 0 st the shifter parks',
      jumpedRouting?.wet === 1 && jumpedRouting?.dry === 0 && jumpedPrimed === true && !!jumped && jumped.hz2k > flat.hz1k - 4 && jumped.hz1k < flat.hz1k - 15
        && parkedAgain?.primed === false && parkedAgain?.target === 0 && parkedAgain?.param === 0 ? 'PASS' : 'FAIL',
      { jumped, jumpedRouting, jumpedPrimed, parkedAgain }, 'objective-audio');

    await setParams({ bass: 14, hpf: 20, mid: 6, high: 6, gain: 2.5, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(500);
    const hot = (await evalOffscreen(measure)).value;
    record('W-AUDIO-LIMITER', 'Worst-case settings (bass +14, mid/high +6, 250%) never exceed -0.3 dBFS at the output',
      hot && hot.peak <= 0.967 ? 'PASS' : 'FAIL', { hot, note: 'linear sample peak; 0.966 = -0.3 dBFS, 1.0 = 0 dBFS' }, 'objective-audio');

    // ---- W-DYN-BASELINE: the sound of 1.4.0, measured. Six settings (AUTO off and on) at the final output; every later
    // build must reproduce them in its default modes (the user's rule of 2026-10-04: nothing about the audio processing
    // changes without asking). ----
    const scenario = async (params, settle = 700) => { await setParams(params); await sleep(settle); return (await evalOffscreen(measure)).value; };
    const BASE = { hpf: 20, mid: 0, high: 0, semitones: 0, bypass: false, stageBypass: NONE };
    const baselineSet = {
      flatOff: { ...BASE, bass: 0, gain: 1, autoBalance: false },
      bass10Off: { ...BASE, bass: 10, gain: 1, autoBalance: false },
      hotOff: { ...BASE, bass: 14, mid: 6, high: 6, gain: 2.5, autoBalance: false },
      flatAuto: { ...BASE, bass: 0, gain: 1, autoBalance: true },
      heavyAuto: { ...BASE, bass: 14, gain: 1.5, autoBalance: true },
      deepAuto: { ...BASE, bass: 8, hpf: 25, high: 1, gain: 1, autoBalance: true }
    };
    const baselineNow = {};
    for (const [name, p] of Object.entries(baselineSet)) baselineNow[name] = await scenario(p);
    // Provenance: the first constants were FFT-bin readings taken on 1.4.0 at 48 kHz (tests/results/baseline-140-dyn), and
    // 1.5.0 reproduced all six with no difference (tests/results/review-v1.5.0). The readings below are the exact-frequency
    // measurement of that same, proven-identical default path, so they hold at any sample rate (re-derived 2026-10-04).
    const BASELINE_140 = { flatOff: { hz60: -25.3, hz1k: -25.8, hz8k: -25.8, peak: 0.149 }, bass10Off: { hz60: -16, hz1k: -25.8, hz8k: -25.8, peak: 0.253 }, hotOff: { hz60: -4.9, hz1k: -12.4, hz8k: -12.9, peak: 0.965 }, flatAuto: { hz60: -22.5, hz1k: -23, hz8k: -23, peak: 0.207 }, heavyAuto: { hz60: -6.7, hz1k: -20.1, hz8k: -20.1, peak: 0.647 }, deepAuto: { hz60: -14.9, hz1k: -23.2, hz8k: -22.3, peak: 0.317 } }; // 48 kHz run of 2026-10-04 (tests/results/candidate-151c)
    // The levels are rate-independent; a sample peak is not (a finer grid lands nearer each crest). Peaks at 96 kHz were
    // measured on 1.5.1 itself, unchanged since 1.4.0 (tests/results/control-1.5.1-96k, 2026-10-10); other rates: levels only.
    const PEAK_96K = { flatOff: 0.155, bass10Off: 0.26, hotOff: 0.965, flatAuto: 0.216, heavyAuto: 0.658, deepAuto: 0.324 };
    const rateNow = baselineNow.flatOff?.rate;
    const peakOf = (k) => rateNow === 48000 ? BASELINE_140[k].peak : rateNow === 96000 ? PEAK_96K[k] : null;
    const same = (a, b, k) => !!a && !!b && ['hz60', 'hz1k', 'hz8k'].every((m) => Math.abs(a[m] - b[m]) <= 0.3) && (peakOf(k) === null || Math.abs(a.peak - peakOf(k)) <= 0.004);
    const baselineDiff = BASELINE_140 ? Object.keys(baselineSet).filter((k) => !same(baselineNow[k], BASELINE_140[k], k)) : Object.keys(baselineSet);
    record('W-DYN-BASELINE', 'Default modes reproduce the measured sound of 1.4.0: six settings (AUTO off and on), 60 Hz / 1 kHz / 8 kHz within 0.3 dB and peak within 0.004 at the final output',
      BASELINE_140 && baselineDiff.length === 0 ? 'PASS' : 'FAIL', { baselineNow, baseline140: BASELINE_140, peak96k: PEAK_96K, rate: rateNow, peaksCompared: peakOf('flatOff') !== null, differs: baselineDiff }, 'objective-audio');

    // ---- W-DYN-*: the switchable alternatives (1.5.0, D-01), each measured at the final output ----
    const setDyn = (d) => writeFrom(popup, { type: 'EDIT_DYNAMICS', dynamics: d });
    const dynState = async () => (await evalOffscreen(`({ eff: effectiveDynamics(), err: dynError,
      band: bandLevelerGain && +bandLevelerGain.gain.value.toFixed(2), wet: autoBalanceWetGain && +autoBalanceWetGain.gain.value.toFixed(2), dry: autoBalanceBypassGain && +autoBalanceBypassGain.gain.value.toFixed(2),
      release: autoBalanceComp && +autoBalanceComp.release.value.toFixed(2), matchWet: matchWetGain && +matchWetGain.gain.value.toFixed(2), matchDry: matchDryGain && +matchDryGain.gain.value.toFixed(2),
      la: lookaheadGain && +lookaheadGain.gain.value.toFixed(2), fast: limiterFastGain && +limiterFastGain.gain.value.toFixed(2), warm: ceilingWarmGain && +ceilingWarmGain.gain.value.toFixed(2), clean: ceilingCleanGain && +ceilingCleanGain.gain.value.toFixed(2),
      meters: dynamicsFrame(), rate: audioCtx.sampleRate })`)).value;
    const DEFAULT_DYN = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' };

    // W-DYN-LEVELER-BASS: "Bass only" turns the boosted 60 Hz down and leaves 1 kHz and 8 kHz exactly as with AUTO off;
    // "Full band" (the original) moves everything.
    const heavy1 = { ...BASE, bass: 14, gain: 1 };
    const autoOff = await scenario({ ...heavy1, autoBalance: false });
    await setDyn({ ...DEFAULT_DYN, leveler: 'bass' });
    const bassMode = await scenario({ ...heavy1, autoBalance: true }, 1000);
    const bassState = await dynState();
    await setDyn({ ...DEFAULT_DYN, leveler: 'full' });
    const fullMode = await scenario({ ...heavy1, autoBalance: true }, 1000);
    const fullState = await dynState();
    record('W-DYN-LEVELER-BASS', 'AUTO "Bass only": with bass +14 dB it turns 60 Hz down by 2 dB or more while 1 kHz and 8 kHz stay within 0.5 dB of AUTO off; "Full band" moves 1 kHz as well (objective FFT); routing and meter agree',
      !!(autoOff && bassMode && fullMode) && bassMode.hz60 <= autoOff.hz60 - 2 && Math.abs(bassMode.hz1k - autoOff.hz1k) <= 0.5 && Math.abs(bassMode.hz8k - autoOff.hz8k) <= 0.5
        && Math.abs(fullMode.hz1k - autoOff.hz1k) > 1 && bassState?.eff?.leveler === 'bass' && bassState.band === 1 && bassState.wet === 0 && bassState.meters?.leveler >= 1
        && fullState?.band === 0 && fullState.wet === 1 ? 'PASS' : 'FAIL',
      { autoOff, bassMode, fullMode, bassState, fullState, cut60: +(autoOff.hz60 - bassMode.hz60).toFixed(1) }, 'objective-audio');

    // W-DYN-LEVELER-SLOW: "Slow release" is the same compressor with a 0.6 s release: the same steady level, a slower
    // recovery. The recovery is read from the output envelope (RMS every 25 ms after all three boosts are removed, inside
    // the engine so both timings are comparable); the node's own `reduction` readout cannot be used, Chrome smooths it
    // with a 0.33 s metering constant of its own.
    const heavy3 = { ...BASE, bass: 14, mid: 6, high: 6, gain: 1, autoBalance: true };
    const recoverySnippet = `(async () => {
      const n = audioCtx.sampleRate > 60000 ? 4096 : 2048; // about 43 ms at 48 or 96 kHz (a 21 ms window at 96 kHz was too noisy)
      const an = audioCtx.createAnalyser(); an.fftSize = n; an.smoothingTimeConstant = 0; outputSum.connect(an);
      const buf = new Float32Array(n);
      const rms = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
      updateParams({ bass: 0, mid: 0, high: 0 });
      const out = []; for (let i = 0; i < 56; i++) { await new Promise(r => setTimeout(r, 25)); out.push(+rms().toFixed(4)); }
      outputSum.disconnect(an); return out; })()`;
    // After the boosts go (a 30 ms ramp) the level settles; while the gain is still recovering the output sits below its
    // final value. The deficit summed over 100 to 350 ms after the step is the measure: near zero when the gain has already
    // recovered during the ramp (0.2 s release), clearly positive when it has not (0.6 s release).
    const deficit = (arr) => {
      if (!arr || arr.length < 24) return { deficit: -1, minAfter100ms: 0, end: 0 };
      const vEnd = arr.slice(-8).reduce((a, b) => a + b, 0) / 8;
      let d = 0, mn = Infinity;
      for (let k = 4; k <= 14; k++) { d += Math.max(0, vEnd - arr[k]) / vEnd; if (arr[k] < mn) mn = arr[k]; }
      return { deficit: +d.toFixed(3), minAfter100ms: mn, end: +vEnd.toFixed(4), minBelowEndPct: +((1 - mn / vEnd) * 100).toFixed(1) };
    };
    await setDyn({ ...DEFAULT_DYN, leveler: 'full' });
    await scenario(heavy3, 1200);
    const fastRecovery = (await evalOffscreen(recoverySnippet)).value;
    await setDyn({ ...DEFAULT_DYN, leveler: 'slow' });
    const slowMode = await scenario({ ...heavy1, autoBalance: true }, 1000);
    const slowState = await dynState();
    await scenario(heavy3, 1200);
    const slowRecovery = (await evalOffscreen(recoverySnippet)).value;
    await setDyn(DEFAULT_DYN);
    await sleep(300);
    const afterSlow = await dynState();
    const dFast = deficit(fastRecovery), dSlow = deficit(slowRecovery);
    record('W-DYN-LEVELER-SLOW', 'AUTO "Slow release": release 0.6 s instead of 0.2 s; the steady level is the same as "Full band" within 0.3 dB; after the boosts are removed the output stays measurably lower for longer (deficit over 100 to 350 ms at least 0.05 above "Full band"); back to "Full band" restores 0.2 s',
      !!(slowMode && fullMode) && Math.abs(slowMode.hz60 - fullMode.hz60) <= 0.3 && Math.abs(slowMode.hz1k - fullMode.hz1k) <= 0.3 && slowState?.release === 0.6 && afterSlow?.release === 0.2
        && dFast.deficit >= 0 && dSlow.deficit >= dFast.deficit + 0.05 ? 'PASS' : 'FAIL',
      { fullMode, slowMode, releaseSlow: slowState?.release, releaseAfter: afterSlow?.release, recovery: { full: dFast, slow: dSlow }, envelopeFull: fastRecovery, envelopeSlow: slowRecovery, note: 'RMS every 25 ms after bass/mid/high go from +14/+6/+6 to 0 with AUTO on' }, 'objective-audio');

    // W-DYN-MATCH: the loudness match brings the K-weighted level of bass +14 dB back to the untouched level (within 1 dB).
    // K-weighting (ITU-R BS.1770) evaluated at the three tones with the same filter design the worklet uses.
    const rate = fullState?.rate || 48000;
    const rbj = (type, f0, Q, fs, gainDb = 0) => {
      const w0 = 2 * Math.PI * f0 / fs, cosw = Math.cos(w0), sinw = Math.sin(w0), alpha = sinw / (2 * Q);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'highpass') { b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2; a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha; }
      else { const A = Math.pow(10, gainDb / 40), sA = 2 * Math.sqrt(A) * alpha; b0 = A * ((A + 1) + (A - 1) * cosw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cosw); b2 = A * ((A + 1) + (A - 1) * cosw - sA); a0 = (A + 1) - (A - 1) * cosw + sA; a1 = 2 * ((A - 1) - (A + 1) * cosw); a2 = (A + 1) - (A - 1) * cosw - sA; }
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    };
    const magDb = (c, f, fs) => { const w = 2 * Math.PI * f / fs; const nr = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w), ni = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w)); const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w), di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w)); return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di)); };
    const kShelf = rbj('highshelf', 1681.974450955533, 0.7071752369554196, rate, 3.999843853973347), kHpf = rbj('highpass', 38.13547087602444, 0.5003270373238773, rate);
    const kW = (f) => magDb(kShelf, f, rate) + magDb(kHpf, f, rate);
    const loud = (m) => 10 * Math.log10([[60, m.hz60], [1000, m.hz1k], [8000, m.hz8k]].reduce((acc, [f, lvl]) => acc + Math.pow(10, (lvl + kW(f)) / 10), 0));
    await setDyn({ ...DEFAULT_DYN, match: true });
    const matched = await scenario({ ...heavy1, autoBalance: false }, 4000);
    const matchState = await dynState();
    await setDyn(DEFAULT_DYN);
    const unmatched = await scenario({ ...heavy1, autoBalance: false }, 600);
    const unmatchedState = await dynState();
    const loudIn = loud(flat), loudOff = loud(autoOff), loudOn = loud(matched);
    record('W-DYN-MATCH', 'MATCH: with bass +14 dB the output is as loud as the untouched tab within 1 dB (K-weighted, ITU-R BS.1770) where it was 3 dB or more louder without it; the trim is reported; off restores the level',
      !!(matched && unmatched) && Math.abs(loudOn - loudIn) <= 1 && loudOff - loudIn >= 3 && matchState?.eff?.match === true && matchState.matchWet === 1 && matchState.meters?.match <= -3
        && unmatchedState?.matchDry === 1 && Math.abs(unmatched.hz60 - autoOff.hz60) <= 0.3 ? 'PASS' : 'FAIL',
      { kWeightsDb: { hz60: +kW(60).toFixed(2), hz1k: +kW(1000).toFixed(2), hz8k: +kW(8000).toFixed(2) }, loudness: { untouched: +loudIn.toFixed(2), bass14NoMatch: +loudOff.toFixed(2), bass14Match: +loudOn.toFixed(2) },
        trimReported: matchState?.meters?.match, matched, unmatched, autoOff }, 'objective-audio');

    // W-DYN-LIMITER-LOOKAHEAD: at the worst-case settings the look-ahead limiter holds the output at or under 0.93 (its
    // ceiling) so the output ceiling has nothing to bend; the fast limiter (original) reproduces the 1.4.0 peak afterwards.
    const hotP = { ...BASE, bass: 14, mid: 6, high: 6, gain: 2.5, autoBalance: false };
    await setDyn({ ...DEFAULT_DYN, limiter: 'lookahead' });
    const la = await scenario(hotP, 1000);
    const laState = await dynState();
    await setDyn(DEFAULT_DYN);
    const fastAgain = await scenario(hotP, 800);
    const fastState = await dynState();
    record('W-DYN-LIMITER-LOOKAHEAD', 'LIM "Look-ahead": worst-case settings never exceed 0.93 (−0.63 dBFS) at the output, the ceiling bends nothing (meter 0) while the limiter meter shows work; "Fast" restores the 1.4.0 peak',
      !!(la && fastAgain) && la.peak <= 0.931 && la.peak >= 0.85 && laState?.eff?.limiter === 'lookahead' && laState.la === 1 && laState.fast === 0 && laState.meters?.ceiling === 0 && laState.meters?.limiter >= 0.5
        && Math.abs(fastAgain.peak - hot.peak) <= 0.004 && fastState?.fast === 1 && fastState.meters?.limiter >= 0.5 ? 'PASS' : 'FAIL',
      { lookahead: la, fastAgain, hot140: hot, laState, fastState, distortion: { lookahead: { hz180: la?.hz180, hz2k: la?.hz2k, hz3k: la?.hz3k }, fast: { hz180: hot.hz180, hz2k: hot.hz2k, hz3k: hot.hz3k } } }, 'objective-audio');

    // W-DYN-CEILING-WARM: the warm ceiling is still a hard guarantee (never above 0.966), is transparent at a quiet level,
    // and adds harmonic colour at the worst-case level (a distortion product rises by 6 dB or more); clean restores 1.4.0.
    await setDyn({ ...DEFAULT_DYN, ceiling: 'warm' });
    const warmFlat = await scenario({ ...BASE, bass: 0, gain: 1, autoBalance: false }, 600);
    const warm = await scenario(hotP, 900);
    const warmState = await dynState();
    await setDyn(DEFAULT_DYN);
    const cleanAgain = await scenario(hotP, 800);
    const cleanState = await dynState();
    const colour = Math.max(warm.hz180 - hot.hz180, warm.hz2k - hot.hz2k, warm.hz3k - hot.hz3k);
    record('W-DYN-CEILING-WARM', 'CEIL "Warm": never above 0.966 at the worst case, within 0.15 dB of clean at the quiet level, adds 6 dB or more of harmonic colour at the worst case; the ceiling meter reports the bend; "Clean" restores the 1.4.0 output',
      !!(warm && warmFlat && cleanAgain) && warm.peak <= 0.966 && Math.abs(warmFlat.hz1k - flat.hz1k) <= 0.15 && Math.abs(warmFlat.peak - flat.peak) <= 0.003 && colour >= 6
        && warmState?.eff?.ceiling === 'warm' && warmState.warm === 1 && warmState.clean === 0 && warmState.meters?.ceiling >= 1
        && Math.abs(cleanAgain.peak - hot.peak) <= 0.004 && Math.abs(cleanAgain.hz1k - hot.hz1k) <= 0.3 && cleanState?.clean === 1 ? 'PASS' : 'FAIL',
      { warmFlat, flat, warm, hot140: hot, cleanAgain, colourDb: +colour.toFixed(1), warmState, cleanState }, 'objective-audio');

    // ---- W-AUDIO-EXTREME (1.5.9, E-03): the doubled-again ends. Bass +56 really lifts 60 Hz beyond +28, Mid/High reach
    // ±24 dB, and at the worst case (bass +56, mid/high +24, 250 %) every combination of the switches stays finite and
    // under the sample ceiling. The defaults are not changed here; W-DYN-BASELINE above still holds the 1.4.0 sound. ----
    const quiet = { ...BASE, gain: 0.5, autoBalance: false };
    const b28 = await scenario({ ...quiet, bass: 28 });
    const b56 = await scenario({ ...quiet, bass: 56 });
    const ends = await scenario({ ...quiet, bass: 0, mid: 24, high: 24 });
    const cuts = await scenario({ ...quiet, bass: 0, mid: -24, high: -24 });
    const flatQ = await scenario({ ...quiet, bass: 0 });
    const extremeP = { ...BASE, bass: 56, mid: 24, high: 24, gain: 2.5 };
    const combos = [];
    for (const limiter of ['fast', 'lookahead']) for (const ceiling of ['clean', 'warm']) {
      combos.push({ autoBalance: false, dyn: { ...DEFAULT_DYN, limiter, ceiling } });
      for (const leveler of ['full', 'slow', 'bass']) combos.push({ autoBalance: true, dyn: { ...DEFAULT_DYN, leveler, limiter, ceiling } });
    }
    combos.push({ autoBalance: true, dyn: { ...DEFAULT_DYN, match: true } });
    const extreme = [];
    for (const c of combos) {
      await setDyn(c.dyn);
      const r = await scenario({ ...extremeP, autoBalance: c.autoBalance }, 800);
      extreme.push({ ...c, peak: r?.peak, hz60: r?.hz60, hz1k: r?.hz1k, ok: !!r && [r.peak, r.hz60, r.hz1k, r.hz8k].every(Number.isFinite) && r.peak <= 0.967 });
    }
    await setDyn(DEFAULT_DYN);
    // The screen at the worst case with AUTO on: a bar's aria-valuenow stays inside its declared 0..12 while the figure and
    // the screen-reader text carry the true reading, which can be larger.
    await setParams({ ...extremeP, autoBalance: true });
    await sleep(1400);
    const extremeMeters = await popup.evaluate(() => ['comp', 'match', 'limiter', 'ceiling'].map((k) => {
      const bar = document.getElementById(`meter-${k}`), val = document.getElementById(`val-${k}`);
      return { k, now: +bar.getAttribute('aria-valuenow'), max: +bar.getAttribute('aria-valuemax'), text: bar.getAttribute('aria-valuetext'), shown: val.textContent };
    }));
    const lift = b28 && b56 ? +(b56.hz60 - b28.hz60).toFixed(1) : null;
    record('W-AUDIO-EXTREME', 'Doubled-again ranges (1.5.9): bass +56 lifts 60 Hz beyond +28; mid and high +24 lift 1 kHz and 8 kHz by 18 dB or more and −24 cuts them by 18 dB or more; at bass +56, mid/high +24, 250 % all 17 switch combinations stay finite and at or under 0.967; meter aria-valuenow stays within 0..12 and the screen-reader text matches the figure',
      lift !== null && lift > 0 && ends && cuts && flatQ
        && ends.hz1k - flatQ.hz1k >= 18 && ends.hz8k - flatQ.hz8k >= 18 && flatQ.hz1k - cuts.hz1k >= 18 && flatQ.hz8k - cuts.hz8k >= 18
        && extreme.length === 17 && extreme.every((e) => e.ok)
        && extremeMeters.every((m) => m.now >= 0 && m.now <= m.max && m.max === 12 && m.text === m.shown) ? 'PASS' : 'FAIL',
      { b28, b56, liftBeyond28: lift, flatQ, ends, cuts, extreme, extremeMeters }, 'objective-audio');

    // W-DYN-METERS-UI: the screen's bars and figures follow the engine while the EQ works (AUTO on, worst case: the leveler,
    // the limiter and the ceiling all show work), the match reads 0.0 dB while off, and a menu change and the MATCH tag persist.
    await setParams({ ...hotP, autoBalance: true });
    await sleep(1200);
    const metersUi = await popup.evaluate(() => {
      const read = (k) => { const bar = document.getElementById(`meter-${k}`), val = document.getElementById(`val-${k}`); return { text: val.textContent, idle: val.classList.contains('idle'), now: +bar.getAttribute('aria-valuenow'), width: bar.firstElementChild.getBoundingClientRect().width, cls: bar.className }; };
      return { comp: read('comp'), match: read('match'), limiter: read('limiter'), ceiling: read('ceiling') };
    });
    await showSurface(popup); // the harness's direct writes came from another screen
    await popup.selectOption('#mode-leveler', 'bass');
    await popup.click('.band-tag[data-band="match"]');
    await sleep(500);
    const storedDyn = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('dynamics', (d) => r(d.dynamics || null))));
    const engineDyn = await dynState();
    const popupD = adopt(await openPopup());
    const reopenedDyn = await popupD.evaluate(() => ({ leveler: document.getElementById('mode-leveler').value, matchPressed: document.querySelector('.band-tag[data-band="match"]').getAttribute('aria-pressed'), rowOff: document.querySelector('.eq-row[data-band="match"]').classList.contains('is-off') }));
    await popupD.close();
    await popup.selectOption('#mode-leveler', 'full');
    await popup.click('.band-tag[data-band="match"]');
    await sleep(400);
    const restoredDyn = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('dynamics', (d) => r(d.dynamics || null))));
    const dbOf = (t) => parseFloat(String(t).replace('−', '-'));
    record('W-DYN-METERS-UI', 'Meters on the screen: with AUTO on at the worst case the leveler, limiter and ceiling bars and figures show work and the match reads 0.0 dB while off; the Leveler menu and the MATCH tag persist to storage, reach the engine and show again on reopening; defaults restored',
      metersUi.comp.now >= 0.5 && dbOf(metersUi.comp.text) <= -0.5 && metersUi.comp.width > 0 && metersUi.limiter.now >= 0.5 && metersUi.ceiling.now >= 0.1 && !metersUi.comp.idle
        && metersUi.match.text === '0.0 dB' && storedDyn?.leveler === 'bass' && storedDyn.match === true && engineDyn?.eff?.leveler === 'bass' && engineDyn.eff.match === true
        && reopenedDyn.leveler === 'bass' && reopenedDyn.matchPressed === 'true' && !reopenedDyn.rowOff && restoredDyn?.leveler === 'full' && restoredDyn.match === false ? 'PASS' : 'FAIL',
      { metersUi, storedDyn, engineEff: engineDyn?.eff, reopenedDyn, restoredDyn }, 'installed-browser');
    await shot(popup, 'popup-meters.png');
    await setDyn(DEFAULT_DYN);

    // ---- W-PRESET-SWITCHES (1.5.8, R-28): a saved preset brings its switches back; a legacy one does not ----
    const switchSnap = await popup.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get(['presets', 'currentPreset', 'currentParams', 'dynamics'], (local) => {
        chrome.storage.session.get('presetSwitchBaseline', (session) => {
          resolve({ local, baseline: session.presetSwitchBaseline || null });
        });
      });
    }));
    const WANTED = { leveler: 'bass', match: true, limiter: 'lookahead', ceiling: 'warm' };
    const OTHER = { leveler: 'slow', match: false, limiter: 'fast', ceiling: 'clean' };
    const readModes = (pg) => pg.evaluate(() => {
      const label = document.getElementById('preset-switch-label');
      const row = document.querySelector('.section-title-row');
      const reset = document.getElementById('btn-reset-defaults');
      const lr = label.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const br = reset.getBoundingClientRect();
      return {
        leveler: document.getElementById('mode-leveler').value,
        limiter: document.getElementById('mode-limiter').value,
        ceiling: document.getElementById('mode-ceiling').value,
        match: document.querySelector('.band-tag[data-band="match"]').getAttribute('aria-pressed') === 'true',
        label: label.textContent,
        labelTitle: label.title,
        badge: document.getElementById('preset-status-badge').textContent.trim(),
        updateTitle: document.getElementById('btn-update-preset').title,
        resetTitle: reset.title,
        saveTitle: document.getElementById('btn-save-preset').title,
        updateShown: getComputedStyle(document.getElementById('btn-update-preset')).display !== 'none',
        preset: document.getElementById('preset-select').value,
        rowH: +rr.height.toFixed(1),
        labelInside: lr.width > 0 && lr.left >= rr.left - 1 && lr.right <= rr.right + 1 && label.scrollWidth <= label.clientWidth + 1,
        resetInside: br.width > 0 && br.left >= rr.left - 1 && br.right <= rr.right + 1 && reset.scrollWidth <= reset.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    const setModes = async (pg, d) => {
      await pg.selectOption('#mode-leveler', d.leveler);
      await pg.selectOption('#mode-limiter', d.limiter);
      await pg.selectOption('#mode-ceiling', d.ceiling);
      const on = await pg.getAttribute('.band-tag[data-band="match"]', 'aria-pressed');
      if ((on === 'true') !== d.match) await pg.click('.band-tag[data-band="match"]');
      await sleep(250);
    };
    const sameDyn = (a, b) => !!a && !!b && a.leveler === b.leveler && a.match === b.match && a.limiter === b.limiter && a.ceiling === b.ceiling;
    let switchDetail = {};
    let switchOk = false;
    try {
      await showSurface(popup);
      await setModes(popup, WANTED);
      await popup.click('#btn-save-preset');
      await sleep(400);
      const savedPreset = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('presets', (d) => r(d.presets?.['Harness Preset'] || null))));
      const savedJson = JSON.stringify(savedPreset);
      await setModes(popup, OTHER);
      const reopened = adopt(await openPopup());
      const hydrated = await readModes(reopened);
      await reopened.close();
      await popup.selectOption('#preset-select', 'Flat (Bypass)');
      await sleep(300);
      const onFactory = await readModes(popup);
      const dynWhileFactory = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('dynamics', (d) => r(d.dynamics))));
      await popup.selectOption('#preset-select', 'Harness Preset');
      await sleep(350);
      const back = await readModes(popup);
      const curve = await popup.evaluate(() => {
        const readout = document.getElementById('physics-readout').textContent || '';
        const bass = parseFloat(document.getElementById('slider-bass').value);
        const match = /Low (off|[+-]?\d+(?:\.\d+)?)/.exec(readout);
        const shown = match && match[1] !== 'off' ? parseFloat(match[1]) : null;
        return { readout, bass, shown };
      });
      const storedBack = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get('dynamics', (d) => r(d.dynamics))));
      const engineBack = await dynState();
      await setModes(popup, OTHER);
      await popup.click('#btn-reset-defaults');
      await sleep(400);
      const afterReset = await readModes(popup);
      const storedReset = await popup.evaluate(() => new Promise((r) => chrome.storage.local.get(['dynamics', 'presets'], (d) => r({ dynamics: d.dynamics, preset: d.presets?.['Harness Preset'] || null }))));
      const engineReset = await dynState();
      const legacyBody = { bass: 14, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: true, bypass: false };
      await popup.evaluate((body) => new Promise((r) => chrome.storage.local.get('presets', (d) => {
        chrome.storage.local.set({ presets: { ...(d.presets || {}), 'Legacy EQ only': body } }, r);
      })), legacyBody);
      const legacyPage = adopt(await openPopup());
      await setModes(legacyPage, OTHER);
      const beforeLegacy = await legacyPage.evaluate(() => new Promise((r) => chrome.storage.local.get('dynamics', (d) => r(d.dynamics))));
      await legacyPage.selectOption('#preset-select', 'Legacy EQ only');
      await sleep(300);
      const onLegacy = await readModes(legacyPage);
      const storedLegacy = await legacyPage.evaluate(() => new Promise((r) => chrome.storage.local.get(['dynamics', 'presets'], (d) => r({ dynamics: d.dynamics, preset: d.presets?.['Legacy EQ only'] || null }))));
      await legacyPage.selectOption('#preset-select', 'Punchy Bass & Clarity');
      await sleep(250);
      const onFactoryLabel = await readModes(legacyPage);
      const storedFactory = await legacyPage.evaluate(() => new Promise((r) => chrome.storage.local.get('dynamics', (d) => r(d.dynamics))));
      await legacyPage.close();

      await showSurface(popup); // the legacy page wrote last
      await popup.selectOption('#preset-select', 'Harness Preset');
      await sleep(300);
      await popup.click('.eq-nudge-btn[data-target="slider-bass"][data-action="up"]');
      await sleep(200);
      const fitPopup = await readModes(popup);
      const panel = adopt(await openPopup('popup.html?panel=1'));
      await panel.setViewportSize({ width: 360, height: 900 });
      await sleep(300);
      await panel.selectOption('#preset-select', 'Harness Preset');
      await sleep(300);
      const fitPanel = await readModes(panel);
      const agreePanel = await readModes(panel);
      await panel.close();
      const win = adopt(await openPopup('popup.html?undocked=true'));
      await win.selectOption('#preset-select', 'Harness Preset');
      await sleep(300);
      const agreeWin = await readModes(win);
      await win.close();

      const surfacesAgree = sameDyn(back, WANTED) && agreePanel.label === 'EQ + switches' && agreeWin.label === 'EQ + switches'
        && agreePanel.labelTitle === back.labelTitle && agreeWin.labelTitle === back.labelTitle
        && sameDyn(agreePanel, WANTED) && sameDyn(agreeWin, WANTED);
      const curveMatches = curve.shown != null && Math.abs(curve.shown - curve.bass) < 0.05
        && savedPreset && Math.abs(curve.bass - savedPreset.bass) < 0.05;
      // Two screens stay open. The panel does not follow live: it refreshes when it is focused.
      // An Update from the panel after the popup has moved on is refused, writes nothing, and refreshes.
      const followPanel = adopt(await openPopup('popup.html?panel=1'));
      await followPanel.setViewportSize({ width: 360, height: 900 });
      await sleep(400);
      await followPanel.selectOption('#preset-select', 'Harness Preset');
      await sleep(300);
      const SLOW = { ...WANTED, leveler: 'slow' };
      await showSurface(popup); // the side panel and the window picked since the popup painted
      await setModes(popup, SLOW);
      await popup.click('#btn-update-preset');
      await sleep(500);
      const followBeforeFocus = await readModes(followPanel);
      await showSurface(followPanel);
      const followUpdated = await readModes(followPanel);
      await popup.selectOption('#preset-select', 'Flat (Bypass)');
      await sleep(400);
      const followStillHarness = await readModes(followPanel);
      await showSurface(followPanel);
      const followFlat = await readModes(followPanel);
      await popup.selectOption('#preset-select', 'Harness Preset');
      await sleep(400);
      await showSurface(followPanel);
      const followBack = await readModes(followPanel);
      const followCache = await followPanel.evaluate(() => new Promise((r) => {
        chrome.storage.local.get(['presets', 'currentPreset'], (d) => r({
          preset: d.currentPreset,
          saved: d.presets?.['Harness Preset']?.dynamics || null
        }));
      }));
      const harnessBefore = await followPanel.evaluate(() => new Promise((r) => {
        chrome.storage.local.get('presets', (d) => r(d.presets?.['Harness Preset'] || null));
      }));
      await followPanel.click('.eq-nudge-btn[data-target="slider-bass"][data-action="up"]');
      await sleep(200);
      await showSurface(popup); // the panel's nudge is the newest write
      await popup.selectOption('#preset-select', 'Flat (Bypass)');
      await sleep(400);
      await followPanel.click('#btn-update-preset');
      await sleep(500);
      const followRefused = await readModes(followPanel);
      const staleHint = await followPanel.evaluate(() => document.getElementById('hint').textContent);
      const harnessAfter = await followPanel.evaluate(() => new Promise((r) => {
        chrome.storage.local.get(['presets', 'currentPreset'], (d) => r({
          preset: d.currentPreset,
          saved: d.presets?.['Harness Preset'] || null
        }));
      }));
      // A switch changed on a screen that has not painted the newest pick writes nothing (Sol, round 3): the
      // popup picks Harness Preset while the panel still shows Flat; the panel's Ceiling change is refused and
      // the panel shows the stored preset with the hint.
      await popup.selectOption('#preset-select', 'Harness Preset');
      await sleep(400);
      const storedNow = (pg) => pg.evaluate(() => new Promise((r) => {
        chrome.storage.local.get(['currentPreset', 'currentParams', 'dynamics', 'stateRev', 'lastWriter'], (d) => r({
          preset: d.currentPreset, params: JSON.stringify(d.currentParams), dynamics: JSON.stringify(d.dynamics), stateRev: d.stateRev, lastWriter: d.lastWriter
        }));
      }));
      const staleSwitchBefore = await storedNow(followPanel);
      const panelBefore = await readModes(followPanel);
      await followPanel.evaluate(() => { document.getElementById('hint').textContent = ''; });
      await followPanel.selectOption('#mode-ceiling', panelBefore.ceiling === 'warm' ? 'clean' : 'warm');
      await sleep(500);
      const staleSwitchAfter = await storedNow(followPanel);
      const staleSwitchEngine = (await dynState())?.eff || null;
      const staleSwitchView = await readModes(followPanel);
      const staleSwitchHint = await followPanel.evaluate(() => document.getElementById('hint').textContent);
      await followPanel.close();
      // Round 4: hold only delivery of real worker replies. Check native disabled attributes while
      // the selection is committed but unconfirmed; then exercise each edit through the real DOM.
      const confirmation = await popup.evaluate(async () => {
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        const calls = [], held = [];
        const types = new Set(['APPLY_PRESET', 'RESET_DEFAULT_PRESETS', 'DELETE_PRESET']);
        let hold = true;
        chrome.runtime.sendMessage = (message, callback) => {
          if (message.type?.startsWith('EDIT_')) calls.push(JSON.parse(JSON.stringify(message)));
          if (hold && types.has(message.type) && callback) {
            return original(message, (res) => {
              const error = chrome.runtime.lastError;
              held.push(() => callback(error ? undefined : res));
            });
          }
          return original(message, callback);
        };
        const waitFor = async (fn) => {
          for (let i = 0; i < 200; i++) {
            if (fn()) return;
            await new Promise(r => setTimeout(r, 10));
          }
          throw Error('confirmation/edit did not settle');
        };
        const controls = () => [...document.querySelectorAll('.eq-slider, .eq-nudge-btn, button.band-tag, #mode-leveler, #mode-limiter, #mode-ceiling, #preset-select, #btn-save-preset, #btn-update-preset, #btn-delete-preset, #btn-reset-defaults')];
        const locked = () => controls().every(el => el.disabled && el.hasAttribute('disabled'));
        const unlocked = () => controls().every(el => !el.disabled && !el.hasAttribute('disabled'));
        const view = () => ({ name: currentPresetName, bass: currentParams.bass, dynamics: { ...dynamics } });
        const rounds = [];
        try {
          // Fresh view after the independent stale-switch check above.
          refreshPresetView();
          await waitFor(() => presetOpsInFlight === 0);
          const initial = view();
          for (const name of ['Flat (Bypass)', 'Harness Preset']) {
            presetSelect.value = name;
            presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
            const before = view();
            await waitFor(() => held.length === 1);
            rounds.push({ operation: 'pick', requested: name, locked: locked(), before, confirmed: currentPresetName !== name });
            held.shift()();
            await waitFor(() => presetOpsInFlight === 0);
            rounds.at(-1).unlocked = unlocked();
            rounds.at(-1).after = view();
          }
          for (const [operation, button] of [['reset', btnResetDefaults], ['delete', btnDeletePreset]]) {
            const before = view();
            button.click();
            await waitFor(() => held.length === 1);
            rounds.push({ operation, locked: locked(), before, stillConfirmed: JSON.stringify(view()) === JSON.stringify(before) });
            held.shift()();
            await waitFor(() => presetOpsInFlight === 0);
            rounds.at(-1).unlocked = unlocked();
          }
          hold = false;
          // Exercise edits on the confirmed fallback after Delete.
          const beforeEdit = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          modeCeiling.value = beforeEdit.dynamics.ceiling === 'warm' ? 'clean' : 'warm';
          modeCeiling.dispatchEvent(new Event('change', { bubbles: true }));
          await waitFor(() => viewRev > beforeEdit.stateRev);
          const afterSwitch = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          sliderMid.value = 6;
          sliderMid.dispatchEvent(new Event('input', { bubbles: true }));
          await waitFor(() => viewRev > afterSwitch.stateRev);
          const afterSlider = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          document.querySelector('.eq-nudge-btn[data-target="slider-high"][data-action="up"]').click();
          await waitFor(() => viewRev > afterSlider.stateRev);
          const afterNudge = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          document.querySelector('button.band-tag[data-band="bass"]').click();
          await waitFor(() => viewRev > afterNudge.stateRev);
          const afterBand = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          document.querySelector('button.band-tag[data-band="match"]').click();
          await waitFor(() => viewRev > afterBand.stateRev);
          const afterMatch = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          valMid.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await waitFor(() => viewRev > afterMatch.stateRev);
          const afterNeutral = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          valMid.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await waitFor(() => viewRev > afterNeutral.stateRev);
          const final = await new Promise(r => original({ type: 'READ_PRESET_STATE' }, r));
          return { initial, rounds, beforeEdit, afterSwitch, afterSlider, final, calls };
        } finally {
          hold = false;
          chrome.runtime.sendMessage = original;
          for (const deliver of held) deliver();
        }
      });
      const editKeys = confirmation.calls.map(m => Object.keys(m.params || m.dynamics).join(','));
      const confirmationOk = confirmation.rounds.every(r => r.locked && r.unlocked)
        && confirmation.rounds.filter(r => r.operation === 'pick').every(r => r.confirmed && r.after.name === r.requested)
        && confirmation.rounds.filter(r => r.operation !== 'pick').every(r => r.stillConfirmed)
        && JSON.stringify(editKeys) === JSON.stringify(['ceiling', 'mid', 'high', 'stageBypass', 'match', 'mid', 'mid'])
        && Object.keys(confirmation.calls[3].params.stageBypass).join(',') === 'bass'
        && ['leveler', 'match', 'limiter'].every(k => confirmation.beforeEdit.dynamics[k] === confirmation.afterSwitch.dynamics[k])
        && confirmation.beforeEdit.currentPreset === confirmation.afterSlider.currentPreset
        && confirmation.afterSlider.currentParams.mid === 6
        && confirmation.final.currentParams.mid === 6;
      const followOk = followBeforeFocus.preset === 'Harness Preset' && sameDyn(followBeforeFocus, WANTED)
        && sameDyn(followUpdated, SLOW) && followUpdated.label === 'EQ + switches' && followUpdated.preset === 'Harness Preset'
        && followStillHarness.preset === 'Harness Preset'
        && followFlat.preset === 'Flat (Bypass)' && followFlat.label === 'EQ only' && sameDyn(followFlat, SLOW)
        && followBack.preset === 'Harness Preset' && followBack.label === 'EQ + switches' && sameDyn(followBack, SLOW)
        && followCache.preset === 'Harness Preset' && sameDyn(followCache.saved, SLOW)
        && JSON.stringify(harnessBefore) === JSON.stringify(harnessAfter.saved)
        && harnessAfter.preset === 'Flat (Bypass)'
        && followRefused.preset === 'Flat (Bypass)'
        && staleHint === 'Another window changed your presets, so this one has been refreshed. Please try again.'
        && panelBefore.preset === 'Flat (Bypass)' && staleSwitchBefore.preset === 'Harness Preset'
        && JSON.stringify(staleSwitchAfter) === JSON.stringify(staleSwitchBefore)
        && staleSwitchView.preset === 'Harness Preset' && sameDyn(staleSwitchView, SLOW) && sameDyn(staleSwitchEngine, SLOW)
        && staleSwitchHint === staleHint;
      switchOk = sameDyn(savedPreset?.dynamics, WANTED)
        && sameDyn(hydrated, OTHER) && hydrated.label === 'EQ + switches'
        && onFactory.label === 'EQ only' && /Save a copy/.test(onFactory.labelTitle) && sameDyn(dynWhileFactory, OTHER)
        && sameDyn(back, WANTED) && sameDyn(storedBack, WANTED) && sameDyn(engineBack?.eff, WANTED) && back.badge === '● Saved'
        && sameDyn(afterReset, WANTED) && afterReset.badge === '● Saved' && JSON.stringify(storedReset.preset) === savedJson && sameDyn(storedReset.dynamics, WANTED) && sameDyn(engineReset?.eff, WANTED)
        && sameDyn(onLegacy, OTHER) && sameDyn(storedLegacy.dynamics, beforeLegacy) && sameDyn(storedFactory, beforeLegacy)
        && onLegacy.label === 'EQ only' && /Press Update/.test(onLegacy.labelTitle) && onLegacy.updateShown
        && Object.keys(storedLegacy.preset).length === Object.keys(legacyBody).length
        && onFactoryLabel.label === 'EQ only' && /Save a copy/.test(onFactoryLabel.labelTitle)
        && back.label === 'EQ + switches' && /pressing Reset/.test(back.labelTitle)
        && back.updateTitle === 'Save the current EQ and switches into this preset'
        && back.resetTitle === "Restore this preset's saved EQ and switches"
        && fitPopup.labelInside && fitPopup.resetInside && fitPopup.rowH === 20 && fitPopup.updateShown
        && fitPanel.labelInside && fitPanel.resetInside && fitPanel.pageOverflow <= 0
        && surfacesAgree && curveMatches && followOk && confirmationOk;
      switchDetail = { savedPreset, hydrated, onFactory, dynWhileFactory, back, storedBack, curve, engineEff: engineBack?.eff, afterReset, storedReset, engineReset: engineReset?.eff, onLegacy, storedLegacy, onFactoryLabel, storedFactory, fitPopup, fitPanel, agreePanel, agreeWin, followBeforeFocus, followUpdated, followStillHarness, followFlat, followBack, followCache, followRefused, staleHint, harnessBefore, harnessAfter, panelBefore, staleSwitchBefore, staleSwitchAfter, staleSwitchEngine, staleSwitchView, staleSwitchHint, confirmationOk, confirmation };
    } finally {
      await popup.evaluate((snap) => new Promise((resolve) => {
        chrome.storage.local.set(snap.local, () => {
          if (snap.baseline) chrome.storage.session.set({ presetSwitchBaseline: snap.baseline }, resolve);
          else chrome.storage.session.remove('presetSwitchBaseline', resolve);
        });
      }), switchSnap);
      if (switchSnap.local.dynamics) await writeFrom(popup, { type: 'EDIT_DYNAMICS', dynamics: switchSnap.local.dynamics });
      if (switchSnap.local.currentParams) await writeFrom(popup, { type: 'EDIT_PARAMS', params: switchSnap.local.currentParams });
    }
    record('W-PRESET-SWITCHES', 'A custom preset stores Bass only / MATCH on / Look-ahead / Warm and brings them back on pick and Reset; a legacy preset and a factory preset leave the switches alone; the label matches; popup, side panel and window agree; the response curve matches the picked preset; a side panel left open refreshes on focus; a stale Update and a stale switch change are refused, write nothing, and refresh that panel; pick/Reset/Delete lock all edit controls until confirmation; each edit sends only its changed field; the header stays on one row',
      switchOk ? 'PASS' : 'FAIL', switchDetail, 'installed-browser');

    // ---- W-PRESET-STEP (R-31): two buttons share the dropdown's confirmed pick path.
    // Additive check only: restore the synthetic preset state before the existing checks continue.
    const stepSaved = await sendFrom(popup, { type: 'READ_PRESET_STATE' });
    const stepDetail = { surfaces: [], layouts: [], screenshots: [] };
    let stepOk = false;
    try {
      const stepBase = { bass: 3, hpf: 20, mid: 1, high: 0, gain: 1, semitones: 0,
        autoBalance: false, bypass: false, stageBypass: NONE };
      const stepModes = [
        { leveler: 'bass', match: true, limiter: 'lookahead', ceiling: 'warm' },
        { leveler: 'slow', match: false, limiter: 'fast', ceiling: 'clean' }
      ];
      for (const [i, name] of ['Step switches A', 'Step switches B'].entries()) {
        const saved = await writeFrom(popup, { type: 'SAVE_PRESET', name,
          params: { ...stepBase, bass: 3 + i }, dynamics: stepModes[i] });
        assert.equal(saved.success, true);
      }
      for (const [surface, path, widths] of [
        ['popup', 'popup.html', [440]], ['panel', 'popup.html?panel=1', [300, 360, 400, 440, 480]]
      ]) {
        const opened = await openPopup(path);
        const pg = opened.page;
        const surfaceResult = { surface, steps: [] };
        stepDetail.surfaces.push(surfaceResult);
        try {
          await pg.setViewportSize({ width: surface === 'popup' ? 440 : 360, height: 800 });
          const menu = await pg.evaluate(() => ({
            names: Array.from(presetSelect.options, option => option.value),
            groups: Array.from(presetSelect.children, group => ({ label: group.label, names: Array.from(group.children, option => option.value) }))
          }));
          assert.equal(menu.groups[0].label, 'Default Presets');
          assert.equal(menu.groups[1].label, 'My Custom Presets');
          assert.deepEqual(menu.names, menu.groups.flatMap(group => group.names));
          assert.deepEqual(menu.names.slice(-2), ['Step switches A', 'Step switches B']);
          surfaceResult.order = menu.names;
          await pg.selectOption('#preset-select', menu.names[0]);
          await pg.waitForFunction(name => presetOpsInFlight === 0 && currentPresetName === name, menu.names[0]);
          let index = 0;
          const checkSelection = async (expected) => {
            const stored = await pg.evaluate(() => chrome.storage.local.get(['presets', 'currentPreset', 'currentParams', 'dynamics']));
            const ui = await pg.evaluate(params => {
              // A dropdown pick also uses native range rounding (e.g. factory HPF 32 displays 30).
              // Independent detached inputs give the expected display without changing stored/engine values.
              const expected = { autoBalance: params.autoBalance };
              for (const key of ['bass', 'hpf', 'mid', 'high', 'gain', 'semitones']) {
                const input = document.getElementById(`slider-${key === 'semitones' ? 'pitch' : key}`).cloneNode();
                input.value = params[key] ?? (key === 'semitones' ? 0 : '');
                expected[key] = input.valueAsNumber;
              }
              return { name: currentPresetName, selected: presetSelect.value, expected,
                params: getParamsFromUI(), dynamics: { leveler: modeLeveler.value, limiter: modeLimiter.value,
                  ceiling: modeCeiling.value, match: document.querySelector('.band-tag[data-band="match"]').getAttribute('aria-pressed') === 'true' } };
            }, stored.currentParams);
            const engine = (await evalOffscreen('({ params: currentParams, dynamics: currentDynamics, capturing: isCapturing })')).value;
            assert.equal(stored.currentPreset, expected);
            assert.equal(ui.name, expected);
            assert.equal(ui.selected, expected);
            assert.equal(engine?.capturing, true);
            for (const key of ['bass', 'hpf', 'mid', 'high', 'gain', 'semitones', 'autoBalance']) {
              assert.equal(ui.params[key], ui.expected[key], `UI ${expected}: ${key}`);
              assert.equal(engine.params[key], stored.currentParams[key] ?? (key === 'semitones' ? 0 : undefined), `engine ${expected}: ${key}`);
            }
            assert.equal(engine.params.bypass, stored.currentParams.bypass === true);
            assert.deepEqual(ui.dynamics, stored.dynamics);
            assert.deepEqual(engine.dynamics, stored.dynamics);
            if (stored.presets[expected].dynamics) assert.deepEqual(stored.dynamics, stored.presets[expected].dynamics);
            return { name: expected, bass: ui.params.bass, dynamics: ui.dynamics };
          };
          for (const direction of [1, -1]) {
            for (let n = 0; n < menu.names.length; n++) {
              index = (index + direction + menu.names.length) % menu.names.length;
              const expected = menu.names[index];
              await pg.click(direction === 1 ? '#btn-next-preset' : '#btn-prev-preset');
              await pg.waitForFunction(name => presetOpsInFlight === 0 && currentPresetName === name, expected);
              surfaceResult.steps.push({ direction, ...await checkSelection(expected) });
            }
            assert.equal(index, 0, 'one full lap wraps to the first option');
          }
          surfaceResult.lock = await pg.evaluate(async () => {
            const original = chrome.runtime.sendMessage.bind(chrome.runtime);
            const before = { name: currentPresetName, bass: currentParams.bass, dynamics: { ...dynamics } };
            let release;
            let calls = 0;
            chrome.runtime.sendMessage = (message, callback) => {
              if (message.type !== 'APPLY_PRESET') return original(message, callback);
              calls++;
              return original(message, response => { release = () => callback(response); });
            };
            try {
              btnNextPreset.click();
              for (let i = 0; i < 200 && !release; i++) await new Promise(r => setTimeout(r, 10));
              if (!release) throw Error('preset reply never arrived');
              const locked = btnPrevPreset.disabled && btnNextPreset.disabled && presetSelect.disabled;
              const heldView = { name: currentPresetName, bass: currentParams.bass, dynamics: { ...dynamics } };
              btnPrevPreset.click(); btnNextPreset.click();
              const whileHeldCalls = calls;
              release(); release = null;
              return { locked, before, heldView, whileHeldCalls,
                unlocked: !btnPrevPreset.disabled && !btnNextPreset.disabled && !presetSelect.disabled };
            } finally {
              chrome.runtime.sendMessage = original;
              if (release) release();
            }
          });
          assert.equal(surfaceResult.lock.locked, true);
          assert.equal(surfaceResult.lock.unlocked, true);
          assert.equal(surfaceResult.lock.whileHeldCalls, 1);
          assert.deepEqual(surfaceResult.lock.heldView, surfaceResult.lock.before);
          await checkSelection(menu.names[1]);
          // Compare the new row against the original select-only DOM, without changing shipped code.
          // Test both default and custom labels at every supported width.
          for (const name of [menu.names[0], 'Step switches A']) {
            await pg.selectOption('#preset-select', name);
            await pg.waitForFunction(name => presetOpsInFlight === 0 && currentPresetName === name, name);
            for (const width of widths) {
              await pg.setViewportSize({ width, height: 800 });
              const layout = await pg.evaluate(() => {
                const row = document.querySelector('.preset-picker');
                const select = document.getElementById('preset-select');
                const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; };
                const measure = () => ({ height: document.querySelector('.popup-container').getBoundingClientRect().height,
                  section: rect(document.querySelector('.preset-section')), physics: rect(document.querySelector('.physics')),
                  select: rect(select), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth });
                const current = measure();
                const buttons = [btnPrevPreset, btnNextPreset].map(button => ({ ...rect(button),
                  label: button.getAttribute('aria-label'), title: button.title, svg: !!button.querySelector('svg use') }));
                row.before(select); row.remove();
                const original = measure();
                select.before(row); row.insertBefore(select, btnNextPreset);
                return { current, original, buttons };
              });
              assert.equal(layout.current.height, layout.original.height, `${surface} ${width}: page height`);
              assert.equal(layout.current.section.h, layout.original.section.h, `${surface} ${width}: preset height`);
              assert.deepEqual(layout.current.physics, layout.original.physics, `${surface} ${width}: drawings do not move`);
              assert.equal(layout.current.select.h, layout.original.select.h);
              assert.ok(layout.current.overflow <= 0);
              assert.ok(layout.current.select.w >= 100, 'dropdown retains usable width');
              if (surface === 'popup') assert.ok(layout.current.height < 600);
              for (const [i, button] of layout.buttons.entries()) {
                assert.equal(button.label, i === 0 ? 'Previous preset' : 'Next preset');
                assert.equal(button.title, button.label);
                assert.equal(button.svg, true);
                assert.equal(button.y, layout.current.select.y);
                assert.equal(button.h, layout.current.select.h);
                assert.ok(button.x >= layout.current.section.x && button.right <= layout.current.section.right);
              }
              assert.ok(layout.buttons[0].right < layout.current.select.x);
              assert.ok(layout.buttons[1].x > layout.current.select.right);
              stepDetail.layouts.push({ surface, width, name, ...layout });
            }
          }
          await pg.setViewportSize({ width: surface === 'popup' ? 440 : 360, height: surface === 'popup' ? 600 : 900 });
          const filename = `preset-step-${surface}.png`;
          if (surface === 'popup') stepDetail.screenshots.push(await shot(pg, filename));
          else {
            await pg.screenshot({ path: join(outDir, filename), fullPage: true });
            stepDetail.screenshots.push(`results/${label}/${filename}`);
          }
          assert.deepEqual(opened.errors, []);
        } finally {
          await pg.close();
        }
      }
      stepOk = true;
    } catch (error) {
      stepDetail.error = String(error.stack || error);
    } finally {
      await popup.evaluate(saved => chrome.storage.local.set({ presets: saved.presets, currentPreset: saved.currentPreset,
        currentParams: saved.currentParams, dynamics: saved.dynamics }), stepSaved);
      await sendFrom(popup, { type: 'READ_PRESET_STATE' });
      await showSurface(popup);
    }
    record('W-PRESET-STEP', 'Previous/Next follow dropdown order and wrap both ends; confirmed storage, engine, UI and saved switches agree; buttons lock in flight; unchanged popup height and unclipped 300–480 px panel layouts',
      stepOk ? 'PASS' : 'FAIL', stepDetail);

    // ---- W-EQ-CUT (R-29): the shipped display reads the existing synthetic spectra.
    // No new audio source, output path, browser or profile; keep the harness's silent flags.
    // Keep these extra steps after the timed audio checks so fixture loop seams do not move into their measurements.
    const cutSaved = await sendFrom(popup, { type: 'READ_PRESET_STATE' });
    await setDyn(DEFAULT_DYN);
    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await showSurface(popup);
    await sleep(2000);
    const readCuts = (page) => page.evaluate(() => {
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return {
        body: rect(document.body),
        bands: ['bass', 'mid', 'high'].map((band) => {
          const row = document.querySelector(`.eq-row[data-band="${band}"]`);
          const slider = document.getElementById(`slider-${band}`);
          const caption = document.getElementById(`cut-${band}`);
          const tick = document.getElementById(`cut-tick-${band}`);
          const track = rect(slider);
          const thumbX = track.x + 7 + (track.w - 14) * ((+slider.value - +slider.min) / (+slider.max - +slider.min));
          return { band, text: caption.textContent, title: caption.getAttribute('title'),
            cutting: caption.classList.contains('cutting'), hidden: tick.hidden,
            tick: rect(tick), ariaHidden: tick.getAttribute('aria-hidden'),
            thumbX, track, row: rect(row), label: rect(row.querySelector('.eq-label')),
            fits: caption.scrollWidth <= caption.clientWidth && row.querySelector('.eq-label').scrollWidth <= row.querySelector('.eq-label').clientWidth };
        })
      };
    });
    const cutFlat = await readCuts(popup);
    await setParams({ bass: 56, gain: 2.5 });
    await showSurface(popup);
    await sleep(3000);
    const cutHot = await readCuts(popup);
    const cutScreenshot = await shot(popup, 'eq-cut-bass56.png');

    const cutContrast = await popup.evaluate(() => {
      const savedTheme = document.body.className;
      const rgb = (v) => v.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = (rgb) => rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const contrast = (a, b) => {
        const x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const results = [];
      for (const theme of ['cyan', 'amber', 'synthwave', 'matrix', 'oled']) {
        document.body.className = `theme-${theme}`;
        const bg = rgb(getComputedStyle(document.body).backgroundColor);
        for (const band of ['bass', 'mid', 'high']) {
          const row = document.querySelector(`.eq-row[data-band="${band}"]`);
          const caption = document.getElementById(`cut-${band}`);
          const tick = document.getElementById(`cut-tick-${band}`);
          const savedRow = row.className, savedCaption = caption.className;
          caption.classList.add('cutting');
          for (const off of [false, true]) {
            row.classList.toggle('is-off', off);
            const style = getComputedStyle(caption);
            const opacity = +style.opacity * +getComputedStyle(caption.parentElement).opacity;
            const fg = rgb(style.color).map((v, i) => v * opacity + bg[i] * (1 - opacity));
            results.push({ theme, band, off, text: contrast(fg, bg),
              tick: contrast(rgb(getComputedStyle(tick).backgroundColor), rgb(getComputedStyle(document.getElementById(`slider-${band}`)).backgroundColor)) });
          }
          row.className = savedRow;
          caption.className = savedCaption;
        }
      }
      document.body.className = savedTheme;
      return results;
    });

    // The panel and fallback window execute the same renderer. Toggle only its presentation
    // synchronously to compare geometry with/without cuts while the real frame stream continues.
    const cutLayouts = [];
    for (const path of ['popup.html?panel=1', 'popup.html?undocked=true']) {
      const { page, errors } = await openPopup(path);
      await sleep(1200);
      for (const width of path.includes('panel') ? [300, 360, 400, 440, 480] : [440]) {
        await page.setViewportSize({ width, height: 900 });
        await sleep(150);
        const geometry = await page.evaluate(() => {
          const positions = () => [...document.querySelectorAll('.eq-cut-label, .eq-cut-track, .eq-row')].map((el) => {
            const r = el.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          });
          const shown = positions();
          const saved = Object.values(bandCuts).map((ui) => ui.state);
          Object.values(bandCuts).forEach((ui) => { ui.state = { value: 0, visible: false }; });
          paintBandCuts();
          const hidden = positions();
          const rows = () => [...document.querySelectorAll('.eq-row')].map((el) => {
            const r = el.getBoundingClientRect();
            return [r.y, r.height];
          });
          const cutRows = rows();
          // The original labels had no fixed height and their small text was inline.
          const labels = [...document.querySelectorAll('.eq-cut-label')];
          labels.forEach((el) => el.classList.remove('eq-cut-label'));
          const originalRows = rows();
          labels.forEach((el) => el.classList.add('eq-cut-label'));
          Object.values(bandCuts).forEach((ui, i) => { ui.state = saved[i]; });
          paintBandCuts();
          return { stable: JSON.stringify(shown) === JSON.stringify(hidden),
            originalRowHeights: JSON.stringify(cutRows) === JSON.stringify(originalRows),
            noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
        });
        cutLayouts.push({ path, width, ...geometry, ...(await readCuts(page)), errors: [...errors] });
      }
      await page.close();
    }

    await showSurface(popup);
    await setParams({ bypass: true });
    await showSurface(popup);
    const cutBypass = await readCuts(popup);
    await setParams({ bypass: false, semitones: 1 });
    await showSurface(popup);
    const cutPitch = await readCuts(popup);
    await setParams({ semitones: 0 });
    await showSurface(popup);
    await sleep(1500);
    await popup.click('.power-switch');
    await sleep(500);
    const cutOff = await readCuts(popup);
    const normalCaptions = ['', 'vocals / body', 'sparkle'];
    const allHidden = (r) => r.bands.every((b, i) => b.hidden && !b.cutting && b.title === null && b.text === normalCaptions[i]);
    const noShift = cutHot.bands.every((b, i) => JSON.stringify(b.row) === JSON.stringify(cutFlat.bands[i].row)
      && JSON.stringify(b.track) === JSON.stringify(cutFlat.bands[i].track));
    const low = cutHot.bands[0], mid = cutHot.bands[1];
    const cutText = /^cut (\d+) dB$/;
    record('W-EQ-CUT', 'Flat hides cuts; Bass +56 / Master 250% / AUTO off shows LOW ≥10 dB and a left tick plus a MID cut; no shift/overflow in popup, 300–480 px panel or window; all themes ≥4.5:1; bypass, Pitch and EQ off restore captions',
      allHidden(cutFlat) && cutText.test(low.text) && +low.text.match(cutText)[1] >= 10
        && !low.hidden && low.tick.x + 1 < low.thumbX && low.tick.w === 2 && low.tick.h === low.track.h
        && cutText.test(mid.text) && !mid.hidden && noShift && cutHot.body.h < 600
        && cutHot.bands.every((b) => b.ariaHidden === 'true' && (!b.cutting || b.title === `About ${b.text.match(cutText)?.[1]} dB of this band is being taken back by the leveler, limiter and ceiling right now. Measured from the audio, so it shows only while this band has sound.`))
        && cutContrast.every((c) => c.text >= 4.5 && c.tick >= 4.5)
        && cutLayouts.every((l) => l.stable && l.originalRowHeights && l.noOverflow && l.errors.length === 0
          && l.bands[0].cutting && l.bands.every((b) => b.fits))
        && allHidden(cutBypass) && allHidden(cutPitch) && allHidden(cutOff) ? 'PASS' : 'FAIL',
      { flat: cutFlat, hot: cutHot, noShift, contrast: cutContrast, layouts: cutLayouts,
        bypass: cutBypass, pitch: cutPitch, off: cutOff, screenshot: cutScreenshot });
    await setParams(cutSaved.currentParams);
    await setDyn(cutSaved.dynamics);
    await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });

    // ---- W-CAPTURE-STOP ----
    const stopRes = await sendFrom(popup, { type: 'STOP_CAPTURE' });
    await sleep(500);
    const afterStop = await evalOffscreen(`({ isCapturing, ctx: audioCtx ? audioCtx.state : null, stream: !!currentStream })`);
    const state = await sendFrom(popup, { type: 'GET_STATE' });
    await sleep(1300); // the screen's 1 s poll notices the stop and idles its meters
    const idleMeters = await popup.evaluate(() => ['comp', 'match', 'limiter', 'ceiling'].map((k) => document.getElementById(`val-${k}`).textContent));
    record('W-CAPTURE-STOP', 'Stop releases stream + AudioContext; state reports OFF; the meters read idle',
      stopRes?.success && afterStop.value?.isCapturing === false && !afterStop.value?.stream && state.isCapturing === false && idleMeters.every((t) => t === 'idle') ? 'PASS' : 'FAIL',
      { stopRes, afterStop, stateIsCapturing: state.isCapturing, idleMeters });

    // ---- W-CAPTURE-RESTART ----
    const re = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
    await sleep(500);
    const reGraph = await evalOffscreen(`({ isCapturing, ctx: audioCtx && audioCtx.state })`);
    record('W-CAPTURE-RESTART', 'EQ can be re-attached after stop', re?.success && reGraph.value?.isCapturing ? 'PASS' : 'FAIL', { re, reGraph });

    // ---- W-EQ-AFTER-ICON (1.5.4): Chrome refuses the EQ from the side panel (no permission for the tab after a
    // reload or restart); the panel says to click the icon, and that click turns the EQ on. Chrome's refusal is
    // simulated (this test browser is allow-listed); the click is the worker's own click handler. ----
    await sendFrom(popup, { type: 'STOP_CAPTURE' });
    await sleep(400);
    const stubbed = await sw.evaluate(() => {
      self.__realGetMediaStreamId = chrome.tabCapture.getMediaStreamId;
      const refuse = async () => { throw new Error('Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'); };
      try { chrome.tabCapture.getMediaStreamId = refuse; } catch (_) {}
      if (chrome.tabCapture.getMediaStreamId !== refuse) { try { Object.defineProperty(chrome.tabCapture, 'getMediaStreamId', { value: refuse, configurable: true, writable: true }); } catch (_) {} }
      return chrome.tabCapture.getMediaStreamId === refuse;
    });
    const panelEq = await context.newPage();
    await panelEq.goto(`chrome-extension://${EXT_ID}/popup.html?panel=1`);
    await sleep(800);
    // Stay open off: the icon opens the popup, so nothing is queued and the popup's advice is given.
    const refusedOff = await sendFrom(panelEq, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
    const pendingWhenOff = await sw.evaluate(() => pendingEq);
    await sw.evaluate(() => chrome.storage.local.set({ stayOpen: true })); // the flag only; the icon behaviour is W-STAY-OPEN's
    const refused = await sendFrom(panelEq, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
    const pendingAfterRefusal = await sw.evaluate(() => pendingEq);
    // A stop by any route (here the worker's own stop, as Alt+E uses) settles the request: a later click starts nothing.
    await sw.evaluate(() => stopAudioCapture());
    const clearedByStop = await sw.evaluate(() => pendingEq === null);
    const refusedAgain = await sendFrom(panelEq, { type: 'START_CAPTURE_FOR_TAB', tabId: mediaTabId });
    await sw.evaluate(() => {
      try { chrome.tabCapture.getMediaStreamId = self.__realGetMediaStreamId; } catch (_) {}
      if (chrome.tabCapture.getMediaStreamId !== self.__realGetMediaStreamId) Object.defineProperty(chrome.tabCapture, 'getMediaStreamId', { value: self.__realGetMediaStreamId, configurable: true, writable: true });
    });
    const tidalTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, TIDAL_URL.split('?')[0]);
    const windowId = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, mediaTabId);
    const clickOther = await sw.evaluate(async ({ id, w }) => onActionClicked({ id, windowId: w }), { id: tidalTabId, w: windowId });
    const stillPending = await sw.evaluate(() => !!pendingEq);
    const clickRight = await sw.evaluate(async ({ id, w }) => onActionClicked({ id, windowId: w }), { id: mediaTabId, w: windowId });
    await sleep(600);
    const eqState = await sendFrom(popup, { type: 'GET_STATE' });
    const eqCaptured = await sw.evaluate(() => capturedTabId);
    await sw.evaluate(() => chrome.storage.local.set({ stayOpen: false }));
    await panelEq.close();
    // Outside a real click Chrome refuses to open the panel, so the handler fell back to the Stay-open window: close it.
    await sleep(800);
    for (const pg of context.pages()) if (pg.url().includes('undocked=true')) await pg.close();
    await sleep(300);
    record('W-EQ-AFTER-ICON', 'EQ refused from the side panel for lack of Chrome\'s permission: with Stay open on, the message says to click the icon, a stop by any route settles it, a click on another tab does nothing, and the click on that tab turns the EQ on; with Stay open off, the popup\'s advice and nothing queued',
      stubbed && refusedOff?.success === false && /then turn Audio EQ on/.test(refusedOff?.error || '') && pendingWhenOff === null
        && refused?.success === false && /Click the icon now/.test(refused?.error || '') && pendingAfterRefusal?.tabId === mediaTabId && clearedByStop && refusedAgain?.success === false
        && clickOther === false && stillPending && clickRight === true && eqState.isCapturing === true && eqCaptured === mediaTabId ? 'PASS' : 'FAIL',
      { stubbed, refusedOff: refusedOff?.error, pendingWhenOff, refused, pendingAfterRefusal, clearedByStop, clickOther, stillPending, clickRight, isCapturing: eqState.isCapturing, eqCaptured, mediaTabId });

    // ---- W-TAB-CLOSE-CLEANUP ----
    await media.close();
    await sleep(1200);
    const afterClose = await evalOffscreen(`({ isCapturing, stream: !!currentStream, ctx: audioCtx ? audioCtx.state : null })`);
    const stateAfterClose = await sendFrom(popup, { type: 'GET_STATE' });
    record('W-TAB-CLOSE-CLEANUP', 'Closing the captured tab releases capture and reports OFF',
      stateAfterClose.isCapturing === false && afterClose.value?.stream !== true ? 'PASS' : 'FAIL', { afterClose, stateIsCapturing: stateAfterClose.isCapturing });

    // ---- W-TAB-CLOSE-AFTER-SW-RESTART: in-memory capturedTabId lost after worker restart ----
    const media2 = await context.newPage();
    watchRequests(media2);
    await media2.goto(MEDIA_URL + '?2');
    await media2.evaluate(() => document.getElementById('a').play());
    await sleep(500);
    const media2Id = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, MEDIA_URL + '?2');
    const s2 = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: media2Id });
    await sleep(400);
    await sw.evaluate(() => { capturedTabId = null; });
    await media2.close();
    await sleep(1200);
    const after2 = await evalOffscreen(`({ isCapturing, stream: !!currentStream })`);
    const st2 = await sendFrom(popup, { type: 'GET_STATE' });
    record('W-TAB-CLOSE-AFTER-SW-RESTART', 'Tab close after worker restart still cleans up capture',
      s2?.success && st2.isCapturing === false && after2.value?.stream !== true ? 'PASS' : 'FAIL', { s2, after2, stateIsCapturing: st2.isCapturing });
  } else {
    record('W-PRESET-STEP', 'Preset stepping requires the synthetic capture engine', 'BLOCKED', startRes);
    for (const id of ['W-EQ-CUT', 'W-AUDIO-TRANSPARENT', 'W-AUDIO-BASS', 'W-AUDIO-BAND-SWITCH', 'W-AUDIO-HPF', 'W-PITCH', 'W-PITCH-RECOVER', 'W-AUDIO-LIMITER', 'W-DYN-BASELINE', 'W-DYN-LEVELER-BASS', 'W-DYN-LEVELER-SLOW', 'W-DYN-MATCH', 'W-DYN-LIMITER-LOOKAHEAD', 'W-DYN-CEILING-WARM', 'W-DYN-METERS-UI', 'W-PRESET-SWITCHES', 'W-CAPTURE-STOP', 'W-CAPTURE-RESTART', 'W-TAB-CLOSE-CLEANUP', 'W-TAB-CLOSE-AFTER-SW-RESTART']) {
      record(id, 'depends on W-CAPTURE-START', 'BLOCKED', null);
    }
  }

  // ---- W-STAY-OPEN: a real click on the switch hands the screen to Chrome's side panel and makes the icon open it; off restores the popup ----
  const popupBefore = await sw.evaluate(() => chrome.action.getPopup({}));
  const popup3 = adopt(await openPopup());
  await popup3.click('label.opt'); // the "Stay open" switch
  await sleep(1500);
  const popupWhenOn = await sw.evaluate(() => chrome.action.getPopup({}));
  const stayStored = await sw.evaluate(async () => (await chrome.storage.local.get('stayOpen')).stayOpen);
  const behaviourOn = await sw.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick);
  const panelContexts = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length);
  await sendFrom(popup, { type: 'SET_STAY_OPEN', on: false });
  await sleep(500);
  const popupWhenOff = await sw.evaluate(() => chrome.action.getPopup({}));
  const behaviourOff = await sw.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick);
  if (!popup3.isClosed()) await popup3.close();
  record('W-STAY-OPEN', 'Stay open (real click): the toolbar icon switches to the side panel (no popup; opened by the worker, so a click never closes it); off restores the popup',
    /popup\.html$/.test(popupBefore) && popupWhenOn === '' && stayStored === true && behaviourOn === false && /popup\.html$/.test(popupWhenOff) && behaviourOff === false ? 'PASS' : 'FAIL', // 1.5.4: the worker opens the panel itself (onActionClicked), so Chrome's toggle stays off
    { popupBefore, popupWhenOn, stayStored, behaviourOn, popupWhenOff, behaviourOff });
  record('W-SIDE-PANEL-OPEN', 'The side panel document opened from the click', panelContexts > 0 ? 'PASS' : 'NOT RUN',
    { panelContexts, note: panelContexts > 0 ? '' : 'Headless Chrome has no side panel UI; confirm on a real Chrome window.' });

  // ---- W-PANEL-LAYOUT: the panel adapts live to its width (R-23): under 400 px the player stacks (no art slice,
  // small cover top right, full-width transport); from 400 px up it is the normal layout. Chrome's own floor is 360 px. ----
  const panelPage = await context.newPage();
  const panelErrors = [];
  panelPage.on('pageerror', (e) => panelErrors.push(String(e)));
  watchRequests(panelPage);
  await panelPage.goto(`chrome-extension://${EXT_ID}/popup.html?panel=1`);
  await sleep(1500);
  const layoutAt = async (width) => {
    await panelPage.setViewportSize({ width, height: 900 });
    await sleep(350);
    const m = await panelPage.evaluate(() => {
      const np = document.querySelector('.np'), cs = getComputedStyle(np);
      const npInner = np.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const cover = document.getElementById('art-cover');
      return {
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        sliderW: Math.round(document.getElementById('slider-bass').getBoundingClientRect().width),
        panelClass: document.body.classList.contains('panel'),
        stripShown: getComputedStyle(document.querySelector('.art-strip')).display !== 'none',
        coverShown: !cover.hidden, coverW: Math.round(cover.getBoundingClientRect().width),
        // The cover sits top right in both layouts: right of the title, flush with the player's right content edge.
        coverRightOfTitle: cover.getBoundingClientRect().left >= document.getElementById('player-title').getBoundingClientRect().right,
        coverEdgeGap: Math.round(np.getBoundingClientRect().right - parseFloat(cs.paddingRight) - cover.getBoundingClientRect().right),
        stacked: getComputedStyle(document.querySelector('.np-main')).display === 'contents',
        transportW: Math.round(document.querySelector('.transport').getBoundingClientRect().width), npInner: Math.round(npInner),
        titleWraps: getComputedStyle(document.getElementById('player-title')).whiteSpace !== 'nowrap',
        // 1.5.0 dynamics rows: the name + mode menu stay inside the label cell and the bar keeps a usable width
        meterW: Math.round(document.getElementById('meter-comp').getBoundingClientRect().width),
        menuFits: document.getElementById('mode-leveler').getBoundingClientRect().right <= document.querySelector('.eq-row[data-band="comp"] .dyn-label').getBoundingClientRect().right + 1
      };
    });
    const movieRows = await movieStatusMatrix(panelPage);
    await panelPage.screenshot({ path: join(outDir, `panel-${width}.png`) });
    return { ...m, movieRows };
  };
  const w300 = await layoutAt(300);
  const w360 = await layoutAt(360);
  // Band tags in the panel are the same words as in the popup (R-21 revised 2026-10-04): text, no icon, all ten fit,
  // struck through when off.
  const bandBtn = await panelPage.evaluate(() => {
    const b = document.querySelector('.band-tag[data-band="mid"]');
    const all = [...document.querySelectorAll('.band-tag')];
    return { text: b.textContent.trim(), hasIcon: !!b.querySelector('svg'), size: Math.round(b.getBoundingClientRect().width),
      words: all.map((t) => t.textContent.trim()), allFit: all.every((t) => t.scrollWidth <= t.clientWidth + 1) };
  });
  await panelPage.click('.band-tag[data-band="mid"]');
  await sleep(300);
  const bandOff = await panelPage.evaluate(() => {
    const b = document.querySelector('.band-tag[data-band="mid"]');
    return { off: b.classList.contains('off'), struck: getComputedStyle(b).textDecorationLine.includes('line-through'), rowDim: b.closest('.eq-row').classList.contains('is-off') };
  });
  await panelPage.screenshot({ path: join(outDir, 'panel-360-band-off.png') });
  await panelPage.click('.band-tag[data-band="mid"]'); // back on
  await sleep(200);
  const w400 = await layoutAt(400);
  const w440 = await layoutAt(440);
  const w480 = await layoutAt(480);
  await panelPage.close();
  const movieRowOk = (m) => movieMatrixOk(m.movieRows, { page: true });
  const fits = (m) => m.panelClass && m.scrollW <= m.clientW && !m.stripShown && m.coverShown && m.coverRightOfTitle && m.coverEdgeGap <= 1 && m.meterW >= 100 && m.menuFits && movieRowOk(m);
  const stackedOk = (m, minSlider) => fits(m) && m.stacked && m.coverW === 56 && m.titleWraps && m.transportW >= m.npInner - 2 && m.sliderW >= minSlider;
  const normalOk = (m, minSlider) => fits(m) && !m.stacked && m.coverW === 76 && !m.titleWraps && m.sliderW >= minSlider;
  record('W-PANEL-LAYOUT', 'Side panel adapts live: stacked player at 300 and 360 px (no art slice, 56 px cover top right, full-width transport, title may wrap), normal layout at 400, 440 and 480 px; all four Movie labels stay on one line at each width with a long badge title; no horizontal overflow; sliders usable; band tags are the popup\'s words, fit, and toggle with a strike-through; no errors',
    stackedOk(w300, 130) && stackedOk(w360, 150) && normalOk(w400, 150) && normalOk(w440, 200) && normalOk(w480, 250) && panelErrors.length === 0
      && bandBtn.text === 'MID' && !bandBtn.hasIcon && bandBtn.size === 40 && bandBtn.allFit && bandBtn.words.join(' ') === 'PITCH HPF LOW MID HI AUTO MATCH VOL LIM CEIL'
      && bandOff.off && bandOff.struck && bandOff.rowDim ? 'PASS' : 'FAIL',
    { w300, w360, w400, w440, w480, bandBtn, bandOff, panelErrors, screenshots: [300, 360, 400, 440, 480].map((w) => `results/${label}/panel-${w}.png`) });

  // ---- W-MOVIE-CONTRAST: the Movie badge text stays at least 4.5:1 on every theme, in every state ----
  const contrast = await popup.evaluate(() => {
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c || '');
      if (!m) return null;
      const p = m[1].split(',').map((s) => parseFloat(s));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
    const lin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const x = L(a), y = L(b); const hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
    const btn = document.getElementById('btn-movie-mode');
    const bar = document.querySelector('.status-bar');
    const line = document.getElementById('movie-status-line');
    const pitchRow = document.querySelector('.eq-row[data-band="pitch"]');
    const pitchSmall = pitchRow ? pitchRow.querySelector('.eq-label small') : null;
    const valPitch = document.getElementById('val-pitch');
    const themes = ['theme-cyan', 'theme-amber', 'theme-synthwave', 'theme-matrix', 'theme-oled'];
    const states = [['off', 'MOVIE'], ['on', 'MOVIE · ON'], ['manual-off', 'MOVIE · OFF']];
    const lineStates = ['off', 'on active', 'manual-off', 'on active alert'];
    const rows = [];
    for (const theme of themes) {
      document.body.className = (document.body.className.replace(/theme-\S+/g, '').trim() + ' ' + theme).trim();
      const pageBg = parse(getComputedStyle(document.body).backgroundColor) || { r: 18, g: 18, b: 22, a: 1 };
      for (const [cls, text] of states) {
        btn.className = 'movie-badge ' + cls;
        btn.textContent = text;
        const fg = parse(getComputedStyle(btn).color);
        let bg = parse(getComputedStyle(btn).backgroundColor);
        const barBg = parse(getComputedStyle(bar).backgroundColor);
        let surface = barBg && barBg.a < 1 ? over(barBg, pageBg) : (barBg || pageBg);
        if (bg && bg.a < 1) bg = over(bg, surface);
        rows.push({ theme, target: 'badge', cls, ratio: +ratio(fg, bg).toFixed(2) });
      }
      if (line) {
        for (const lcls of lineStates) {
          line.className = 'movie-status-line ' + lcls;
          const lfg = parse(getComputedStyle(line).color);
          let lbg = parse(getComputedStyle(line).backgroundColor);
          if (lbg && lbg.a < 1) lbg = over(lbg, pageBg);
          rows.push({ theme, target: 'status-line', cls: lcls, ratio: +ratio(lfg, lbg || pageBg).toFixed(2) });
        }
      }
      if (pitchRow && pitchSmall && valPitch) {
        pitchRow.classList.add('is-off', 'movie-locked');
        const rowBgRaw = parse(getComputedStyle(pitchRow).backgroundColor);
        const rowBg = rowBgRaw && rowBgRaw.a < 1 ? over(rowBgRaw, pageBg) : (rowBgRaw || pageBg);
        const labelOp = parseFloat(getComputedStyle(pitchRow.querySelector('.eq-label')).opacity || '1');
        const valOp = parseFloat(getComputedStyle(valPitch).opacity || '1');
        const sfgRaw = parse(getComputedStyle(pitchSmall).color);
        const vfgRaw = parse(getComputedStyle(valPitch).color);
        const sfg = over({ ...sfgRaw, a: (sfgRaw.a ?? 1) * labelOp }, rowBg);
        const vfg = over({ ...vfgRaw, a: (vfgRaw.a ?? 1) * valOp }, rowBg);
        rows.push({ theme, target: 'pitch-small-locked', cls: 'movie-locked', ratio: +ratio(sfg, rowBg).toFixed(2) });
        rows.push({ theme, target: 'val-pitch-locked', cls: 'movie-locked', ratio: +ratio(vfg, rowBg).toFixed(2) });
        pitchRow.classList.remove('is-off', 'movie-locked');
      }
    }
    document.body.className = document.body.className.replace(/theme-\S+/g, '').trim();
    document.body.classList.add('theme-cyan');
    btn.className = 'movie-badge off';
    btn.textContent = 'MOVIE';
    if (line) line.className = 'movie-status-line off';
    return rows;
  });
  record('W-MOVIE-CONTRAST', 'Movie badge, #movie-status-line (off, on, manual-off, alert), and locked Pitch labels stay at least 4.5:1 on all five themes',
    contrast.every((r) => r.ratio >= 4.5) ? 'PASS' : 'FAIL', contrast);

  // ---- W-MOVIE-MODE: audio stays on the large buffer; video switches to the short one; the button can force either ----
  const movieBadge = () => popup.evaluate(() => {
    const b = document.getElementById('btn-movie-mode');
    return { text: b.textContent.trim(), cls: b.className, pressed: b.getAttribute('aria-pressed') };
  });
  const movieEngine = async () => (await evalOffscreen(`({
    movie: currentMovieMode,
    hint: audioCtx && audioCtx.latencyHint,
    base: audioCtx ? audioCtx.baseLatency : null,
    ctx: audioCtx ? audioCtx.state : null,
    stream: currentStream ? currentStream.id : null,
    tracks: currentStream ? currentStream.getAudioTracks().map((t) => t.id) : [],
    bass: bassNode ? bassNode.gain.value : null,
    hpf: hpfNode ? hpfNode.frequency.value : null,
    gain: volumeGain ? volumeGain.gain.value : null,
    release: autoBalanceComp ? autoBalanceComp.release.value : null,
    old: (typeof __oldMovieCtx !== 'undefined' && __oldMovieCtx) ? __oldMovieCtx.state : null
  })`)).value;
  const audioPage = await context.newPage();
  watchRequests(audioPage);
  await audioPage.goto(MEDIA_URL + '?movie-a');
  await audioPage.evaluate(() => document.getElementById('a').play());
  const videoPage = await context.newPage();
  watchRequests(videoPage);
  await videoPage.goto(`http://127.0.0.1:${PORT}/video.html`);
  const videoReady = await videoPage.waitForFunction(() => { const v = document.getElementById('v'); return v && v.videoWidth > 0 && v.videoHeight > 0; }, null, { timeout: 8000 }).then(() => true).catch((e) => String(e));
  const audioId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, MEDIA_URL + '?movie-a');
  const videoId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `http://127.0.0.1:${PORT}/video.html`);
  const audioStart = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: audioId });
  await sleep(900);
  const audioBadge = await movieBadge();
  const audioEng = await movieEngine();
  await sleep(2200); // an unrelated video tab must not flip the captured audio tab
  const audioIgnored = await movieEngine();
  const audioBadgeStill = await movieBadge();
  await sendFrom(popup, { type: 'STOP_CAPTURE' });
  await sleep(400);
  const videoStart = await sendFrom(popup, { type: 'START_CAPTURE_FOR_TAB', tabId: videoId });
  await sleep(900);
  const videoBadge = await movieBadge();
  const videoEng = await movieEngine();
  const uiContexts = () => sw.evaluate(async () => {
    const list = await chrome.runtime.getContexts({ contextTypes: ['POPUP', 'SIDE_PANEL', 'TAB'] });
    return list.map((c) => c.documentUrl || c.contextType);
  });
  const closeDebugTarget = async (path) => {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const t = list.find((x) => x.url === `chrome-extension://${EXT_ID}/${path}`);
    if (!t) return false;
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${t.id}`).catch(() => {});
    return true;
  };
  const closeExtensionUi = async () => {
    if (!popup.isClosed()) await popup.close();
    for (const pg of context.pages()) {
      const url = pg.url();
      if (!pg.isClosed() && (url.includes('undocked=true') || url.includes('popup.html'))) await pg.close().catch(() => {});
    }
    await evalExtensionDoc('popup.html?panel=1', 'window.close()');
    await evalExtensionDoc('popup.html?undocked=true', 'window.close()');
    await evalExtensionDoc('popup.html', 'window.close()');
    for (const path of ['popup.html?panel=1', 'popup.html?undocked=true', 'popup.html']) await closeDebugTarget(path);
    let left = await uiContexts();
    for (let i = 0; i < 15 && left.length; i++) {
      await sleep(200);
      for (const path of ['popup.html?panel=1', 'popup.html?undocked=true', 'popup.html']) await closeDebugTarget(path);
      left = await uiContexts();
    }
    return left;
  };
  const workerMovie = () => sw.evaluate(() => ({
    tab: capturedTabId,
    timer: !!movieWatchTimer,
    override: movieState.override,
    effective: !!movieState.effective,
    detected: !!movieState.detected,
    source: movieState.override === null ? 'auto' : 'manual'
  }));
  const restartWorker = () => sw.evaluate(async () => {
    capturedTabId = null;
    movieState = { captureSessionId: 0, tabId: null, effective: false, override: null, detected: false, audioStreak: 0 };
    movieStateHydrated = false;
    movieStateHydrating = null;
    stopMovieWatchTimer();
    await recoverCaptureSessionOnWake();
    return {
      tab: capturedTabId,
      timer: !!movieWatchTimer,
      override: movieState.override,
      effective: !!movieState.effective,
      detected: !!movieState.detected,
      source: movieState.override === null ? 'auto' : 'manual'
    };
  });
  // Every extension screen is closed: popup, side panel, and any Stay-open window.
  const closedUrls = await closeExtensionUi();
  const closedUi = await movieEngine();
  const uiClosed = await uiContexts();
  // Audio-only (video hidden) then a visible picture, both with no UI open.
  await videoPage.evaluate(() => { document.getElementById('v').style.display = 'none'; });
  await sleep(4000);
  const closedToPlayback = await movieEngine();
  const closedToPlaybackState = await workerMovie();
  const uiDuringPlayback = await uiContexts();
  await videoPage.evaluate(() => { document.getElementById('v').style.display = ''; });
  await sleep(2200);
  const closedToInteractive = await movieEngine();
  const closedToInteractiveState = await workerMovie();
  const uiDuringInteractive = await uiContexts();
  // Worker restart while the screen is still closed, then hide the video again.
  const wakeState = await restartWorker();
  await sleep(700);
  const afterWake = await movieEngine();
  const uiAfterWake = await uiContexts();
  await videoPage.evaluate(() => { document.getElementById('v').style.display = 'none'; });
  await sleep(4000);
  const wakeToPlayback = await movieEngine();
  const wakeToPlaybackState = await workerMovie();
  const uiAfterWakeHide = await uiContexts();
  await videoPage.evaluate(() => { document.getElementById('v').style.display = ''; });
  await sleep(2200);
  const restoredEng = await movieEngine();
  const restoredState = await workerMovie();
  let popupMovie = adopt(await openPopup());
  await sleep(600);
  const movieReopened = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await writeFrom(popupMovie, { type: 'EDIT_PARAMS', params: { bass: 9, hpf: 80, gain: 1.2, semitones: 0 } });
  await writeFrom(popupMovie, { type: 'EDIT_DYNAMICS', dynamics: { leveler: 'slow', match: false, limiter: 'fast', ceiling: 'clean' } });
  await sleep(500);
  await evalOffscreen('globalThis.__oldMovieCtx = audioCtx; 1');
  const beforeSwitch = await movieEngine();
  await popupMovie.click('#btn-movie-mode');
  await sleep(800);
  const manualOff = await popupMovie.evaluate(() => { const b = document.getElementById('btn-movie-mode'); return { text: b.textContent.trim(), cls: b.className }; });
  const offEng = await movieEngine();
  // MOVIE · OFF survives a reopen and a worker restart (the visible video must not take over).
  await popupMovie.close();
  popupMovie = adopt(await openPopup());
  const offReopened = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await popupMovie.close();
  const offWake = await restartWorker();
  await sleep(800);
  const offWakeEng = await movieEngine();
  popupMovie = adopt(await openPopup());
  const offAfterWake = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await popupMovie.click('#btn-movie-mode');
  await sleep(800);
  const manualOn = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  const onEng = await movieEngine();
  await popupMovie.close();
  popupMovie = adopt(await openPopup());
  const onReopened = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await popupMovie.close();
  const onWake = await restartWorker();
  await sleep(800);
  const onWakeEng = await movieEngine();
  popupMovie = adopt(await openPopup());
  const onAfterWake = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await videoPage.evaluate(() => { document.getElementById('v').style.display = 'none'; });
  await sleep(3600);
  const hiddenBadge = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  const hiddenEng = await movieEngine();
  await videoPage.evaluate(() => { document.getElementById('v').style.display = ''; });
  await sleep(500);
  await popupMovie.click('#btn-movie-mode', { modifiers: ['Shift'] });
  await sleep(800);
  const backAuto = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  const autoEng = await movieEngine();
  const frame = await sendFrom(popupMovie, { target: 'offscreen', type: 'GET_AUDIO_FRAME' });
  await sendFrom(popupMovie, { type: 'STOP_CAPTURE' });
  await sleep(400);
  const cleared = await sendFrom(popupMovie, { type: 'GET_STATE' });
  const audioAgain = await sendFrom(popupMovie, { type: 'START_CAPTURE_FOR_TAB', tabId: audioId });
  await sleep(900);
  const audioLabel = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await popupMovie.click('#btn-movie-mode');
  await sleep(700);
  const audioOn = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  const audioOnEng = await movieEngine();
  await popupMovie.click('#btn-movie-mode');
  await sleep(700);
  const audioOff = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  await popupMovie.click('#btn-movie-mode', { modifiers: ['Shift'] });
  await sleep(700);
  const audioAuto = await popupMovie.evaluate(() => document.getElementById('btn-movie-mode').textContent.trim());
  const stopped = await sendFrom(popupMovie, { type: 'STOP_CAPTURE' });
  await audioPage.close();
  await videoPage.close();
  const sameStream = beforeSwitch && offEng && onEng && beforeSwitch.stream && beforeSwitch.stream === offEng.stream && offEng.stream === onEng.stream && autoEng.stream === onEng.stream;
  const sameTracks = beforeSwitch && offEng && JSON.stringify(beforeSwitch.tracks) === JSON.stringify(offEng.tracks) && JSON.stringify(offEng.tracks) === JSON.stringify(onEng.tracks);
  // AudioParam values are 32-bit, so 1.2 and 0.6 do not compare equal to the numbers we sent.
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-3;
  const preserved = offEng && offEng.bass === 9 && offEng.hpf === 80 && near(offEng.gain, 1.2) && near(offEng.release, 0.6) && near(onEng.release, 0.6);
  const movieOk = audioStart?.success === true && audioBadge.text === 'MOVIE' && audioBadge.cls.includes('off') && audioEng?.movie === false && audioEng?.hint === 'playback'
    && audioIgnored?.hint === 'playback' && audioIgnored?.movie === false && audioBadgeStill.text === 'MOVIE'
    && videoStart?.success === true && videoReady === true && videoBadge.text === 'MOVIE · AUTO' && videoBadge.cls.includes('on') && videoEng?.movie === true && videoEng?.hint === 'interactive'
    && closedUi?.hint === 'interactive' && closedUi?.movie === true
    && closedUrls.length === 0 && uiClosed.length === 0
    && closedToPlayback?.movie === false && closedToPlayback?.hint === 'playback'
    && closedToPlaybackState.source === 'auto' && closedToPlaybackState.effective === false && uiDuringPlayback.length === 0
    && closedToInteractive?.movie === true && closedToInteractive?.hint === 'interactive'
    && closedToInteractiveState.source === 'auto' && closedToInteractiveState.effective === true && uiDuringInteractive.length === 0
    && afterWake?.hint === 'interactive' && afterWake?.movie === true
    && wakeState.tab === videoId && wakeState.timer === true && wakeState.override === null && wakeState.effective === true
    && uiAfterWake.length === 0
    && wakeToPlayback?.movie === false && wakeToPlayback?.hint === 'playback'
    && wakeToPlaybackState.source === 'auto' && wakeToPlaybackState.effective === false && uiAfterWakeHide.length === 0
    && restoredEng?.movie === true && restoredEng?.hint === 'interactive' && restoredState.source === 'auto'
    && movieReopened === 'MOVIE · AUTO'
    && manualOff.text === 'MOVIE · OFF' && manualOff.cls.includes('manual-off') && offEng?.movie === false && offEng?.hint === 'playback' && offEng?.old === 'closed'
    && offReopened === 'MOVIE · OFF' && offAfterWake === 'MOVIE · OFF'
    && offWake.override === false && offWake.effective === false && offWakeEng?.movie === false && offWakeEng?.hint === 'playback'
    && manualOn === 'MOVIE · ON' && onEng?.movie === true && onEng?.hint === 'interactive'
    && onReopened === 'MOVIE · ON' && onAfterWake === 'MOVIE · ON'
    && onWake.override === true && onWake.effective === true && onWakeEng?.movie === true && onWakeEng?.hint === 'interactive'
    && hiddenBadge === 'MOVIE · ON' && hiddenEng?.movie === true
    && backAuto === 'MOVIE · AUTO' && autoEng?.movie === true && autoEng?.hint === 'interactive'
    && sameStream && sameTracks && preserved
    && frame?.isCapturing === true && Array.isArray(frame.input) && frame.input.length === 72 && Array.isArray(frame.output)
    && cleared.movieOverride === null && cleared.movieMode === false
    && audioAgain?.success === true && audioLabel === 'MOVIE' && audioOn === 'MOVIE · ON' && audioOnEng?.hint === 'interactive'
    && audioOff === 'MOVIE · OFF' && audioAuto === 'MOVIE' && stopped?.movieOverride === null && stopped?.movieMode === false;
  record('W-MOVIE-MODE', 'Audio capture stays on playback; with every screen closed, hiding and showing the video switches playback and interactive by itself, including after a worker restart; MOVIE · ON and MOVIE · OFF survive a reopen and a restart; the button keeps the stream and the EQ; Shift-click returns to automatic; stopping clears the choice',
    movieOk ? 'PASS' : 'FAIL', {
      videoReady, audioId, videoId, audioStart, audioBadge, audioEng, audioIgnored, audioBadgeStill,
      videoStart, videoBadge, videoEng, closedUi, closedUrls, uiClosed,
      closedToPlayback, closedToPlaybackState, uiDuringPlayback,
      closedToInteractive, closedToInteractiveState, uiDuringInteractive,
      afterWake, wakeState, uiAfterWake, wakeToPlayback, wakeToPlaybackState, uiAfterWakeHide,
      restoredEng, restoredState, movieReopened,
      beforeSwitch, manualOff, offEng, offReopened, offWake, offWakeEng, offAfterWake,
      manualOn, onEng, onReopened, onWake, onWakeEng, onAfterWake, hiddenBadge, hiddenEng, backAuto, autoEng,
      frame: frame && { isCapturing: frame.isCapturing, in: frame.input && frame.input.length, out: frame.output && frame.output.length },
      cleared: { movieMode: cleared.movieMode, movieOverride: cleared.movieOverride },
      audioLabel, audioOn, audioOnEng, audioOff, audioAuto, stopped: { movieMode: stopped?.movieMode, movieOverride: stopped?.movieOverride },
      bases: { playback: audioEng && audioEng.base, interactive: videoEng && videoEng.base }
    });

  // ---- W-MOVIE-PITCH-LOCK: Movie mode locks Pitch off (0 st, wet=0/dry=1), preserves saved preset pitch without marking Modified, blocks Pitch controls with a height-neutral alert, and restores Pitch when Movie mode turns off (L-02, 1.5.6) ----
  const pitchLock = await (async () => {
    const pPage = await context.newPage();
    watchRequests(pPage);
    await pPage.goto(MEDIA_URL + '?movie-pitch');
    await pPage.evaluate(() => document.getElementById('a').play());
    const pTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, MEDIA_URL + '?movie-pitch');
    await sendFrom(popupMovie, { type: 'START_CAPTURE_FOR_TAB', tabId: pTabId });
    await sleep(900);

    // 1. Check initial AUTO (off) status line geometry & text
    const autoLine = await popupMovie.evaluate(() => {
      const el = document.getElementById('movie-status-line');
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        cls: el.className,
        height: Math.round(r.height),
        singleLine: el.scrollWidth <= el.clientWidth + 1,
        bodyH: +document.body.getBoundingClientRect().height.toFixed(1),
        subTop: +document.getElementById('slider-bass').getBoundingClientRect().top.toFixed(1),
        pitchTop: +document.getElementById('slider-pitch').getBoundingClientRect().top.toFixed(1)
      };
    });

    // 2. Save a custom preset "Movie Pitch +4" with semitones: 4.0 while in normal playback mode
    const pitchPresetParams = { bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 4, autoBalance: false, bypass: false, stageBypass: { hpf: false, bass: false, mid: false, high: false, pitch: false, gain: false } };
    await writeFrom(popupMovie, { type: 'SAVE_PRESET', name: 'Movie Pitch +4', params: pitchPresetParams });
    await writeFrom(popupMovie, { type: 'SET_ACTIVE_PRESET', presetName: 'Movie Pitch +4' });
    await writeFrom(popupMovie, { type: 'EDIT_PARAMS', params: pitchPresetParams });
    await sleep(400);
    await popupMovie.close();
    popupMovie = adopt(await openPopup());
    const beforeMovieOn = await popupMovie.evaluate(() => ({
      preset: document.getElementById('preset-select').value,
      badge: document.getElementById('preset-status-badge').textContent.trim(),
      valPitch: document.getElementById('val-pitch').textContent.trim(),
      subText: document.querySelector('.eq-row[data-band="pitch"] .eq-label small').textContent.trim(),
      bodyH: +document.body.getBoundingClientRect().height.toFixed(1),
      subTop: +document.getElementById('slider-bass').getBoundingClientRect().top.toFixed(1),
      pitchTop: +document.getElementById('slider-pitch').getBoundingClientRect().top.toFixed(1)
    }));

    // 3. Click MOVIE to force Movie mode ON while "+4.0 st" preset is active
    await popupMovie.click('#btn-movie-mode');
    await sleep(750);
    const engOn = (await evalOffscreen(`({
      movie: currentMovieMode,
      target: pitchTarget(),
      savedSemitones: currentParams.semitones,
      wet: pitchWetGain ? pitchWetGain.gain.value : null,
      dry: pitchDryGain ? pitchDryGain.gain.value : null,
      nodeSt: pitchNode ? pitchNode.parameters.get('semitones').value : null
    })`)).value;

    const uiOnAlert = await popupMovie.evaluate(() => {
      const el = document.getElementById('movie-status-line');
      const tag = document.querySelector('.band-tag[data-band="pitch"]');
      const val = document.getElementById('val-pitch');
      const vals = [...document.querySelectorAll('.eq-val')];
      const valBoxOverflowCount = vals.filter((v) => v.scrollWidth > v.clientWidth + 1).length;
      return {
        lineText: el.textContent.trim(),
        lineCls: el.className,
        lineH: Math.round(el.getBoundingClientRect().height),
        singleLine: el.scrollWidth <= el.clientWidth + 1,
        tagCls: tag.className,
        tagPressed: tag.getAttribute('aria-pressed'),
        tagDisabled: tag.getAttribute('aria-disabled'),
        subText: document.querySelector('.eq-row[data-band="pitch"] .eq-label small').textContent.trim(),
        valText: val.textContent.trim(),
        valBoxOverflowCount,
        badge: document.getElementById('preset-status-badge').textContent.trim(),
        sliderVal: parseFloat(document.getElementById('slider-pitch').value),
        bodyH: +document.body.getBoundingClientRect().height.toFixed(1),
        subTop: +document.getElementById('slider-bass').getBoundingClientRect().top.toFixed(1),
        pitchTop: +document.getElementById('slider-pitch').getBoundingClientRect().top.toFixed(1)
      };
    });

    // Wait for alert to dismiss (4.5s) and verify steady-state status line
    await sleep(4700);
    const uiOnSteady = await popupMovie.evaluate(() => {
      const el = document.getElementById('movie-status-line');
      return {
        lineText: el.textContent.trim(),
        lineCls: el.className,
        singleLine: el.scrollWidth <= el.clientWidth + 1,
        bodyH: +document.body.getBoundingClientRect().height.toFixed(1),
        subTop: +document.getElementById('slider-bass').getBoundingClientRect().top.toFixed(1),
        pitchTop: +document.getElementById('slider-pitch').getBoundingClientRect().top.toFixed(1)
      };
    });

    // 4. Attempt to click PITCH tag, click Pitch nudge +, and press ArrowRight on #slider-pitch while Movie mode is ON
    await popupMovie.click('.band-tag[data-band="pitch"]', { force: true });
    await sleep(100);
    const afterTagClick = await popupMovie.evaluate(() => ({
      lineText: document.getElementById('movie-status-line').textContent.trim(),
      lineCls: document.getElementById('movie-status-line').className,
      sliderVal: parseFloat(document.getElementById('slider-pitch').value),
      badge: document.getElementById('preset-status-badge').textContent.trim()
    }));
    await popupMovie.click('.eq-nudge-btn[data-target="slider-pitch"][data-action="up"]', { force: true });
    await popupMovie.focus('#slider-pitch');
    await popupMovie.keyboard.press('ArrowRight');
    await sleep(150);
    const afterBlockedInputs = await popupMovie.evaluate(() => ({
      lineText: document.getElementById('movie-status-line').textContent.trim(),
      sliderVal: parseFloat(document.getElementById('slider-pitch').value),
      valText: document.getElementById('val-pitch').textContent.trim(),
      badge: document.getElementById('preset-status-badge').textContent.trim(),
      bodyH: +document.body.getBoundingClientRect().height.toFixed(1)
    }));

    // 5. Nudge Bass (+) and click Update on the custom preset while in Movie mode; verify saved semitones: 4 is preserved in storage
    await popupMovie.click('.eq-nudge-btn[data-target="slider-bass"][data-action="up"]');
    await sleep(200);
    await popupMovie.click('#btn-update-preset');
    await sleep(250);
    const savedPresetInStorage = await popupMovie.evaluate(() => new Promise((r) => {
      chrome.storage.local.get(['presets'], (res) => r(res.presets?.['Movie Pitch +4'] || null));
    }));

    // 6. Click MOVIE to switch to MOVIE · OFF and verify Pitch (+4.0 st) immediately restores in UI and engine
    await popupMovie.click('#btn-movie-mode');
    await sleep(750);
    const uiOff = await popupMovie.evaluate(() => ({
      btnText: document.getElementById('btn-movie-mode').textContent.trim(),
      lineText: document.getElementById('movie-status-line').textContent.trim(),
      lineCls: document.getElementById('movie-status-line').className,
      tagPressed: document.querySelector('.band-tag[data-band="pitch"]').getAttribute('aria-pressed'),
      tagDisabled: document.querySelector('.band-tag[data-band="pitch"]').getAttribute('aria-disabled'),
      subText: document.querySelector('.eq-row[data-band="pitch"] .eq-label small').textContent.trim(),
      valText: document.getElementById('val-pitch').textContent.trim()
    }));
    const engOff = (await evalOffscreen(`({
      movie: currentMovieMode,
      target: pitchTarget(),
      savedSemitones: currentParams.semitones
    })`)).value;

    // Clean up custom preset and restore Flat (Bypass) + stop capture
    await writeFrom(popupMovie, { type: 'DELETE_PRESET', name: 'Movie Pitch +4' });
    await writeFrom(popupMovie, { type: 'SET_ACTIVE_PRESET', presetName: 'Flat (Bypass)' });
    await writeFrom(popupMovie, { type: 'EDIT_PARAMS', params: { bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: true, stageBypass: { hpf: false, bass: false, mid: false, high: false, pitch: false, gain: false } } });
    await sleep(250);
    await sendFrom(popupMovie, { type: 'STOP_CAPTURE' });
    await sleep(300);
    await pPage.close();

    return {
      autoLine,
      beforeMovieOn,
      engOn,
      uiOnAlert,
      uiOnSteady,
      afterTagClick,
      afterBlockedInputs,
      savedPresetInStorage,
      uiOff,
      engOff
    };
  })();
  const pitchLockOk = pitchLock.autoLine.height === 16 && pitchLock.autoLine.singleLine && pitchLock.autoLine.text === 'Music buffer · auto low-delay on video'
    && pitchLock.beforeMovieOn.valPitch === '+4.0 st' && pitchLock.beforeMovieOn.badge === '● Saved'
    && pitchLock.engOn?.movie === true && pitchLock.engOn?.target === 0 && pitchLock.engOn?.savedSemitones === 4 && pitchLock.engOn?.wet === 0 && pitchLock.engOn?.dry === 1 && pitchLock.engOn?.nodeSt === 0
    && pitchLock.uiOnAlert.lineH === 16 && pitchLock.uiOnAlert.singleLine && pitchLock.uiOnAlert.lineCls.includes('alert') && pitchLock.uiOnAlert.lineText.includes('disabled in Movie mode')
    && pitchLock.uiOnAlert.tagCls.includes('off') && pitchLock.uiOnAlert.tagCls.includes('movie-locked') && pitchLock.uiOnAlert.tagPressed === 'false' && pitchLock.uiOnAlert.tagDisabled === 'true'
    && pitchLock.uiOnAlert.subText === 'off in Movie' && pitchLock.uiOnAlert.valText === 'OFF' && pitchLock.uiOnAlert.valBoxOverflowCount === 0 && pitchLock.uiOnAlert.badge === '● Saved'
    && pitchLock.uiOnAlert.bodyH < 600 && pitchLock.uiOnAlert.bodyH === pitchLock.beforeMovieOn.bodyH
    && pitchLock.uiOnAlert.subTop === pitchLock.beforeMovieOn.subTop && pitchLock.uiOnAlert.pitchTop === pitchLock.beforeMovieOn.pitchTop
    && pitchLock.uiOnSteady.lineText === 'Pitch off (+4.0 st saved) · short video buffer' && pitchLock.uiOnSteady.singleLine
    && pitchLock.uiOnSteady.bodyH === pitchLock.beforeMovieOn.bodyH && pitchLock.uiOnSteady.subTop === pitchLock.beforeMovieOn.subTop && pitchLock.uiOnSteady.pitchTop === pitchLock.beforeMovieOn.pitchTop
    && pitchLock.afterTagClick.lineCls.includes('alert') && pitchLock.afterTagClick.sliderVal === 4 && pitchLock.afterTagClick.badge === '● Saved'
    && pitchLock.afterBlockedInputs.sliderVal === 4 && pitchLock.afterBlockedInputs.valText === 'OFF' && pitchLock.afterBlockedInputs.badge === '● Saved' && pitchLock.afterBlockedInputs.bodyH === pitchLock.beforeMovieOn.bodyH
    && pitchLock.savedPresetInStorage?.semitones === 4 && pitchLock.savedPresetInStorage?.bass === 0.5 && pitchLock.savedPresetInStorage?.stageBypass?.pitch === false
    && pitchLock.uiOff.btnText === 'MOVIE · OFF' && pitchLock.uiOff.lineText === 'Movie off (manual) · music buffer · Pitch on'
    && pitchLock.uiOff.tagPressed === 'true' && pitchLock.uiOff.tagDisabled === null && pitchLock.uiOff.subText === 'key, same speed' && pitchLock.uiOff.valText === '+4.0 st'
    && pitchLock.engOff?.movie === false && pitchLock.engOff?.target === 4 && pitchLock.engOff?.savedSemitones === 4;
  record('W-MOVIE-PITCH-LOCK', 'Movie mode locks Pitch off (0 st, wet=0/dry=1), keeps saved preset semitones without marking Modified, blocks Pitch controls with a height-neutral 16 px status-line alert (0.0 px body/slider shift), and restores Pitch when Movie mode turns off',
    pitchLockOk ? 'PASS' : 'FAIL', pitchLock);

  // ---- W-FALLBACK-WINDOW: the Stay-open window page ----
  const fbPage = await context.newPage();
  const fbErrors = [];
  fbPage.on('pageerror', (e) => fbErrors.push(String(e)));
  watchRequests(fbPage);
  const fbUrl = await sw.evaluate(() => typeof FALLBACK_WINDOW_URL !== 'undefined' ? FALLBACK_WINDOW_URL : 'miniplayer.html');
  await fbPage.goto(`chrome-extension://${EXT_ID}/${fbUrl}`);
  await sleep(1500);
  const fbTitle = await fbPage.locator('#player-title').first().textContent().catch(() => null);
  await shot(fbPage, 'fallback-window.png');
  record('W-FALLBACK-WINDOW', 'Stay-open window page loads without script errors and shows the track',
    fbErrors.length === 0 && fbTitle === 'Synthetic Tone' ? 'PASS' : 'FAIL', { url: fbUrl, pageErrors: fbErrors, fbTitle });

  // ---- W-MINIBAR: Document Picture-in-Picture from the Stay-open page (a real click) ----
  const pipSupported = await fbPage.evaluate(() => 'documentPictureInPicture' in window);
  if (pipSupported) {
    await fbPage.click('#btn-minibar');
    await sleep(1200);
    const mb = await fbPage.evaluate(() => {
      const w = window.documentPictureInPicture.window;
      if (!w) return { opened: false, hint: document.getElementById('hint').textContent };
      const d = w.document;
      return { opened: true, title: d.getElementById('mb-title')?.textContent, hasPlay: !!d.getElementById('mb-play'), hasEq: !!d.getElementById('mb-eq'), width: w.innerWidth, height: w.innerHeight };
    });
    if (mb.opened) await fbPage.evaluate(() => window.documentPictureInPicture.window.close());
    record('W-MINIBAR', 'Mini bar opens as a Document PiP window from the Stay-open page and shows the track',
      mb.opened && mb.title === 'Synthetic Tone' && mb.hasPlay && mb.hasEq ? 'PASS' : 'FAIL', mb);
  } else {
    record('W-MINIBAR', 'Mini bar (Document PiP) from the Stay-open page', 'NOT RUN', { reason: 'documentPictureInPicture unavailable in this browser mode' });
  }
  await fbPage.close();

  // ---- W-FALLBACK-SINGLE: repeated "open window" requests reuse one window ----
  await sendFrom(popupMovie, { type: 'OPEN_WINDOW' });
  await sleep(800);
  await sendFrom(popupMovie, { type: 'OPEN_WINDOW' });
  await sleep(800);
  const fbCount = await sw.evaluate(async (u) => (await chrome.runtime.getContexts({ contextTypes: ['TAB'] }))
    .filter((c) => c.documentUrl && c.documentUrl.startsWith(chrome.runtime.getURL(u))).length, fbUrl);
  record('W-FALLBACK-SINGLE', 'Opening the Stay-open window twice keeps a single window', fbCount === 1 ? 'PASS' : 'FAIL', { fbCount });
  for (const pg of context.pages()) if (pg.url().includes('undocked=true')) await pg.close();

  // ---- W-NO-REMOTE-REQUESTS: nothing is contacted beyond the local fixture server ----
  const remote = remoteRequests();
  record('W-NO-REMOTE-REQUESTS', 'Popup, windows and page script make no requests beyond the local fixture server (no Tidal API, no telemetry)',
    remote.length === 0 ? 'PASS' : 'FAIL', { requestsSeen: allRequests.length, remote: remote.slice(0, 10), note: 'On real Tidal the popup also loads the cover image from Tidal\'s image server.' });

  await shot(popupMovie, 'popup-final.png');
  record('W-NO-PAGE-ERRORS', 'No uncaught errors in popup / fake Tidal page during run',
    popupErrors.length === 0 && tidalErrors.length === 0 ? 'PASS' : 'FAIL', { popupErrors, tidalErrors });

  // ---- W-REINJECT-ORPHAN: a tab whose page script is not listening (as after an update or a Reload on the card, which
  // orphans the old copy) still works: the worker re-injects the page script and the screen shows the track ----
  // (A real chrome.runtime.reload() cannot be used here: in this headless setup the extension does not come back.)
  await tidal.close();
  if (!popup.isClosed()) await popup.close(); // nothing may poll the tab before the screen under test opens
  if (!popupMovie.isClosed()) await popupMovie.close();
  const panelClosed = await evalExtensionDoc('popup.html?panel=1', 'window.close()'); // the side panel from W-STAY-OPEN polls too
  await sleep(500);
  const orphan = await context.newPage();
  watchRequests(orphan);
  await orphan.goto(TIDAL_URL + '?hang=1', { waitUntil: 'commit' });
  await sleep(1500);
  const orphanTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, TIDAL_URL.split('?')[0]);
  const probe = (id) => sw.evaluate(async (tabId) => { try { const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_TRACK_INFO' }); return r?.title || 'answered'; } catch (e) { return e.message; } }, id);
  const before = await probe(orphanTabId);
  const openedR = await openPopup();
  const popupRErrors = openedR.errors;
  const popupR = adopt(openedR);
  await sleep(2500);
  const titleAfter = await popupR.locator('#player-title').textContent().catch(() => null);
  const after = await probe(orphanTabId);
  const reinjections = await sw.evaluate((id) => (typeof reinjectedTabs !== 'undefined' ? reinjectedTabs.get(id) : undefined) ?? 0, orphanTabId);
  await shot(popupR, 'popup-orphan-tab.png');
  await popupR.close();
  await orphan.close();
  record('W-REINJECT-ORPHAN', 'A tab with no listening page script (orphaned by an update/Reload) gets it re-injected by the worker: the screen shows its track',
    reinjections >= 1 && titleAfter === 'Synthetic Tone' && after === 'Synthetic Tone' && popupRErrors.length === 0 ? 'PASS' : 'FAIL',
    { pageScriptBefore: before, reinjectionsByWorker: reinjections, titleShown: titleAfter, pageScriptAfter: after, panelClosed, popupRErrors, screenshot: `results/${label}/popup-orphan-tab.png` });

  // ---- 1.5.3: a narrow Tidal page drops its seek bar and time labels. The jumps then go through Tidal's own page
  // (page-bridge.js, world MAIN): its media-session seek handler, else the media element that last played. A forward
  // jump that reaches the end goes to the next track. One fixture tab at a time (the worker picks the Tidal tab). ----
  const jumpCase = async (query, run) => {
    const pg = await context.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e)));
    watchRequests(pg);
    await pg.goto(TIDAL_URL + query);
    await sleep(600);
    await pg.click('#footer-play'); // the page's own play(): the bridge notes the element
    await sleep(700);
    const opened = await openPopup();
    const ppErrors = opened.errors;
    try { return await run(pg, adopt(opened), errs, ppErrors); } finally { await opened.page.close(); await pg.close(); }
  };
  const settle = async (pg, t) => { await pg.evaluate((x) => { window.audioEl.currentTime = x; }, t); await sleep(2300); };

  const narrowSession = await jumpCase('?narrow=1&media=detached&session=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 2);
    const meta = await pp.locator('#player-meta').textContent();
    const t0 = await pg.evaluate(() => window.audioEl.currentTime);
    await pp.click('#player-btn-fwd30'); await sleep(900);
    const t1 = await pg.evaluate(() => window.audioEl.currentTime);
    await sleep(1600);
    await pp.click('#player-btn-back15'); await sleep(900);
    const t2 = await pg.evaluate(() => window.audioEl.currentTime);
    const clicks = await pg.evaluate(() => window.clicks);
    return { meta, fwd: +(t1 - t0).toFixed(2), back: +(t2 - t1).toFixed(2), sessionSeeks: clicks.sessionSeek, barSeeks: clicks.seek, errs, ppErrors };
  });
  record('W-JUMP-NARROW', 'With the seek bar and time labels gone (narrow Tidal page) and the media element out of reach, +30 / -15 go through Tidal\'s own seek handler, and the time still shows',
    narrowSession.fwd > 28 && narrowSession.fwd < 33 && narrowSession.back > -18.5 && narrowSession.back < -12 && narrowSession.sessionSeeks === 2
      && /\d:\d\d \/ 1:00/.test(narrowSession.meta) && narrowSession.errs.length === 0 && narrowSession.ppErrors.length === 0 ? 'PASS' : 'FAIL', narrowSession);

  const narrowElement = await jumpCase('?narrow=1&media=closed', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 2);
    const meta = await pp.locator('#player-meta').textContent();
    const t0 = await pg.evaluate(() => window.audioEl.currentTime);
    await pp.click('#player-btn-fwd30'); await sleep(900);
    const t1 = await pg.evaluate(() => window.audioEl.currentTime);
    return { meta, fwd: +(t1 - t0).toFixed(2), errs, ppErrors };
  });
  record('W-JUMP-NARROW-ELEMENT', 'Same without any media-session handler, the element in a closed shadow root: +30 moves the element that played',
    narrowElement.fwd > 28 && narrowElement.fwd < 33 && /\d:\d\d \/ 1:00/.test(narrowElement.meta) && narrowElement.errs.length === 0 && narrowElement.ppErrors.length === 0 ? 'PASS' : 'FAIL', narrowElement);

  const atEnd = await jumpCase('?tracks=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 45);
    const before = await pg.evaluate(() => ({ t: window.audioEl.currentTime, ...window.clicks }));
    await pp.click('#player-btn-fwd30'); await sleep(150); await pp.click('#player-btn-fwd30'); // a quick second click
    await sleep(1200);
    const after = await pg.evaluate(() => ({ t: window.audioEl.currentTime, title: document.querySelector('[data-test="footer-track-title"]').textContent, ...window.clicks }));
    await sleep(1500);
    const shown = await pp.locator('#player-title').textContent();
    return { nextClicks: after.next - before.next, barSeeks: after.seek - before.seek, title: after.title, shown, t1: +after.t.toFixed(2), errs, ppErrors };
  });
  record('W-JUMP-END', '+30 with less than 30 s left goes to the next track (Tidal\'s Next), with no seek; a quick second click neither skips the new track nor moves it',
    atEnd.nextClicks === 1 && atEnd.barSeeks === 0 && atEnd.title === 'Synthetic Tone 2' && atEnd.shown === 'Synthetic Tone 2' && atEnd.t1 < 5
      && atEnd.errs.length === 0 && atEnd.ppErrors.length === 0 ? 'PASS' : 'FAIL', atEnd);

  const atEndDisabled = await jumpCase('?nextdisabled=1&session=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 45);
    await pp.click('#player-btn-fwd30'); await sleep(1500);
    const after = await pg.evaluate(() => ({ t: window.audioEl.currentTime, ended: window.audioEl.ended, sessionNext: window.clicks.sessionNext, next: window.clicks.next }));
    return { ...after, t: +after.t.toFixed(2), errs, ppErrors };
  });
  record('W-JUMP-END-QUEUE-END', 'At the end of the queue (Next disabled, a next-track handler present), +30 near the end plays the track out instead',
    atEndDisabled.t > 59 && atEndDisabled.sessionNext === 0 && atEndDisabled.next === 0 && atEndDisabled.errs.length === 0 && atEndDisabled.ppErrors.length === 0 ? 'PASS' : 'FAIL', atEndDisabled);

  const atEndNoNext = await jumpCase('?narrow=1&media=detached&nonext=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 45);
    await pp.click('#player-btn-fwd30'); await sleep(1200);
    const after = await pg.evaluate(() => ({ t: window.audioEl.currentTime, ended: window.audioEl.ended }));
    return { t1: +after.t.toFixed(2), ended: after.ended, errs, ppErrors };
  });
  const atEndPaused = await jumpCase('?narrow=1&media=detached&nonext=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 45);
    await pg.click('#footer-play'); await sleep(1500); // paused
    await pp.click('#player-btn-fwd30'); await sleep(1200);
    const after = await pg.evaluate(() => ({ t: window.audioEl.currentTime, ended: window.audioEl.ended, paused: window.audioEl.paused }));
    return { ...after, t: +after.t.toFixed(2), errs, ppErrors };
  });
  record('W-JUMP-END-NO-NEXT', 'With no Next button and no Tidal handler, +30 near the end plays the track out to its end; when paused, it goes to the very end',
    atEndNoNext.t1 > 59 && atEndPaused.t > 59.9 && atEndPaused.ended && atEndNoNext.errs.length === 0 && atEndNoNext.ppErrors.length === 0
      && atEndPaused.errs.length === 0 && atEndPaused.ppErrors.length === 0 ? 'PASS' : 'FAIL', { playing: atEndNoNext, paused: atEndPaused });

  // ---- Review round 2: each route is checked; a route that does nothing hands over to the next; anything else
  // moving the playback during the check (the user in Tidal itself) wins; Next on the screen also holds jumps. ----
  const nextThenJump = await jumpCase('?tracks=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 45);
    await pp.click('#player-btn-next'); await sleep(150); await pp.click('#player-btn-fwd30');
    await sleep(1500);
    const after = await pg.evaluate(() => ({ t: window.audioEl.currentTime, title: document.querySelector('[data-test="footer-track-title"]').textContent, ...window.clicks }));
    return { next: after.next, seek: after.seek, title: after.title, t: +after.t.toFixed(2), errs, ppErrors };
  });
  record('W-NEXT-THEN-JUMP', 'Next on the screen and +30 straight after: one new track, not skipped and not moved to the old track\'s time',
    nextThenJump.next === 1 && nextThenJump.seek === 0 && nextThenJump.title === 'Synthetic Tone 2' && nextThenJump.t < 5
      && nextThenJump.errs.length === 0 && nextThenJump.ppErrors.length === 0 ? 'PASS' : 'FAIL', nextThenJump);

  const noopHandler = await jumpCase('?narrow=1&media=detached&session=noop', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 2);
    const t0 = await pg.evaluate(() => window.audioEl.currentTime);
    await pp.click('#player-btn-fwd30'); await sleep(2000);
    const t1 = await pg.evaluate(() => window.audioEl.currentTime);
    const c = await pg.evaluate(() => window.clicks);
    return { fwd: +(t1 - t0).toFixed(2), handlerCalls: c.sessionSeek, errs, ppErrors };
  });
  record('W-JUMP-NOOP-HANDLER', 'A Tidal seek handler that does nothing hands over to the player element: +30 still moves',
    noopHandler.fwd > 28 && noopHandler.fwd < 34 && noopHandler.handlerCalls === 1 && noopHandler.errs.length === 0 && noopHandler.ppErrors.length === 0 ? 'PASS' : 'FAIL', noopHandler);

  const noopNext = await jumpCase('?narrow=1&media=detached&nonext=1&session=noop', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 45);
    await pg.click('#footer-play'); await sleep(1200); // paused
    await pp.click('#player-btn-fwd30'); await sleep(6500);
    const after = await pg.evaluate(() => ({ t: window.audioEl.currentTime, ended: window.audioEl.ended, handlerCalls: window.clicks.sessionNext }));
    return { ...after, t: +after.t.toFixed(2), errs, ppErrors };
  });
  record('W-JUMP-END-NOOP-NEXT', 'No Next button and a next-track handler that does nothing: after 3 s +30 near the end still ends the track',
    noopNext.t > 59.9 && noopNext.ended && noopNext.handlerCalls === 1 && noopNext.errs.length === 0 && noopNext.ppErrors.length === 0 ? 'PASS' : 'FAIL', noopNext);

  const deadBar = await jumpCase('?deadbar=1&session=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 2);
    const t0 = await pg.evaluate(() => window.audioEl.currentTime);
    await pp.click('#player-btn-fwd30'); await sleep(2200);
    const t1 = await pg.evaluate(() => window.audioEl.currentTime);
    const c = await pg.evaluate(() => window.clicks);
    return { fwd: +(t1 - t0).toFixed(2), barEvents: c.seek, handlerSeeks: c.sessionSeek, errs, ppErrors };
  });
  record('W-JUMP-DEADBAR', 'A seek bar that is there but does nothing hands over to Tidal\'s seek handler after the check',
    deadBar.fwd > 28 && deadBar.fwd < 35 && deadBar.barEvents === 1 && deadBar.handlerSeeks === 1 && deadBar.errs.length === 0 && deadBar.ppErrors.length === 0 ? 'PASS' : 'FAIL', deadBar);

  const userWins = await jumpCase('?deadbar=1&session=1', async (pg, pp, errs, ppErrors) => {
    await settle(pg, 2);
    await pp.click('#player-btn-fwd30'); await sleep(300);
    await pg.evaluate(() => { window.audioEl.currentTime = 12; }); // the user moves Tidal's own timeline meanwhile
    await sleep(2000);
    const t = await pg.evaluate(() => window.audioEl.currentTime);
    const c = await pg.evaluate(() => window.clicks);
    return { t: +t.toFixed(2), handlerSeeks: c.sessionSeek, errs, ppErrors };
  });
  record('W-JUMP-USER-WINS', 'If the playback is moved in Tidal itself during the check, the extension leaves it there (no fallback seek)',
    userWins.t > 12 && userWins.t < 16 && userWins.handlerSeeks === 0 && userWins.errs.length === 0 && userWins.ppErrors.length === 0 ? 'PASS' : 'FAIL', userWins);

  // ---- W-JUMP-FEEDBACK: the investigation's working and silent-failure states, on both shared surfaces.
  // Existing W-JUMP checks above are intentionally unchanged. All pages here remain synthetic and silent.
  const feedbackCases = [];
  const feedbackHint = (pp) => pp.evaluate(() => {
    const el = document.getElementById('hint');
    return el.hidden ? '' : el.textContent;
  });
  const feedbackSet = async (pg, pp, time, paused = true) => {
    await pg.evaluate(({ time, paused }) => {
      audioEl.currentTime = time;
      if (paused) {
        audioEl.pause();
        document.getElementById('footer-play').setAttribute('data-test', 'play');
        document.getElementById('footer-play').setAttribute('aria-label', 'Play');
      }
    }, { time, paused });
    await pp.waitForFunction(({ time, paused }) =>
      currentTrackInfo && Math.abs(currentTrackInfo.currentTime - time) < 2 && currentTrackInfo.isPlaying !== paused,
    { time, paused });
  };
  const feedbackDone = async (pp, count = 1) => {
    await pp.waitForFunction((n) => __transport.length >= n, count, { timeout: 12000 });
    return pp.evaluate(() => __transport.at(-1));
  };
  const blockFeedbackSeek = () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(audioEl, 'currentTime', {
      configurable: true, get() { return descriptor.get.call(this); }, set() {}
    });
  };
  for (const surface of ['popup', 'panel']) {
    const feedbackCase = async (name, query, run, play = true) => {
      const pg = await context.newPage();
      watchRequests(pg);
      const errors = [];
      pg.on('pageerror', (e) => errors.push(String(e)));
      let opened;
      try {
        await pg.goto(TIDAL_URL + query);
        await pg.waitForFunction(() => window.audioEl?.duration > 0);
        if (play) await pg.click('#footer-play');
        opened = await openPopup(surface === 'panel' ? 'popup.html?panel=1' : 'popup.html');
        const pp = opened.page;
        await pp.setViewportSize({ width: surface === 'panel' ? 360 : 440, height: 760 });
        await pp.evaluate(() => {
          window.__transport = [];
          window.__hints = [];
          const hint = document.getElementById('hint');
          new MutationObserver(() => { if (!hint.hidden) __hints.push(hint.textContent); })
            .observe(hint, { subtree: true, childList: true, attributes: true });
          const original = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (m, callback) => {
            if (m.type !== 'FORWARD_PLAYER_COMMAND' || m.command.type === 'GET_TRACK_INFO') return original(m, callback);
            const done = (res) => { __transport.push({ command: m.command, response: res }); callback?.(res); };
            if (window.__replyMode === 'failed') return done({ success: false, error: 'Synthetic transport failure' });
            if (window.__replyMode === 'missing') return done(undefined);
            if (window.__replyMode === 'throw') throw new Error('Synthetic disconnected port');
            return original(m, done);
          };
        });
        const height = await pp.evaluate(() => document.body.getBoundingClientRect().height);
        const evidence = await run(pg, pp);
        const afterHeight = await pp.evaluate(() => document.body.getBoundingClientRect().height);
        assert.equal(afterHeight, height, 'transport hint must not change layout height');
        const hintVisible = await pp.evaluate(() => {
          const el = document.getElementById('hint'), r = el.getBoundingClientRect();
          return el.hidden || (r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth);
        });
        assert.ok(hintVisible, 'feedback must be on-screen, including a short scrolling side panel');
        assert.deepEqual([...errors, ...opened.errors], []);
        feedbackCases.push({ surface, name, pass: true, height, ...evidence });
      } catch (error) {
        feedbackCases.push({ surface, name, pass: false, error: String(error.stack || error) });
      } finally {
        if (opened) await opened.page.close();
        if (!pg.isClosed()) await pg.close();
      }
    };
    for (const [name, query, reachable, playing] of [
      ['bar paused', '', false, false],
      ['bar playing', '', false, true],
      ['reachable media paused', '', true, false],
      ['narrow handler paused', '?narrow=1&media=detached&session=1', false, false],
      ['narrow closed element paused', '?narrow=1&media=closed', false, false],
      ['dead bar falls back', '?deadbar=1&session=1', false, false],
      ['noop handler falls back', '?narrow=1&media=detached&session=noop', false, false]
    ]) {
      await feedbackCase(name, query, async (pg, pp) => {
        if (reachable) await pg.evaluate(() => document.body.append(audioEl));
        await feedbackSet(pg, pp, 5, !playing);
        await pp.click('#player-btn-fwd30');
        const forward = await feedbackDone(pp);
        assert.equal(forward.response.status, 'confirmed');
        assert.equal(await feedbackHint(pp), '');
        const fwd = await pg.evaluate(() => audioEl.currentTime);
        assert.ok(fwd > 32 && fwd < 39);
        await pp.click('#player-btn-back15');
        const back = await feedbackDone(pp, 2);
        assert.equal(back.response.status, 'confirmed');
        assert.equal(await feedbackHint(pp), '');
        const time = await pg.evaluate(() => audioEl.currentTime);
        assert.ok(time > 17 && time < 26);
        const hints = await pp.evaluate(() => __hints);
        if (name === 'dead bar falls back' || name === 'noop handler falls back') assert.ok(hints.includes('Moving playback…'));
        else assert.deepEqual(hints, [], 'fast success must never flash a hint');
        return { fwd, back: time, forward: forward.response, hints };
      });
    }
    await feedbackCase('unknown length before first play', '?narrow=1&media=detached', async (pg, pp) => {
      await pp.click('#player-btn-fwd30');
      assert.equal(await feedbackHint(pp), 'Reload the Tidal tab once, then try again');
      assert.equal(await pp.evaluate(() => __transport.length), 0);
    }, false);
    await feedbackCase('dead bar and empty helper', '?deadbar=1', async (pg, pp) => {
      await pp.click('#player-btn-fwd30');
      const result = await feedbackDone(pp);
      assert.equal(result.response.status, 'exhausted');
      assert.equal(await feedbackHint(pp), 'Reload the Tidal tab once, then try again');
      assert.equal(await pg.evaluate(() => audioEl.currentTime), 0);
      assert.ok(await pp.evaluate(() => __hints.includes('Moving playback…')));
      return { response: result.response };
    }, false);
    await feedbackCase('all routes refuse (synthetic ad-like state)', '?deadbar=1&session=noop', async (pg, pp) => {
      await feedbackSet(pg, pp, 5);
      await pg.evaluate(blockFeedbackSeek);
      await pp.click('#player-btn-fwd30');
      await pp.waitForFunction(() => !document.getElementById('hint').hidden && document.getElementById('hint').textContent === 'Moving playback…');
      const result = await feedbackDone(pp);
      assert.equal(result.response.status, 'exhausted');
      assert.equal(result.response.seeked, false);
      assert.equal(await feedbackHint(pp), "This page isn't allowing seeking right now");
      assert.equal(await pg.evaluate(() => audioEl.currentTime), 5);
      assert.equal(await pp.evaluate(() => currentTrackInfo.currentTime), 5);
      await pp.screenshot({ path: join(outDir, `seek-feedback-${surface}.png`) });
      return { response: result.response, screenshot: `results/${label}/seek-feedback-${surface}.png` };
    });
    // The ignored isolated-world assignment must fail verification, then retain the working footer fallback.
    // With every other route refused as well it must finally show the seek refusal.
    for (const blocked of [false, true]) {
      await feedbackCase(blocked ? 'reachable assignment and all fallbacks ignored' : 'reachable assignment ignored; bar recovers',
        blocked ? '?deadbar=1&session=noop' : '', async (pg, pp) => {
          await feedbackSet(pg, pp, 5);
          await pg.evaluate(() => document.body.append(audioEl));
          if (blocked) await pg.evaluate(blockFeedbackSeek);
          await pp.evaluate(async (url) => {
            const [tab] = await chrome.tabs.query({ url });
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
              const media = document.querySelector('audio');
              const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
              Object.defineProperty(media, 'currentTime', { configurable: true, get() { return descriptor.get.call(this); }, set() {} });
            } });
          }, pg.url());
          await pp.click('#player-btn-fwd30');
          const result = await feedbackDone(pp);
          assert.equal(result.response.status, blocked ? 'exhausted' : 'confirmed');
          assert.equal(await feedbackHint(pp), blocked ? "This page isn't allowing seeking right now" : '');
          assert.ok(Math.abs(await pg.evaluate(() => audioEl.currentTime) - (blocked ? 5 : 35)) < 0.2);
          return { response: result.response };
        });
    }
    await feedbackCase('end goes next; quick repeat held', '?tracks=1', async (pg, pp) => {
      await feedbackSet(pg, pp, 45);
      // Same event turn guarantees that the second click arrives before the confirmation.
      await pp.evaluate(() => { document.getElementById('player-btn-fwd30').click(); document.getElementById('player-btn-fwd30').click(); });
      assert.equal(await feedbackHint(pp), 'Waiting for the next track');
      const result = await feedbackDone(pp);
      assert.equal(result.response.status, 'confirmed');
      assert.equal(await feedbackHint(pp), '');
      const clicks = await pg.evaluate(() => window.clicks);
      assert.equal(clicks.next, 1);
      assert.equal(clicks.seek, 0);
      return { clicks };
    });
    for (const button of ['#player-btn-fwd30', '#player-btn-next']) {
      await feedbackCase(`dead Next (${button})`, '', async (pg, pp) => {
        await feedbackSet(pg, pp, 45);
        await pp.click(button);
        const result = await feedbackDone(pp);
        assert.equal(result.response.status, 'exhausted');
        assert.equal(await feedbackHint(pp), "Tidal didn't move to the next track");
        const clicks = await pg.evaluate(() => window.clicks);
        assert.equal(clicks.next, 1);
        assert.equal(clicks.seek, 0);
        assert.equal(await pg.evaluate(() => audioEl.currentTime), 45);
        return { clicks, response: result.response };
      });
    }
    await feedbackCase('disabled Next ends paused queue', '?nextdisabled=1&session=1', async (pg, pp) => {
      await feedbackSet(pg, pp, 45);
      await pp.click('#player-btn-fwd30');
      const result = await feedbackDone(pp);
      assert.equal(result.response.status, 'confirmed');
      assert.equal(result.response.next, 'end');
      assert.equal(await feedbackHint(pp), '');
      assert.equal(await pg.evaluate(() => audioEl.currentTime), 60);
    });
    await feedbackCase('back at start', '', async (pg, pp) => {
      await feedbackSet(pg, pp, 0);
      await pp.click('#player-btn-back15');
      assert.equal(await feedbackHint(pp), 'Already at the start');
      assert.equal(await pp.evaluate(() => __transport.length), 0);
      assert.equal(await pg.evaluate(() => audioEl.currentTime), 0);
    });
    await feedbackCase('closed target tab', '', async (pg, pp) => {
      await feedbackSet(pg, pp, 5);
      await pg.close();
      await pp.click('#player-btn-fwd30');
      await feedbackDone(pp);
      assert.equal(await feedbackHint(pp), "The Tidal tab isn't reachable. Open it and try again");
      assert.equal(await pp.evaluate(() => currentTrackInfo.currentTime), 5);
    });
    for (const mode of ['failed', 'missing', 'throw']) {
      await feedbackCase(`${mode} transport reply`, '', async (pg, pp) => {
        await feedbackSet(pg, pp, 5);
        await pp.evaluate((mode) => { window.__replyMode = mode; }, mode);
        await pp.click('#player-btn-fwd30');
        assert.equal(await feedbackHint(pp), "The Tidal tab isn't reachable. Open it and try again");
        assert.equal(await pp.evaluate(() => currentTrackInfo.currentTime), 5);
        assert.equal(await pg.evaluate(() => audioEl.currentTime), 5);
      });
    }
    await feedbackCase('manual movement cancels without fallback or failure hint', '?deadbar=1&session=1', async (pg, pp) => {
      await feedbackSet(pg, pp, 5);
      await pp.click('#player-btn-fwd30');
      await sleep(450);
      await pg.evaluate(() => { audioEl.currentTime = 12; });
      const result = await feedbackDone(pp);
      assert.equal(result.response.status, 'cancelled');
      assert.equal(await feedbackHint(pp), '');
      assert.equal(await pg.evaluate(() => audioEl.currentTime), 12);
      assert.equal(await pg.evaluate(() => clicks.sessionSeek), 0);
    });
  }
  record('W-JUMP-FEEDBACK', 'Confirmed jumps clear feedback; every investigated silent failure is explained, without changing popup/panel height',
    feedbackCases.every((c) => c.pass) ? 'PASS' : 'FAIL', { passed: feedbackCases.filter((c) => c.pass).length, total: feedbackCases.length, cases: feedbackCases });

  // ---- W-BRIDGE-PAUSE-TIME: with only Tidal's position report (no element known), paused time is not counted ----
  const pauseTime = await (async () => {
    const pg = await context.newPage();
    watchRequests(pg);
    await pg.goto(TIDAL_URL + '?session=1');
    await sleep(700);
    const ask = () => pg.evaluate(() => {
      const id = `harness-${Math.random()}`;
      let reply;
      const on = (e) => { const m = JSON.parse(e.detail); if (m.id === id) reply = m.reply; };
      document.addEventListener('tme-bridge-reply', on);
      document.dispatchEvent(new CustomEvent('tme-bridge-request', { detail: JSON.stringify({ id, op: 'state' }) }));
      document.removeEventListener('tme-bridge-reply', on);
      return reply;
    });
    await pg.evaluate(() => { navigator.mediaSession.playbackState = 'playing'; navigator.mediaSession.setPositionState({ duration: 60, position: 20, playbackRate: 1 }); });
    await sleep(1000); const playing = await ask();
    await pg.evaluate(() => { navigator.mediaSession.playbackState = 'paused'; });
    await sleep(1000); const paused = await ask();
    await pg.evaluate(() => { navigator.mediaSession.playbackState = 'playing'; });
    await sleep(1000); const resumed = await ask();
    const stateReads = await pg.evaluate(() => navigator.mediaSession.playbackState);
    await pg.close();
    const r = (x) => x && +x.currentTime.toFixed(2);
    return { from: playing && playing.from, playing: r(playing), paused: r(paused), resumed: r(resumed), stateReads };
  })();
  record('W-BRIDGE-PAUSE-TIME', 'Time from Tidal\'s position report alone stops while paused and goes on from there (no rewind, no paused time counted)',
    pauseTime.from === 'session' && Math.abs(pauseTime.playing - 21) < 0.3 && Math.abs(pauseTime.paused - 21) < 0.3 && Math.abs(pauseTime.resumed - 22) < 0.3
      && pauseTime.stateReads === 'playing' ? 'PASS' : 'FAIL', pauseTime);

  // ---- W-BRIDGE-SCOPE: the page-world helper changes nothing outside Tidal ----
  const plain = await context.newPage();
  await plain.goto(MEDIA_URL);
  await sleep(500);
  const plainNative = await plain.evaluate(() => ({
    play: /\[native code\]/.test(HTMLMediaElement.prototype.play.toString()),
    session: !navigator.mediaSession || !Object.prototype.hasOwnProperty.call(navigator.mediaSession, 'setActionHandler'),
    flag: '__tmePageBridge' in window
  }));
  await plain.close();
  record('W-BRIDGE-SCOPE', 'Outside Tidal the page-world helper does nothing (play() and the media session untouched)',
    plainNative.play && plainNative.session && !plainNative.flag ? 'PASS' : 'FAIL', plainNative);

  // ---- W-NO-REMOTE-REQUESTS-LATE: the same audit over the whole run, including the 1.5.3 cases ----
  const remoteLate = remoteRequests();
  record('W-NO-REMOTE-REQUESTS-LATE', 'No request left the two local fixture origins during the whole run (1.5.3 cases included)',
    remoteLate.length === 0 ? 'PASS' : 'FAIL', { requestsSeen: allRequests.length, remote: remoteLate.slice(0, 10), origins: localOrigins() });
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
  for (const r of hanging) r.end();
  server.close();
  tlsServer.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
}
