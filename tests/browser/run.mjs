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
  res.writeHead(200, { 'content-type': file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
  if (url.searchParams.get('hang') === '1') {
    // Whole page delivered, connection held open: the document never finishes loading, so the manifest's
    // document_idle page script never runs. That is the state of a tab whose page script was orphaned.
    res.write(readFileSync(p));
    hanging.push(res);
    return;
  }
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
// Every request made by pages and extension documents during the run (privacy check at the end).
const allRequests = [];
const watchRequests = (page) => page.on('request', (r) => allRequests.push(r.url()));

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
    return { slack: +slack.toFixed(1), belowRows: +(foot.top - last.bottom).toFixed(1), bodyH: +bodyH.toFixed(1), bodyW: document.body.getBoundingClientRect().width };
  });
  record('W-NO-DEAD-SPACE', 'No empty band above or below the EQ sliders; popup height follows content',
    space.slack < 4 && space.belowRows < 20 && space.bodyH < 600 && space.bodyW === 440 ? 'PASS' : 'FAIL', space);

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

  // ---- W-KEYBOARD: Tab reaches every control with a visible focus ring; arrows and Space operate sliders and buttons ----
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
  const { page: popup2 } = await openPopup();
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
  const graph = await evalOffscreen(`({ isCapturing, ctx: audioCtx && audioCtx.state, dsp: dspPathGain && dspPathGain.gain.value, direct: directPassThroughGain && directPassThroughGain.gain.value, tracks: currentStream && currentStream.getAudioTracks().map(t => t.readyState) })`);
  const captureOk = startRes?.success === true && graph.value?.isCapturing === true && graph.value?.ctx === 'running';
  record('W-CAPTURE-START', 'EQ attaches to the synthetic tab; offscreen DSP graph runs',
    captureOk ? 'PASS' : (String(startRes?.error || '').includes('invoked') ? 'BLOCKED' : 'FAIL'),
    { startRes, graph, note: 'Uses --allowlisted-extension-id to stand in for the toolbar click, which automation cannot perform.' });

  const NONE = { hpf: false, bass: false, mid: false, high: false, gain: false, pitch: false };
  if (captureOk) {
    const measure = `(async () => {
      const an = audioCtx.createAnalyser(); an.fftSize = 16384; an.smoothingTimeConstant = 0;
      const tap = (typeof outputCeiling !== 'undefined' && outputCeiling) || masterLimiter;
      tap.connect(an);
      await new Promise(r => setTimeout(r, 700));
      const d = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(d); const hz = audioCtx.sampleRate / an.fftSize;
      const at = (f) => Math.max(...[-2,-1,0,1,2].map(k => d[Math.round(f / hz) + k]));
      const t = new Float32Array(an.fftSize); an.getFloatTimeDomainData(t); let peak = 0; for (const v of t) peak = Math.max(peak, Math.abs(v));
      const r = { hz60: +at(60).toFixed(1), hz1k: +at(1000).toFixed(1), hz8k: +at(8000).toFixed(1), hz500: +at(500).toFixed(1), hz2k: +at(2000).toFixed(1), peak: +peak.toFixed(3), tap: tap === masterLimiter ? 'limiter' : 'ceiling' };
      tap.disconnect(an); return r; })()`;
    const setParams = (params) => sendFrom(popup, { type: 'UPDATE_AUDIO_PARAMS', params });

    await setParams({ bass: 0, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(400);
    const flat = (await evalOffscreen(measure)).value;
    await setParams({ bass: 10, hpf: 20, mid: 0, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(400);
    const boosted = (await evalOffscreen(measure)).value;
    const lift60 = boosted && flat ? boosted.hz60 - flat.hz60 : null;
    const lift1k = boosted && flat ? boosted.hz1k - flat.hz1k : null;
    record('W-AUDIO-TRANSPARENT', 'Flat settings pass the tone at its original level (input peak 0.15)',
      flat && Math.abs(flat.peak - 0.15) < 0.01 ? 'PASS' : 'FAIL', { flat }, 'objective-audio');
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

    await setParams({ bass: 14, hpf: 20, mid: 6, high: 6, gain: 2.5, semitones: 0, autoBalance: false, bypass: false, stageBypass: NONE });
    await sleep(500);
    const hot = (await evalOffscreen(measure)).value;
    record('W-AUDIO-LIMITER', 'Worst-case settings (bass +14, mid/high +6, 250%) never exceed -0.3 dBFS at the output',
      hot && hot.peak <= 0.967 ? 'PASS' : 'FAIL', { hot, note: 'linear sample peak; 0.966 = -0.3 dBFS, 1.0 = 0 dBFS' }, 'objective-audio');

    // ---- W-CAPTURE-STOP ----
    const stopRes = await sendFrom(popup, { type: 'STOP_CAPTURE' });
    await sleep(500);
    const afterStop = await evalOffscreen(`({ isCapturing, ctx: audioCtx ? audioCtx.state : null, stream: !!currentStream })`);
    const state = await sendFrom(popup, { type: 'GET_STATE' });
    record('W-CAPTURE-STOP', 'Stop releases stream + AudioContext; state reports OFF',
      stopRes?.success && afterStop.value?.isCapturing === false && !afterStop.value?.stream && state.isCapturing === false ? 'PASS' : 'FAIL',
      { stopRes, afterStop, stateIsCapturing: state.isCapturing });

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
    for (const id of ['W-AUDIO-TRANSPARENT', 'W-AUDIO-BASS', 'W-AUDIO-BAND-SWITCH', 'W-AUDIO-HPF', 'W-PITCH', 'W-AUDIO-LIMITER', 'W-CAPTURE-STOP', 'W-CAPTURE-RESTART', 'W-TAB-CLOSE-CLEANUP', 'W-TAB-CLOSE-AFTER-SW-RESTART']) {
      record(id, 'depends on W-CAPTURE-START', 'BLOCKED', null);
    }
  }

  // ---- W-STAY-OPEN: a real click on the switch hands the screen to Chrome's side panel and makes the icon open it; off restores the popup ----
  const popupBefore = await sw.evaluate(() => chrome.action.getPopup({}));
  const { page: popup3 } = await openPopup();
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
  record('W-STAY-OPEN', 'Stay open (real click): the toolbar icon switches to the side panel (no popup); off restores the popup',
    /popup\.html$/.test(popupBefore) && popupWhenOn === '' && stayStored === true && behaviourOn === true && /popup\.html$/.test(popupWhenOff) && behaviourOff === false ? 'PASS' : 'FAIL',
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
        titleWraps: getComputedStyle(document.getElementById('player-title')).whiteSpace !== 'nowrap'
      };
    });
    await panelPage.screenshot({ path: join(outDir, `panel-${width}.png`) });
    return m;
  };
  const w300 = await layoutAt(300);
  const w360 = await layoutAt(360);
  // Band buttons in the panel are icons (option A): icon visible, text hidden, slash when off.
  const bandBtn = await panelPage.evaluate(() => {
    const b = document.querySelector('.band-tag[data-band="mid"]');
    const icon = b.querySelector('.band-icon').getBoundingClientRect();
    const textHidden = getComputedStyle(b.querySelector('.band-text')).display === 'none';
    return { iconW: Math.round(icon.width), textHidden, size: Math.round(b.getBoundingClientRect().width) };
  });
  await panelPage.click('.band-tag[data-band="mid"]');
  await sleep(300);
  const bandOff = await panelPage.evaluate(() => {
    const b = document.querySelector('.band-tag[data-band="mid"]');
    return { off: b.classList.contains('off'), slash: getComputedStyle(b, '::after').content !== 'none', rowDim: b.closest('.eq-row').classList.contains('is-off') };
  });
  await panelPage.screenshot({ path: join(outDir, 'panel-360-band-off.png') });
  await panelPage.click('.band-tag[data-band="mid"]'); // back on
  await sleep(200);
  const w400 = await layoutAt(400);
  const w480 = await layoutAt(480);
  await panelPage.close();
  const fits = (m) => m.panelClass && m.scrollW <= m.clientW && !m.stripShown && m.coverShown && m.coverRightOfTitle && m.coverEdgeGap <= 1;
  const stackedOk = (m, minSlider) => fits(m) && m.stacked && m.coverW === 56 && m.titleWraps && m.transportW >= m.npInner - 2 && m.sliderW >= minSlider;
  const normalOk = (m, minSlider) => fits(m) && !m.stacked && m.coverW === 76 && !m.titleWraps && m.sliderW >= minSlider;
  record('W-PANEL-LAYOUT', 'Side panel adapts live: stacked player at 300 and 360 px (no art slice, 56 px cover top right, full-width transport, title may wrap), normal layout at 400 and 480 px; no horizontal overflow; sliders usable; band icon buttons toggle; no errors',
    stackedOk(w300, 130) && stackedOk(w360, 150) && normalOk(w400, 150) && normalOk(w480, 250) && panelErrors.length === 0
      && bandBtn.iconW >= 14 && bandBtn.textHidden && bandBtn.size >= 26 && bandOff.off && bandOff.slash && bandOff.rowDim ? 'PASS' : 'FAIL',
    { w300, w360, w400, w480, bandBtn, bandOff, panelErrors, screenshots: [300, 360, 400, 480].map((w) => `results/${label}/panel-${w}.png`) });

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
  await sendFrom(popup, { type: 'OPEN_WINDOW' });
  await sleep(800);
  await sendFrom(popup, { type: 'OPEN_WINDOW' });
  await sleep(800);
  const fbCount = await sw.evaluate(async (u) => (await chrome.runtime.getContexts({ contextTypes: ['TAB'] }))
    .filter((c) => c.documentUrl && c.documentUrl.startsWith(chrome.runtime.getURL(u))).length, fbUrl);
  record('W-FALLBACK-SINGLE', 'Opening the Stay-open window twice keeps a single window', fbCount === 1 ? 'PASS' : 'FAIL', { fbCount });
  for (const pg of context.pages()) if (pg.url().includes('undocked=true')) await pg.close();

  // ---- W-NO-REMOTE-REQUESTS: nothing is contacted beyond the local fixture server ----
  const remote = allRequests.filter((u) => !/^(chrome-extension:|http:\/\/127\.0\.0\.1:|http:\/\/fake-tidal\.com:|data:|blob:|about:)/.test(u));
  record('W-NO-REMOTE-REQUESTS', 'Popup, windows and page script make no requests beyond the local fixture server (no Tidal API, no telemetry)',
    remote.length === 0 ? 'PASS' : 'FAIL', { requestsSeen: allRequests.length, remote: remote.slice(0, 10), note: 'On real Tidal the popup also loads the cover image from Tidal\'s image server.' });

  await shot(popup, 'popup-final.png');
  record('W-NO-PAGE-ERRORS', 'No uncaught errors in popup / fake Tidal page during run',
    popupErrors.length === 0 && tidalErrors.length === 0 ? 'PASS' : 'FAIL', { popupErrors, tidalErrors });

  // ---- W-REINJECT-ORPHAN: a tab whose page script is not listening (as after an update or a Reload on the card, which
  // orphans the old copy) still works: the worker re-injects the page script and the screen shows the track ----
  // (A real chrome.runtime.reload() cannot be used here: in this headless setup the extension does not come back.)
  await tidal.close();
  if (!popup.isClosed()) await popup.close(); // nothing may poll the tab before the screen under test opens
  const panelClosed = await evalExtensionDoc('popup.html?panel=1', 'window.close()'); // the side panel from W-STAY-OPEN polls too
  await sleep(500);
  const orphan = await context.newPage();
  watchRequests(orphan);
  await orphan.goto(TIDAL_URL + '?hang=1', { waitUntil: 'commit' });
  await sleep(1500);
  const orphanTabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, TIDAL_URL.split('?')[0]);
  const probe = (id) => sw.evaluate(async (tabId) => { try { const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_TRACK_INFO' }); return r?.title || 'answered'; } catch (e) { return e.message; } }, id);
  const before = await probe(orphanTabId);
  const { page: popupR, errors: popupRErrors } = await openPopup();
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
  rmSync(profile, { recursive: true, force: true });
}
