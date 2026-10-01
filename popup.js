// popup.js - Controller for the Tidal DJ Bass Booster toolbar popup and its standalone window

let currentParams = {};
let currentPresetName = "Punchy Bass & Clarity";
let presets = {};
let factoryPresetNames = [];
let isCapturingActive = false;
let currentTrackInfo = null;
let isSeeking = false;
let activePresetBaseline = null;
let isMicroMode = false;
const isUndocked = window.location.search.includes('undocked=true');

// DOM Elements - Navigation & Controls
const toggleEqPower = document.getElementById('toggle-eq-power');
const eqPowerStatusBadge = document.getElementById('eq-power-status-badge');
const toggleFloatingBtn = document.getElementById('toggle-floating-btn');
const btnSizeToggle = document.getElementById('btn-size-toggle');
const btnOpenRouter = document.getElementById('btn-open-router');
const btnMicroToggle = document.getElementById('btn-micro-toggle');
const btnAlwaysOnTop = document.getElementById('btn-always-on-top');
const btnUndock = document.getElementById('btn-undock');
const btnThemeToggle = document.getElementById('btn-theme-toggle');

// Presets Elements & Badges
const presetSelect = document.getElementById('preset-select');
const presetStatusBadge = document.getElementById('preset-status-badge');
const btnUpdatePreset = document.getElementById('btn-update-preset');
const btnSavePreset = document.getElementById('btn-save-preset');
const btnDeletePreset = document.getElementById('btn-delete-preset');
const btnResetDefaults = document.getElementById('btn-reset-defaults');

// Main Player Elements
const playerArt = document.getElementById('player-art');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const playerProgress = document.getElementById('player-progress');
const playerTimeCur = document.getElementById('player-time-cur');
const playerTimeDur = document.getElementById('player-time-dur');
const playerBtnPrev = document.getElementById('player-btn-prev');
const playerBtnPlay = document.getElementById('player-btn-play');
const playerBtnNext = document.getElementById('player-btn-next');
const playerBtnSkipBack = document.getElementById('player-btn-skip-back');
const playerBtnSkipFwd = document.getElementById('player-btn-skip-fwd');

// Volume Controls
const playerVolSlider = document.getElementById('player-vol-slider');
const volStepDown = document.getElementById('vol-step-down');
const volStepUp = document.getElementById('vol-step-up');
const playerVolBadge = document.getElementById('player-vol-badge');

// Micro Player Elements
const microContainer = document.getElementById('micro-container');
const microArt = document.getElementById('micro-art');
const microTitle = document.getElementById('micro-title');
const microArtist = document.getElementById('micro-artist');
const microBtnPrev = document.getElementById('micro-btn-prev');
const microBtnPlay = document.getElementById('micro-btn-play');
const microBtnNext = document.getElementById('micro-btn-next');
const microEqPill = document.getElementById('micro-eq-pill');
const btnExitMicro = document.getElementById('btn-exit-micro');

// EQ Sliders
const sliderBass = document.getElementById('slider-bass');
const sliderHpf = document.getElementById('slider-hpf');
const sliderMid = document.getElementById('slider-mid');
const sliderHigh = document.getElementById('slider-high');
const sliderGain = document.getElementById('slider-gain');
const sliderPitch = document.getElementById('slider-pitch');
const toggleAutoBalance = document.getElementById('toggle-autobalance');

// Value Labels
const valBass = document.getElementById('val-bass');
const valHpf = document.getElementById('val-hpf');
const valMid = document.getElementById('val-mid');
const valHigh = document.getElementById('val-high');
const valGain = document.getElementById('val-gain');
const valPitch = document.getElementById('val-pitch');

// Standalone window only: size the window to its content. (Chrome sizes the toolbar popup itself.)
function fitUndockedWindow() {
  if (!isUndocked || !chrome.windows) return;
  const main = document.querySelector('.popup-main');
  const physicsOpen = document.body.classList.contains('physics-open');
  const targetW = (document.body.classList.contains('size-wide') ? 490 : 360) + (physicsOpen ? 300 : 0);
  const targetH = isMicroMode ? 95 : (main ? main.offsetHeight : document.body.offsetHeight);
  chrome.windows.getCurrent((win) => {
    if (chrome.runtime.lastError || !win || win.type !== 'popup') return;
    const chromeW = Math.max(0, window.outerWidth - window.innerWidth);
    const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
    chrome.windows.update(win.id, { width: targetW + chromeW, height: targetH + chromeH });
  });
}

// Physics side panel: docked beside the controls so both are visible. Its open state is remembered.
const routerVisualizer = new AudioRouterVisualizer({
  container: document.querySelector('.popup-container'),
  mode: 'side',
  onToggle: (open) => {
    document.body.classList.toggle('physics-open', open);
    btnOpenRouter.classList.toggle('btn-active', open);
    chrome.storage.local.set({ physicsPanelOpen: open });
    fitUndockedWindow();
  }
});

btnOpenRouter.onclick = () => routerVisualizer.toggle();

chrome.storage.local.get('physicsPanelOpen', (data) => {
  if (data.physicsPanelOpen && !routerVisualizer.isOpen) routerVisualizer.open({ instant: true });
});

// Sizing & Reset Size Controls
if (btnSizeToggle) {
  btnSizeToggle.onclick = () => {
    document.body.classList.toggle('size-wide');
    fitUndockedWindow();
  };
  btnSizeToggle.ondblclick = () => {
    document.body.classList.remove('size-wide');
    fitUndockedWindow();
  };
}

// Themes Cycler
const THEMES = ['theme-cyan', 'theme-amber', 'theme-synthwave', 'theme-matrix', 'theme-oled'];
let currentThemeIndex = 0;

// Swap only the theme class so layout classes (size-wide, micro-mode, physics-open) survive.
function applyTheme(theme) {
  document.body.classList.remove(...THEMES);
  document.body.classList.add(theme);
}

chrome.storage.local.get('visualTheme', (data) => {
  if (data.visualTheme) {
    applyTheme(data.visualTheme);
    currentThemeIndex = THEMES.indexOf(data.visualTheme);
    if (currentThemeIndex === -1) currentThemeIndex = 0;
  }
});

btnThemeToggle.onclick = () => {
  currentThemeIndex = (currentThemeIndex + 1) % THEMES.length;
  const newTheme = THEMES[currentThemeIndex];
  applyTheme(newTheme);
  chrome.storage.local.set({ visualTheme: newTheme });
};

// 1. Initial State Load
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError || !response) return;

  isCapturingActive = !!response.isCapturing;
  presets = response.presets || {};
  factoryPresetNames = response.factoryPresets || [];
  currentPresetName = response.currentPreset || "Punchy Bass & Clarity";
  currentParams = response.currentParams || presets[currentPresetName] || {};
  toggleFloatingBtn.checked = !!response.showFloatingButton;

  updateEqPowerUI(isCapturingActive);
  populatePresets(currentPresetName);
  applyParamsToUI(currentParams);

  activePresetBaseline = presets[currentPresetName] ? { ...presets[currentPresetName] } : null;
  checkPresetModificationState();

  routerVisualizer.updateState(currentParams, isCapturingActive);
  requestAnimationFrame(fitUndockedWindow);
});

// 2. Poll Active Track Info for Toolbar Player & Sync Capture Status
function refreshTrackInfo() {
  chrome.runtime.sendMessage({
    type: 'FORWARD_PLAYER_COMMAND',
    command: { type: 'GET_TRACK_INFO' }
  }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.title) {
      currentTrackInfo = res;
      updatePlayerUI(res);
    }
  });

  // Verify capture status periodically to stay strictly in sync
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (res && typeof res.isCapturing === 'boolean' && res.isCapturing !== isCapturingActive) {
      updateEqPowerUI(res.isCapturing);
      routerVisualizer.updateState(currentParams, res.isCapturing);
    }
  });
}

function updatePlayerUI(info) {
  if (!info) return;
  const title = info.title || 'Unknown Track';
  const artist = info.artist || 'Unknown Artist';

  playerTitle.textContent = title;
  playerArtist.textContent = artist;
  if (microTitle) microTitle.textContent = title;
  if (microArtist) microArtist.textContent = artist;

  if (info.artwork) {
    playerArt.src = info.artwork;
    playerArt.style.display = 'block';
    if (microArt) {
      microArt.src = info.artwork;
      microArt.style.display = 'block';
    }
  } else {
    playerArt.style.display = 'none';
    if (microArt) microArt.style.display = 'none';
  }

  const playSymbol = info.isPlaying ? '⏸' : '▶';
  playerBtnPlay.textContent = playSymbol;
  if (microBtnPlay) microBtnPlay.textContent = playSymbol;

  if (!isSeeking && typeof info.currentTime === 'number' && typeof info.duration === 'number' && info.duration > 0) {
    playerProgress.value = (info.currentTime / info.duration) * 100;
    playerTimeCur.textContent = formatTime(info.currentTime);
    playerTimeDur.textContent = formatTime(info.duration);
  }
}

function formatTime(secs) {
  if (isNaN(secs) || secs === Infinity) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

refreshTrackInfo();
const trackPollInterval = setInterval(refreshTrackInfo, 1000);
window.addEventListener('unload', () => clearInterval(trackPollInterval));

// 3. Playback Controls
function handlePlayPause() {
  chrome.runtime.sendMessage({
    type: 'FORWARD_PLAYER_COMMAND',
    command: { type: 'TOGGLE_PLAY_PAUSE' }
  }, (res) => {
    if (res && res.title) updatePlayerUI(res);
    setTimeout(refreshTrackInfo, 250);
  });
}
playerBtnPlay.onclick = handlePlayPause;
if (microBtnPlay) microBtnPlay.onclick = handlePlayPause;

function handlePrev() {
  chrome.runtime.sendMessage({
    type: 'FORWARD_PLAYER_COMMAND',
    command: { type: 'PREV_TRACK' }
  }, (res) => {
    if (res && res.title) updatePlayerUI(res);
    setTimeout(refreshTrackInfo, 300);
  });
}
playerBtnPrev.onclick = handlePrev;
if (microBtnPrev) microBtnPrev.onclick = handlePrev;

function handleNext() {
  chrome.runtime.sendMessage({
    type: 'FORWARD_PLAYER_COMMAND',
    command: { type: 'NEXT_TRACK' }
  }, (res) => {
    if (res && res.title) updatePlayerUI(res);
    setTimeout(refreshTrackInfo, 300);
  });
}
playerBtnNext.onclick = handleNext;
if (microBtnNext) microBtnNext.onclick = handleNext;

function handleSkip(pctDelta) {
  if (!currentTrackInfo || !currentTrackInfo.duration) return;
  const dur = currentTrackInfo.duration;
  const cur = currentTrackInfo.currentTime || 0;
  const deltaSecs = dur * (pctDelta / 100);
  const newTime = Math.max(0, Math.min(dur, cur + deltaSecs));
  chrome.runtime.sendMessage({
    type: 'FORWARD_PLAYER_COMMAND',
    command: { type: 'SEEK_AUDIO', time: newTime }
  }, () => {
    currentTrackInfo.currentTime = newTime;
    updatePlayerUI(currentTrackInfo);
    setTimeout(refreshTrackInfo, 250);
  });
}
if (playerBtnSkipBack) playerBtnSkipBack.onclick = () => handleSkip(-25);
if (playerBtnSkipFwd) playerBtnSkipFwd.onclick = () => handleSkip(25);

playerProgress.onmousedown = () => { isSeeking = true; };
playerProgress.ontouchstart = () => { isSeeking = true; };
playerProgress.onchange = (e) => {
  isSeeking = false;
  if (currentTrackInfo && currentTrackInfo.duration) {
    const targetSeconds = (parseFloat(e.target.value) / 100) * currentTrackInfo.duration;
    chrome.runtime.sendMessage({
      type: 'FORWARD_PLAYER_COMMAND',
      command: { type: 'SEEK_AUDIO', time: targetSeconds }
    });
  }
};

// 4. Volume Control & 100% Unity Indicator
function updateVolumeUI(val) {
  const clamped = Math.max(0, Math.min(1, val));
  playerVolSlider.value = clamped;
  const pct = Math.round(clamped * 100);

  if (pct >= 99) {
    playerVolBadge.className = 'vol-badge vol-100';
    playerVolBadge.textContent = '100%';
    playerVolBadge.title = 'Nominal Unity Volume (100%). Double-click to snap to 100%.';
  } else {
    playerVolBadge.className = 'vol-badge vol-attenuated';
    playerVolBadge.textContent = `${pct}%`;
    playerVolBadge.title = `Volume: ${pct}%. Double-click to snap back to 100%.`;
  }

  chrome.runtime.sendMessage({
    type: 'FORWARD_PLAYER_COMMAND',
    command: { type: 'SET_VOLUME', volume: clamped }
  });
}

if (playerVolSlider) {
  playerVolSlider.oninput = (e) => updateVolumeUI(parseFloat(e.target.value));
}
if (volStepDown) {
  volStepDown.onclick = () => updateVolumeUI(parseFloat(playerVolSlider.value) - 0.05);
}
if (volStepUp) {
  volStepUp.onclick = () => updateVolumeUI(parseFloat(playerVolSlider.value) + 0.05);
}
if (playerVolBadge) {
  playerVolBadge.ondblclick = () => updateVolumeUI(1.0);
}

// 5. Undock, Always On Top, and Micro Mode Controls
if (btnUndock) {
  if (isUndocked) {
    btnUndock.textContent = '🔒 Dock';
    btnUndock.title = 'Close undocked window and return to toolbar';
    btnUndock.onclick = () => window.close();
  } else {
    btnUndock.onclick = () => {
      chrome.windows.create({
        url: chrome.runtime.getURL('popup.html?undocked=true'),
        type: 'popup',
        width: 360,
        height: 420
      });
      window.close();
    };
  }
}

if (btnAlwaysOnTop) {
  btnAlwaysOnTop.onclick = async () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_MINIPLAYER' });
  };
}

function setMicroMode(active) {
  isMicroMode = active;
  if (isMicroMode) {
    if (routerVisualizer.isOpen) routerVisualizer.close();
    document.body.classList.add('micro-mode');
  } else {
    document.body.classList.remove('micro-mode');
  }
  fitUndockedWindow();
}

if (btnMicroToggle) btnMicroToggle.onclick = () => setMicroMode(!isMicroMode);
if (btnExitMicro) btnExitMicro.onclick = () => setMicroMode(false);

// 6. Master EQ Power Switch
function updateEqPowerUI(active) {
  isCapturingActive = !!active;
  if (toggleEqPower) {
    toggleEqPower.checked = isCapturingActive;
  }
  if (eqPowerStatusBadge) {
    if (isCapturingActive) {
      eqPowerStatusBadge.className = 'power-badge on';
      eqPowerStatusBadge.textContent = '● ON (Attached)';
    } else {
      eqPowerStatusBadge.className = 'power-badge off';
      eqPowerStatusBadge.textContent = '○ OFF (Detached)';
    }
  }
  if (microEqPill) {
    if (isCapturingActive) {
      microEqPill.className = 'micro-eq-pill active';
      microEqPill.textContent = '● EQ';
    } else {
      microEqPill.className = 'micro-eq-pill inactive';
      microEqPill.textContent = '○ EQ';
    }
  }
}

function handleToggleEqPower() {
  const wantActive = !isCapturingActive;
  if (wantActive) {
    // Send directly and synchronously to preserve the user gesture token for tabCapture
    chrome.runtime.sendMessage({ type: 'START_CAPTURE_FOR_TAB' }, (res) => {
      if (res?.success) {
        updateEqPowerUI(true);
        routerVisualizer.updateState(currentParams, true);
      } else {
        updateEqPowerUI(false);
        alert(res?.error || 'Could not attach to audio tab. Make sure Tidal or a music tab is open.');
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, (res) => {
      updateEqPowerUI(false);
      routerVisualizer.updateState(currentParams, false);
    });
  }
}

if (toggleEqPower) {
  toggleEqPower.onchange = () => handleToggleEqPower();
}
if (microEqPill) {
  microEqPill.onclick = () => handleToggleEqPower();
}

// 7. Floating Button Visibility Switch
toggleFloatingBtn.onchange = (e) => {
  chrome.runtime.sendMessage({
    type: 'TOGGLE_FLOATING_BUTTON',
    show: e.target.checked
  });
};

// 8. Presets Management
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
    if (factoryPresetNames.includes(name)) {
      optGroupFactory.appendChild(opt);
    } else {
      optGroupCustom.appendChild(opt);
    }
  });

  presetSelect.appendChild(optGroupFactory);
  if (optGroupCustom.children.length > 0) {
    presetSelect.appendChild(optGroupCustom);
  }

  if (selectedName && presets[selectedName]) {
    presetSelect.value = selectedName;
    currentPresetName = selectedName;
  }
  updatePresetButtonsVisibility();
}

function updatePresetButtonsVisibility() {
  const current = presetSelect.value;
  const isFactory = factoryPresetNames.includes(current);
  btnDeletePreset.style.display = isFactory ? 'none' : 'inline-block';
  checkPresetModificationState();
}

function checkPresetModificationState() {
  if (!activePresetBaseline || !presetStatusBadge) return;
  const currentUI = getParamsFromUI();
  const b = activePresetBaseline;

  const isModified =
    Math.abs(currentUI.bass - b.bass) > 0.01 ||
    Math.abs(currentUI.hpf - b.hpf) > 0.5 ||
    Math.abs(currentUI.mid - b.mid) > 0.01 ||
    Math.abs(currentUI.high - b.high) > 0.01 ||
    Math.abs(currentUI.gain - b.gain) > 0.01 ||
    Math.abs(currentUI.pitch - (b.pitch || 1.0)) > 0.01 ||
    currentUI.autoBalance !== b.autoBalance;

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
    activePresetBaseline = { ...sel };
    applyParamsToUI(sel);
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
    chrome.runtime.sendMessage({
      type: 'SAVE_PRESET',
      name: name.trim(),
      params: p
    }, (res) => {
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
  chrome.runtime.sendMessage({
    type: 'UPDATE_PRESET',
    name: currentPresetName,
    params: p
  }, (res) => {
    if (res?.success) {
      presets = res.presets;
      activePresetBaseline = { ...p };
      checkPresetModificationState();
      const orig = btnUpdatePreset.textContent;
      btnUpdatePreset.textContent = '✅ Saved';
      setTimeout(() => { btnUpdatePreset.textContent = orig; }, 1200);
    }
  });
};

btnDeletePreset.onclick = () => {
  if (!currentPresetName || factoryPresetNames.includes(currentPresetName)) return;
  if (confirm(`Delete preset "${currentPresetName}"?`)) {
    chrome.runtime.sendMessage({
      type: 'DELETE_PRESET',
      name: currentPresetName
    }, (res) => {
      if (res?.success) {
        presets = res.presets;
        currentPresetName = factoryPresetNames[0];
        populatePresets(currentPresetName);
        if (presets[currentPresetName]) {
          activePresetBaseline = { ...presets[currentPresetName] };
          applyParamsToUI(presets[currentPresetName]);
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
    chrome.runtime.sendMessage({
      type: 'RESET_DEFAULT_PRESETS',
      currentPreset: currentPresetName
    }, (res) => {
      if (res?.success) {
        presets = res.presets;
        currentPresetName = res.selectedName;
        populatePresets(res.selectedName);
        applyParamsToUI(res.currentParams);
        activePresetBaseline = { ...res.currentParams };
        sendAudioParamUpdate();
        checkPresetModificationState();
      }
    });
  }
};

// 9. EQ Parameter Sliders & Double-Click Reset/Restore Logic
function applyParamsToUI(p) {
  if (typeof p.bass === 'number') {
    sliderBass.value = p.bass;
    valBass.textContent = `+${parseFloat(p.bass).toFixed(1)} dB`;
  }
  if (typeof p.hpf === 'number') {
    sliderHpf.value = p.hpf;
    valHpf.textContent = `${Math.round(p.hpf)} Hz`;
  }
  if (typeof p.mid === 'number') {
    sliderMid.value = p.mid;
    valMid.textContent = `${p.mid >= 0 ? '+' : ''}${parseFloat(p.mid).toFixed(1)} dB`;
  }
  if (typeof p.high === 'number') {
    sliderHigh.value = p.high;
    valHigh.textContent = `${p.high >= 0 ? '+' : ''}${parseFloat(p.high).toFixed(1)} dB`;
  }
  if (typeof p.gain === 'number') {
    sliderGain.value = p.gain;
    valGain.textContent = `${Math.round(p.gain * 100)}%`;
  }
  if (typeof p.pitch === 'number') {
    sliderPitch.value = p.pitch;
    valPitch.textContent = `${parseFloat(p.pitch).toFixed(2)}x`;
  }
  if (typeof p.autoBalance === 'boolean') {
    toggleAutoBalance.checked = p.autoBalance;
  }
}

function getParamsFromUI() {
  const sel = presets[presetSelect.value];
  const isBypass = sel?.bypass === true;
  return {
    bass: parseFloat(sliderBass.value),
    hpf: parseFloat(sliderHpf.value),
    mid: parseFloat(sliderMid.value),
    high: parseFloat(sliderHigh.value),
    gain: parseFloat(sliderGain.value),
    pitch: parseFloat(sliderPitch.value),
    autoBalance: toggleAutoBalance.checked,
    bypass: isBypass,
    // Keep the Physics panel's A/B stage bypass with every save so it is not silently dropped.
    stageBypass: { ...routerVisualizer.currentParams.stageBypass }
  };
}

function sendAudioParamUpdate() {
  currentParams = getParamsFromUI();
  chrome.runtime.sendMessage({
    type: 'UPDATE_AUDIO_PARAMS',
    params: currentParams,
    presetName: currentPresetName
  });
  checkPresetModificationState();
  routerVisualizer.updateState(currentParams, isCapturingActive);
}

// Double-Click Value Reset & Toggle Helper
function setupValueToggle(valEl, sliderEl, neutralVal, formatFn) {
  let prevVal = parseFloat(sliderEl.value);
  valEl.title = 'Double-click to reset to neutral / restore previous';

  valEl.ondblclick = (e) => {
    e.preventDefault();
    const cur = parseFloat(sliderEl.value);
    if (Math.abs(cur - neutralVal) < 0.001) {
      const target = (prevVal !== undefined && Math.abs(prevVal - neutralVal) >= 0.001)
        ? prevVal
        : parseFloat(sliderEl.defaultValue || neutralVal);
      sliderEl.value = target;
    } else {
      prevVal = cur;
      sliderEl.value = neutralVal;
    }
    formatFn(sliderEl.value);
    sendAudioParamUpdate();
  };
}

setupValueToggle(valBass, sliderBass, 0, (v) => {
  valBass.textContent = `+${parseFloat(v).toFixed(1)} dB`;
});
setupValueToggle(valHpf, sliderHpf, 20, (v) => {
  valHpf.textContent = `${Math.round(v)} Hz`;
});
setupValueToggle(valMid, sliderMid, 0, (v) => {
  const num = parseFloat(v);
  valMid.textContent = `${num >= 0 ? '+' : ''}${num.toFixed(1)} dB`;
});
setupValueToggle(valHigh, sliderHigh, 0, (v) => {
  const num = parseFloat(v);
  valHigh.textContent = `${num >= 0 ? '+' : ''}${num.toFixed(1)} dB`;
});
setupValueToggle(valGain, sliderGain, 1.0, (v) => {
  valGain.textContent = `${Math.round(parseFloat(v) * 100)}%`;
});
setupValueToggle(valPitch, sliderPitch, 1.0, (v) => {
  valPitch.textContent = `${parseFloat(v).toFixed(2)}x`;
  if (isCapturingActive) {
    chrome.runtime.sendMessage({
      type: 'FORWARD_PLAYER_COMMAND',
      command: { type: 'SET_SPEED', speed: parseFloat(v) }
    });
  }
});

sliderBass.oninput = (e) => {
  valBass.textContent = `+${parseFloat(e.target.value).toFixed(1)} dB`;
  sendAudioParamUpdate();
};
sliderHpf.oninput = (e) => {
  valHpf.textContent = `${Math.round(e.target.value)} Hz`;
  sendAudioParamUpdate();
};
sliderMid.oninput = (e) => {
  const v = parseFloat(e.target.value);
  valMid.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
  sendAudioParamUpdate();
};
sliderHigh.oninput = (e) => {
  const v = parseFloat(e.target.value);
  valHigh.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
  sendAudioParamUpdate();
};
sliderGain.oninput = (e) => {
  valGain.textContent = `${Math.round(e.target.value * 100)}%`;
  sendAudioParamUpdate();
};
sliderPitch.oninput = (e) => {
  const val = parseFloat(e.target.value);
  valPitch.textContent = `${val.toFixed(2)}x`;
  if (isCapturingActive) {
    chrome.runtime.sendMessage({
      type: 'FORWARD_PLAYER_COMMAND',
      command: { type: 'SET_SPEED', speed: val }
    });
  }
};
toggleAutoBalance.onchange = () => {
  sendAudioParamUpdate();
};

// Wire up small increment nudge clickers (-) and (+)
document.querySelectorAll('.eq-nudge-btn').forEach(btn => {
  btn.onclick = (e) => {
    e.preventDefault();
    const targetId = btn.getAttribute('data-target');
    const action = btn.getAttribute('data-action');
    let step = parseFloat(btn.getAttribute('data-step') || '0.5');

    // Shift-click enables fine-tuning micro-step
    if (e.shiftKey) {
      step = step / 5;
    }

    const slider = document.getElementById(targetId);
    if (!slider) return;

    let cur = parseFloat(slider.value);
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);

    if (action === 'up') {
      cur = Math.min(max, cur + step);
    } else {
      cur = Math.max(min, cur - step);
    }

    const decimals = step < 0.1 ? 2 : (step < 1 ? 1 : 0);
    slider.value = cur.toFixed(decimals);
    slider.dispatchEvent(new Event('input'));
  };
});
