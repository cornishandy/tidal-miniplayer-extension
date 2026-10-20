// background.js - Service Worker for Tab Audio Capture, Routing, and the Stay-open window

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
// The Stay-open window: the popup screen in a window Chrome does not auto-close.
const FALLBACK_WINDOW_URL = 'popup.html?undocked=true';
// The page script, re-injected into tabs that were open before an update or reload (their copy is orphaned).
const PAGE_SCRIPT_FILES = ['content.js'];
const PAGE_WORLD_FILES = ['page-bridge.js']; // runs in Tidal's own page world (see the file); Tidal tabs only
const isTidalUrl = (url) => { try { const h = new URL(url).hostname; return h === 'tidal.com' || h.endsWith('.tidal.com'); } catch (_) { return false; } };
const reinjectedTabs = new Map(); // tabId -> how many times the page script was re-injected (diagnostics)
let capturedTabId = null;

// Movie mode (1.5.5, L-01). The service worker is the authority: the offscreen engine only applies a mode it has acknowledged.
let movieState = {
  captureSessionId: 0,
  tabId: null,
  effective: false,     // what offscreen.js is currently running
  override: null,       // null = automatic, true = manual ON, false = manual OFF
  detected: false,      // stable auto-detected video state on capturedTabId
  audioStreak: 0        // debounce counter for video -> audio transitions
};
let movieStateHydrated = false;
let movieStateHydrating = null;
let movieOpQueue = Promise.resolve();
let movieWatchTimer = null;
let bgCaptureGen = 0; // one token per capture request, taken before the first await

function enqueueMovieOp(fn) {
  const run = movieOpQueue.then(fn, fn);
  movieOpQueue = run.then(() => {}, () => {});
  return run;
}

async function ensureMovieState() {
  if (movieStateHydrated) return movieState;
  if (!movieStateHydrating) {
    movieStateHydrating = (async () => {
      try {
        const data = await chrome.storage.session.get('movieState');
        if (!movieStateHydrated && data && data.movieState && typeof data.movieState === 'object') {
          const s = data.movieState;
          movieState = {
            captureSessionId: s.captureSessionId || 0,
            tabId: s.tabId ?? null,
            effective: !!s.effective,
            override: s.override === true ? true : s.override === false ? false : null,
            detected: !!s.detected,
            audioStreak: s.audioStreak || 0
          };
        }
      } finally {
        movieStateHydrated = true;
        movieStateHydrating = null;
      }
    })();
  }
  await movieStateHydrating;
  return movieState;
}

function emptyMovieState() {
  return { captureSessionId: 0, tabId: null, effective: false, override: null, detected: false, audioStreak: 0 };
}

// A save started under an older capture generation must not land after Stop or a newer capture.
// Snapshot first, then write the current state again if the generation changed during the write.
async function saveMovieState() {
  const genAtCall = bgCaptureGen;
  const snap = { ...movieState };
  await chrome.storage.session.set({ movieState: snap }).catch(() => {});
  if (genAtCall !== bgCaptureGen) {
    await chrome.storage.session.set({ movieState: { ...movieState } }).catch(() => {});
  }
}

// Hydration runs before capturedTabId is restored, so a live session must not be cleared there.
// Call only once status is known and capture is idle.
async function clearEndedCaptureMovieState(status) {
  if (!status || status.isCapturing || capturedTabId !== null) return;
  if (!(movieState.captureSessionId > 0)) return;
  movieState = emptyMovieState();
  await saveMovieState();
}

function moviePayload() {
  return {
    movieMode: !!movieState.effective,
    movieModeSource: movieState.override === null ? 'auto' : 'manual',
    movieOverride: movieState.override,
    detectedVideo: !!movieState.detected
  };
}

function broadcastMovieMode() {
  const sent = chrome.runtime.sendMessage({ type: 'MOVIE_MODE_CHANGED', ...moviePayload() });
  if (sent && typeof sent.catch === 'function') sent.catch(() => {});
}

function startMovieWatchTimer() {
  if (movieWatchTimer) return;
  movieWatchTimer = setInterval(() => { pollCapturedTabVideo().catch(() => {}); }, 1500);
}

function stopMovieWatchTimer() {
  if (movieWatchTimer) clearInterval(movieWatchTimer);
  movieWatchTimer = null;
}

function sendOffscreen(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ success: false, error: err.message, lastError: err.message });
      else resolve(res == null ? null : res);
    });
  });
}

// "Stay open": when on, the toolbar icon opens the screen in Chrome's side panel (docked beside the
// page, it stays while you click anything) instead of the auto-closing popup. Chrome without a side
// panel gets the standalone window instead. The icon click opens the panel through onActionClicked
// rather than Chrome's own toggle (1.5.4), so a click never closes the panel and can finish an EQ
// switch-on that Chrome refused (see pendingEq).
async function applyStayOpen(on) {
  await chrome.action.setPopup({ popup: on ? '' : 'popup.html' });
  if (chrome.sidePanel) {
    try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (e) {}
  }
}

// Chrome lets the EQ attach to a tab only after the extension was invoked there (its icon or Alt+E); a reload
// of the tab or a Chrome restart takes that back. An EQ switch-on refused for that reason is remembered for
// 10 minutes, and the next icon click on the same tab, which is the permission, completes it.
let pendingEq = null; // { tabId, at }
const PENDING_EQ_MS = 10 * 60 * 1000;

// Any EQ start or stop, by any route (screen, Alt+E, icon), settles the pending switch-on.
function clearPendingEq() {
  pendingEq = null;
  return chrome.storage.session.remove('pendingEq').catch(() => {});
}

// The pending switch-on for this tab, taken (cleared); a click on another tab leaves it waiting.
async function takePendingEq(tabId) {
  let p = pendingEq;
  if (!p) p = (await chrome.storage.session.get('pendingEq')).pendingEq || null;
  if (!p) return null;
  const live = Date.now() - p.at < PENDING_EQ_MS;
  if (live && p.tabId !== tabId) return null;
  await clearPendingEq();
  return live ? p : null;
}

function onActionClicked(tab) {
  // Only fires while no popup is set (Stay open on). Opening the panel must happen inside the click.
  if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => openFallbackWindow().catch(() => {}));
  } else {
    openFallbackWindow().catch(() => {});
  }
  if (!tab || tab.id === undefined) return Promise.resolve(false);
  return takePendingEq(tab.id)
    .then((p) => (p && capturedTabId !== tab.id ? startAudioCapture(tab.id).then(() => true) : false))
    .catch(() => false);
}
chrome.action.onClicked.addListener(onActionClicked);

async function openPanelOrWindow() {
  if (chrome.sidePanel) {
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      await chrome.sidePanel.open({ windowId: win.id });
      return 'panel';
    } catch (e) {}
  }
  await openFallbackWindow();
  return 'window';
}

async function restoreStayOpen() {
  const { stayOpen } = await chrome.storage.local.get('stayOpen');
  await applyStayOpen(!!stayOpen);
}
chrome.runtime.onStartup.addListener(() => { restoreStayOpen().catch(() => {}); });

// Built-in presets
const FACTORY_PRESETS = {
  "Punchy Bass & Clarity": {
    bass: 5.0,
    hpf: 30,
    mid: 1.5,
    high: 2.0,
    gain: 1.0,
    semitones: 0,
    autoBalance: true
  },
  "Clean DJ (Anti-Distortion)": {
    bass: 4.5,
    hpf: 35,
    mid: 1.0,
    high: 2.5,
    gain: 1.0,
    semitones: 0,
    autoBalance: true
  },
  "Deep Sub-Bass (Dub/Trap)": {
    bass: 8.0,
    hpf: 25,
    mid: 0.0,
    high: 1.0,
    gain: 1.0,
    semitones: 0,
    autoBalance: true
  },
  "Club / Festival Bangers": {
    bass: 7.0,
    hpf: 32,
    mid: 2.0,
    high: 3.5,
    gain: 1.0,
    semitones: 0,
    autoBalance: true
  },
  "Audiophile Clean (Flat Bass)": {
    bass: 2.0,
    hpf: 20,
    mid: 0.5,
    high: 1.5,
    gain: 1.0,
    semitones: 0,
    autoBalance: false
  },
  "Late Night Movies & Dialogue": {
    bass: 3.5,
    hpf: 45,
    mid: 3.0,
    high: 1.0,
    gain: 1.0,
    semitones: 0,
    autoBalance: true
  },
  "Acoustic & Live": {
    bass: 3.0,
    hpf: 40,
    mid: 2.0,
    high: 3.0,
    gain: 1.0,
    semitones: 0,
    autoBalance: false
  },
  "Flat (Bypass)": {
    bass: 0.0,
    hpf: 20,
    mid: 0.0,
    high: 0.0,
    gain: 1.0,
    semitones: 0,
    autoBalance: false,
    bypass: true
  }
};

const FACTORY_PRESET_NAMES = Object.keys(FACTORY_PRESETS);
const DEFAULT_PRESETS = { ...FACTORY_PRESETS };

// Dynamics modes (1.5.0, D-01; a saved preset may remember them from 1.5.8, R-28). The top-level `dynamics`
// key is the sound in force. Factory definitions never carry it. A preset saved or updated from 1.5.8 may
// store its own copy; a stored preset without that field is never rewritten to add one. The defaults are
// the 1.4.0 chain.
const DEFAULT_DYNAMICS = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' };
function normaliseDynamics(d) {
  const x = d || {};
  return {
    leveler: ['full', 'slow', 'bass'].includes(x.leveler) ? x.leveler : 'full',
    match: x.match === true,
    limiter: ['fast', 'lookahead'].includes(x.limiter) ? x.limiter : 'fast',
    ceiling: ['clean', 'warm'].includes(x.ceiling) ? x.ceiling : 'clean'
  };
}

// Preset writes share one queue so a slow storage reply cannot land after a newer choice, and so
// currentPreset, currentParams and (only when the preset has them) dynamics go out in one local set.
// Movie Sound reads those keys on a throttle; a split write can hand it one preset's EQ with another's switches.
let presetWriteChain = Promise.resolve();
function enqueuePresetWrite(fn) {
  const run = presetWriteChain.then(fn, fn);
  presetWriteChain = run.then(() => {}, () => {});
  return run;
}

function isFactoryPresetName(name) {
  if (typeof name !== 'string') return false;
  const folded = name.toLowerCase();
  return FACTORY_PRESET_NAMES.some((factory) => factory.toLowerCase() === folded);
}

function paramsWithoutDynamics(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const copy = { ...params };
  delete copy.dynamics;
  return copy;
}

function presetSavedDynamics(preset) {
  if (!preset || !Object.prototype.hasOwnProperty.call(preset, 'dynamics')) return null;
  const d = preset.dynamics;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  return normaliseDynamics(d);
}

// `presetRev` counts writes that change the preset list or which preset is current.
// Slider and switch edits do not count: a screen compares this number, and the name it
// is showing, before Save, Update, Delete or Reset, and the worker writes nothing if either moved.
function storedPresetRev(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function storedPresetName(value) {
  return typeof value === 'string' && value ? value : 'Punchy Bass & Clarity';
}

function askOffscreen(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message || String(err) });
      else resolve({ ok: true, res: res ?? null });
    });
  });
}

// `saved` on a preset reply means storage accepted the write. `applied` is the offscreen
// document's own acknowledgement, and is false when that document is closed or rejects the message.
async function tellOffscreen(params, dynamics) {
  const acks = [];
  if (params && typeof params === 'object') {
    acks.push(await askOffscreen({ target: 'offscreen', type: 'UPDATE_AUDIO_PARAMS', params }));
  }
  if (dynamics) {
    acks.push(await askOffscreen({ target: 'offscreen', type: 'SET_DYNAMICS', dynamics }));
  }
  const failed = acks.find((ack) => !ack.ok);
  return { ok: !failed, error: failed ? failed.error : null, acks };
}

// One local set. `dynamics` is omitted entirely for a preset that has none, so the switches stay as they are.
// The comparison for Modified is the preset's own saved switches, so nothing is written to session storage.
async function writeSelection({ presetName, params, dynamics, extra }) {
  const prev = await chrome.storage.local.get('presetRev');
  const presetRev = storedPresetRev(prev.presetRev) + 1;
  const payload = { ...(extra || {}), currentPreset: presetName, presetRev };
  if (params && typeof params === 'object') payload.currentParams = paramsWithoutDynamics(params);
  else if (params !== undefined) payload.currentParams = params;
  if (dynamics) payload.dynamics = normaliseDynamics(dynamics);
  await chrome.storage.local.set(payload);
  const open = await isOffscreenOpen();
  const offscreen = open ? await tellOffscreen(payload.currentParams, payload.dynamics || null) : null;
  return {
    success: true,
    saved: true,
    currentParams: payload.currentParams,
    dynamicsApplied: !!payload.dynamics,
    dynamics: payload.dynamics,
    switchBaseline: payload.dynamics || null,
    applied: !!(offscreen && offscreen.ok),
    offscreen,
    presetRev
  };
}

async function readPresetSnapshot() {
  const stored = await chrome.storage.local.get(['presets', 'currentParams', 'currentPreset', 'dynamics', 'presetRev']);
  const presets = { ...DEFAULT_PRESETS, ...(stored.presets || {}) };
  const currentPreset = storedPresetName(stored.currentPreset);
  const currentParams = stored.currentParams || presets[currentPreset] || DEFAULT_PRESETS['Punchy Bass & Clarity'];
  return {
    success: true,
    saved: true,
    presets,
    currentPreset,
    currentParams: paramsWithoutDynamics(currentParams),
    dynamics: normaliseDynamics(stored.dynamics),
    presetRev: storedPresetRev(stored.presetRev),
    factoryPresets: FACTORY_PRESET_NAMES
  };
}

// Inside the preset queue, before any write. A miss writes nothing and returns the snapshot
// the screen should paint instead.
async function refuseStalePresetView(message) {
  const stored = await chrome.storage.local.get(['presetRev', 'currentPreset']);
  const rev = storedPresetRev(stored.presetRev);
  const name = storedPresetName(stored.currentPreset);
  if (rev === message.expectedRev && name === message.expectedPreset) return null;
  const state = await readPresetSnapshot();
  return { success: false, saved: false, error: 'stale-view', presetRev: state.presetRev, state };
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['presets', 'currentParams', 'currentPreset']);
  if (!data.presets) {
    await chrome.storage.local.set({ presets: DEFAULT_PRESETS });
  } else {
    // The container is rewritten. Each stored entry is copied as it is: no normalisation and no
    // backfill of `dynamics` (R-28). Factory definitions are not written onto entries that exist.
    const merged = { ...DEFAULT_PRESETS, ...data.presets };
    await chrome.storage.local.set({ presets: merged });
  }
  if (!data.currentParams) {
    await chrome.storage.local.set({
      currentParams: DEFAULT_PRESETS["Punchy Bass & Clarity"]
    });
  }
  if (!data.currentPreset) {
    await chrome.storage.local.set({ currentPreset: "Punchy Bass & Clarity" });
  }
  // Settings of removed features (floating button, Physics side panel).
  await chrome.storage.local.remove(['showFloatingButton', 'showFloatingButton_userExplicit', 'physicsPanelOpen']);
  await restoreStayOpen();
});

async function isOffscreenOpen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await isOffscreenOpen()) return;

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Process tab audio with Web Audio API for EQ and bass boost'
    });
  } catch (err) {
    if (!err.message?.includes('single offscreen document')) {
      throw err;
    }
  }

  // Ping offscreen document until its listener is ready
  for (let i = 0; i < 15; i++) {
    const ready = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_AUDIO_STATUS' }, (res) => {
        if (chrome.runtime.lastError || !res) resolve(false);
        else resolve(true);
      });
    });
    if (ready) break;
    await new Promise(r => setTimeout(r, 40));
  }
}

function broadcastAudioState(isCapturing, tabId = null) {
  const sent = chrome.runtime.sendMessage({
    type: 'AUDIO_STATE_CHANGED',
    isCapturing,
    tabId,
    ...moviePayload()
  });
  if (sent && typeof sent.catch === 'function') sent.catch(() => {});

  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      type: 'AUDIO_STATE_CHANGED',
      isCapturing
    }).catch(() => {});
  }
}

// Check live audio capture status directly from the running offscreen document
async function getActualCaptureStatus() {
  const offscreenOpen = await isOffscreenOpen();
  if (!offscreenOpen) {
    if (capturedTabId) {
      capturedTabId = null;
      await chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });
    }
    return { isCapturing: false, tabId: null };
  }

  if (!capturedTabId) {
    const data = await chrome.storage.local.get(['capturedTabId', 'isAudioCapturing']);
    if (data.capturedTabId) {
      capturedTabId = data.capturedTabId;
    }
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'GET_AUDIO_STATUS'
    }, (res) => {
      if (chrome.runtime.lastError || !res) {
        resolve({ isCapturing: false, tabId: null });
      } else {
        const isCapturing = !!res.isCapturing;
        if (!isCapturing && capturedTabId) {
          capturedTabId = null;
          chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });
        }
        resolve({ isCapturing, tabId: capturedTabId });
      }
    });
  });
}

// Translate Chrome's tabCapture errors into something actionable.
// `docked`: asked from the side panel or the Stay-open window, where an icon click completes the switch-on.
function explainCaptureError(err, tab, docked = false) {
  const msg = err?.message || String(err);
  const name = tab?.title ? `"${tab.title}"` : 'the tab that is playing';
  if (/invoked|activeTab/i.test(msg)) {
    return docked
      ? `Chrome wants one click on this extension's icon in the toolbar while ${name} is showing (it asks again after Chrome restarts or that tab reloads). Click the icon now and the EQ turns on by itself.`
      : `Chrome only lets the EQ attach to a tab after you open this extension on that tab. Switch to ${name}, click the extension icon there, then turn Audio EQ on.`;
  }
  if (/active stream/i.test(msg)) {
    return `${name} is already being captured, possibly by another copy of this extension or another audio extension. Turn that one off first.`;
  }
  if (/Chrome pages cannot be captured/i.test(msg)) {
    return 'Chrome system pages cannot be captured. Switch to a music or video tab.';
  }
  return msg;
}

// Stop won after this attempt had already touched session or storage. Leave neither one saying capture is on.
async function abandonCaptureStartup(tabId, sessionId) {
  if (capturedTabId === tabId) capturedTabId = null;
  if (capturedTabId == null || movieState.captureSessionId === sessionId) {
    movieState = { captureSessionId: 0, tabId: null, effective: false, override: null, detected: false, audioStreak: 0 };
    await saveMovieState();
  }
  stopMovieWatchTimer();
  await chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });
  return new Error('Capture stopped during startup');
}

// entryGen is taken synchronously by the caller (or here, before the first await) and checked after every wait.
async function startAudioCapture(tabId, entryGen = ++bgCaptureGen) {
  const myBgGen = entryGen;
  if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled before stream acquisition');
  // CRITICAL: Call getMediaStreamId immediately so the user gesture token from the message is fresh!
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });
  if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled during stream acquisition');

  return enqueueMovieOp(async () => {
    if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled while waiting in queue');
    await ensureMovieState();
    if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled');

    const stagedOverride = (movieState.captureSessionId === 0 && movieState.override !== null) ? movieState.override : null;

    if (capturedTabId && capturedTabId !== tabId) {
      await stopAudioCapture({ preserveGen: true });
      if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled during prior-capture cleanup');
    }

    const sessionId = Date.now() + Math.floor(Math.random() * 1000);
    await ensureOffscreenDocument();
    if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled during offscreen setup');

    const stored = await chrome.storage.local.get(['currentParams', 'currentPreset', 'presets', 'dynamics']);
    if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled during probe');
    const presets = { ...DEFAULT_PRESETS, ...(stored.presets || {}) };
    const currentPreset = stored.currentPreset || 'Punchy Bass & Clarity';
    const params = stored.currentParams || presets[currentPreset] || DEFAULT_PRESETS['Punchy Bass & Clarity'];
    const dynamics = normaliseDynamics(stored.dynamics);

    const vRes = await probeTabVideoState(tabId, 250);
    if (myBgGen !== bgCaptureGen) throw new Error('Capture cancelled during probe');

    const effectiveOverride = (movieState.captureSessionId === 0 && movieState.override !== null) ? movieState.override : stagedOverride;
    const initialDetected = vRes?.state === 'video';
    const initialEffective = effectiveOverride !== null ? effectiveOverride : initialDetected;

    const response = await sendOffscreen({
      type: 'START_AUDIO_CAPTURE',
      streamId,
      params,
      dynamics,
      movieMode: initialEffective
    });

    if (myBgGen !== bgCaptureGen) {
      if (capturedTabId === null) await sendOffscreen({ type: 'STOP_AUDIO_CAPTURE' });
      throw new Error('Capture stopped during startup');
    }
    if (response?.lastError || response?.success !== true || typeof response?.movieMode !== 'boolean') {
      throw new Error(response?.lastError || response?.error || 'Audio engine did not acknowledge startup');
    }

    // Clear the pending switch-on before publishing this session. Stop during any of these
    // waits must not leave storage, the watcher, or a broadcast saying capture is on.
    await clearPendingEq();
    if (myBgGen !== bgCaptureGen) throw await abandonCaptureStartup(tabId, sessionId);

    capturedTabId = tabId;
    movieState = {
      captureSessionId: sessionId,
      tabId,
      effective: response.movieMode,
      override: effectiveOverride,
      detected: initialDetected,
      audioStreak: 0
    };
    await saveMovieState();
    if (myBgGen !== bgCaptureGen) throw await abandonCaptureStartup(tabId, sessionId);
    await chrome.storage.local.set({ capturedTabId: tabId, isAudioCapturing: true });
    if (myBgGen !== bgCaptureGen) throw await abandonCaptureStartup(tabId, sessionId);
    startMovieWatchTimer();
    setTimeout(() => { pollCapturedTabVideo().catch(() => {}); }, 400);
    broadcastAudioState(true, tabId);
    broadcastMovieMode();
    return response;
  });
}

async function stopAudioCapture({ preserveGen = false } = {}) {
  if (!preserveGen) bgCaptureGen++;
  stopMovieWatchTimer();
  const oldTabId = capturedTabId;
  capturedTabId = null;
  await ensureMovieState();
  movieState = { captureSessionId: 0, tabId: null, effective: false, override: null, detected: false, audioStreak: 0 };
  await saveMovieState();
  await clearPendingEq();
  await chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });

  const finish = () => {
    broadcastAudioState(false, oldTabId);
    broadcastMovieMode();
    return { success: true };
  };

  if (!(await isOffscreenOpen())) return finish();
  await sendOffscreen({ type: 'STOP_AUDIO_CAPTURE' });
  return finish();
}

function probeTabVideoState(tabId, timeoutMs = 600) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value && value.state ? value : { state: 'unknown', videoWidth: 0, videoHeight: 0 });
    };
    const timer = setTimeout(() => finish({ state: 'unknown' }), timeoutMs);
    const ask = (allowInject) => {
      let callbackRan = false;
      try {
        chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_STATE' }, (res) => {
          callbackRan = true;
          const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
          if (settled) return;
          const missing = err.includes('Receiving end does not exist') || err.includes('Could not establish connection');
          if (err && allowInject && missing) {
            Promise.resolve(chrome.scripting.executeScript({
              target: { tabId },
              files: PAGE_SCRIPT_FILES,
              injectImmediately: true
            })).then(() => {
              reinjectedTabs.set(tabId, (reinjectedTabs.get(tabId) || 0) + 1);
              if (!settled) ask(false);
            }).catch(() => finish({ state: 'unknown' }));
            return;
          }
          if (err || !res || !res.state) finish({ state: 'unknown' });
          else finish(res);
        });
      } catch (_) {
        if (!callbackRan) finish({ state: 'unknown' });
      }
    };
    ask(true);
  });
}

async function pollCapturedTabVideo(opts = {}) {
  await ensureMovieState();
  if (!capturedTabId || !movieState.captureSessionId) return;
  const sessionId = movieState.captureSessionId;
  const tabId = capturedTabId;
  const res = await probeTabVideoState(tabId, 700);
  if (capturedTabId !== tabId || movieState.captureSessionId !== sessionId) return;
  if (res.state === 'video') {
    movieState.audioStreak = 0;
    movieState.detected = true;
  } else if (res.state === 'audio') {
    if (movieState.detected) {
      movieState.audioStreak = (movieState.audioStreak || 0) + 1;
      if (movieState.audioStreak >= 2) {
        movieState.detected = false;
        movieState.audioStreak = 0;
      }
    } else {
      movieState.detected = false;
      movieState.audioStreak = 0;
    }
  }
  await saveMovieState();
  if (capturedTabId !== tabId || movieState.captureSessionId !== sessionId) return;
  if (movieState.override === null && movieState.detected !== movieState.effective) {
    // Wake recovery is already on this queue, so it applies the switch itself. Every other caller waits its turn.
    const run = () => applyDetectedMovieMode(sessionId, tabId);
    if (opts.inline) await run();
    else await enqueueMovieOp(run);
  }
}

async function applyDetectedMovieMode(sessionId, tabId) {
  if (capturedTabId !== tabId || movieState.captureSessionId !== sessionId || movieState.override !== null) return;
  const wantMode = !!movieState.detected;
  if (wantMode === movieState.effective) return;
  const engineRes = await sendOffscreen({ type: 'SET_ENGINE_MOVIE_MODE', movieMode: wantMode });
  if (capturedTabId !== tabId || movieState.captureSessionId !== sessionId || movieState.override !== null) return;
  if (engineRes?.success === true && typeof engineRes.movieMode === 'boolean') {
    movieState.effective = engineRes.movieMode;
    await saveMovieState();
    broadcastMovieMode();
  }
}

async function handleSetMovieMode(message) {
  await ensureMovieState();
  const status = await getActualCaptureStatus();
  const sessionId = movieState.captureSessionId;
  const tabId = status.tabId;
  let candidateOverride;
  if (message.resetAuto === true) candidateOverride = null;
  else if (typeof message.movieMode === 'boolean') candidateOverride = message.movieMode;
  else {
    const cur = status.isCapturing ? !!movieState.effective : (movieState.override !== null ? !!movieState.override : false);
    candidateOverride = !cur;
  }

  if (!status.isCapturing) {
    if (capturedTabId !== null || movieState.captureSessionId !== 0) {
      return { success: false, error: 'Capture session changed', ...moviePayload() };
    }
    movieState.override = candidateOverride;
    movieState.effective = candidateOverride !== null ? candidateOverride : false;
    await saveMovieState();
    broadcastMovieMode();
    return { success: true, ...moviePayload() };
  }

  if (candidateOverride === null) {
    const vRes = await probeTabVideoState(tabId, 400);
    if (capturedTabId !== tabId || movieState.captureSessionId !== sessionId) {
      return { success: false, error: 'Capture session changed', ...moviePayload() };
    }
    if (vRes?.state === 'video') { movieState.detected = true; movieState.audioStreak = 0; }
    else if (vRes?.state === 'audio') { movieState.detected = false; movieState.audioStreak = 0; }
  }
  const targetMode = candidateOverride !== null ? candidateOverride : !!movieState.detected;
  const engineRes = await sendOffscreen({ type: 'SET_ENGINE_MOVIE_MODE', movieMode: targetMode });
  if (capturedTabId !== tabId || movieState.captureSessionId !== sessionId) {
    return { success: false, error: 'Capture session changed', ...moviePayload() };
  }
  if (engineRes?.success === true && typeof engineRes.movieMode === 'boolean') {
    movieState.override = candidateOverride;
    movieState.effective = engineRes.movieMode;
    await saveMovieState();
    broadcastMovieMode();
    return { success: true, ...moviePayload(), baseLatency: engineRes.baseLatency ?? null };
  }
  return { success: false, error: engineRes?.error || 'Could not switch Movie mode', ...moviePayload() };
}

async function recoverCaptureSessionOnWake() {
  return enqueueMovieOp(async () => {
    const wakeGen = bgCaptureGen;
    await ensureMovieState();
    if (wakeGen !== bgCaptureGen) return;
    const status = await getActualCaptureStatus();
    if (wakeGen !== bgCaptureGen) return;
    if (!(status.isCapturing && status.tabId)) {
      await clearEndedCaptureMovieState(status);
      return;
    }
    const engine = await sendOffscreen({ type: 'GET_AUDIO_STATUS' });
    if (wakeGen !== bgCaptureGen) return;
    const engineMovieMode = !!engine?.movieMode;
    if (movieState.tabId !== status.tabId || !movieState.captureSessionId) {
      movieState = {
        captureSessionId: Date.now(),
        tabId: status.tabId,
        effective: engineMovieMode,
        override: movieState.tabId === status.tabId ? movieState.override : null,
        detected: engineMovieMode,
        audioStreak: 0
      };
    } else {
      movieState.effective = engineMovieMode;
    }
    await saveMovieState();
    if (wakeGen !== bgCaptureGen) {
      await saveMovieState();
      return;
    }
    if (movieState.override !== null && movieState.effective !== movieState.override) {
      const sessionId = movieState.captureSessionId;
      const tabId = status.tabId;
      const want = movieState.override;
      // Already on the movie queue. Waiting for another turn here would wait for this function.
      if (capturedTabId === tabId && movieState.captureSessionId === sessionId && movieState.override === want) {
        const res = await sendOffscreen({ type: 'SET_ENGINE_MOVIE_MODE', movieMode: !!want });
        if (wakeGen !== bgCaptureGen) return;
        if (capturedTabId === tabId && movieState.captureSessionId === sessionId && movieState.override === want
            && res?.success === true && typeof res.movieMode === 'boolean') {
          movieState.effective = res.movieMode;
          await saveMovieState();
          if (wakeGen !== bgCaptureGen) {
            await saveMovieState();
            return;
          }
          broadcastMovieMode();
        }
      }
    }
    if (wakeGen !== bgCaptureGen) return;
    startMovieWatchTimer();
    await pollCapturedTabVideo({ inline: true }).catch(() => {});
  });
}

// Target tab finder specifically for player commands & track info
async function findMediaTabForPlayer() {
  const allTabs = await chrome.tabs.query({});
  if (!allTabs || allTabs.length === 0) return null;

  // 1. Any Tidal tab: first active/audible, then any open Tidal tab
  const activeTidal = allTabs.find(t => t.active && t.url && t.url.includes('tidal.com'));
  if (activeTidal) return activeTidal;

  const audibleTidal = allTabs.find(t => t.audible && t.url && t.url.includes('tidal.com'));
  if (audibleTidal) return audibleTidal;

  const anyTidal = allTabs.find(t => t.url && t.url.includes('tidal.com'));
  if (anyTidal) return anyTidal;

  // 2. Currently captured tab (if active capture)
  if (capturedTabId) {
    const captured = allTabs.find(t => t.id === capturedTabId);
    if (captured) return captured;
  }

  // 3. Any currently audible tab across any window
  const audible = allTabs.find(t => t.audible);
  if (audible) return audible;

  // 4. Any media streaming service tab
  const media = allTabs.find(t => t.url && (
    t.url.includes('youtube.com') ||
    t.url.includes('spotify.com') ||
    t.url.includes('soundcloud.com') ||
    t.url.includes('music.apple.com') ||
    t.url.includes('netflix.com')
  ));
  if (media) return media;

  // 5. Active web tab in current focused window
  const activeWeb = allTabs.find(t => t.active && t.url && !t.url.startsWith('chrome'));
  return activeWeb || null;
}

// Target tab finder specifically for Audio EQ Capture
async function findAudioCaptureTab(preferredTabId = null) {
  const allTabs = await chrome.tabs.query({});
  if (!allTabs || allTabs.length === 0) return null;

  // If a valid tab was explicitly passed from popup or content script
  if (preferredTabId) {
    const pref = allTabs.find(t => t.id === preferredTabId);
    if (pref && pref.url && !pref.url.startsWith('chrome')) {
      return pref;
    }
  }

  // 1. Audible Tidal tab
  const audibleTidal = allTabs.find(t => t.audible && t.url && t.url.includes('tidal.com'));
  if (audibleTidal) return audibleTidal;

  // 2. Any currently audible tab across all windows
  const audible = allTabs.find(t => t.audible);
  if (audible) return audible;

  // 3. Any open Tidal tab (even if paused right now)
  const anyTidal = allTabs.find(t => t.url && t.url.includes('tidal.com'));
  if (anyTidal) return anyTidal;

  // 4. Other media streaming tabs (YouTube, Spotify, etc.)
  const media = allTabs.find(t => t.url && (
    t.url.includes('youtube.com') ||
    t.url.includes('spotify.com') ||
    t.url.includes('soundcloud.com') ||
    t.url.includes('music.apple.com') ||
    t.url.includes('netflix.com')
  ));
  if (media) return media;

  // 5. Active tab in normal window
  const activeTab = allTabs.find(t => t.active && t.url && !t.url.startsWith('chrome'));
  return activeTab || null;
}

// Clean up when tabs close. The in-memory id is lost when the worker restarts, so fall back to storage.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!capturedTabId) {
    capturedTabId = (await chrome.storage.local.get('capturedTabId')).capturedTabId || null;
  }
  if (tabId === capturedTabId) {
    await stopAudioCapture();
  }
});

// A navigation on the captured tab can swap audio for video. The watcher also polls on its own timer.
chrome.tabs.onUpdated.addListener((tabId) => {
  if (tabId && tabId === capturedTabId) pollCapturedTabVideo().catch(() => {});
});

// Stay-open window (single instance). `minibar` asks the window to highlight its Mini bar button.
async function findFallbackWindow() {
  const url = chrome.runtime.getURL(FALLBACK_WINDOW_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  return contexts.find(c => c.documentUrl && c.documentUrl.startsWith(url)) || null;
}

async function openFallbackWindow({ minibar = false } = {}) {
  const existing = await findFallbackWindow();
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    if (minibar) chrome.runtime.sendMessage({ type: 'MINIBAR_HINT' }).catch(() => {});
    return;
  }
  // Initial size only; the page then fits the window to its content (popup.js fitUndockedWindow).
  await chrome.windows.create({
    url: chrome.runtime.getURL(FALLBACK_WINDOW_URL + (minibar ? '&minibar=1' : '')),
    type: 'popup',
    width: 440,
    height: 600
  });
}


// Keyboard shortcut handlers
chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'toggle-miniplayer') {
      // Opens the screen in the side panel; a second press while the window fallback is open closes it.
      const existing = await findFallbackWindow();
      if (existing) {
        await chrome.windows.remove(existing.windowId);
        return;
      }
      await openPanelOrWindow();
    } else if (command === 'toggle-eq') {
      const status = await getActualCaptureStatus();
      if (status.isCapturing) {
        await stopAudioCapture();
      } else {
        const targetTab = await findAudioCaptureTab();
        if (targetTab?.id) {
          await startAudioCapture(targetTab.id);
        }
      }
    }
  } catch (err) {
    console.warn(`Command "${command}" failed:`, err?.message || err);
  }
});

// Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'START_CAPTURE_FOR_TAB': {
          const entryGen = ++bgCaptureGen; // before the first await, so Stop during tab lookup still owns this request
          const targetTab = await findAudioCaptureTab(message.tabId || sender.tab?.id);
          if (entryGen !== bgCaptureGen) {
            sendResponse({ success: false, error: 'Capture cancelled before stream acquisition', ...moviePayload() });
            return;
          }
          if (!targetTab?.id) {
            sendResponse({ success: false, error: 'No active media tab found. Open Tidal or any music/video tab.', ...moviePayload() });
            return;
          }
          try {
            const result = await startAudioCapture(targetTab.id, entryGen); // first, while the click is fresh
            sendResponse({ success: true, result, capturedTabId, tabTitle: targetTab.title || null, ...moviePayload() });
          } catch (err) {
            // The icon completes a refused switch-on only while it opens the panel (Stay open on); otherwise it
            // opens the popup, and the popup's own advice applies.
            const docked = /[?&](panel=1|undocked=true)/.test(sender.url || '') && !!(await chrome.storage.local.get('stayOpen')).stayOpen;
            if (docked && /invoked|activeTab/i.test(err?.message || '')) {
              pendingEq = { tabId: targetTab.id, at: Date.now() };
              await chrome.storage.session.set({ pendingEq }).catch(() => {});
            }
            await ensureMovieState();
            sendResponse({ success: false, error: explainCaptureError(err, targetTab, docked), ...moviePayload() });
          }
          break;
        }

        case 'CAPTURE_ENDED': {
          // Sent by the offscreen document when the captured stream ends (e.g. the tab was closed).
          if (!capturedTabId) {
            capturedTabId = (await chrome.storage.local.get('capturedTabId')).capturedTabId || null;
          }
          await stopAudioCapture();
          sendResponse({ success: true, ...moviePayload() });
          break;
        }

        case 'STOP_CAPTURE': {
          const result = await stopAudioCapture();
          sendResponse({ success: true, result, ...moviePayload() });
          break;
        }

        case 'SET_MOVIE_MODE': {
          const result = await enqueueMovieOp(() => handleSetMovieMode(message));
          sendResponse(result);
          break;
        }

        case 'VIDEO_STATE_HINT': {
          const hintTab = sender.tab && sender.tab.id;
          if (!hintTab) { sendResponse({ ignored: true }); break; }
          let liveId = capturedTabId;
          if (!liveId) liveId = (await getActualCaptureStatus()).tabId;
          if (hintTab !== liveId) { sendResponse({ ignored: true }); break; }
          startMovieWatchTimer();
          await pollCapturedTabVideo();
          sendResponse({ success: true, ...moviePayload() });
          break;
        }

        case 'UPDATE_AUDIO_PARAMS': {
          // Sliders and band switches. One set, and never the dynamics key: a slider must not reapply a preset's switches.
          const result = await enqueuePresetWrite(async () => {
            const clean = paramsWithoutDynamics(message.params);
            const payload = { currentParams: clean };
            if (message.presetName) payload.currentPreset = message.presetName;
            await chrome.storage.local.set(payload);
            const open = await isOffscreenOpen();
            const offscreen = open ? await tellOffscreen(clean, null) : null;
            return { success: true, saved: true, applied: !!(offscreen && offscreen.ok), offscreen };
          });
          sendResponse(result);
          break;
        }

        case 'SET_ACTIVE_PRESET':
        case 'APPLY_PRESET': {
          // The caller's cached EQ and switches are ignored. The stored preset, read inside the
          // write queue, is the one that gets published, so a stale open screen cannot apply an old copy.
          const result = await enqueuePresetWrite(async () => {
            const data = await chrome.storage.local.get('presets');
            const presets = { ...DEFAULT_PRESETS, ...(data.presets || {}) };
            const preset = presets[message.presetName];
            if (!preset) {
              const state = await readPresetSnapshot();
              return { success: false, saved: false, error: 'missing-preset', presetRev: state.presetRev };
            }
            return writeSelection({
              presetName: message.presetName,
              params: preset,
              dynamics: presetSavedDynamics(preset)
            });
          });
          sendResponse(result);
          break;
        }

        case 'SET_DYNAMICS': {
          const result = await enqueuePresetWrite(async () => {
            const dynamics = normaliseDynamics(message.dynamics);
            await chrome.storage.local.set({ dynamics });
            const open = await isOffscreenOpen();
            const offscreen = open ? await tellOffscreen(null, dynamics) : null;
            return { success: true, saved: true, dynamics, applied: !!(offscreen && offscreen.ok), offscreen };
          });
          sendResponse(result);
          break;
        }

        case 'READ_PRESET_STATE': {
          // Queued behind earlier preset writes, so a screen that edited after Reset or pick
          // hydrates the state those writes left, not the reply that was already in flight.
          const result = await enqueuePresetWrite(() => readPresetSnapshot());
          sendResponse(result);
          break;
        }

        case 'GET_STATE': {
          await ensureMovieState();
          const stored = await chrome.storage.local.get(['presets', 'currentParams', 'currentPreset', 'stayOpen', 'dynamics', 'presetRev']);
          const presets = { ...DEFAULT_PRESETS, ...(stored.presets || {}) };
          const currentPreset = storedPresetName(stored.currentPreset);
          const status = await getActualCaptureStatus();
          await clearEndedCaptureMovieState(status);
          let tabTitle = null;
          if (status.isCapturing && status.tabId) {
            try { tabTitle = (await chrome.tabs.get(status.tabId)).title || null; } catch { tabTitle = null; }
          }
          sendResponse({
            capturedTabId: status.tabId,
            capturedTabTitle: tabTitle,
            isCapturing: status.isCapturing,
            presets,
            factoryPresets: FACTORY_PRESET_NAMES,
            currentPreset,
            currentParams: stored.currentParams || presets[currentPreset] || DEFAULT_PRESETS["Punchy Bass & Clarity"],
            stayOpen: !!stored.stayOpen,
            dynamics: normaliseDynamics(stored.dynamics),
            presetRev: storedPresetRev(stored.presetRev),
            ...moviePayload()
          });
          break;
        }

        case 'SET_STAY_OPEN': {
          await chrome.storage.local.set({ stayOpen: !!message.on });
          await applyStayOpen(!!message.on);
          sendResponse({ success: true, stayOpen: !!message.on });
          break;
        }

        case 'OPEN_WINDOW':
        case 'TOGGLE_MINIPLAYER':
        case 'OPEN_MINIPLAYER':
        case 'CREATE_FALLBACK_WINDOW': {
          await openFallbackWindow({ minibar: !!message.minibar });
          sendResponse({ success: true });
          break;
        }

        case 'SAVE_PRESET':
        case 'UPDATE_PRESET': {
          const { name, params } = message;
          if (isFactoryPresetName(name)) {
            sendResponse({ success: false, error: 'factory-name' });
            break;
          }
          const result = await enqueuePresetWrite(async () => {
            const stale = await refuseStalePresetView(message);
            if (stale) return stale;
            const data = await chrome.storage.local.get(['presets', 'dynamics', 'presetRev']);
            const p = { ...DEFAULT_PRESETS, ...(data.presets || {}) };
            const clean = paramsWithoutDynamics(params);
            const dyn = message.dynamics === undefined ? normaliseDynamics(data.dynamics) : normaliseDynamics(message.dynamics);
            p[name] = { ...clean, dynamics: dyn };
            const presetRev = storedPresetRev(data.presetRev) + 1;
            // Preset, the EQ in force, the switches in force and the new revision, in one set.
            // The map was just read inside the queue, so this cannot drop a preset another screen saved earlier.
            // The EQ and switches stored are the ones in this message: the screen that has the controls.
            await chrome.storage.local.set({ presets: p, currentPreset: name, currentParams: clean, dynamics: dyn, presetRev });
            const open = await isOffscreenOpen();
            const offscreen = open ? await tellOffscreen(clean, dyn) : null;
            return { success: true, saved: true, presets: p, savedName: name, dynamics: dyn, applied: !!(offscreen && offscreen.ok), offscreen, presetRev };
          });
          sendResponse(result);
          break;
        }

        case 'DELETE_PRESET': {
          const result = await enqueuePresetWrite(async () => {
            const stale = await refuseStalePresetView(message);
            if (stale) return stale;
            const { name } = message;
            const data = await chrome.storage.local.get(['presets', 'presetRev']);
            const p = { ...DEFAULT_PRESETS, ...(data.presets || {}) };
            delete p[name];
            const presetRev = storedPresetRev(data.presetRev) + 1;
            await chrome.storage.local.set({ presets: p, presetRev });
            return { success: true, presets: p, presetRev };
          });
          sendResponse(result);
          break;
        }

        case 'RESET_DEFAULT_PRESETS': {
          const result = await enqueuePresetWrite(async () => {
            const stale = await refuseStalePresetView(message);
            if (stale) return stale;
            const presetToReset = message.currentPreset;
            const data = await chrome.storage.local.get('presets');
            const p = { ...DEFAULT_PRESETS, ...(data.presets || {}) };

            if (presetToReset && !FACTORY_PRESETS[presetToReset] && p[presetToReset]) {
              // Custom preset: discard unsaved changes. The saved entry itself is not rewritten.
              const savedDyn = presetSavedDynamics(p[presetToReset]);
              const applied = await writeSelection({
                presetName: presetToReset,
                params: p[presetToReset],
                dynamics: savedDyn
              });
              return {
                success: true,
                saved: true,
                presets: p,
                selectedName: presetToReset,
                currentParams: applied.currentParams,
                dynamicsApplied: applied.dynamicsApplied,
                dynamics: applied.dynamics,
                switchBaseline: applied.switchBaseline,
                applied: applied.applied,
                offscreen: applied.offscreen,
                presetRev: applied.presetRev
              };
            }

            let selectedName = presetToReset;
            let presetsOut = p;
            let params;
            if (presetToReset && FACTORY_PRESETS[presetToReset]) {
              p[presetToReset] = { ...FACTORY_PRESETS[presetToReset] };
              params = p[presetToReset];
            } else {
              // Restore factory values for every factory preset; custom presets are kept.
              presetsOut = { ...p, ...DEFAULT_PRESETS };
              selectedName = 'Punchy Bass & Clarity';
              params = DEFAULT_PRESETS['Punchy Bass & Clarity'];
            }
            const applied = await writeSelection({
              presetName: selectedName,
              params,
              dynamics: null,
              extra: { presets: presetsOut }
            });
            return {
              success: true,
              saved: true,
              presets: presetsOut,
              selectedName,
              currentParams: applied.currentParams,
              dynamicsApplied: false,
              switchBaseline: applied.switchBaseline,
              applied: applied.applied,
              offscreen: applied.offscreen,
              presetRev: applied.presetRev
            };
          });
          sendResponse(result);
          break;
        }

        case 'FORWARD_PLAYER_COMMAND': {
          const targetTab = await findMediaTabForPlayer();
          if (!targetTab?.id) {
            sendResponse({ success: false, error: 'No media tab found' });
            return;
          }
          chrome.tabs.sendMessage(targetTab.id, message.command, async (response) => {
            if (chrome.runtime.lastError) {
              const errMsg = chrome.runtime.lastError.message || '';
              if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection')) {
                try {
                  await chrome.scripting.executeScript({
                    target: { tabId: targetTab.id },
                    files: PAGE_SCRIPT_FILES,
                    injectImmediately: true // the screen is asking now; do not wait for the page to go idle
                  });
                  // Tidal tabs only. The helper has no tie to the extension, so it outlives a Reload; it is missing only
                  // in Tidal tabs opened before 1.5.3 was installed, where it comes late: it misses what Tidal set up
                  // before and catches the next play(). Reloading the Tidal tab once gives it everything.
                  if (isTidalUrl(targetTab.url)) {
                    await chrome.scripting.executeScript({
                      target: { tabId: targetTab.id },
                      files: PAGE_WORLD_FILES,
                      world: 'MAIN',
                      injectImmediately: true
                    }).catch(() => {});
                  }
                  reinjectedTabs.set(targetTab.id, (reinjectedTabs.get(targetTab.id) || 0) + 1);
                  chrome.tabs.sendMessage(targetTab.id, message.command, (retryRes) => {
                    if (chrome.runtime.lastError) {
                      sendResponse({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                      sendResponse(retryRes);
                    }
                  });
                  return;
                } catch (injectErr) {
                  sendResponse({ success: false, error: errMsg });
                  return;
                }
              }
              sendResponse({ success: false, error: errMsg });
            } else {
              sendResponse(response);
            }
          });
          break;
        }

        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

// Wake the movie-mode watcher even when every popup and panel is closed. The script runs again each time the worker starts.
recoverCaptureSessionOnWake().catch(() => {});
