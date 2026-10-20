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
let switchBaseline = null; // what Modified compares against; the worker keeps a copy in session storage
let presetUiGen = 0; // a newer select, save, update, delete or reset ignores a stale reply
let dynUnavailableTold = false;
const query = new URLSearchParams(window.location.search);
const isUndocked = query.get('undocked') === 'true';
const isPanel = query.get('panel') === '1';       // Chrome's side panel (Stay open)
const isLongLived = isUndocked || isPanel;        // documents that survive clicks elsewhere
if (isPanel) document.body.classList.add('panel');

const BANDS = ['hpf', 'bass', 'mid', 'high', 'comp', 'gain', 'pitch'];
const THEMES = ['theme-cyan', 'theme-amber', 'theme-synthwave', 'theme-matrix', 'theme-oled'];

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
      if (chrome.runtime.lastError || !res || !res.isCapturing) { physics.setFrame(null); updateMeters(null); return; }
      physics.setFrame(res);
      updateMeters(res.dyn || null);
    });
  }, 66);
}
function stopFrames() {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
  physics.setFrame(null);
  updateMeters(null);
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

function sendDynamicsUpdate() {
  dynamics = normaliseDyn(dynamics);
  chrome.runtime.sendMessage({ type: 'SET_DYNAMICS', dynamics });
  applyDynamicsToUI();
  checkPresetModificationState();
}

if (modeLeveler) modeLeveler.onchange = () => { dynamics.leveler = modeLeveler.value; sendDynamicsUpdate(); };
if (modeLimiter) modeLimiter.onchange = () => { dynamics.limiter = modeLimiter.value; sendDynamicsUpdate(); };
if (modeCeiling) modeCeiling.onchange = () => { dynamics.ceiling = modeCeiling.value; sendDynamicsUpdate(); };
window.addEventListener('unload', stopFrames);
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { physics.resize(); physics.updateState(); }, 60);
});

function showHint(text, ms = 4000) {
  if (!hintEl) return;
  hintEl.textContent = text;
  hintEl.hidden = !text;
  if (text && ms) setTimeout(() => { if (hintEl.textContent === text) hintEl.hidden = true; }, ms);
}

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
  presets = response.presets || {};
  factoryPresetNames = response.factoryPresets || [];
  currentPresetName = response.currentPreset || "Punchy Bass & Clarity";
  currentParams = normaliseBypass(stripDynamics(response.currentParams || presets[currentPresetName] || {}));
  stayOpen = !!response.stayOpen;
  toggleStayOpen.checked = stayOpen;
  // Hydrate only. A preset's saved switches are not applied again on open.
  dynamics = normaliseDyn(response.dynamics);

  updateEqPowerUI(isCapturingActive, response.capturedTabTitle);
  populatePresets(currentPresetName);
  applyParamsToUI(currentParams);
  applyDynamicsToUI();
  updateMovieModeUI(response, { checkSavedPitch: true });

  const selected = presets[currentPresetName];
  activePresetBaseline = selected ? { ...normaliseBypass(stripDynamics(selected)) } : null;
  if (response.switchBaseline) switchBaseline = normaliseDyn(response.switchBaseline);
  else if (presetHasSavedSwitches(selected)) switchBaseline = normaliseDyn(selected.dynamics);
  else switchBaseline = normaliseDyn(dynamics);
  checkPresetModificationState();

  physics.updateState(currentParams, isCapturingActive);
  if (isCapturingActive) startFrames();
  requestAnimationFrame(fitUndockedWindow);

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

function handlePlayPause() { playerCommand({ type: 'TOGGLE_PLAY_PAUSE' }); }
// After Next, Previous or a jump into the next track, the screen still shows the old track for up to a second;
// jumps wait for the new one (at most 2 s, 3 s after an end jump), so a quick click never skips it or seeks it
// to the old track's time. Previous that only restarts the same track holds jumps for those 2 s.
let leavingTrack = null;
const leaveTrack = (ms) => { leavingTrack = currentTrackInfo ? { title: currentTrackInfo.title, until: Date.now() + ms } : null; };

function handlePrev() { leaveTrack(2000); playerCommand({ type: 'PREV_TRACK' }, 300); }
function handleNext() { leaveTrack(2000); playerCommand({ type: 'NEXT_TRACK' }, 300); }

function handleJump(deltaSecs) {
  if (leavingTrack && currentTrackInfo && currentTrackInfo.title === leavingTrack.title && Date.now() < leavingTrack.until) return;
  leavingTrack = null;
  if (!currentTrackInfo || !currentTrackInfo.duration) {
    showHint("The track length isn't known on this page, so the jump can't be placed.");
    return;
  }
  const dur = currentTrackInfo.duration;
  const cur = currentTrackInfo.currentTime || 0;
  if (deltaSecs > 0 && cur + deltaSecs >= dur - 0.5) {
    // The jump reaches the end: finish this track and go to the next one, as if it had played out.
    leaveTrack(3000);
    chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command: { type: 'NEXT_TRACK', orEnd: true } }, (res) => {
      if (res && res.next === false) {
        leavingTrack = null;
        showHint("Couldn't go to the next track or to the end of this one on this page.");
      }
      setTimeout(refreshTrackInfo, 300);
    });
    return;
  }
  const newTime = Math.max(0, Math.min(dur, cur + deltaSecs));
  chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command: { type: 'SEEK_AUDIO', time: newTime } }, (res) => {
    if (res && res.seeked === false) {
      showHint(res.bridge !== undefined // a Tidal tab
        ? "Couldn't move the playback position in Tidal. If the Tidal tab was open before this update, reload it once."
        : "Couldn't move the playback position on this page (no media element or seek bar found). Prev, next and play still work.");
      return;
    }
    if (!res || !res.unverified) { // unverified: show the real time from the next reading instead of the target
      currentTrackInfo.currentTime = newTime;
      updatePlayerUI(currentTrackInfo);
    }
    setTimeout(refreshTrackInfo, 250);
  });
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
  const switchesChanged = !!switchBaseline && !sameSwitches(dynamics, switchBaseline);
  const isModified = eqModified || switchesChanged;

  const isFactory = factoryPresetNames.includes(currentPresetName);
  const hasSwitches = presetHasSavedSwitches(presets[currentPresetName]);
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

// Show the preset's EQ, and its switches only when it stored them. Returns those switches, or null.
function applyLiveSelection(name) {
  currentPresetName = name;
  const sel = presets[name];
  if (!sel) { updatePresetButtonsVisibility(); return null; }
  const savedDyn = presetHasSavedSwitches(sel) ? normaliseDyn(sel.dynamics) : null;
  const p = normaliseBypass(stripDynamics(sel));
  activePresetBaseline = { ...p };
  applyParamsToUI(p);
  if (savedDyn) {
    dynamics = { ...savedDyn };
    switchBaseline = { ...savedDyn };
    applyDynamicsToUI();
  } else {
    switchBaseline = normaliseDyn(dynamics);
  }
  updatePresetButtonsVisibility();
  return savedDyn;
}

function sendApplyPreset(savedDyn) {
  const msg = { type: 'APPLY_PRESET', presetName: currentPresetName, params: getParamsFromUI() };
  if (savedDyn) msg.dynamics = { ...savedDyn };
  chrome.runtime.sendMessage(msg, () => { if (chrome.runtime.lastError) {} });
}

presetSelect.onchange = () => {
  const gen = bumpPresetUi();
  const savedDyn = applyLiveSelection(presetSelect.value);
  if (!presets[currentPresetName]) return;
  const msg = { type: 'APPLY_PRESET', presetName: currentPresetName, params: getParamsFromUI() };
  if (savedDyn) msg.dynamics = { ...savedDyn };
  chrome.runtime.sendMessage(msg, (res) => {
    if (!presetUiCurrent(gen) || !res?.success) return;
    if (res.switchBaseline) switchBaseline = normaliseDyn(res.switchBaseline);
    checkPresetModificationState();
  });
  const savedSt = parseFloat(sliderPitch.value) || 0;
  if (currentMovieMode && Math.abs(savedSt) >= 0.05 && !bandOff.pitch) {
    flashMovieAlert(`Pitch (${fmt.pitch(savedSt)}) disabled in Movie mode — saved value kept`);
  }
};

btnSavePreset.onclick = () => {
  const defaultName = factoryPresetNames.includes(currentPresetName)
    ? `${currentPresetName} (Custom)`
    : `${currentPresetName} (New)`;
  const name = prompt('Save current settings as new preset name:', defaultName);
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (factoryPresetNames.includes(trimmed)) { showHint(FACTORY_NAME_HINT); return; }
  const gen = bumpPresetUi();
  const p = getParamsFromUI();
  const dyn = normaliseDyn(dynamics);
  chrome.runtime.sendMessage({ type: 'SAVE_PRESET', name: trimmed, params: p, dynamics: dyn }, (res) => {
    if (!presetUiCurrent(gen)) return;
    if (res?.error === 'factory-name') { showHint(FACTORY_NAME_HINT); return; }
    if (res?.success) {
      presets = res.presets;
      currentPresetName = res.savedName;
      activePresetBaseline = { ...p };
      switchBaseline = normaliseDyn(res.dynamics || dyn);
      populatePresets(res.savedName);
      checkPresetModificationState();
    }
  });
};

btnUpdatePreset.onclick = () => {
  if (!currentPresetName || factoryPresetNames.includes(currentPresetName)) return;
  const gen = bumpPresetUi();
  const p = getParamsFromUI();
  const dyn = normaliseDyn(dynamics);
  chrome.runtime.sendMessage({ type: 'UPDATE_PRESET', name: currentPresetName, params: p, dynamics: dyn }, (res) => {
    if (!presetUiCurrent(gen)) return;
    if (res?.error === 'factory-name') { showHint(FACTORY_NAME_HINT); return; }
    if (res?.success) {
      presets = res.presets;
      activePresetBaseline = { ...p };
      switchBaseline = normaliseDyn(res.dynamics || dyn);
      checkPresetModificationState();
      if (btnUpdatePreset.style.display !== 'none') {
        const orig = btnUpdatePreset.textContent;
        btnUpdatePreset.textContent = 'Saved';
        setTimeout(() => { btnUpdatePreset.textContent = orig; }, 1200);
      }
    }
  });
};

btnDeletePreset.onclick = () => {
  if (!currentPresetName || factoryPresetNames.includes(currentPresetName)) return;
  if (confirm(`Delete preset "${currentPresetName}"?`)) {
    const gen = bumpPresetUi();
    chrome.runtime.sendMessage({ type: 'DELETE_PRESET', name: currentPresetName }, (res) => {
      if (!presetUiCurrent(gen) || !res?.success) return;
      presets = res.presets;
      populatePresets(factoryPresetNames[0]);
      const savedDyn = applyLiveSelection(factoryPresetNames[0]);
      if (presets[currentPresetName]) sendApplyPreset(savedDyn);
    });
  }
};

btnResetDefaults.onclick = () => {
  const isFactory = factoryPresetNames.includes(currentPresetName);
  const question = isFactory
    ? `Restore default factory settings for "${currentPresetName}"?`
    : `Discard unsaved changes and go back to the saved values of "${currentPresetName}"?\n\n(Your custom presets are kept.)`;
  if (confirm(question)) {
    const gen = bumpPresetUi();
    chrome.runtime.sendMessage({ type: 'RESET_DEFAULT_PRESETS', currentPreset: currentPresetName }, (res) => {
      if (!presetUiCurrent(gen) || !res?.success) return;
      presets = res.presets;
      currentPresetName = res.selectedName;
      populatePresets(res.selectedName);
      const p = normaliseBypass(stripDynamics(res.currentParams || {}));
      applyParamsToUI(p);
      activePresetBaseline = { ...p };
      currentParams = getParamsFromUI();
      if (res.dynamicsApplied && res.dynamics) {
        dynamics = normaliseDyn(res.dynamics);
        applyDynamicsToUI();
      }
      switchBaseline = normaliseDyn(res.switchBaseline || dynamics);
      checkPresetModificationState();
      physics.updateState(currentParams, isCapturingActive);
    });
  }
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
  const sel = presets[presetSelect.value];
  return {
    bass: parseFloat(sliderBass.value),
    hpf: parseFloat(sliderHpf.value),
    mid: parseFloat(sliderMid.value),
    high: parseFloat(sliderHigh.value),
    gain: parseFloat(sliderGain.value),
    semitones: parseFloat(sliderPitch.value),
    autoBalance: !bandOff.comp,
    bypass: sel?.bypass === true,
    stageBypass: { hpf: bandOff.hpf, bass: bandOff.bass, mid: bandOff.mid, high: bandOff.high, gain: bandOff.gain, pitch: bandOff.pitch }
  };
}

function sendAudioParamUpdate() {
  currentParams = getParamsFromUI();
  chrome.runtime.sendMessage({ type: 'UPDATE_AUDIO_PARAMS', params: currentParams, presetName: currentPresetName });
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
      sendDynamicsUpdate();
      return;
    }
    bandOff[band] = !bandOff[band];
    renderBandTags();
    sendAudioParamUpdate();
  };
});

// Double-click a value: snap to neutral; double-click again: restore.
function setupValueToggle(valEl, sliderEl, neutralVal, formatFn, onChange) {
  let prevVal = parseFloat(sliderEl.value);
  valEl.ondblclick = (e) => {
    e.preventDefault();
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
    sendAudioParamUpdate();
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

sliderBass.oninput = (e) => { valBass.textContent = fmt.bass(e.target.value); sendAudioParamUpdate(); };
sliderHpf.oninput = (e) => { valHpf.textContent = fmt.hpf(e.target.value); sendAudioParamUpdate(); };
sliderMid.oninput = (e) => { valMid.textContent = fmt.mid(e.target.value); sendAudioParamUpdate(); };
sliderHigh.oninput = (e) => { valHigh.textContent = fmt.high(e.target.value); sendAudioParamUpdate(); };
sliderGain.oninput = (e) => { valGain.textContent = fmt.gain(e.target.value); sendAudioParamUpdate(); };
sliderPitch.oninput = (e) => {
  if (currentMovieMode) {
    sliderPitch.value = typeof currentParams.semitones === 'number' ? currentParams.semitones : 0;
    syncMoviePresentation();
    notifyPitchLocked();
    return;
  }
  valPitch.textContent = fmt.pitch(e.target.value);
  sendAudioParamUpdate();
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
