// popup.js - Controller for the DJ Bass Booster screen: toolbar popup, Stay-open window and the mini bar.

let currentParams = {};
let currentPresetName = "Punchy Bass & Clarity";
let presets = {};
let factoryPresetNames = [];
let isCapturingActive = false;
let currentTrackInfo = null;
let activePresetBaseline = null;
let stayOpen = false;
const query = new URLSearchParams(window.location.search);
const isUndocked = query.get('undocked') === 'true';

const BANDS = ['hpf', 'bass', 'mid', 'high', 'comp', 'gain', 'speed'];
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
const presetSelect = document.getElementById('preset-select');
const presetStatusBadge = document.getElementById('preset-status-badge');
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
const valAuto = document.getElementById('val-auto');

// Per-band on/off. Off keeps the slider value but takes that stage out of the chain.
// `comp` is the Auto-Balancing switch (autoBalance); the others live in stageBypass.
let bandOff = { hpf: false, bass: false, mid: false, high: false, comp: false, gain: false, speed: false };

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
      if (chrome.runtime.lastError || !res || !res.isCapturing) { physics.setFrame(null); return; }
      physics.setFrame(res);
    });
  }, 66);
}
function stopFrames() {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
  physics.setFrame(null);
}
window.addEventListener('unload', stopFrames);

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
  themeDots.querySelectorAll('.dot').forEach((d) => d.classList.toggle('sel', d.dataset.theme === (theme || 'theme-cyan')));
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
  // Older saved values used `eq` for the whole 3-band EQ and `comp` beside autoBalance.
  const b = { ...(p.stageBypass || {}) };
  if (b.eq) { b.bass = b.mid = b.high = true; delete b.eq; }
  if (b.comp) { p.autoBalance = false; delete b.comp; }
  p.stageBypass = { hpf: !!b.hpf, bass: !!b.bass, mid: !!b.mid, high: !!b.high, gain: !!b.gain, speed: !!b.speed };
  return p;
}

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError || !response) return;

  isCapturingActive = !!response.isCapturing;
  presets = response.presets || {};
  factoryPresetNames = response.factoryPresets || [];
  currentPresetName = response.currentPreset || "Punchy Bass & Clarity";
  currentParams = normaliseBypass({ ...(response.currentParams || presets[currentPresetName] || {}) });
  stayOpen = !!response.stayOpen;
  toggleStayOpen.checked = stayOpen;

  updateEqPowerUI(isCapturingActive, response.capturedTabTitle);
  populatePresets(currentPresetName);
  applyParamsToUI(currentParams);

  activePresetBaseline = presets[currentPresetName] ? normaliseBypass({ ...presets[currentPresetName] }) : null;
  checkPresetModificationState();

  physics.updateState(currentParams, isCapturingActive);
  if (isCapturingActive) startFrames();
  requestAnimationFrame(fitUndockedWindow);

  if (query.get('minibar') === '1') {
    btnMinibar.classList.add('pulse');
    showHint('Click "Mini bar" here to float it. Chrome only lets it open from this window, and it stays as long as this window is open.', 8000);
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
    if (res && typeof res.isCapturing === 'boolean' && res.isCapturing !== isCapturingActive) {
      updateEqPowerUI(res.isCapturing, res.capturedTabTitle);
      physics.updateState(currentParams, res.isCapturing);
    }
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
    for (const img of [artCover, artSlice]) {
      if (info.artwork) { img.src = info.artwork; img.hidden = false; }
      else { img.hidden = true; img.removeAttribute('src'); }
    }
  }

  playIcon.setAttribute('href', info.isPlaying ? '#s-pause' : '#s-play');
  playerBtnPlay.title = info.isPlaying ? 'Pause' : 'Play';
  updateHeartUI(info);
  if (minibar.win) renderMinibar(info);
}

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
function handlePrev() { playerCommand({ type: 'PREV_TRACK' }, 300); }
function handleNext() { playerCommand({ type: 'NEXT_TRACK' }, 300); }

function handleJump(deltaSecs) {
  if (!currentTrackInfo || !currentTrackInfo.duration) {
    showHint("The track length isn't known on this page, so the jump can't be placed.");
    return;
  }
  const dur = currentTrackInfo.duration;
  const cur = currentTrackInfo.currentTime || 0;
  const newTime = Math.max(0, Math.min(dur, cur + deltaSecs));
  chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command: { type: 'SEEK_AUDIO', time: newTime } }, (res) => {
    if (res && res.seeked === false) {
      showHint("Couldn't move the playback position on this page (no media element or seek bar found). Prev, next and play still work.");
      return;
    }
    currentTrackInfo.currentTime = newTime;
    updatePlayerUI(currentTrackInfo);
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

// ---------- EQ power ----------
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
        physics.updateState(currentParams, true);
        applySpeedToPage();
      } else {
        updateEqPowerUI(false);
        alert(res?.error || 'Could not attach to the audio tab. Make sure Tidal or a music tab is open.');
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, () => {
      updateEqPowerUI(false);
      physics.updateState(currentParams, false);
    });
  }
}

toggleEqPower.onchange = () => handleToggleEqPower();

// ---------- Stay open / mini bar ----------
toggleStayOpen.onchange = () => {
  stayOpen = toggleStayOpen.checked;
  chrome.runtime.sendMessage({ type: 'SET_STAY_OPEN', on: stayOpen }, () => {
    if (stayOpen && !isUndocked) {
      // The toolbar popup itself cannot be kept open; hand over to the window now.
      chrome.runtime.sendMessage({ type: 'OPEN_WINDOW' }, () => window.close());
    }
  });
};

btnMinibar.onclick = () => {
  if (isUndocked) {
    openMinibar();
  } else {
    // Chrome will only float a window from a click inside a page that stays alive: the Stay-open window.
    chrome.runtime.sendMessage({ type: 'OPEN_WINDOW', minibar: true }, () => window.close());
  }
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

  const isModified =
    Math.abs(currentUI.bass - b.bass) > 0.01 ||
    Math.abs(currentUI.hpf - b.hpf) > 0.5 ||
    Math.abs(currentUI.mid - b.mid) > 0.01 ||
    Math.abs(currentUI.high - b.high) > 0.01 ||
    Math.abs(currentUI.gain - b.gain) > 0.01 ||
    Math.abs(currentUI.pitch - (b.pitch || 1.0)) > 0.01 ||
    currentUI.autoBalance !== b.autoBalance ||
    ['hpf', 'bass', 'mid', 'high', 'gain', 'speed'].some((k) => !!cb[k] !== !!bb[k]);

  const isFactory = factoryPresetNames.includes(currentPresetName);
  if (isModified) {
    presetStatusBadge.className = 'preset-badge-modified';
    presetStatusBadge.textContent = '● Modified';
    btnUpdatePreset.style.display = isFactory ? 'none' : 'inline-block';
  } else {
    presetStatusBadge.className = 'preset-badge-saved';
    presetStatusBadge.textContent = '● Saved';
    btnUpdatePreset.style.display = 'none';
  }
}

presetSelect.onchange = () => {
  currentPresetName = presetSelect.value;
  updatePresetButtonsVisibility();
  const sel = presets[currentPresetName];
  if (sel) {
    const p = normaliseBypass({ ...sel });
    activePresetBaseline = { ...p };
    applyParamsToUI(p);
    sendAudioParamUpdate();
  }
};

btnSavePreset.onclick = () => {
  const defaultName = factoryPresetNames.includes(currentPresetName)
    ? `${currentPresetName} (Custom)`
    : `${currentPresetName} (New)`;
  const name = prompt('Save current settings as new preset name:', defaultName);
  if (name && name.trim()) {
    const p = getParamsFromUI();
    chrome.runtime.sendMessage({ type: 'SAVE_PRESET', name: name.trim(), params: p }, (res) => {
      if (res?.success) {
        presets = res.presets;
        currentPresetName = res.savedName;
        activePresetBaseline = { ...p };
        populatePresets(res.savedName);
        checkPresetModificationState();
      }
    });
  }
};

btnUpdatePreset.onclick = () => {
  if (!currentPresetName || factoryPresetNames.includes(currentPresetName)) return;
  const p = getParamsFromUI();
  chrome.runtime.sendMessage({ type: 'UPDATE_PRESET', name: currentPresetName, params: p }, (res) => {
    if (res?.success) {
      presets = res.presets;
      activePresetBaseline = { ...p };
      checkPresetModificationState();
      const orig = btnUpdatePreset.textContent;
      btnUpdatePreset.textContent = 'Saved';
      setTimeout(() => { btnUpdatePreset.textContent = orig; }, 1200);
    }
  });
};

btnDeletePreset.onclick = () => {
  if (!currentPresetName || factoryPresetNames.includes(currentPresetName)) return;
  if (confirm(`Delete preset "${currentPresetName}"?`)) {
    chrome.runtime.sendMessage({ type: 'DELETE_PRESET', name: currentPresetName }, (res) => {
      if (res?.success) {
        presets = res.presets;
        currentPresetName = factoryPresetNames[0];
        populatePresets(currentPresetName);
        if (presets[currentPresetName]) {
          const p = normaliseBypass({ ...presets[currentPresetName] });
          activePresetBaseline = { ...p };
          applyParamsToUI(p);
          sendAudioParamUpdate();
        }
      }
    });
  }
};

btnResetDefaults.onclick = () => {
  const isFactory = factoryPresetNames.includes(currentPresetName);
  const question = isFactory
    ? `Restore default factory settings for "${currentPresetName}"?`
    : `Discard unsaved changes and go back to the saved values of "${currentPresetName}"?\n\n(Your custom presets are kept.)`;
  if (confirm(question)) {
    chrome.runtime.sendMessage({ type: 'RESET_DEFAULT_PRESETS', currentPreset: currentPresetName }, (res) => {
      if (res?.success) {
        presets = res.presets;
        currentPresetName = res.selectedName;
        populatePresets(res.selectedName);
        const p = normaliseBypass({ ...res.currentParams });
        applyParamsToUI(p);
        activePresetBaseline = { ...p };
        sendAudioParamUpdate();
        checkPresetModificationState();
      }
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
  pitch: (v) => `${parseFloat(v).toFixed(2)}x`
};

function renderBandTags() {
  document.querySelectorAll('.band-tag').forEach((tag) => {
    const band = tag.dataset.band;
    const off = !!bandOff[band];
    tag.classList.toggle('off', off);
    tag.closest('.eq-row')?.classList.toggle('is-off', off);
    const names = { hpf: 'High-pass filter', bass: 'Bass', mid: 'Mid', high: 'High', comp: 'Auto-Balancing', gain: 'Master volume', speed: 'Pitch / Speed' };
    tag.title = off
      ? `${names[band]} is off (the value is kept). Click to switch it back on.`
      : `${names[band]} is on. Click to switch it off without losing the value.`;
  });
  if (valAuto) valAuto.textContent = bandOff.comp ? 'off' : 'on';
}

function applyParamsToUI(p) {
  if (typeof p.bass === 'number') { sliderBass.value = p.bass; valBass.textContent = fmt.bass(p.bass); }
  if (typeof p.hpf === 'number') { sliderHpf.value = p.hpf; valHpf.textContent = fmt.hpf(p.hpf); }
  if (typeof p.mid === 'number') { sliderMid.value = p.mid; valMid.textContent = fmt.mid(p.mid); }
  if (typeof p.high === 'number') { sliderHigh.value = p.high; valHigh.textContent = fmt.high(p.high); }
  if (typeof p.gain === 'number') { sliderGain.value = p.gain; valGain.textContent = fmt.gain(p.gain); }
  if (typeof p.pitch === 'number') { sliderPitch.value = p.pitch; valPitch.textContent = fmt.pitch(p.pitch); }
  const b = p.stageBypass || {};
  bandOff = {
    hpf: !!b.hpf, bass: !!b.bass, mid: !!b.mid, high: !!b.high, gain: !!b.gain, speed: !!b.speed,
    comp: typeof p.autoBalance === 'boolean' ? !p.autoBalance : bandOff.comp
  };
  renderBandTags();
}

function getParamsFromUI() {
  const sel = presets[presetSelect.value];
  return {
    bass: parseFloat(sliderBass.value),
    hpf: parseFloat(sliderHpf.value),
    mid: parseFloat(sliderMid.value),
    high: parseFloat(sliderHigh.value),
    gain: parseFloat(sliderGain.value),
    pitch: parseFloat(sliderPitch.value),
    autoBalance: !bandOff.comp,
    bypass: sel?.bypass === true,
    stageBypass: { hpf: bandOff.hpf, bass: bandOff.bass, mid: bandOff.mid, high: bandOff.high, gain: bandOff.gain, speed: bandOff.speed }
  };
}

// Pitch / Speed is applied to the page's media element, so it is sent separately (only while the EQ is on).
function applySpeedToPage() {
  if (!isCapturingActive) return;
  const speed = bandOff.speed ? 1.0 : parseFloat(sliderPitch.value);
  chrome.runtime.sendMessage({ type: 'FORWARD_PLAYER_COMMAND', command: { type: 'SET_SPEED', speed } });
}

function sendAudioParamUpdate() {
  currentParams = getParamsFromUI();
  chrome.runtime.sendMessage({ type: 'UPDATE_AUDIO_PARAMS', params: currentParams, presetName: currentPresetName });
  checkPresetModificationState();
  physics.updateState(currentParams, isCapturingActive);
}

document.querySelectorAll('.band-tag').forEach((tag) => {
  tag.onclick = () => {
    const band = tag.dataset.band;
    bandOff[band] = !bandOff[band];
    renderBandTags();
    sendAudioParamUpdate();
    if (band === 'speed') applySpeedToPage();
  };
});

// Double-click a value: snap to neutral; double-click again: restore.
function setupValueToggle(valEl, sliderEl, neutralVal, formatFn, onChange) {
  let prevVal = parseFloat(sliderEl.value);
  valEl.ondblclick = (e) => {
    e.preventDefault();
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
setupValueToggle(valPitch, sliderPitch, 1.0, fmt.pitch, applySpeedToPage);

sliderBass.oninput = (e) => { valBass.textContent = fmt.bass(e.target.value); sendAudioParamUpdate(); };
sliderHpf.oninput = (e) => { valHpf.textContent = fmt.hpf(e.target.value); sendAudioParamUpdate(); };
sliderMid.oninput = (e) => { valMid.textContent = fmt.mid(e.target.value); sendAudioParamUpdate(); };
sliderHigh.oninput = (e) => { valHigh.textContent = fmt.high(e.target.value); sendAudioParamUpdate(); };
sliderGain.oninput = (e) => { valGain.textContent = fmt.gain(e.target.value); sendAudioParamUpdate(); };
sliderPitch.oninput = (e) => { valPitch.textContent = fmt.pitch(e.target.value); sendAudioParamUpdate(); applySpeedToPage(); };

// − / + nudges; Shift-click = 5× finer
document.querySelectorAll('.eq-nudge-btn').forEach(btn => {
  btn.onclick = (e) => {
    e.preventDefault();
    const slider = document.getElementById(btn.getAttribute('data-target'));
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
  if (message?.type === 'MINIBAR_HINT' && isUndocked) {
    btnMinibar.classList.remove('pulse');
    void btnMinibar.offsetWidth;
    btnMinibar.classList.add('pulse');
    showHint('Click "Mini bar" here to float it.', 6000);
  }
});
