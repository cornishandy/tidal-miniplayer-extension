// tests/unit/movie-mode.test.mjs — Movie mode (1.5.5, L-01). No browser, no audio device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
async function drain(n = 40) { for (let i = 0; i < n; i++) await tick(); }
async function until(fn, label, n = 60) {
  for (let i = 0; i < n; i++) { if (fn()) return; await tick(); }
  throw new Error('timed out waiting for ' + label);
}

function fakeTimers() {
  let seq = 1;
  const items = [];
  return {
    setTimeout(fn) { const id = seq++; items.push({ id, fn, kind: 'timeout' }); return id; },
    clearTimeout(id) { const i = items.findIndex((t) => t.id === id); if (i >= 0) items.splice(i, 1); },
    setInterval(fn) { const id = seq++; items.push({ id, fn, kind: 'interval' }); return id; },
    clearInterval(id) { const i = items.findIndex((t) => t.id === id); if (i >= 0) items.splice(i, 1); },
    pending: () => items.length,
    fire() { const due = items.slice(); for (const t of due) { if (t.kind === 'timeout') { const i = items.findIndex((x) => x.id === t.id); if (i >= 0) items.splice(i, 1); } t.fn(); } }
  };
}

// ---------- offscreen.js ----------

function loadOffscreen() {
  const timers = fakeTimers();
  const contexts = [];
  const worklets = [];
  let gumCalls = 0;
  let trackStops = 0;
  let holdGum = false;
  let releaseGum = null;
  let holdModule = false;
  let holdOnContext = 0;
  let holdModuleUrl = null;
  const moduleWaiters = [];
  let failResume = false;
  const messages = [];
  let listener = null;

  class Gain {
    constructor() { this.gain = { value: 1, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} }; }
    connect() { return this; }
    disconnect() {}
  }
  class Biquad {
    constructor() {
      this.type = '';
      this.frequency = { value: 0, setTargetAtTime(v) { this.value = v; } };
      this.Q = { value: 0 };
      this.gain = { value: 0, setTargetAtTime(v) { this.value = v; } };
    }
    connect() { return this; }
    disconnect() {}
  }
  class Comp {
    constructor() {
      this.threshold = { value: 0 }; this.knee = { value: 0 }; this.ratio = { value: 0 };
      this.attack = { value: 0 }; this.release = { value: 0 };
    }
    connect() { return this; }
    disconnect() {}
  }
  class Shaper { constructor() { this.curve = null; this.oversample = 'none'; } connect() { return this; } disconnect() {} }
  class Analyser { constructor() { this.fftSize = 0; this.smoothingTimeConstant = 0; } connect() { return this; } getFloatFrequencyData(b) { b.fill(-100); } }
  class Param { constructor(v) { this.value = v; } setValueAtTime(v) { this.value = v; } setTargetAtTime(v) { this.value = v; } cancelScheduledValues() {} }
  class AudioWorkletNode {
    constructor(ctx, name) {
      this.context = ctx; this.name = name;
      this.port = { onmessage: null };
      const params = new Map();
      this.parameters = {
        get(paramName) {
          if (!params.has(paramName)) params.set(paramName, new Param(0));
          return params.get(paramName);
        }
      };
      worklets.push(this);
    }
    connect() { return this; }
    disconnect() {}
  }
  class AudioContext {
    constructor(opts) {
      this.n = contexts.length + 1;
      this.latencyHint = opts && opts.latencyHint;
      this.baseLatency = this.latencyHint === 'interactive' ? 0.005 : 0.02;
      this.state = 'suspended';
      this.currentTime = 10;
      this.destination = {};
      this.sampleRate = 48000;
      this.audioWorklet = { addModule: async (url) => {
        const wanted = !holdModuleUrl || String(url).includes(holdModuleUrl);
        if (holdModule && this.n === holdOnContext && wanted) await new Promise((r) => moduleWaiters.push(r));
      } };
      this.resume = async () => { if (failResume && this.n > 1) throw new Error('resume failed'); this.state = 'running'; };
      this.close = () => { this.state = 'closed'; return Promise.resolve(); };
      this.createGain = () => new Gain();
      this.createBiquadFilter = () => new Biquad();
      this.createDynamicsCompressor = () => new Comp();
      this.createWaveShaper = () => new Shaper();
      this.createAnalyser = () => new Analyser();
      this.createMediaStreamSource = (stream) => ({ stream, connect() {}, disconnect() {} });
      contexts.push(this);
    }
  }
  function makeStream() {
    const track = { id: 'track-' + gumCalls, readyState: 'live', stop() { this.readyState = 'ended'; trackStops++; }, addEventListener() {} };
    return { id: 'stream-' + gumCalls, track, getTracks: () => [track], getAudioTracks: () => [track] };
  }
  const sandbox = {
    console, Math, Number, Object, Array, Error, String, Boolean, isFinite, Infinity, Float32Array, Promise,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    AudioContext, AudioWorkletNode,
    navigator: { mediaDevices: { getUserMedia: () => {
      gumCalls++;
      if (holdGum) return new Promise((r) => { releaseGum = () => r(makeStream()); });
      return Promise.resolve(makeStream());
    } } },
    chrome: { runtime: {
      getURL: (p) => 'chrome-extension://test/' + p,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener(fn) { listener = fn; } },
      lastError: null
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('offscreen.js') + `
    globalThis.__movieTest = () => ({
      currentStream, audioCtx, isCapturing, pitchNode, bandLevelerNode, matchNode, lookaheadNode,
      bassNode, hpfNode, autoBalanceComp, currentMovieMode, captureGen, pitchHoldTimer, pitchPrimed
    });
    globalThis.__armHold = () => { pitchHoldTimer = setTimeout(() => { globalThis.__holdFired = true; }, 5000); };
    globalThis.__setDynamics = (d) => { currentDynamics = d; };
    globalThis.__setParam = (k, v) => { currentParams[k] = v; };
  `, sandbox, { filename: 'offscreen.js' });
  const realApply = sandbox.applyRoutingState;
  let inBuild = false;
  let premature = 0;
  const realBuild = sandbox.buildAudioGraph;
  sandbox.buildAudioGraph = async function (...args) {
    inBuild = true;
    try { return await realBuild.apply(this, args); }
    finally { inBuild = false; }
  };
  sandbox.applyRoutingState = function (...args) {
    if (inBuild) premature++;
    return realApply.apply(this, args);
  };
  async function releaseModules() {
    holdModule = false;
    holdModuleUrl = null;
    const pending = moduleWaiters.splice(0);
    for (const r of pending) r();
    await drain();
  }
  return {
    sandbox, timers, contexts, worklets, messages, listener,
    premature: () => premature,
    gumCalls: () => gumCalls,
    trackStops: () => trackStops,
    setHoldGum(v) { holdGum = v; },
    releaseGum: () => releaseGum,
    setHoldModule(n) { holdModule = true; holdOnContext = n; holdModuleUrl = null; },
    setHoldDyn(n) { holdModule = true; holdOnContext = n; holdModuleUrl = 'dynamics.worklet'; },
    releaseModules,
    moduleWaiters,
    setFailResume(v) { failResume = v; },
    state: () => sandbox.__movieTest(),
    async call(type, message) {
      const msg = Object.assign({ type }, message);
      let responded;
      const ret = listener(msg, {}, (res) => { responded = res; });
      await drain();
      return { ret, responded };
    }
  };
}

test('offscreen: playback vs interactive constructors, and the playback literal stays', () => {
  assert.match(read('offscreen.js'), /new AudioContext\(\{ latencyHint: 'playback' \}\)/);
  assert.match(read('offscreen.js'), /new AudioContext\(\{ latencyHint: 'interactive' \}\)/);
  const eng = loadOffscreen();
  const playback = eng.sandbox.makeAudioContext(false);
  const interactive = eng.sandbox.makeAudioContext(true);
  assert.equal(playback.latencyHint, 'playback');
  assert.equal(playback.baseLatency, 0.02);
  assert.equal(interactive.latencyHint, 'interactive');
  assert.equal(interactive.baseLatency, 0.005);
});

test('offscreen: rebuild keeps the stream, closes the old context, and uses params from after the worklet load', async () => {
  const eng = loadOffscreen();
  const started = eng.sandbox.startCapture('sid', { bass: 5, hpf: 30 }, null, false);
  await drain();
  const first = await started;
  assert.equal(first.success, true);
  assert.equal(first.movieMode, false);
  assert.equal(first.latencyHint, 'playback');
  assert.equal(first.baseLatency, 0.02);
  assert.equal(eng.premature(), 0, 'applyRoutingState ran before the graph was installed');
  const stream = eng.state().currentStream;
  const oldCtx = eng.state().audioCtx;
  const oldPitch = eng.state().pitchNode;
  const oldBand = eng.state().bandLevelerNode;
  const oldMatch = eng.state().matchNode;
  const oldLa = eng.state().lookaheadNode;
  const oldHandler = oldPitch.port.onmessage;
  const oldBass = eng.state().bassNode;
  eng.sandbox.__armHold();
  eng.setHoldModule(2);
  const switching = eng.sandbox.setMovieMode(true);
  await until(() => eng.moduleWaiters.length > 0, 'rebuild worklet');
  assert.equal(eng.state().audioCtx, oldCtx, 'the live context was replaced before the new graph was ready');
  eng.sandbox.__setParam('bass', 8);
  eng.sandbox.__setParam('hpf', 40);
  eng.sandbox.__setDynamics({ leveler: 'slow', match: false, limiter: 'fast', ceiling: 'clean' });
  await eng.releaseModules();
  const switched = await switching;
  assert.equal(switched.success, true, switched.error);
  assert.equal(switched.movieMode, true);
  assert.equal(switched.latencyHint, 'interactive');
  assert.equal(eng.state().currentStream, stream);
  assert.equal(eng.gumCalls(), 1);
  assert.equal(eng.trackStops(), 0);
  assert.equal(oldCtx.state, 'closed');
  assert.equal(eng.state().audioCtx.latencyHint, 'interactive');
  assert.equal(eng.state().audioCtx.state, 'running');
  assert.equal(oldPitch.port.onmessage, null);
  assert.equal(oldBand.port.onmessage, null);
  assert.equal(oldMatch.port.onmessage, null);
  assert.equal(oldLa.port.onmessage, null);
  assert.equal(eng.state().pitchHoldTimer, null);
  eng.timers.fire();
  assert.equal(eng.sandbox.__holdFired, undefined);
  assert.equal(eng.premature(), 0);
  assert.equal(eng.state().bassNode.gain.value, 8);
  assert.equal(oldBass.gain.value, 5);
  assert.equal(eng.state().hpfNode.frequency.value, 40);
  assert.equal(eng.state().autoBalanceComp.release.value, 0.6);
  eng.state().pitchNode.port.onmessage({ data: { primed: true } });
  assert.equal(eng.state().pitchPrimed, true);
  oldHandler({ data: { primed: false } });
  assert.equal(eng.state().pitchPrimed, true, 'the retired worklet still changed pitch state');
  const status = await eng.call('GET_AUDIO_STATUS');
  assert.equal(status.responded.movieMode, true);
  assert.equal(status.responded.latencyHint, 'interactive');
  assert.equal(typeof status.responded.baseLatency, 'number');
});

test('offscreen: stop during getUserMedia drops the new stream and never keeps it', async () => {
  const eng = loadOffscreen();
  eng.setHoldGum(true);
  const pending = eng.sandbox.startCapture('sid', {}, null, false);
  await until(() => eng.releaseGum(), 'getUserMedia');
  eng.sandbox.stopCapture();
  eng.releaseGum()();
  const res = await pending;
  assert.equal(res.success, false);
  assert.equal(res.stale, true);
  assert.equal(eng.state().currentStream, null);
  assert.equal(eng.trackStops(), 1);
  assert.equal(eng.state().isCapturing, false);
});

test('offscreen: stop during a rebuild closes the new context and leaves capture stopped', async () => {
  const eng = loadOffscreen();
  const started = await eng.sandbox.startCapture('sid', {}, null, false);
  assert.equal(started.success, true);
  eng.setHoldModule(2);
  const switching = eng.sandbox.setMovieMode(true);
  await until(() => eng.moduleWaiters.length > 0, 'rebuild');
  eng.sandbox.stopCapture();
  await eng.releaseModules();
  const res = await switching;
  assert.equal(res.success, false);
  assert.equal(res.stale, true);
  assert.equal(eng.state().isCapturing, false);
  assert.equal(eng.state().currentStream, null);
  assert.equal(eng.contexts[0].state, 'closed');
  assert.equal(eng.contexts[1].state, 'closed');
});

test('offscreen: a start queued behind a rebuild does not run after stop', async () => {
  const eng = loadOffscreen();
  const started = await eng.sandbox.startCapture('sid', {}, null, false);
  assert.equal(started.success, true);
  eng.setHoldModule(2);
  const switching = eng.sandbox.setMovieMode(true);
  await until(() => eng.moduleWaiters.length > 0, 'rebuild');
  const queued = eng.sandbox.startCapture('sid-2', {}, null, true);
  eng.sandbox.stopCapture();
  await eng.releaseModules();
  const switchRes = await switching;
  const startRes = await queued;
  assert.equal(switchRes.success, false);
  assert.equal(switchRes.stale, true);
  assert.equal(startRes.success, false);
  assert.equal(startRes.stale, true);
  assert.equal(eng.state().isCapturing, false);
  assert.equal(eng.state().currentStream, null);
});

test('offscreen: a pitch change during the dynamics worklet load is on the installed node', async () => {
  const eng = loadOffscreen();
  eng.setHoldDyn(1);
  const started = eng.sandbox.startCapture('sid', { semitones: 0 }, null, false);
  await until(() => eng.moduleWaiters.length > 0, 'dynamics worklet');
  eng.sandbox.__setParam('semitones', 7);
  await eng.releaseModules();
  const res = await started;
  assert.equal(res.success, true, res.error);
  const pitch = eng.state().pitchNode;
  assert.ok(pitch);
  assert.equal(pitch.parameters.get('semitones').value, 7);
  assert.equal(pitch.parameters.get('semitones'), pitch.parameters.get('semitones'));
});

test('offscreen: a failed rebuild keeps the old context running', async () => {
  const eng = loadOffscreen();
  const started = await eng.sandbox.startCapture('sid', {}, null, true);
  assert.equal(started.movieMode, true);
  assert.equal(started.latencyHint, 'interactive');
  const oldCtx = eng.state().audioCtx;
  const stream = eng.state().currentStream;
  eng.setFailResume(true);
  const res = await eng.sandbox.setMovieMode(false);
  assert.equal(res.success, false);
  assert.match(res.error, /resume failed/);
  assert.equal(eng.state().audioCtx, oldCtx);
  assert.equal(oldCtx.state, 'running');
  assert.equal(eng.state().isCapturing, true);
  assert.equal(eng.state().currentStream, stream);
  assert.equal(eng.trackStops(), 0);
  assert.equal(eng.state().currentMovieMode, true);
  assert.equal(eng.contexts[1].state, 'closed');
});

test('offscreen: SET_ENGINE_MOVIE_MODE is ignored unless it targets the offscreen document', async () => {
  const eng = loadOffscreen();
  const ignored = await eng.call('SET_ENGINE_MOVIE_MODE', { movieMode: true });
  assert.equal(ignored.ret, false);
  assert.equal(eng.state().currentMovieMode, false);
  const accepted = eng.listener({ type: 'SET_ENGINE_MOVIE_MODE', target: 'offscreen', movieMode: true }, {}, () => {});
  assert.equal(accepted, true);
});

// ---------- background.js ----------

function pick(bag, keys) {
  if (keys == null) return { ...bag };
  const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const out = {};
  for (const k of names) if (k in bag) out[k] = bag[k];
  return out;
}

function loadBackground() {
  const timers = fakeTimers();
  const local = {};
  const session = {};
  const engine = { starts: [], sets: [], stops: 0, broadcasts: [], capturing: false, movieMode: false, nextStart: null, nextSet: null, holdStart: false, holdStop: false, holdStatusAfter: 0 };
  const startHolds = [];
  const stopHolds = [];
  const statusHolds = [];
  let statusCalls = 0;
  let sessionSetHoldsLeft = 0;
  const sessionSetHolds = [];
  let holdStream = false;
  const streamHolds = [];
  let holdProbe = false;
  const probeHolds = [];
  let offscreenOpen = false;
  let streamSerial = 0;
  const tabs = [{ id: 7, url: 'https://example.com/audio', title: 'Audio tab', active: true, audible: true, windowId: 1 }];
  const videoByTab = new Map();
  let onMessage = null;
  let ops = 0;
  const area = (bag) => ({
    get: (keys) => Promise.resolve(pick(bag, keys)),
    set: (obj) => {
      const apply = () => { Object.assign(bag, obj); return Promise.resolve(); };
      if (bag === session && sessionSetHoldsLeft > 0) {
        sessionSetHoldsLeft--;
        return new Promise((resolve) => sessionSetHolds.push(() => resolve(apply())));
      }
      return apply();
    },
    remove: (keys) => { for (const k of [].concat(keys)) delete bag[k]; return Promise.resolve(); }
  });
  function ackStart(msg) {
    engine.capturing = true;
    engine.movieMode = !!msg.movieMode;
    return { success: true, movieMode: engine.movieMode, latencyHint: engine.movieMode ? 'interactive' : 'playback', baseLatency: engine.movieMode ? 0.005 : 0.02 };
  }
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://id/' + p,
      getContexts: async () => (offscreenOpen ? [{ documentUrl: 'chrome-extension://id/offscreen.html' }] : []),
      onMessage: { addListener(fn) { onMessage = fn; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage(msg, cb) {
        const finish = (res) => { if (typeof cb === 'function') cb(res); return res; };
        if (msg && msg.target === 'offscreen') {
          if (msg.type === 'GET_AUDIO_STATUS') {
            statusCalls++;
            const snap = { isCapturing: engine.capturing, movieMode: engine.movieMode, latencyHint: engine.movieMode ? 'interactive' : 'playback', baseLatency: engine.capturing ? (engine.movieMode ? 0.005 : 0.02) : null };
            if (engine.holdStatusAfter && statusCalls >= engine.holdStatusAfter) {
              return new Promise((resolve) => { statusHolds.push(() => { finish(snap); resolve(snap); }); });
            }
            return Promise.resolve(finish(snap));
          }
          if (msg.type === 'START_AUDIO_CAPTURE') {
            engine.starts.push(msg);
            if (engine.holdStart) return new Promise((resolve) => { startHolds.push((res) => { const out = res === undefined ? ackStart(msg) : res; finish(out); resolve(out); }); });
            const out = engine.nextStart ? engine.nextStart(msg) : ackStart(msg);
            return Promise.resolve(finish(out));
          }
          if (msg.type === 'SET_ENGINE_MOVIE_MODE') {
            engine.sets.push(msg);
            const out = engine.nextSet ? engine.nextSet(msg) : { success: true, movieMode: !!msg.movieMode, latencyHint: msg.movieMode ? 'interactive' : 'playback', baseLatency: 0.005 };
            if (out && out.success === true && typeof out.movieMode === 'boolean') engine.movieMode = out.movieMode;
            return Promise.resolve(finish(out));
          }
          if (msg.type === 'STOP_AUDIO_CAPTURE') {
            engine.stops++;
            if (engine.holdStop) return new Promise((resolve) => { stopHolds.push(() => { engine.capturing = false; finish({ success: true }); resolve({ success: true }); }); });
            engine.capturing = false;
            return Promise.resolve(finish({ success: true }));
          }
          return Promise.resolve(finish(null));
        }
        engine.broadcasts.push(msg);
        return Promise.resolve();
      }
    },
    storage: { local: area(local), session: area(session) },
    action: { onClicked: { addListener() {} }, setPopup: async () => {}, getPopup: async () => 'popup.html' },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      query: async () => tabs.map((t) => ({ ...t })),
      get: async (id) => tabs.find((t) => t.id === id) || null,
      sendMessage(tabId, msg, cb) {
        if (msg && msg.type === 'GET_VIDEO_STATE') {
          const reply = () => { if (typeof cb === 'function') cb(videoByTab.get(tabId) || { state: 'audio', videoWidth: 0, videoHeight: 0 }); };
          if (holdProbe) { probeHolds.push(reply); return Promise.resolve(); }
          reply();
          return Promise.resolve();
        }
        if (typeof cb === 'function') cb(null);
        return Promise.resolve();
      }
    },
    commands: { onCommand: { addListener() {} } },
    tabCapture: { getMediaStreamId: () => {
      streamSerial++;
      if (holdStream) return new Promise((r) => streamHolds.push(() => r('stream-' + streamSerial)));
      return Promise.resolve('stream-' + streamSerial);
    } },
    offscreen: { createDocument: async () => { offscreenOpen = true; } },
    scripting: { executeScript: async () => [] },
    windows: { getLastFocused: async () => ({ id: 1 }), create: async () => ({ id: 2 }), update: async () => {}, remove: async () => {} }
  };
  const sandbox = {
    console, Math, Number, Object, Array, Error, String, Boolean, Date, Promise, isFinite, Infinity, Map, Set,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    chrome
  };
  vm.createContext(sandbox);
  vm.runInContext(read('background.js') + `
    globalThis.__movieTest = () => ({
      capturedTabId, bgCaptureGen, movieWatchTimer, movieStateHydrated,
      movieState: {
        captureSessionId: movieState.captureSessionId, tabId: movieState.tabId,
        effective: movieState.effective, override: movieState.override,
        detected: movieState.detected, audioStreak: movieState.audioStreak
      }
    });
    globalThis.__resetHydration = (next) => {
      movieStateHydrated = false;
      movieStateHydrating = null;
      capturedTabId = null;
      if (next && typeof next === 'object') {
        movieState = {
          captureSessionId: next.captureSessionId || 0,
          tabId: next.tabId ?? null,
          effective: !!next.effective,
          override: next.override === true ? true : next.override === false ? false : null,
          detected: !!next.detected,
          audioStreak: next.audioStreak || 0
        };
      }
    };
  `, sandbox, { filename: 'background.js' });
  const origEnq = sandbox.enqueueMovieOp;
  sandbox.enqueueMovieOp = (fn) => { ops++; return origEnq(fn); };
  function send(message, sender = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response for ' + message.type)), 3000);
      const ret = onMessage(message, sender, (res) => { clearTimeout(timer); resolve(res); });
      if (ret !== true) { clearTimeout(timer); resolve({ returned: ret }); }
    });
  }
  return {
    sandbox, timers, engine, local, session, tabs, videoByTab, send, onMessage,
    ops: () => ops,
    startHolds, stopHolds, streamHolds, probeHolds, statusHolds, sessionSetHolds,
    holdNextSessionSet() { sessionSetHoldsLeft++; },
    setOffscreen(v) { offscreenOpen = v; },
    setHoldStream(v) { holdStream = v; },
    setHoldProbe(v) { holdProbe = v; },
    state: () => JSON.parse(JSON.stringify(sandbox.__movieTest())),
    async ready() { await drain(); }
  };
}

async function capture(bg, tabId = 7) {
  const res = await bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId });
  assert.equal(res.success, true, res.error);
  bg.sandbox.stopMovieWatchTimer();
  return res;
}
const snap = (bg) => bg.state().movieState;

test('background: a missing engine acknowledgement does not commit capture or the manual choice', async () => {
  for (const bad of [null, {}, { success: true }]) {
    const bg = loadBackground();
    await bg.ready();
    const armed = await bg.send({ type: 'SET_MOVIE_MODE', movieMode: true });
    assert.equal(armed.success, true);
    assert.equal(armed.movieOverride, true);
    assert.equal(snap(bg).captureSessionId, 0);
    bg.engine.nextStart = () => bad;
    const res = await bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 7 });
    assert.equal(res.success, false);
    assert.equal(bg.state().capturedTabId, null);
    assert.equal(snap(bg).override, true);
    assert.equal(snap(bg).effective, true);
    assert.equal(snap(bg).captureSessionId, 0);
    assert.equal(bg.local.capturedTabId, undefined);
  }
});

test('background: Stop during stream acquisition, the queue, prior-tab cleanup, the probe, or engine startup never commits', async () => {
  // getMediaStreamId
  {
    const bg = loadBackground();
    await bg.ready();
    await bg.send({ type: 'SET_MOVIE_MODE', movieMode: true });
    bg.setHoldStream(true);
    const pending = bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 7 });
    await until(() => bg.streamHolds.length === 1, 'stream id');
    const stopped = await bg.send({ type: 'STOP_CAPTURE' });
    assert.equal(stopped.movieOverride, null);
    bg.streamHolds.shift()();
    const res = await pending;
    assert.equal(res.success, false);
    assert.equal(bg.engine.starts.length, 0);
    assert.equal(bg.state().capturedTabId, null);
    assert.equal(snap(bg).override, null);
  }
  // waiting in movieOpQueue
  {
    const bg = loadBackground();
    await bg.ready();
    let release;
    bg.sandbox.enqueueMovieOp(() => new Promise((r) => { release = r; }));
    const pending = bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 7 });
    await until(() => bg.ops() >= 2, 'start queued');
    await bg.send({ type: 'STOP_CAPTURE' });
    release();
    const res = await pending;
    assert.equal(res.success, false);
    assert.equal(bg.engine.starts.length, 0);
    assert.equal(bg.state().capturedTabId, null);
  }
  // prior-capture cleanup
  {
    const bg = loadBackground();
    await bg.ready();
    await capture(bg, 7);
    assert.equal(bg.engine.starts.length, 1);
    bg.tabs.push({ id: 8, url: 'https://example.com/other', title: 'Other', active: false, audible: false, windowId: 1 });
    bg.engine.holdStop = true;
    const pending = bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 8 });
    await until(() => bg.stopHolds.length === 1, 'prior stop');
    const stopping = bg.send({ type: 'STOP_CAPTURE' });
    await until(() => bg.stopHolds.length === 2, 'external stop');
    bg.stopHolds.splice(0).forEach((fn) => fn());
    const stopped = await stopping;
    const res = await pending;
    assert.equal(stopped.success, true);
    assert.equal(res.success, false);
    assert.equal(bg.engine.starts.length, 1);
    assert.equal(bg.state().capturedTabId, null);
    assert.equal(snap(bg).override, null);
  }
  // probe
  {
    const bg = loadBackground();
    await bg.ready();
    await bg.send({ type: 'SET_MOVIE_MODE', movieMode: false });
    bg.setHoldProbe(true);
    const pending = bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 7 });
    await until(() => bg.probeHolds.length === 1, 'probe');
    await bg.send({ type: 'STOP_CAPTURE' });
    bg.probeHolds.shift()();
    const res = await pending;
    assert.equal(res.success, false);
    assert.equal(bg.engine.starts.length, 0);
    assert.equal(bg.state().capturedTabId, null);
    assert.equal(snap(bg).override, null);
  }
  // engine already starting when Stop lands
  {
    const bg = loadBackground();
    await bg.ready();
    await bg.send({ type: 'SET_MOVIE_MODE', movieMode: true });
    bg.engine.holdStart = true;
    const pending = bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 7 });
    await until(() => bg.startHolds.length === 1, 'engine start');
    await bg.send({ type: 'STOP_CAPTURE' });
    bg.startHolds.shift()();
    const res = await pending;
    assert.equal(res.success, false);
    assert.match(res.error, /stopped during startup|cancelled/);
    assert.equal(bg.state().capturedTabId, null);
    assert.equal(snap(bg).override, null);
    assert.ok(bg.engine.stops >= 1);
  }
});

test('background: an automatic switch queued behind a manual choice does not override it', async () => {
  const bg = loadBackground();
  await bg.ready();
  await capture(bg, 7);
  assert.equal(snap(bg).override, null);
  assert.equal(snap(bg).effective, false);
  let release;
  const before = bg.ops();
  bg.sandbox.enqueueMovieOp(() => new Promise((r) => { release = r; }));
  const manual = bg.send({ type: 'SET_MOVIE_MODE', movieMode: false });
  await until(() => bg.ops() >= before + 2, 'manual queued');
  bg.videoByTab.set(7, { state: 'video', videoWidth: 640, videoHeight: 360 });
  const polled = bg.sandbox.pollCapturedTabVideo();
  await until(() => bg.ops() >= before + 3, 'poll queued');
  release();
  const manualRes = await manual;
  await polled;
  assert.equal(manualRes.success, true);
  assert.equal(manualRes.movieOverride, false);
  assert.equal(snap(bg).override, false);
  assert.equal(snap(bg).effective, false);
  assert.equal(snap(bg).detected, true);
  assert.deepEqual(bg.engine.sets.map((m) => m.movieMode), [false]);
});

test('background: a failed engine switch does not commit the manual choice or an automatic change', async () => {
  const bg = loadBackground();
  await bg.ready();
  await capture(bg, 7);
  bg.engine.nextSet = () => ({ success: true });
  const manual = await bg.send({ type: 'SET_MOVIE_MODE', movieMode: true });
  assert.equal(manual.success, false);
  assert.equal(snap(bg).override, null);
  assert.equal(snap(bg).effective, false);
  bg.engine.nextSet = () => null;
  bg.videoByTab.set(7, { state: 'video', videoWidth: 320, videoHeight: 180 });
  await bg.sandbox.pollCapturedTabVideo();
  assert.equal(snap(bg).detected, true);
  assert.equal(snap(bg).effective, false);
  assert.equal(snap(bg).override, null);
  bg.engine.nextSet = () => ({});
  await bg.sandbox.pollCapturedTabVideo();
  assert.equal(snap(bg).effective, false);
});

test('background: wake recovery with no UI restores the tab, reconciles the engine, and restarts the watcher', async () => {
  const bg = loadBackground();
  await bg.ready();
  assert.equal(bg.state().capturedTabId, null);
  bg.local.capturedTabId = 5;
  bg.local.isAudioCapturing = true;
  bg.session.movieState = { captureSessionId: 12345, tabId: 5, effective: false, override: true, detected: false, audioStreak: 0 };
  bg.tabs.push({ id: 5, url: 'https://example.com/video', title: 'Video', active: true, audible: true, windowId: 1 });
  bg.videoByTab.set(5, { state: 'unknown' });
  bg.setOffscreen(true);
  bg.engine.capturing = true;
  bg.engine.movieMode = false;
  bg.sandbox.__resetHydration();
  await bg.sandbox.recoverCaptureSessionOnWake();
  assert.equal(bg.state().capturedTabId, 5);
  assert.equal(snap(bg).override, true);
  assert.equal(snap(bg).tabId, 5);
  assert.equal(snap(bg).effective, true);
  assert.notEqual(bg.state().movieWatchTimer, null);
  assert.deepEqual(bg.engine.sets.map((m) => m.movieMode), [true]);
  const state = await bg.send({ type: 'GET_STATE' });
  assert.equal(state.isCapturing, true);
  assert.equal(state.movieMode, true);
  assert.equal(state.movieOverride, true);
  assert.equal(state.movieModeSource, 'manual');
});

test('background: Stop during the startup storage writes does not leave capture on', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.holdNextSessionSet();
  const pending = bg.send({ type: 'START_CAPTURE_FOR_TAB', tabId: 7 });
  await until(() => bg.sessionSetHolds.length === 1, 'session save');
  const stopped = await bg.send({ type: 'STOP_CAPTURE' });
  assert.equal(stopped.success, true);
  bg.sessionSetHolds.shift()();
  const res = await pending;
  assert.equal(res.success, false);
  assert.match(res.error, /Capture stopped during startup/);
  assert.equal(bg.local.isAudioCapturing, false);
  assert.equal(bg.local.capturedTabId, null);
  assert.equal(bg.state().capturedTabId, null);
  assert.equal(bg.state().movieWatchTimer, null);
  assert.equal(snap(bg).captureSessionId, 0);
  assert.equal(bg.engine.broadcasts.some((m) => m && m.type === 'AUDIO_STATE_CHANGED' && m.isCapturing === true), false);
});

test('background: Stop during wake recovery does not resurrect the session', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.local.capturedTabId = 5;
  bg.local.isAudioCapturing = true;
  bg.session.movieState = { captureSessionId: 12345, tabId: 5, effective: true, override: null, detected: true, audioStreak: 0 };
  bg.tabs.push({ id: 5, url: 'https://example.com/video', title: 'Video', active: true, audible: true, windowId: 1 });
  bg.setOffscreen(true);
  bg.engine.capturing = true;
  bg.engine.movieMode = true;
  bg.engine.holdStatusAfter = 2;
  bg.sandbox.__resetHydration();
  const pending = bg.sandbox.recoverCaptureSessionOnWake();
  await until(() => bg.statusHolds.length === 1, 'wake status');
  const stopped = await bg.send({ type: 'STOP_CAPTURE' });
  assert.equal(stopped.success, true);
  assert.equal(snap(bg).captureSessionId, 0);
  bg.statusHolds.shift()();
  await pending;
  assert.equal(snap(bg).captureSessionId, 0);
  assert.equal(bg.state().movieWatchTimer, null);
  assert.equal(bg.state().capturedTabId, null);
});

test('background: Stop during a wake save cannot leave the recovered session for the next wake', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.local.capturedTabId = 5;
  bg.local.isAudioCapturing = true;
  bg.session.movieState = { captureSessionId: 12345, tabId: 5, effective: true, override: true, detected: false, audioStreak: 0 };
  bg.tabs.push({ id: 5, url: 'https://example.com/video', title: 'Video', active: true, audible: true, windowId: 1 });
  bg.setOffscreen(true);
  bg.engine.capturing = true;
  bg.engine.movieMode = true;
  bg.sandbox.__resetHydration();
  bg.holdNextSessionSet();
  const pending = bg.sandbox.recoverCaptureSessionOnWake();
  await until(() => bg.sessionSetHolds.length === 1, 'wake save');
  const stopped = await bg.send({ type: 'STOP_CAPTURE' });
  assert.equal(stopped.success, true);
  assert.equal(stopped.movieMode, false);
  assert.equal(stopped.movieOverride, null);
  assert.equal(bg.session.movieState.captureSessionId, 0);
  bg.sessionSetHolds.shift()();
  await pending;
  assert.equal(bg.session.movieState.captureSessionId, 0);
  assert.equal(bg.session.movieState.override, null);
  assert.equal(bg.session.movieState.effective, false);
  bg.sandbox.__resetHydration({ captureSessionId: 999, tabId: 5, effective: true, override: true, detected: true, audioStreak: 4 });
  const state = await bg.send({ type: 'GET_STATE' });
  assert.equal(state.isCapturing, false);
  assert.equal(state.movieMode, false);
  assert.equal(state.movieOverride, null);
  assert.equal(state.movieModeSource, 'auto');
  assert.equal(bg.session.movieState.captureSessionId, 0);
});

// ---------- content.js ----------

function loadContent() {
  const timers = fakeTimers();
  const hints = [];
  const styles = new Map();
  const listeners = [];
  const observers = [];
  let onMessage = null;
  function nodeInRoot(root, node) {
    let cur = node;
    while (cur) {
      if (cur === root) return true;
      cur = cur.parentElement || null;
    }
    return false;
  }
  function notifyStyle(el) {
    const rec = { type: 'attributes', attributeName: 'style', target: el, addedNodes: [], removedNodes: [] };
    for (const obs of observers) {
      if (obs.observing.some((o) => nodeInRoot(o.root, el))) obs.fn([rec]);
    }
  }
  function makeEl(tag, props = {}) {
    const el = {
      tagName: tag.toUpperCase(), nodeType: 1, isConnected: true, parentElement: null, children: [],
      shadowRoot: null, src: '', currentSrc: '', srcObject: null, videoWidth: 0, videoHeight: 0,
      readyState: 0, muted: false, loop: false, controls: false, duration: NaN, paused: true, ended: false,
      volume: 1, playbackRate: 1, rect: { width: 200, height: 120, top: 0, left: 0, right: 200, bottom: 120 },
      querySelector(sel) { const found = this.querySelectorAll(sel); return found[0] || null; },
      querySelectorAll(sel) { return queryAll(this, sel); },
      getBoundingClientRect() { return this.rect; },
      getRootNode() { return this._root || document; },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    };
    const styleBag = {};
    Object.defineProperty(el, 'style', {
      configurable: true,
      enumerable: true,
      value: new Proxy(styleBag, {
        get: (target, prop) => target[prop],
        set(target, prop, value) {
          target[prop] = value;
          if (prop === 'display' || prop === 'visibility' || prop === 'opacity') {
            const prev = styles.get(el) || { display: 'block', visibility: 'visible', opacity: '1' };
            styles.set(el, Object.assign({}, prev, { [prop]: String(value) }));
          }
          notifyStyle(el);
          return true;
        }
      })
    });
    Object.assign(el, props);
    return el;
  }
  function queryAll(root, sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children || []) {
        const tag = (c.tagName || '').toLowerCase();
        if (sel === '*' || sel === tag) out.push(c);
        if (sel === 'source[src]' && tag === 'source' && c.src) out.push(c);
        walk(c);
        if (c.shadowRoot) walk(c.shadowRoot);
      }
    };
    walk(root);
    return out;
  }
  const document = {
    title: 'Fixture', pictureInPictureElement: null, fullscreenElement: null, children: [],
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    querySelector(sel) { return queryAll(document.documentElement, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(document.documentElement, sel); }
  };
  document.documentElement = makeEl('html');
  document.body = makeEl('body');
  document.documentElement.appendChild(document.body);
  document.documentElement._root = document;
  document.body._root = document;
  const sandbox = {
    console, Math, Number, Object, Array, Error, String, Boolean, Promise, isFinite, WeakSet,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    document, window: null, location: { hostname: 'example.test', href: 'http://example.test/page' },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.observing = []; observers.push(this); }
      observe(root, options) { this.observing.push({ root, options }); }
      disconnect() { this.observing = []; }
    },
    getComputedStyle: (el) => styles.get(el) || { display: 'block', visibility: 'visible', opacity: '1' },
    chrome: { runtime: { onMessage: { addListener(fn) { onMessage = fn; } }, sendMessage(msg) { hints.push(msg); return Promise.resolve(); }, lastError: null } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('content.js'), sandbox, { filename: 'content.js' });
  function ask() {
    let res;
    const ret = onMessage({ type: 'GET_VIDEO_STATE' }, {}, (r) => { res = r; });
    assert.equal(ret, true);
    return res;
  }
  function reset() {
    document.body.children = [];
    document.pictureInPictureElement = null;
    document.fullscreenElement = null;
    styles.clear();
  }
  function add(parent, tag, props) {
    const el = makeEl(tag, props);
    el._root = parent && parent._root && parent._root !== document ? parent._root : (parent && parent.host ? parent : document);
    parent.appendChild(el);
    return el;
  }
  return { sandbox, document, styles, listeners, hints, timers, observers, ask, reset, add, makeEl };
}

test('content: audio-only pages, a silent video file, and hidden video are audio', () => {
  const page = loadContent();
  page.add(page.document.body, 'audio', { paused: false, src: '/tone.wav' });
  assert.equal(page.ask().state, 'audio');
  page.reset();
  page.add(page.document.body, 'video', { src: '/tone.wav', readyState: 1, videoWidth: 0, videoHeight: 0, rect: { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 } });
  assert.deepEqual(JSON.parse(JSON.stringify(page.ask())), { state: 'audio', videoWidth: 0, videoHeight: 0 });
  page.reset();
  const fs = page.add(page.document.body, 'video', { src: '/clip.mp4', readyState: 2, videoWidth: 0, videoHeight: 0, rect: { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 } });
  page.document.fullscreenElement = fs;
  assert.equal(page.ask().state, 'audio');
  page.document.fullscreenElement = null;
  const wrap = page.add(page.document.body, 'div');
  page.styles.set(wrap, { display: 'block', visibility: 'visible', opacity: '0' });
  page.add(wrap, 'video', { src: '/clip.mp4', readyState: 4, videoWidth: 1280, videoHeight: 720, rect: { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 } });
  assert.equal(page.ask().state, 'audio');
  page.reset();
  const hidden = page.add(page.document.body, 'div');
  page.styles.set(hidden, { display: 'none', visibility: 'visible', opacity: '1' });
  page.add(hidden, 'video', { src: '/clip.mp4', readyState: 4, videoWidth: 320, videoHeight: 180, rect: { width: 320, height: 180, top: 0, left: 0, right: 320, bottom: 180 } });
  assert.equal(page.ask().state, 'audio');
  page.reset();
  const vis = page.add(page.document.body, 'div');
  page.styles.set(vis, { display: 'block', visibility: 'hidden', opacity: '1' });
  page.add(vis, 'video', { src: '/clip.mp4', readyState: 4, videoWidth: 320, videoHeight: 180, rect: { width: 320, height: 180, top: 0, left: 0, right: 320, bottom: 180 } });
  assert.equal(page.ask().state, 'audio');
});

test('content: a visible, paused, or picture-in-picture video counts, and an unloaded one is unknown', () => {
  const page = loadContent();
  page.add(page.document.body, 'video', { src: '/clip.mp4', readyState: 4, paused: true, videoWidth: 640, videoHeight: 360, rect: { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 } });
  assert.deepEqual(JSON.parse(JSON.stringify(page.ask())), { state: 'video', videoWidth: 640, videoHeight: 360 });
  page.reset();
  const pip = page.makeEl('video', { src: '/clip.mp4', readyState: 4, videoWidth: 320, videoHeight: 180, rect: { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 } });
  page.document.pictureInPictureElement = pip;
  assert.deepEqual(JSON.parse(JSON.stringify(page.ask())), { state: 'video', videoWidth: 320, videoHeight: 180 });
  page.reset();
  page.add(page.document.body, 'video', { src: '/clip.mp4', readyState: 0, videoWidth: 0, videoHeight: 0, rect: { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 } });
  assert.deepEqual(JSON.parse(JSON.stringify(page.ask())), { state: 'unknown', videoWidth: 0, videoHeight: 0 });
  page.reset();
  const loading = page.add(page.document.body, 'video', { src: '/clip.mp4', readyState: 0, videoWidth: 0, videoHeight: 0 });
  page.document.fullscreenElement = loading;
  assert.equal(page.ask().state, 'unknown');
  const hintListeners = page.listeners.filter((l) => l.type === 'loadedmetadata' && l.opts && l.opts.capture === true && l.opts.passive === true);
  assert.equal(hintListeners.length, 1);
});

test('content: hiding an ancestor and a change inside an open shadow root both push an audio hint', () => {
  const visible = { src: '/clip.mp4', readyState: 4, videoWidth: 640, videoHeight: 360, rect: { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 } };
  {
    const page = loadContent();
    const obs = page.observers[0];
    assert.ok(obs, 'no video observer');
    const doc = obs.observing.find((o) => o.root === page.document.documentElement);
    assert.ok(doc);
    assert.equal(doc.options.subtree, true);
    assert.equal(doc.options.childList, true);
    assert.equal(doc.options.attributes, true);
    assert.equal([].map.call(doc.options.attributeFilter, String).join(','), 'style,class,hidden,src');
    const wrap = page.add(page.document.body, 'div');
    page.add(wrap, 'video', visible);
    assert.equal(page.ask().state, 'video');
    wrap.style.display = 'none';
    page.timers.fire();
    const hint = page.hints.at(-1);
    assert.equal(hint && hint.type, 'VIDEO_STATE_HINT');
    assert.equal(hint.state, 'audio');
  }
  {
    const page = loadContent();
    const host = page.add(page.document.body, 'div');
    const shadow = page.makeEl('div');
    shadow.host = host;
    shadow._root = shadow;
    shadow.parentElement = null;
    host.shadowRoot = shadow;
    page.add(shadow, 'video', visible);
    assert.equal(page.ask().state, 'video');
    const obs = page.observers[0];
    assert.ok(obs.observing.some((o) => o.root === shadow), 'open shadow root was not observed');
    shadow.children[0].style.display = 'none';
    page.timers.fire();
    const hint = page.hints.at(-1);
    assert.equal(hint && hint.type, 'VIDEO_STATE_HINT');
    assert.equal(hint.state, 'audio');
  }
});
