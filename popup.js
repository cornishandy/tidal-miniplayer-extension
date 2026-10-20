// popup.js - Controller for the DJ Bass Booster screen: toolbar popup, Stay-open window and the mini bar.

let currentParams = {};
let currentPresetName = "Punchy Bass & Clarity";
let presets = {};
let factoryPresetNames = [];
let isCapturingActive = false;
let currentTrackInfo = null;
let activePresetBaseline = null;
let stayOpen = false;
let currentMovieMode = false;
let currentMovieOverride = null;
let currentMovieModeOverride = null;
let movieAlertText = '';
let movieAlertTimer = null;
// Dynamics modes (1.5.0, D-01). From 1.5.8 (R-28) Save and Update may store a copy on the preset.
// The top-level `dynamics` value is still the sound in force. The defaults are the 1.4.0 chain.
const DYN_DEFAULT = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' };
let dynamics = { ...DYN_DEFAULT };
let switchBaseline = null; // saved switches on the selected preset, or null when that preset has none
let presetUiGen = 0; // a newer select, save, update, delete or reset ignores a stale reply
let surfaceEditSeq = 0; // slider and switch edits since this screen opened
// R-28: the worker accepts a write from the screen that wrote last, or from a screen whose controls show the
// latest revision. This screen's id, one per page load, and the revision its controls show. `viewRev` moves
// only with this screen's own accepted writes and the reads it paints, never with another screen's event.
const surfaceId = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : `s${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
let viewRev = 0;
let presetOpsInFlight = 0;
let authoritativePresetPaint = false;
let presetCacheRev = -1;
let presetViewWatching = false;
let dynUnavailableTold = false;
const query = new URLSearchParams(window.location.search);
const isUndocked = query.get('undocked') === 'true';
const isPanel = query.get('panel') === '1';       // Chrome's side panel (Stay open)
const isLongLived = isUndocked || isPanel;        // documents that survive clicks elsewhere
if (isPanel) document.body.classList.add('panel');

const BANDS = ['hpf', 'bass', 'mid', 'high', 'comp', 'gain', 'pitch'];
const THEMES = ['theme-cyan', 'theme-amber', 'theme-synthwave', 'theme-matrix', 'theme-oled'];

// ---------- Band cut model (display only; no audio nodes or parameter writes) ----------
const EqCuts = (() => {
  const ranges = { bass: [45, 80], mid: [800, 1250], high: [6000, 10000] };
  // spectrumPoints reports maxima of 72 logarithmic spans, not 72 endpoint samples.
  const frequencies = Array.from({ length: 72 }, (_, i) => 20 * 1000 ** ((i + 0.5) / 72));
  const points = Object.fromEntries(Object.entries(ranges).map(([band, [lo, hi]]) =>
    [band, frequencies.flatMap((f, i) => f >= lo && f <= hi ? [i] : [])]));

  // Web Audio's biquad coefficients (Audio EQ Cookbook, shelf slope S = 1).
  // HPF Q is in dB in Web Audio; peaking Q is linear:
  // https://webaudio.github.io/web-audio-api/#filters-characteristics
  function biquadDb(type, f, f0, gain, q, rate) {
    const w0 = 2 * Math.PI * f0 / rate;
    const c = Math.cos(w0), s = Math.sin(w0), A = 10 ** (gain / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'highpass') {
      const alpha = s / (2 * 10 ** (q / 20));
      b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha;
    } else if (type === 'peaking') {
      const alpha = s / (2 * q);
      b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A;
    } else {
      const beta = Math.sqrt(2 * A) * s;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * c + beta);
        b1 = 2 * A * ((A - 1) - (A + 1) * c);
        b2 = A * ((A + 1) - (A - 1) * c - beta);
        a0 = (A + 1) + (A - 1) * c + beta;
        a1 = -2 * ((A - 1) + (A + 1) * c);
        a2 = (A + 1) + (A - 1) * c - beta;
      } else {
        b0 = A * ((A + 1) + (A - 1) * c + beta);
        b1 = -2 * A * ((A - 1) + (A + 1) * c);
        b2 = A * ((A + 1) + (A - 1) * c - beta);
        a0 = (A + 1) - (A - 1) * c + beta;
        a1 = 2 * ((A - 1) - (A + 1) * c);
        a2 = (A + 1) - (A - 1) * c - beta;
      }
    }
    const w = 2 * Math.PI * f / rate;
    const magnitude = (x0, x1, x2) => Math.hypot(
      x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w),
      x1 * Math.sin(w) + x2 * Math.sin(2 * w));
    return 20 * Math.log10(Math.max(1e-12, magnitude(b0, b1, b2) / magnitude(a0, a1, a2)));
  }

  function askedDb(p, f, rate = 48000) {
    if (p.bypass) return 0;
    const off = p.stageBypass || {};
    let db = off.gain ? 0 : 20 * Math.log10(p.gain ?? 1);
    if (!off.hpf) db += biquadDb('highpass', f, p.hpf ?? 20, 0, 0.707, rate);
    if (!off.bass) db += biquadDb('lowshelf', f, 120, p.bass || 0, 0, rate);
    if (!off.mid) db += biquadDb('peaking', f, 1000, p.mid || 0, 0.8, rate);
    if (!off.high) db += biquadDb('highshelf', f, 5000, p.high || 0, 0, rate);
    return db;
  }

  function allowed(p, active, movieMode) {
    return active && !p.bypass && !(p.semitones && !p.stageBypass?.pitch && !movieMode);
  }

  function measure(frame, p, active, movieMode) {
    const cuts = { bass: null, mid: null, high: null };
    if (!allowed(p, active, movieMode) || !frame?.isCapturing
      || frame.input?.length !== 72 || frame.output?.length !== 72) return cuts;
    const rate = Number.isFinite(frame.sampleRate) && frame.sampleRate > 0 ? frame.sampleRate : 48000;
    const meter = (key) => Number.isFinite(frame.dyn?.[key]) ? frame.dyn[key] : 0;
    const fullBandLeveler = p.autoBalance && !p.stageBypass?.comp
      && ['full', 'slow'].includes(frame.dyn?.modes?.leveler) ? meter('leveler') : 0;
    const netFullBandReduction = meter('limiter') + fullBandLeveler - meter('match');
    for (const [band, indices] of Object.entries(points)) {
      const valid = indices.filter((i) => Number.isFinite(frame.input[i])
        && frame.input[i] >= -70 && Number.isFinite(frame.output[i]));
      if (valid.length < 2) continue;
      // Independent spectrum maxima can mistake distortion for retained sound. Keep the
      // spectral estimate, floored at live net full-band reduction (not the peak-based ceiling).
      const sum = valid.reduce((total, i) =>
        total + askedDb(p, frequencies[i], rate) - (frame.output[i] - frame.input[i]), 0);
      cuts[band] = Math.max(0, sum / valid.length, netFullBandReduction);
    }
    return cuts;
  }

  function smooth(previous, raw, elapsedMs) {
    if (raw == null || !Number.isFinite(raw)) return { value: 0, visible: false };
    const value = previous.value + (Math.max(0, raw) - previous.value) * -Math.expm1(-Math.max(0, elapsedMs) / 600);
    return { value, visible: previous.visible ? value >= 1 : value >= 2 };
  }

  function position(value, cut, min, max) {
    return Math.max(0, Math.min(1, (value - Math.max(0, cut) - min) / (max - min)));
  }
  return { frequencies, points, biquadDb, askedDb, allowed, measure, smooth, position };
})();
// ---------- End band cut model ----------

// DOM: player
const artCover = document.getElementById('art-cover');
const artSlice = document.getElementById('art-slice');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const playerMeta = document.getElementById('player-meta');
const playerProgressFill = document.getElementById('player-progress-fill');
const playerBtnFav = document.getElementById('player-btn-fav');
const playerBtnPrev = document.getElementById('player-btn-prev');
const playerBtnBack15 = document.getElementById('player-btn-back15');
const playerBtnPlay = document.getElementById('player-btn-play');
const playIcon = document.getElementById('play-icon');
const playerBtnFwd30 = document.getElementById('player-btn-fwd30');
const playerBtnNext = document.getElementById('player-btn-next');

// DOM: EQ power, presets, footer
const toggleEqPower = document.getElementById('toggle-eq-power');
const eqPowerStatusBadge = document.getElementById('eq-power-status-badge');
const btnMovieMode = document.getElementById('btn-movie-mode');
const movieStatusLine = document.getElementById('movie-status-line');
const presetSelect = document.getElementById('preset-select');
const btnPrevPreset = document.getElementById('btn-prev-preset');
const btnNextPreset = document.getElementById('btn-next-preset');
const presetStatusBadge = document.getElementById('preset-status-badge');
const presetSwitchLabel = document.getElementById('preset-switch-label');
const btnUpdatePreset = document.getElementById('btn-update-preset');
const btnSavePreset = document.getElementById('btn-save-preset');
const btnDeletePreset = document.getElementById('btn-delete-preset');
const btnResetDefaults = document.getElementById('btn-reset-defaults');
const toggleStayOpen = document.getElementById('toggle-stay-open');
const themeDots = document.getElementById('theme-dots');
const btnMinibar = document.getElementById('btn-minibar');
const hintEl = document.getElementById('hint');

// DOM: sliders and values
const sliderBass = document.getElementById('slider-bass');
const sliderHpf = document.getElementById('slider-hpf');
const sliderMid = document.getElementById('slider-mid');
const sliderHigh = document.getElementById('slider-high');
const sliderGain = document.getElementById('slider-gain');
const sliderPitch = document.getElementById('slider-pitch');
const valBass = document.getElementById('val-bass');
const valHpf = document.getElementById('val-hpf');
const valMid = document.getElementById('val-mid');
const valHigh = document.getElementById('val-high');
const valGain = document.getElementById('val-gain');
const valPitch = document.getElementById('val-pitch');
const pitchRow = document.querySelector('.eq-row[data-band="pitch"]');
const pitchTag = document.querySelector('.band-tag[data-band="pitch"]');
const pitchSub = pitchRow ? pitchRow.querySelector('.eq-label small') : null;
const pitchNudges = [...document.querySelectorAll('.eq-nudge-btn[data-target="slider-pitch"]')];

// DOM: dynamics modes and meters (AUTO, MATCH, LIM, CEIL)
const modeLeveler = document.getElementById('mode-leveler');
const modeLimiter = document.getElementById('mode-limiter');
const modeCeiling = document.getElementById('mode-ceiling');
const meters = {
  comp: { bar: document.getElementById('meter-comp'), val: document.getElementById('val-comp'), shown: 0 },
  match: { bar: document.getElementById('meter-match'), val: document.getElementById('val-match'), shown: 0 },
  limiter: { bar: document.getElementById('meter-limiter'), val: document.getElementById('val-limiter'), shown: 0 },
  ceiling: { bar: document.getElementById('meter-ceiling'), val: document.getElementById('val-ceiling'), shown: 0 }
};

const bandCuts = Object.fromEntries(['bass', 'mid', 'high'].map((band) => {
  const caption = document.getElementById(`cut-${band}`);
  return [band, {
    caption, normal: caption.textContent,
    tick: document.getElementById(`cut-tick-${band}`),
    slider: document.getElementById(`slider-${band}`),
    state: { value: 0, visible: false }
  }];
}));
let cutFrameAt = null;

function paintBandCuts() {
  for (const { caption, normal, tick, slider, state } of Object.values(bandCuts)) {
    const n = Math.round(state.value);
    caption.textContent = state.visible ? `cut ${n} dB` : normal;
    caption.classList.toggle('cutting', state.visible);
    if (state.visible) {
      caption.title = `About ${n} dB of this band is being taken back by the leveler, limiter and ceiling right now. Measured from the audio, so it shows only while this band has sound.`;
      const ratio = EqCuts.position(+slider.value, state.value, +slider.min, +slider.max);
      // Range thumbs travel within the track's 7 px end insets (14 px thumb).
      tick.style.left = `calc(${ratio * 100}% + ${7 - 14 * ratio}px)`;
    } else {
      caption.removeAttribute('title');
    }
    tick.hidden = !state.visible;
  }
}

function updateBandCuts(frame) {
  const now = Date.now();
  const cuts = EqCuts.measure(frame, currentParams, isCapturingActive, currentMovieMode);
  for (const [band, ui] of Object.entries(bandCuts)) {
    ui.state = EqCuts.smooth(ui.state, cuts[band], cutFrameAt == null ? 66 : now - cutFrameAt);
  }
  cutFrameAt = frame ? now : null;
  paintBandCuts();
}

function syncBandCutVisibility() {
  if (!EqCuts.allowed(currentParams, isCapturingActive, currentMovieMode)) updateBandCuts(null);
  else paintBandCuts();
}

// Per-band on/off. Off keeps the slider value but takes that stage out of the chain.
// `comp` is the Auto-Balancing switch (autoBalance); the others live in stageBypass.
let bandOff = { hpf: false, bass: false, mid: false, high: false, comp: false, gain: false, pitch: false };

const physics = new PhysicsView({
  liveCanvas: document.getElementById('live-canvas'),
  bodeCanvas: document.getElementById('bode-canvas'),
  readoutEl: document.getElementById('physics-readout')
});

// Live spectrum frames come straight from the offscreen audio document while the EQ is on.
let frameTimer = null;
function startFrames() {
  if (frameTimer) return;
  frameTimer = setInterval(() => {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_AUDIO_FRAME' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.isCapturing) { physics.setFrame(null); updateMeters(null); updateBandCuts(null); return; }
      physics.setFrame(res);
      updateMeters(res.dyn || null);
      updateBandCuts(res);
    });
  }, 66);
}
function stopFrames() {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
  physics.setFrame(null);
  updateMeters(null);
  updateBandCuts(null);
}

// ---------- Dynamics meters ----------
// Each bar is how much that stage is turning the music down right now, full at 12 dB (the match bar: the size of its
// trim, signed in the figure). The figure is the true reading and keeps counting past 12 dB; so does the screen-reader
// text, while aria-valuenow stays inside the declared 0 to 12 (1.5.8). Values fall at about 20 dB/s on screen so short
// limiter hits stay visible.
const METER_MAX_DB = 12;
const METER_FALL_PER_FRAME = 1.4;
function updateMeters(dyn) {
  for (const [key, m] of Object.entries(meters)) {
    if (!m.bar || !m.val) continue;
    if (!dyn) {
      m.shown = 0;
      m.bar.firstElementChild.style.width = '0%';
      m.bar.classList.remove('warn', 'heavy');
      m.bar.setAttribute('aria-valuenow', '0');
      m.bar.removeAttribute('aria-valuetext');
      m.val.textContent = 'idle';
      m.val.classList.add('idle');
      continue;
    }
    const raw = Number(dyn[key === 'comp' ? 'leveler' : key]) || 0;
    const size = Math.abs(raw);
    m.shown = Math.max(size, m.shown - METER_FALL_PER_FRAME);
    const pct = Math.max(0, Math.min(100, (m.shown / METER_MAX_DB) * 100));
    m.bar.firstElementChild.style.width = `${pct.toFixed(1)}%`;
    m.bar.classList.toggle('warn', m.shown >= 3 && m.shown < 8);
    m.bar.classList.toggle('heavy', m.shown >= 8);
    m.bar.setAttribute('aria-valuenow', Math.min(METER_MAX_DB, m.shown).toFixed(1));
    const signed = key === 'match' ? raw : -size;
    m.val.textContent = `${signed > 0.05 ? '+' : signed < -0.05 ? '−' : ''}${Math.abs(signed).toFixed(1)} dB`;
    m.bar.setAttribute('aria-valuetext', m.val.textContent);
    m.val.classList.remove('idle');
  }
  if (dyn && dyn.available === false && !dynUnavailableTold) {
    dynUnavailableTold = true;
    showHint('The alternative stages (Bass only, Loudness match, Look-ahead) could not be loaded in this Chrome; the original stages are in use.', 8000);
  }
}

function normaliseDyn(d) {
  const x = d || {};
  return {
    leveler: ['full', 'slow', 'bass'].includes(x.leveler) ? x.leveler : 'full',
    match: x.match === true,
    limiter: ['fast', 'lookahead'].includes(x.limiter) ? x.limiter : 'fast',
    ceiling: ['clean', 'warm'].includes(x.ceiling) ? x.ceiling : 'clean'
  };
}

function applyDynamicsToUI() {
  if (modeLeveler) modeLeveler.value = dynamics.leveler;
  if (modeLimiter) modeLimiter.value = dynamics.limiter;
  if (modeCeiling) modeCeiling.value = dynamics.ceiling;
  renderBandTags();
}

function noteSurfaceEdit() {
  surfaceEditSeq += 1;
  return surfaceEditSeq;
}

function sendDynamicsUpdate(delta) {
  const editAtSend = noteSurfaceEdit();
  const gen = presetUiGen;
  dynamics = normaliseDyn(dynamics);
  chrome.runtime.sendMessage({ type: 'EDIT_DYNAMICS', dynamics: delta, ...viewTag() }, (res) => {
    if (chrome.runtime.lastError) return;
    if (handleRefusal(res, gen, editAtSend)) return;
    noteAccepted(res);
    if (mayPaint(res, gen, editAtSend)) paintPresetSnapshot(res);
  });
  applyDynamicsToUI();
  checkPresetModificationState();
}

if (modeLeveler) modeLeveler.onchange = () => { dynamics.leveler = modeLeveler.value; sendDynamicsUpdate({ leveler: dynamics.leveler }); };
if (modeLimiter) modeLimiter.onchange = () => { dynamics.limiter = modeLimiter.value; sendDynamicsUpdate({ limiter: dynamics.limiter }); };
if (modeCeiling) modeCeiling.onchange = () => { dynamics.ceiling = modeCeiling.value; sendDynamicsUpdate({ ceiling: dynamics.ceiling }); };
window.addEventListener('unload', stopFrames);
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { physics.resize(); physics.updateState(); }, 60);
});

function showHint(text, ms = 4000) {
  if (!hintEl) return;
  clearTimeout(hintHideTimer);
  hintEl.classList.remove('transport-hint');
  hintEl.textContent = text;
  hintEl.hidden = !text;
  if (text && ms) hintHideTimer = setTimeout(() => { hintEl.hidden = true; }, ms);
}
let hintHideTimer = null;

// Stay-open window only: size the window to its content. (Chrome sizes the toolbar popup itself.)
function fitUndockedWindow() {
  if (!isUndocked || !chrome.windows) return;
  const targetW = document.body.offsetWidth || 440;
  const targetH = document.body.offsetHeight;
  chrome.windows.getCurrent((win) => {
    if (chrome.runtime.lastError || !win || win.type !== 'popup') return;
    const chromeW = Math.max(0, window.outerWidth - window.innerWidth);
    const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
    chrome.windows.update(win.id, { width: targetW + chromeW, height: targetH + chromeH });
  });
}

// ---------- Themes ----------
function applyTheme(theme) {
  document.body.classList.remove(...THEMES);
  if (theme && theme !== 'theme-cyan') document.body.classList.add(theme);
  themeDots.querySelectorAll('.dot').forEach((d) => {
    const sel = d.dataset.theme === (theme || 'theme-cyan');
    d.classList.toggle('sel', sel);
    d.setAttribute('aria-pressed', String(sel));
  });
  if (minibar.win) syncMinibarTheme();
}

chrome.storage.local.get('visualTheme', (data) => applyTheme(THEMES.includes(data.visualTheme) ? data.visualTheme : 'theme-cyan'));

themeDots.querySelectorAll('.dot').forEach((dot) => {
  dot.onclick = () => {
    applyTheme(dot.dataset.theme);
    chrome.storage.local.set({ visualTheme: dot.dataset.theme });
  };
});

// ---------- Initial state ----------
function normaliseBypass(p) {
  // Older saved values used `eq` for the whole 3-band EQ, `comp` beside autoBalance, and `speed` for the pitch switch.
  const b = { ...(p.stageBypass || {}) };
  if (b.eq) { b.bass = b.mid = b.high = true; delete b.eq; }
  if (b.comp) { p.autoBalance = false; delete b.comp; }
  p.stageBypass = { hpf: !!b.hpf, bass: !!b.bass, mid: !!b.mid, high: !!b.high, gain: !!b.gain, pitch: !!(b.pitch || b.speed) };
  return p;
}

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError || !response) return;

  isCapturingActive = !!response.isCapturing;
  factoryPresetNames = response.factoryPresets || [];
  // A refusal reply can already have painted a newer state here; this older read must not replace it.
  const openedRev = Number.isInteger(response.stateRev) ? response.stateRev : 0;
  const opened = openedRev >= viewRev;
  if (opened) {
    viewRev = openedRev;
    presets = response.presets || {};
    presetCacheRev = openedRev;
    authoritativePresetPaint = true;
    currentPresetName = response.currentPreset || "Punchy Bass & Clarity";
    currentParams = normaliseBypass(stripDynamics(response.currentParams || presets[currentPresetName] || {}));
    // Hydrate only. A preset's saved switches are not applied again on open.
    dynamics = normaliseDyn(response.dynamics);
  }
  stayOpen = !!response.stayOpen;
  toggleStayOpen.checked = stayOpen;

  updateEqPowerUI(isCapturingActive, response.capturedTabTitle);
  populatePresets(currentPresetName);
  if (opened) {
    applyParamsToUI(currentParams);
    applyDynamicsToUI();
  }
  updateMovieModeUI(response, { checkSavedPitch: true });

  if (opened) {
    const selected = presets[currentPresetName];
    activePresetBaseline = selected ? { ...normaliseBypass(stripDynamics(selected)) } : null;
    // EQ-only presets (legacy custom and factory) compare EQ only, so opening one does not
    // treat the switches already in force as a saved baseline.
    switchBaseline = presetHasSavedSwitches(selected) ? normaliseDyn(selected.dynamics) : null;
  }
  checkPresetModificationState();

  physics.updateState(currentParams, isCapturingActive);
  if (isCapturingActive) startFrames();
  requestAnimationFrame(fitUndockedWindow);

  watchPresetView();

  if (query.get('minibar') === '1') {
    btnMinibar.classList.add('pulse');
    showHint('Click "Mini bar" here to float it. Chrome only lets it open from this window, and it stays as long as this window is open.', 8000);
  }
  if (isPanel) {
    chrome.storage.local.get('minibarHint', (d) => {
      if (!d.minibarHint) return;
      chrome.storage.local.remove('minibarHint');
      btnMinibar.classList.add('pulse');
      showHint('Click "Mini bar" here to float it. It stays as long as this panel is open.', 8000);
    });
  }
});

// ---------- Track info polling ----------
function refreshTrackInfo() {
  chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command: { type: 'GET_TRACK_INFO' } }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.title) {
      currentTrackInfo = res;
      updatePlayerUI(res);
    }
  });
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (!res) return;
    if (typeof res.isCapturing === 'boolean' && res.isCapturing !== isCapturingActive) {
      updateEqPowerUI(res.isCapturing, res.capturedTabTitle);
      physics.updateState(currentParams, res.isCapturing);
    }
    if ('movieMode' in res) updateMovieModeUI(res);
  });
}

function formatTime(secs) {
  if (isNaN(secs) || secs === Infinity) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

let lastArtwork = null;
function updatePlayerUI(info) {
  if (!info) return;
  const title = info.title || 'Unknown Track';
  const artist = info.artist || 'Unknown Artist';
  playerTitle.textContent = title;
  playerArtist.textContent = artist;

  const hasTime = typeof info.duration === 'number' && info.duration > 0;
  playerMeta.textContent = hasTime ? ` · ${formatTime(info.currentTime || 0)} / ${formatTime(info.duration)}` : '';
  playerProgressFill.style.width = hasTime ? `${Math.max(0, Math.min(100, (info.currentTime / info.duration) * 100))}%` : '0%';

  if (info.artwork !== lastArtwork) {
    lastArtwork = info.artwork;
    setArtwork(info.artwork);
  }

  playIcon.setAttribute('href', info.isPlaying ? '#s-pause' : '#s-play');
  playerBtnPlay.title = info.isPlaying ? 'Pause' : 'Play';
  updateHeartUI(info);
  if (minibar.win) renderMinibar(info);
}

// Both art images share one URL. Tidal's 1280 px size is missing for some old albums: step down on error.
function setArtwork(url) {
  for (const img of [artCover, artSlice]) {
    if (url) { img.src = url; img.hidden = false; }
    else { img.hidden = true; img.removeAttribute('src'); }
  }
}
artCover.onerror = () => {
  const src = artCover.getAttribute('src') || '';
  const smaller = src.includes('/1280x1280.') ? src.replace('/1280x1280.', '/640x640.')
    : src.includes('/640x640.') ? src.replace('/640x640.', '/320x320.') : '';
  if (smaller) setArtwork(smaller); else setArtwork('');
};

function updateHeartUI(info) {
  const found = !!info.favoriteFound;
  playerBtnFav.classList.toggle('unavailable', !found);
  playerBtnFav.classList.toggle('on', found && !!info.isFavorite);
  playerBtnFav.title = !found
    ? "Tidal's heart button was not found on this page, so this can't be changed from here."
    : (info.isFavorite ? 'In My Collection. Click to remove.' : 'Add to My Collection');
}

refreshTrackInfo();
const trackPollInterval = setInterval(refreshTrackInfo, 1000);
window.addEventListener('unload', () => clearInterval(trackPollInterval));

// ---------- Transport ----------
function playerCommand(command, after = 250) {
  chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command }, (res) => {
    if (res && res.title) updatePlayerUI(res);
    setTimeout(refreshTrackInfo, after);
  });
}

function handlePlayPause() { cancelTransportFeedback(); playerCommand({ type: 'TOGGLE_PLAY_PAUSE' }); }
// After Next, Previous or a jump into the next track, the screen still shows the old track for up to a second;
// jumps wait for the new one (at most 2 s, 3 s after an end jump), so a quick click never skips it or seeks it
// to the old track's time. Previous that only restarts the same track holds jumps for those 2 s.
let leavingTrack = null;
const leaveTrack = (ms) => { leavingTrack = currentTrackInfo ? { title: currentTrackInfo.title, until: Date.now() + ms } : null; };

const jumpHints = {
  moving: 'Moving playback…',
  held: 'Waiting for the track to change',
  start: 'Already at the start',
  seek: "This page isn't allowing seeking right now",
  helper: 'Reload the tab once, then try again',
  unreachable: "Can't reach the tab. Reload it and try again",
  missing: 'No media tab found. Open one and try again',
  next: "The page didn't move to the next track"
};
let pendingTransport = null;

function showTransportHint(text, ms = 4000) {
  showHint(text, ms);
  if (hintEl && text) hintEl.classList.add('transport-hint');
}

function cancelTransportFeedback() {
  if (pendingTransport) {
    clearTimeout(pendingTransport.progress);
    clearTimeout(pendingTransport.deadline);
    pendingTransport = null;
  }
  if (hintEl && hintEl.classList.contains('transport-hint')) showTransportHint('');
}

function heldForTrack() {
  if ((pendingTransport && pendingTransport.command.type === 'NEXT_TRACK')
    || (leavingTrack && currentTrackInfo && currentTrackInfo.title === leavingTrack.title && Date.now() < leavingTrack.until)) {
    if (pendingTransport) pendingTransport.held = true;
    showTransportHint(jumpHints.held);
    return true;
  }
  return false;
}

function confirmedPlayerCommand(command) {
  cancelTransportFeedback();
  const attempt = { command, held: false };
  pendingTransport = attempt;
  attempt.progress = setTimeout(() => {
    if (pendingTransport === attempt && !attempt.held) showTransportHint(jumpHints.moving, 0);
  }, 400);
  const finish = (res, failed) => {
    if (pendingTransport !== attempt) return; // a newer command owns the feedback
    clearTimeout(attempt.progress);
    clearTimeout(attempt.deadline);
    pendingTransport = null;
    let text = '';
    if (failed || !res || !['confirmed', 'cancelled', 'exhausted'].includes(res.status)) {
      text = res?.error === 'No media tab found' ? jumpHints.missing : jumpHints.unreachable;
    }
    else if (res.status === 'exhausted') text = jumpHints[res.reason] || jumpHints.seek;
    else if (res.status === 'confirmed' && res.success !== true) text = jumpHints.unreachable;
    if (text || res?.status === 'cancelled' || res?.status === 'confirmed') leavingTrack = null;
    showTransportHint(text);
    // Paint only observed playback, never the requested target or an unverified reply.
    if (!text && res?.status === 'confirmed' && res.title) {
      currentTrackInfo = res;
      updatePlayerUI(res);
    }
    setTimeout(refreshTrackInfo, 250);
  };
  // All seek routes, including a no-button Next's end fallback, finish within this bound.
  attempt.deadline = setTimeout(() => finish(null, true), 10000);
  try {
    chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command }, (res) => finish(res, !!chrome.runtime.lastError));
  } catch (_) { finish(null, true); }
}

function handlePrev() { cancelTransportFeedback(); leaveTrack(2000); playerCommand({ type: 'PREV_TRACK' }, 300); }
function handleNext() {
  if (heldForTrack()) return;
  leaveTrack(3000);
  confirmedPlayerCommand({ type: 'NEXT_TRACK' });
}

function handleJump(deltaSecs) {
  if (heldForTrack()) return;
  leavingTrack = null;
  cancelTransportFeedback();
  if (!currentTrackInfo || !currentTrackInfo.duration) {
    showTransportHint(currentTrackInfo ? jumpHints.helper : jumpHints.unreachable);
    return;
  }
  const dur = currentTrackInfo.duration;
  const cur = currentTrackInfo.currentTime || 0;
  if (deltaSecs < 0 && cur <= 0) {
    showTransportHint(jumpHints.start);
    return;
  }
  if (deltaSecs > 0 && cur + deltaSecs >= dur - 0.5) {
    // The jump reaches the end: finish this track and go to the next one, as if it had played out.
    leaveTrack(3000);
    confirmedPlayerCommand({ type: 'NEXT_TRACK', orEnd: true });
    return;
  }
  const newTime = Math.max(0, Math.min(dur, cur + deltaSecs));
  confirmedPlayerCommand({ type: 'SEEK_AUDIO', time: newTime });
}

function handleFav() {
  if (playerBtnFav.classList.contains('unavailable')) {
    showHint("Tidal's heart button was not found in the player bar, so nothing was changed.");
    return;
  }
  chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command: { type: 'TOGGLE_FAVORITE' } }, (res) => {
    if (res && res.found === false) showHint("Tidal's heart button was not found in the player bar, so nothing was changed.");
    setTimeout(refreshTrackInfo, 300);
  });
}

playerBtnPlay.onclick = handlePlayPause;
playerBtnPrev.onclick = handlePrev;
playerBtnNext.onclick = handleNext;
playerBtnBack15.onclick = () => handleJump(-15);
playerBtnFwd30.onclick = () => handleJump(30);
playerBtnFav.onclick = handleFav;

// ---------- EQ power & Movie mode (1.5.5 L-01, 1.5.6 L-02) ----------
function flashMovieAlert(text, ms = 4500) {
  if (!movieStatusLine) return;
  clearTimeout(movieAlertTimer);
  movieAlertText = text || '';
  syncMoviePresentation();
  if (movieAlertText && ms > 0) {
    movieAlertTimer = setTimeout(() => {
      movieAlertText = '';
      syncMoviePresentation();
    }, ms);
  }
}

function showMoviePitchAlert(customMsg, ms = 4500) {
  if (customMsg) {
    flashMovieAlert(customMsg, ms);
    return;
  }
  const savedSt = parseFloat(sliderPitch.value) || 0;
  const detail = Math.abs(savedSt) >= 0.05 ? ` (${fmt.pitch(savedSt)} saved)` : '';
  flashMovieAlert(`Pitch${detail} is disabled in Movie mode (~140 ms delay) — click MOVIE to allow`, ms);
}

function notifyPitchLocked() {
  showMoviePitchAlert();
}

function syncMoviePresentation() {
  syncBandCutVisibility();
  if (btnMovieMode) {
    const on = !!currentMovieMode;
    const manualOff = currentMovieOverride === false;
    const auto = currentMovieOverride == null;
    btnMovieMode.className = 'movie-badge ' + (manualOff ? 'manual-off' : (on ? 'on' : 'off'));
    btnMovieMode.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnMovieMode.textContent = manualOff ? 'MOVIE · OFF' : (auto ? (on ? 'MOVIE · AUTO' : 'MOVIE') : (on ? 'MOVIE · ON' : 'MOVIE · OFF'));
  }

  const savedSt = sliderPitch ? (parseFloat(sliderPitch.value) || 0) : 0;
  const hasSavedShift = Math.abs(savedSt) >= 0.05 && !bandOff.pitch;

  if (pitchRow && pitchTag && sliderPitch && valPitch) {
    if (currentMovieMode) {
      pitchRow.classList.add('is-off', 'movie-locked');
      pitchTag.classList.add('off', 'movie-locked');
      pitchTag.setAttribute('aria-pressed', 'false');
      pitchTag.setAttribute('aria-disabled', 'true');
      pitchTag.title = 'Pitch is disabled in Movie mode (~140 ms granular window). Saved preset pitch is preserved and resumes when Movie mode turns off.';
      if (pitchSub) pitchSub.textContent = 'off in Movie';
      valPitch.textContent = 'OFF';
      valPitch.title = hasSavedShift
        ? `Saved: ${fmt.pitch(savedSt)} (disabled in Movie mode)`
        : 'Disabled in Movie mode (~140 ms granular window)';
      sliderPitch.setAttribute('aria-disabled', 'true');
      pitchNudges.forEach((b) => b.setAttribute('aria-disabled', 'true'));
    } else {
      pitchRow.classList.remove('movie-locked');
      pitchTag.classList.remove('movie-locked');
      pitchTag.removeAttribute('aria-disabled');
      sliderPitch.removeAttribute('aria-disabled');
      pitchNudges.forEach((b) => b.removeAttribute('aria-disabled'));
      if (pitchSub) pitchSub.textContent = 'key, same speed';
      valPitch.textContent = fmt.pitch(savedSt);
      valPitch.title = 'Double-click: neutral / restore';
      const off = !!bandOff.pitch;
      pitchTag.classList.toggle('off', off);
      pitchTag.setAttribute('aria-pressed', String(!off));
      pitchRow.classList.toggle('is-off', off);
      pitchTag.title = off
        ? 'Pitch is off (the value is kept). Click to switch it back on.'
        : 'Pitch is on. Click to switch it off without losing the value.';
    }
  }

  if (movieStatusLine) {
    if (movieAlertText) {
      movieStatusLine.className = 'movie-status-line on active alert';
      movieStatusLine.textContent = movieAlertText;
    } else if (currentMovieMode) {
      movieStatusLine.className = 'movie-status-line on active';
      movieStatusLine.textContent = hasSavedShift
        ? `Pitch off (${fmt.pitch(savedSt)} saved) · short video buffer`
        : 'Pitch off for sync · short video buffer';
    } else if (currentMovieOverride === false) {
      movieStatusLine.className = 'movie-status-line manual-off off';
      movieStatusLine.textContent = 'Movie off (manual) · music buffer · Pitch on';
    } else {
      movieStatusLine.className = 'movie-status-line off';
      movieStatusLine.textContent = 'Music buffer · auto low-delay on video';
    }
  }
}

const renderMovieModeUI = syncMoviePresentation;

function updateMovieModeUI(res, { checkSavedPitch = false } = {}) {
  if (!res) return;
  const wasMovie = currentMovieMode;
  currentMovieMode = !!res.movieMode;
  if ('movieOverride' in res) {
    currentMovieOverride = res.movieOverride ?? null;
    currentMovieModeOverride = currentMovieOverride;
  }
  if (!currentMovieMode && movieAlertText) {
    clearTimeout(movieAlertTimer);
    movieAlertText = '';
  }
  syncMoviePresentation();
  if (currentMovieMode && (!wasMovie || checkSavedPitch)) {
    const savedSt = sliderPitch ? (parseFloat(sliderPitch.value) || 0) : 0;
    if (Math.abs(savedSt) >= 0.05 && !bandOff.pitch) {
      flashMovieAlert(`Pitch (${fmt.pitch(savedSt)}) disabled in Movie mode — saved value kept`);
    }
  }
}

function updateEqPowerUI(active, tabTitle) {
  isCapturingActive = !!active;
  toggleEqPower.checked = isCapturingActive;
  if (isCapturingActive) startFrames(); else stopFrames();
  if (isCapturingActive) {
    eqPowerStatusBadge.className = 'power-badge on';
    eqPowerStatusBadge.textContent = tabTitle ? `● ON · ${tabTitle}` : '● ON';
    eqPowerStatusBadge.title = tabTitle ? `Processing the tab "${tabTitle}"` : 'Processing';
  } else {
    eqPowerStatusBadge.className = 'power-badge off';
    eqPowerStatusBadge.textContent = '○ OFF';
    eqPowerStatusBadge.title = '';
  }
  if (minibar.win) renderMinibarEq();
}

function handleToggleEqPower() {
  const wantActive = !isCapturingActive;
  if (wantActive) {
    // Sent synchronously from the click so Chrome's user-gesture token is still fresh for tabCapture.
    chrome.runtime.sendMessage({ type: 'START_CAPTURE_FOR_TAB' }, (res) => {
      if (res?.success) {
        updateEqPowerUI(true, res.tabTitle);
        updateMovieModeUI(res);
        physics.updateState(currentParams, true);
      } else {
        updateEqPowerUI(false);
        if (res && 'movieMode' in res) updateMovieModeUI(res);
        alert(res?.error || 'Could not attach to the audio tab. Make sure Tidal or a music tab is open.');
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, (res) => {
      updateEqPowerUI(false);
      if (res && 'movieMode' in res) updateMovieModeUI(res);
      else updateMovieModeUI({ movieMode: false, movieOverride: null });
      physics.updateState(currentParams, false);
    });
  }
}

if (btnMovieMode) {
  btnMovieMode.onclick = (e) => {
    const msg = e.shiftKey ? { type: 'SET_MOVIE_MODE', resetAuto: true } : { type: 'SET_MOVIE_MODE', toggle: true };
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && 'movieMode' in res) updateMovieModeUI(res);
    });
  };
}

toggleEqPower.onchange = () => handleToggleEqPower();

// ---------- Stay open / mini bar ----------
// Hand the screen over to Chrome's side panel (docked beside the page, survives clicks anywhere).
// Must run inside the click's activation; falls back to the standalone window where there is no side panel.
async function handOverToPanel({ minibar = false } = {}) {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      if (minibar) await chrome.storage.local.set({ minibarHint: true });
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    } catch (e) { /* fall through to the window */ }
  }
  chrome.runtime.sendMessage({ type: 'OPEN_WINDOW', minibar }, () => window.close());
}

toggleStayOpen.onchange = () => {
  stayOpen = toggleStayOpen.checked;
  chrome.runtime.sendMessage({ type: 'SET_STAY_OPEN', on: stayOpen }, () => {
    // The toolbar popup itself cannot be kept open: move to the side panel now.
    if (stayOpen && !isLongLived) handOverToPanel();
  });
};

btnMinibar.onclick = () => {
  if (isLongLived) openMinibar();
  else handOverToPanel({ minibar: true }); // Chrome only floats a window from a click inside a page that stays alive
};

// The mini bar is a Document Picture-in-Picture window owned by this (Stay-open) window.
const minibar = { win: null, els: null };

function syncMinibarTheme() {
  if (!minibar.win) return;
  const b = minibar.win.document.body;
  b.classList.remove(...THEMES);
  const t = THEMES.find((c) => document.body.classList.contains(c));
  if (t) b.classList.add(t);
}

async function openMinibar() {
  if (minibar.win) { minibar.win.focus(); return; }
  if (!('documentPictureInPicture' in window)) {
    showHint('This Chrome cannot float a window (Document Picture-in-Picture is unavailable).');
    return;
  }
  let win;
  try {
    win = await window.documentPictureInPicture.requestWindow({ width: 480, height: 66 });
  } catch (err) {
    showHint(`Could not float the mini bar: ${err.message}`);
    return;
  }
  const doc = win.document;
  doc.title = 'DJ Bass Booster';
  for (const href of ['popup.css', 'themes.css']) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(href);
    doc.head.appendChild(link);
  }
  doc.body.className = 'minibar';
  doc.body.innerHTML = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">${document.querySelector('svg[aria-hidden]').innerHTML}</svg>
    <div class="mb">
      <img class="mb-art" id="mb-art" alt="">
      <div class="mb-text"><div class="mb-title" id="mb-title">…</div><div class="mb-artist" id="mb-artist"></div></div>
      <button class="tbtn heart" id="mb-fav" title="Add to / remove from My Collection"><svg><use href="#s-heart"/></svg></button>
      <button class="tbtn jump" id="mb-back" title="Back 15 seconds"><svg><use href="#s-back"/></svg><span>15</span></button>
      <button class="tbtn play" id="mb-play" title="Play / Pause"><svg><use id="mb-play-icon" href="#s-play"/></svg></button>
      <button class="tbtn jump" id="mb-fwd" title="Forward 30 seconds"><svg><use href="#s-fwd"/></svg><span>30</span></button>
      <button class="eq-pill off" id="mb-eq" title="Audio EQ on / off">○ EQ</button>
      <button class="mb-close" id="mb-close" title="Close">✕</button>
    </div>`;
  const $ = (id) => doc.getElementById(id);
  minibar.win = win;
  minibar.els = { art: $('mb-art'), title: $('mb-title'), artist: $('mb-artist'), fav: $('mb-fav'), playIcon: $('mb-play-icon'), eq: $('mb-eq') };
  $('mb-play').onclick = handlePlayPause;
  $('mb-back').onclick = () => handleJump(-15);
  $('mb-fwd').onclick = () => handleJump(30);
  $('mb-fav').onclick = handleFav;
  $('mb-eq').onclick = () => handleToggleEqPower();
  $('mb-close').onclick = () => win.close();
  win.addEventListener('pagehide', () => { minibar.win = null; minibar.els = null; });
  syncMinibarTheme();
  if (currentTrackInfo) renderMinibar(currentTrackInfo);
  renderMinibarEq();
}

function renderMinibar(info) {
  const e = minibar.els;
  if (!e) return;
  e.title.textContent = info.title || 'Unknown Track';
  e.artist.textContent = info.artist || '';
  if (info.artwork) { e.art.src = info.artwork; e.art.style.visibility = 'visible'; } else { e.art.removeAttribute('src'); }
  e.playIcon.setAttribute('href', info.isPlaying ? '#s-pause' : '#s-play');
  e.fav.classList.toggle('unavailable', !info.favoriteFound);
  e.fav.classList.toggle('on', !!info.favoriteFound && !!info.isFavorite);
}

function renderMinibarEq() {
  const e = minibar.els;
  if (!e) return;
  e.eq.className = `eq-pill ${isCapturingActive ? 'on' : 'off'}`;
  e.eq.textContent = isCapturingActive ? '● EQ' : '○ EQ';
}

// ---------- Presets ----------
function populatePresets(selectedName) {
  presetSelect.innerHTML = '';
  const optGroupFactory = document.createElement('optgroup');
  optGroupFactory.label = 'Default Presets';
  const optGroupCustom = document.createElement('optgroup');
  optGroupCustom.label = 'My Custom Presets';

  Object.keys(presets).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    (factoryPresetNames.includes(name) ? optGroupFactory : optGroupCustom).appendChild(opt);
  });

  presetSelect.appendChild(optGroupFactory);
  if (optGroupCustom.children.length > 0) presetSelect.appendChild(optGroupCustom);

  if (selectedName && presets[selectedName]) {
    presetSelect.value = selectedName;
    currentPresetName = selectedName;
  }
  updatePresetButtonsVisibility();
}

function presetHasSavedSwitches(preset) {
  if (!preset || !Object.prototype.hasOwnProperty.call(preset, 'dynamics')) return false;
  const d = preset.dynamics;
  return !!d && typeof d === 'object' && !Array.isArray(d);
}

function isFactoryPresetNameUi(name) {
  const folded = String(name || '').toLowerCase();
  return factoryPresetNames.some((factory) => String(factory).toLowerCase() === folded);
}

function stripDynamics(preset) {
  const copy = { ...(preset || {}) };
  delete copy.dynamics;
  return copy;
}

function sameSwitches(a, b) {
  const x = normaliseDyn(a);
  const y = normaliseDyn(b);
  return x.leveler === y.leveler && x.match === y.match && x.limiter === y.limiter && x.ceiling === y.ceiling;
}

function bumpPresetUi() { return ++presetUiGen; }
function presetUiCurrent(gen) { return gen === presetUiGen; }

const SWITCH_LABELS = {
  saved: ['EQ + switches', 'Picking this preset or pressing Reset also sets Leveler, MATCH, Limiter and Ceiling.'],
  custom: ['EQ only', 'Picking this preset sets the EQ only; Leveler, MATCH, Limiter and Ceiling stay as they are. Press Update to save the current switches with it.'],
  factory: ['EQ only', 'Default presets set the EQ only. Save a copy to keep switches with it.']
};
const RESET_TITLE_SWITCHES = "Restore this preset's saved EQ and switches";
const RESET_TITLE_VALUES = "Restore this preset's saved values (factory values for a default preset)";
const FACTORY_NAME_HINT = 'That name belongs to a default preset. Pick another name.';

function updatePresetButtonsVisibility() {
  const isFactory = factoryPresetNames.includes(presetSelect.value);
  btnDeletePreset.style.display = isFactory ? 'none' : 'inline-block';
  checkPresetModificationState();
}

function checkPresetModificationState() {
  if (!activePresetBaseline || !presetStatusBadge) return;
  const currentUI = getParamsFromUI();
  const b = activePresetBaseline;
  const bb = b.stageBypass || {};
  const cb = currentUI.stageBypass;

  const eqModified =
    Math.abs(currentUI.bass - b.bass) > 0.01 ||
    Math.abs(currentUI.hpf - b.hpf) > 0.5 ||
    Math.abs(currentUI.mid - b.mid) > 0.01 ||
    Math.abs(currentUI.high - b.high) > 0.01 ||
    Math.abs(currentUI.gain - b.gain) > 0.01 ||
    Math.abs((currentUI.semitones || 0) - (b.semitones || 0)) > 0.01 ||
    currentUI.autoBalance !== b.autoBalance ||
    ['hpf', 'bass', 'mid', 'high', 'gain', 'pitch'].some((k) => !!cb[k] !== !!bb[k]);
  const isFactory = factoryPresetNames.includes(currentPresetName);
  const hasSwitches = presetHasSavedSwitches(presets[currentPresetName]);
  // A switch change marks Modified only when this preset stored its switches. EQ-only presets
  // keep Update visible so the current switches can be saved with one click.
  const switchesChanged = hasSwitches && !!switchBaseline && !sameSwitches(dynamics, switchBaseline);
  const isModified = eqModified || switchesChanged;
  presetStatusBadge.className = isModified ? 'preset-badge-modified' : 'preset-badge-saved';
  presetStatusBadge.textContent = isModified ? '● Modified' : '● Saved';
  btnUpdatePreset.style.display = (!isFactory && (isModified || !hasSwitches)) ? 'inline-block' : 'none';

  const kind = isFactory ? 'factory' : (hasSwitches ? 'saved' : 'custom');
  if (presetSwitchLabel) {
    presetSwitchLabel.textContent = SWITCH_LABELS[kind][0];
    presetSwitchLabel.title = SWITCH_LABELS[kind][1];
  }
  if (btnResetDefaults) {
    btnResetDefaults.title = (!isFactory && hasSwitches) ? RESET_TITLE_SWITCHES : RESET_TITLE_VALUES;
  }
}

const STALE_VIEW_HINT = 'Another window changed your presets, so this one has been refreshed. Please try again.';

// Every write of the preset state carries these.
function viewTag() {
  return { surfaceId, viewRev };
}

function replyRev(res) {
  if (!res) return null;
  if (Number.isInteger(res.stateRev)) return res.stateRev;
  if (res.state && Number.isInteger(res.state.stateRev)) return res.state.stateRev;
  return null;
}

// This screen's own write was accepted, so viewRev moves up to its revision (never back), even when the reply
// does not repaint. Anything these controls show beyond it is this screen's own later edits: accepted ones, or
// refused ones, and a refusal means the stored revision had already moved past this one.
function noteAccepted(res) {
  if (!res || res.success !== true) return;
  refreshPresetCache(res);
  const rev = replyRev(res);
  if (rev == null || rev < viewRev) return;
  viewRev = rev;
}

function refreshPresetCache(snap) {
  const rev = replyRev(snap);
  if (snap?.presets && rev != null && rev >= presetCacheRev) {
    presets = snap.presets;
    presetCacheRev = rev;
  }
}

function mayPaint(res, gen, editAtSend) {
  if (!res || res.success !== true) return false;
  if (!presetUiCurrent(gen)) return false;
  if (surfaceEditSeq !== editAtSend) return false;
  const rev = replyRev(res);
  return rev != null && rev >= viewRev;
}

function presetOpButtons() {
  return [btnSavePreset, btnUpdatePreset, btnDeletePreset, btnResetDefaults, btnPrevPreset, btnNextPreset];
}

function presetEditControls() {
  return [...presetOpButtons(), presetSelect, sliderBass, sliderHpf, sliderMid, sliderHigh, sliderGain, sliderPitch,
    modeLeveler, modeLimiter, modeCeiling, ...document.querySelectorAll('.eq-nudge-btn'),
    ...document.querySelectorAll('button.band-tag')];
}

function lockPresetOps() {
  presetOpsInFlight += 1;
  authoritativePresetPaint = false;
  for (const control of presetEditControls()) if (control) control.disabled = true;
}

function unlockPresetOps() {
  presetOpsInFlight = Math.max(0, presetOpsInFlight - 1);
  if (presetOpsInFlight === 0) {
    for (const control of presetEditControls()) if (control) control.disabled = false;
  }
}

// A closed message port normally calls back with lastError; a lost callback must not lock a screen forever.
// Ignore a response delivered after its deadline, then reconcile through the same worker queue.
const PRESET_REPLY_TIMEOUT_MS = 5000;
function presetRequest(message, done) {
  let settled = false;
  const finish = (res) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(res);
  };
  const timer = setTimeout(() => finish(null), PRESET_REPLY_TIMEOUT_MS);
  try {
    chrome.runtime.sendMessage(message, (res) => finish(chrome.runtime.lastError ? null : res));
  } catch {
    finish(null);
  }
}

// The stored state, from the worker's queue. Never painted over a newer state these controls already show.
function paintPresetSnapshot(snap) {
  if (!snap) return;
  refreshPresetCache(snap);
  const rev = Number.isInteger(snap.stateRev) ? snap.stateRev : null;
  if (rev == null || rev < viewRev) return;
  viewRev = rev;
  authoritativePresetPaint = true;
  const name = snap.currentPreset || currentPresetName;
  currentPresetName = name;
  populatePresets(name);
  const p = normaliseBypass(stripDynamics(snap.currentParams || presets[name] || {}));
  currentParams = p;
  applyParamsToUI(p);
  currentParams = getParamsFromUI();
  activePresetBaseline = normaliseBypass(stripDynamics(presets[name] || p));
  if (snap.dynamics) {
    dynamics = normaliseDyn(snap.dynamics);
    applyDynamicsToUI();
  }
  const selected = presets[name];
  switchBaseline = presetHasSavedSwitches(selected) ? normaliseDyn(selected.dynamics) : null;
  checkPresetModificationState();
  physics.updateState(currentParams, isCapturingActive);
  return true;
}

// The worker refused this screen's write and wrote nothing. Paint the stored state it sent, with the hint,
// unless this screen has made an edit or started a preset operation since that message: the newer one's own
// reply settles the screen, so a drag converges and a late refusal never paints over a newer accepted edit.
function handleRefusal(res, gen, editAtSend) {
  if (!res || res.error !== 'stale-view') return false;
  refreshPresetCache(res.state);
  const rev = replyRev(res);
  if (res.state && presetUiCurrent(gen) && surfaceEditSeq === editAtSend && rev != null && rev >= viewRev) {
    paintPresetSnapshot(res.state);
    showHint(STALE_VIEW_HINT);
  }
  return true;
}

// A newer local edit is already on screen. Read the queue, which runs after that edit, and paint the result.
function hydrateFromAuthoritativeState(gen, done = () => {}) {
  const seq = surfaceEditSeq;
  presetRequest({ type: 'READ_PRESET_STATE' }, (res) => {
    if (res?.success) refreshPresetCache(res);
    if (!res?.success || !presetUiCurrent(gen)) { done(); return; }
    if (surfaceEditSeq !== seq) {
      hydrateFromAuthoritativeState(gen, done);
      return;
    }
    paintPresetSnapshot(res);
    done();
  });
}

// On focus or visibility: repaint when the stored state is newer than these controls, unless this screen
// made an edit or started a preset operation after the read was sent.
function refreshPresetView() {
  const gen = presetUiGen;
  const editAtSend = surfaceEditSeq;
  chrome.runtime.sendMessage({ type: 'READ_PRESET_STATE' }, (res) => {
    if (!res?.success) return;
    refreshPresetCache(res);
    if (!presetUiCurrent(gen) || surfaceEditSeq !== editAtSend) return;
    if (!Number.isInteger(res.stateRev) || res.stateRev <= viewRev) return;
    paintPresetSnapshot(res);
  });
}

function watchPresetView() {
  if (presetViewWatching) return;
  presetViewWatching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshPresetView();
  });
  window.addEventListener('focus', () => refreshPresetView());
}

function runPresetOperation(message, onPaint = () => {}, hydrateAfterEdit = true) {
  const gen = bumpPresetUi();
  const editAtSend = surfaceEditSeq;
  lockPresetOps();
  presetRequest({ ...message, ...viewTag() }, (res) => {
    const refused = handleRefusal(res, gen, editAtSend);
    noteAccepted(res);
    if (res?.error === 'factory-name') showHint(FACTORY_NAME_HINT);
    if (!res?.success || refused || (hydrateAfterEdit && presetUiCurrent(gen) && surfaceEditSeq !== editAtSend)) {
      hydrateFromAuthoritativeState(gen, unlockPresetOps);
      return;
    }
    if (mayPaint(res, gen, editAtSend) && paintPresetSnapshot(res)) onPaint();
    unlockPresetOps();
  });
}

function canSavePreset() {
  if (presetOpsInFlight) return false;
  if (authoritativePresetPaint) return true;
  // A failed recovery read cannot authorise a Save from an unconfirmed display.
  lockPresetOps();
  hydrateFromAuthoritativeState(presetUiGen, unlockPresetOps);
  return false;
}

function pickPreset(name) {
  runPresetOperation({ type: 'APPLY_PRESET', presetName: name }, () => {
    const savedSt = parseFloat(sliderPitch.value) || 0;
    if (currentMovieMode && Math.abs(savedSt) >= 0.05 && !bandOff.pitch) {
      flashMovieAlert(`Pitch (${fmt.pitch(savedSt)}) disabled in Movie mode — saved value kept`);
    }
  });
}

presetSelect.onchange = () => {
  const name = presetSelect.value;
  // Even the selector keeps the confirmed name until the worker returns its stored snapshot.
  presetSelect.value = currentPresetName;
  pickPreset(name);
};

function stepPreset(direction) {
  if (presetOpsInFlight || presetSelect.disabled) return;
  // Read the rendered optgroups: defaults first, then custom presets, exactly as in the menu.
  const names = Array.from(presetSelect.options, option => option.value);
  if (!names.length) return;
  const index = names.indexOf(currentPresetName);
  const next = index < 0 ? (direction > 0 ? 0 : names.length - 1) : (index + direction + names.length) % names.length;
  pickPreset(names[next]);
}

btnPrevPreset.onclick = () => { if (!btnPrevPreset.disabled) stepPreset(-1); };
btnNextPreset.onclick = () => { if (!btnNextPreset.disabled) stepPreset(1); };

btnSavePreset.onclick = () => {
  if (btnSavePreset.disabled || !canSavePreset()) return;
  const defaultName = factoryPresetNames.includes(currentPresetName)
    ? `${currentPresetName} (Custom)`
    : `${currentPresetName} (New)`;
  const name = prompt('Save current settings as new preset name:', defaultName);
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (isFactoryPresetNameUi(trimmed)) { showHint(FACTORY_NAME_HINT); return; }
  const p = getParamsFromUI();
  const dyn = normaliseDyn(dynamics);
  runPresetOperation({ type: 'SAVE_PRESET', name: trimmed, params: p, dynamics: dyn }, undefined, false);
};

btnUpdatePreset.onclick = () => {
  if (btnUpdatePreset.disabled || !canSavePreset()) return;
  if (!currentPresetName || isFactoryPresetNameUi(currentPresetName)) return;
  const p = getParamsFromUI();
  const dyn = normaliseDyn(dynamics);
  runPresetOperation({ type: 'UPDATE_PRESET', name: currentPresetName, params: p, dynamics: dyn }, () => {
    if (btnUpdatePreset.style.display !== 'none') {
      const orig = btnUpdatePreset.textContent;
      btnUpdatePreset.textContent = 'Saved';
      setTimeout(() => { btnUpdatePreset.textContent = orig; }, 1200);
    }
  }, false);
};

btnDeletePreset.onclick = () => {
  if (btnDeletePreset.disabled) return;
  if (!currentPresetName || factoryPresetNames.includes(currentPresetName)) return;
  if (!confirm(`Delete preset "${currentPresetName}"?`)) return;
  runPresetOperation({ type: 'DELETE_PRESET', name: currentPresetName });
};

btnResetDefaults.onclick = () => {
  if (btnResetDefaults.disabled) return;
  const isFactory = factoryPresetNames.includes(currentPresetName);
  const question = isFactory
    ? `Restore default factory settings for "${currentPresetName}"?`
    : `Discard unsaved changes and go back to the saved values of "${currentPresetName}"?\n\n(Your custom presets are kept.)`;
  if (!confirm(question)) return;
  runPresetOperation({ type: 'RESET_DEFAULT_PRESETS', currentPreset: currentPresetName });
};

// ---------- Values, band switches and the audio engine ----------
const fmt = {
  bass: (v) => `+${parseFloat(v).toFixed(1)} dB`,
  hpf: (v) => `${Math.round(v)} Hz`,
  mid: (v) => `${parseFloat(v) >= 0 ? '+' : ''}${parseFloat(v).toFixed(1)} dB`,
  high: (v) => `${parseFloat(v) >= 0 ? '+' : ''}${parseFloat(v).toFixed(1)} dB`,
  gain: (v) => `${Math.round(parseFloat(v) * 100)}%`,
  pitch: (v) => { const st = parseFloat(v); return `${st > 0 ? '+' : ''}${st.toFixed(1)} st`; }
};
const formatPitch = (v) => fmt.pitch(v);

function computeActivePipelineStages() {
  const byp = currentParams.bypass === true;
  const sb = bandOff || {};
  return {
    pitchOn: !byp && !sb.pitch && !currentMovieMode && Math.abs(currentParams.semitones || 0) >= 0.05,
    hpfOn: !byp && !sb.hpf,
    bassOn: !byp && !sb.bass,
    midOn: !byp && !sb.mid,
    highOn: !byp && !sb.high,
    compOn: !byp && !sb.comp,
    matchOn: !byp && !!dynamics.match,
    gainOn: !byp && !sb.gain,
    movieMode: !!currentMovieMode
  };
}

function renderBandTags() {
  document.querySelectorAll('.band-tag').forEach((tag) => {
    const band = tag.dataset.band;
    if (!band) return; // LIM and CEIL: always on, labels only
    const off = band === 'match' ? !dynamics.match : !!bandOff[band];
    tag.classList.toggle('off', off);
    tag.setAttribute('aria-pressed', String(!off));
    tag.closest('.eq-row')?.classList.toggle('is-off', off);
    const names = { hpf: 'High-pass filter', bass: 'Bass', mid: 'Mid', high: 'High', comp: 'Auto-Balancing', gain: 'Master volume', pitch: 'Pitch' };
    if (band === 'match') {
      tag.title = off
        ? 'Loudness match is off (more bass means more loudness). Click to switch it on.'
        : 'Loudness match is on: the music is kept as loud as the untouched tab. Click to switch it off.';
      return;
    }
    tag.title = off
      ? `${names[band]} is off (the value is kept). Click to switch it back on.`
      : `${names[band]} is on. Click to switch it off without losing the value.`;
  });
  syncMoviePresentation();
}

function applyParamsToUI(p) {
  if (typeof p.bass === 'number') { sliderBass.value = p.bass; valBass.textContent = fmt.bass(p.bass); }
  if (typeof p.hpf === 'number') { sliderHpf.value = p.hpf; valHpf.textContent = fmt.hpf(p.hpf); }
  if (typeof p.mid === 'number') { sliderMid.value = p.mid; valMid.textContent = fmt.mid(p.mid); }
  if (typeof p.high === 'number') { sliderHigh.value = p.high; valHigh.textContent = fmt.high(p.high); }
  if (typeof p.gain === 'number') { sliderGain.value = p.gain; valGain.textContent = fmt.gain(p.gain); }
  // Semitones (1.4.0). Presets saved before that carry a speed ratio under `pitch`, which is ignored: they load at 0 st.
  const st = typeof p.semitones === 'number' ? p.semitones : 0;
  sliderPitch.value = st; valPitch.textContent = fmt.pitch(st);
  const b = p.stageBypass || {};
  bandOff = {
    hpf: !!b.hpf, bass: !!b.bass, mid: !!b.mid, high: !!b.high, gain: !!b.gain, pitch: !!(b.pitch || b.speed),
    comp: typeof p.autoBalance === 'boolean' ? !p.autoBalance : bandOff.comp
  };
  renderBandTags();
}
const renderSliders = applyParamsToUI;
const renderStageBypass = () => renderBandTags();

function getParamsFromUI() {
  return {
    bass: parseFloat(sliderBass.value),
    hpf: parseFloat(sliderHpf.value),
    mid: parseFloat(sliderMid.value),
    high: parseFloat(sliderHigh.value),
    gain: parseFloat(sliderGain.value),
    semitones: parseFloat(sliderPitch.value),
    autoBalance: !bandOff.comp,
    bypass: currentParams.bypass === true,
    stageBypass: { hpf: bandOff.hpf, bass: bandOff.bass, mid: bandOff.mid, high: bandOff.high, gain: bandOff.gain, pitch: bandOff.pitch }
  };
}

function sendAudioParamUpdate(delta) {
  const editAtSend = noteSurfaceEdit();
  const gen = presetUiGen;
  currentParams = getParamsFromUI();
  syncBandCutVisibility();
  chrome.runtime.sendMessage({ type: 'EDIT_PARAMS', params: delta, ...viewTag() }, (res) => {
    if (chrome.runtime.lastError) return;
    if (handleRefusal(res, gen, editAtSend)) return;
    noteAccepted(res);
    if (mayPaint(res, gen, editAtSend)) paintPresetSnapshot(res);
  });
  checkPresetModificationState();
  physics.updateState(currentParams, isCapturingActive);
}

document.querySelectorAll('button.band-tag').forEach((tag) => {
  tag.onclick = () => {
    const band = tag.dataset.band;
    if (band === 'pitch' && currentMovieMode) {
      notifyPitchLocked();
      return;
    }
    if (band === 'match') { // the live switch; a preset remembers it only when you Save or Update (R-28)
      dynamics.match = !dynamics.match;
      sendDynamicsUpdate({ match: dynamics.match });
      return;
    }
    bandOff[band] = !bandOff[band];
    renderBandTags();
    sendAudioParamUpdate(band === 'comp' ? { autoBalance: !bandOff.comp } : { stageBypass: { [band]: bandOff[band] } });
  };
});

// Double-click a value: snap to neutral; double-click again: restore.
function setupValueToggle(valEl, sliderEl, neutralVal, formatFn, onChange) {
  let prevVal = parseFloat(sliderEl.value);
  valEl.ondblclick = (e) => {
    e.preventDefault();
    if (presetOpsInFlight) return;
    if (sliderEl === sliderPitch && currentMovieMode) {
      notifyPitchLocked();
      return;
    }
    const cur = parseFloat(sliderEl.value);
    if (Math.abs(cur - neutralVal) < 0.001) {
      sliderEl.value = (prevVal !== undefined && Math.abs(prevVal - neutralVal) >= 0.001) ? prevVal : parseFloat(sliderEl.defaultValue || neutralVal);
    } else {
      prevVal = cur;
      sliderEl.value = neutralVal;
    }
    valEl.textContent = formatFn(sliderEl.value);
    const key = sliderEl === sliderPitch ? 'semitones' : sliderEl.id.replace('slider-', '');
    sendAudioParamUpdate({ [key]: parseFloat(sliderEl.value) });
    if (onChange) onChange();
  };
}

setupValueToggle(valBass, sliderBass, 0, fmt.bass);
setupValueToggle(valHpf, sliderHpf, 20, fmt.hpf);
setupValueToggle(valMid, sliderMid, 0, fmt.mid);
setupValueToggle(valHigh, sliderHigh, 0, fmt.high);
setupValueToggle(valGain, sliderGain, 1.0, fmt.gain);
setupValueToggle(valPitch, sliderPitch, 0, fmt.pitch);

if (valPitch) {
  valPitch.addEventListener('click', (e) => {
    if (!currentMovieMode) return;
    e.preventDefault();
    notifyPitchLocked();
  });
}

if (sliderPitch) {
  const guardPitchPointer = (e) => {
    if (!currentMovieMode) return;
    e.preventDefault();
    notifyPitchLocked();
  };
  sliderPitch.addEventListener('pointerdown', guardPitchPointer);
  sliderPitch.addEventListener('mousedown', guardPitchPointer);
  sliderPitch.addEventListener('click', guardPitchPointer);
  sliderPitch.addEventListener('keydown', (e) => {
    if (!currentMovieMode) return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      notifyPitchLocked();
    }
  });
}

sliderBass.oninput = (e) => { valBass.textContent = fmt.bass(e.target.value); sendAudioParamUpdate({ bass: parseFloat(e.target.value) }); };
sliderHpf.oninput = (e) => { valHpf.textContent = fmt.hpf(e.target.value); sendAudioParamUpdate({ hpf: parseFloat(e.target.value) }); };
sliderMid.oninput = (e) => { valMid.textContent = fmt.mid(e.target.value); sendAudioParamUpdate({ mid: parseFloat(e.target.value) }); };
sliderHigh.oninput = (e) => { valHigh.textContent = fmt.high(e.target.value); sendAudioParamUpdate({ high: parseFloat(e.target.value) }); };
sliderGain.oninput = (e) => { valGain.textContent = fmt.gain(e.target.value); sendAudioParamUpdate({ gain: parseFloat(e.target.value) }); };
sliderPitch.oninput = (e) => {
  if (currentMovieMode) {
    sliderPitch.value = typeof currentParams.semitones === 'number' ? currentParams.semitones : 0;
    syncMoviePresentation();
    notifyPitchLocked();
    return;
  }
  valPitch.textContent = fmt.pitch(e.target.value);
  sendAudioParamUpdate({ semitones: parseFloat(e.target.value) });
};

// − / + nudges; Shift-click = 5× finer
document.querySelectorAll('.eq-nudge-btn').forEach(btn => {
  btn.onclick = (e) => {
    e.preventDefault();
    const targetId = btn.getAttribute('data-target');
    if (targetId === 'slider-pitch' && currentMovieMode) {
      notifyPitchLocked();
      return;
    }
    const slider = document.getElementById(targetId);
    if (!slider) return;
    let step = parseFloat(btn.getAttribute('data-step') || '0.5');
    if (e.shiftKey) step = step / 5;
    const min = parseFloat(slider.min), max = parseFloat(slider.max);
    let cur = parseFloat(slider.value);
    cur = btn.getAttribute('data-action') === 'up' ? Math.min(max, cur + step) : Math.max(min, cur - step);
    const decimals = step < 0.1 ? 2 : (step < 1 ? 1 : 0);
    slider.value = cur.toFixed(decimals);
    slider.dispatchEvent(new Event('input'));
  };
});

// Hint from the background when the window was opened for the mini bar and already existed.
chrome.runtime.onMessage.addListener((message) => {
  if (message && (message.type === 'MOVIE_MODE_CHANGED' || message.type === 'AUDIO_STATE_CHANGED') && 'movieMode' in message) {
    updateMovieModeUI(message);
  }
  if (message?.type === 'MINIBAR_HINT' && isLongLived) {
    btnMinibar.classList.remove('pulse');
    void btnMinibar.offsetWidth;
    btnMinibar.classList.add('pulse');
    showHint('Click "Mini bar" here to float it.', 6000);
  }
});
