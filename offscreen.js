// offscreen.js - Web Audio DSP Pipeline & Tab Audio Routing Engine

let audioCtx = null;
let currentStream = null;
let sourceNode = null;
let isCapturing = false;

// Movie mode (1.5.5, L-01; 1.5.6, L-02): 'interactive' shortens the device buffer for video and locks Pitch off. Audio-only stays on 'playback'.
let currentMovieMode = false;
let captureGen = 0; // bumped synchronously at the public entry of start, stop and each real rebuild, before the engine queue, so a queued start cannot run after Stop
let engineQueue = Promise.resolve();

function enqueueEngine(fn) {
  const run = engineQueue.then(fn, fn);
  engineQueue = run.then(() => {}, () => {});
  return run;
}

// The literal 'playback' call stays in this function: tests/unit/clicks.test.mjs matches it.
function makeAudioContext(movieMode) {
  const ctx = movieMode
    ? new AudioContext({ latencyHint: 'interactive' })
    : new AudioContext({ latencyHint: 'playback' });
  // Chrome does not echo the constructor option. Remember it on this context so a later read
  // can tell the short video buffer from the large music buffer. A real getter is left alone.
  if (ctx.latencyHint == null) {
    try { ctx.latencyHint = movieMode ? 'interactive' : 'playback'; } catch (_) {}
  }
  return ctx;
}

function latencyFields(extra) {
  return Object.assign({
    movieMode: currentMovieMode,
    latencyHint: currentMovieMode ? 'interactive' : 'playback',
    baseLatency: audioCtx ? audioCtx.baseLatency : null,
    pitchLockedByMovie: !!currentMovieMode,
    effectivePitch: pitchTarget(currentMovieMode),
    effectivePitchBypassed: Boolean(currentMovieMode || bypassState().pitch),
    effectiveSemitones: currentMovieMode ? 0 : currentParams.semitones
  }, extra || {});
}

// Audio DSP Nodes
let dspPathGain = null;
let directPassThroughGain = null;
let hpfNode = null;
let bassNode = null;
let midNode = null;
let highNode = null;
let autoBalanceComp = null;
let autoBalanceBypassGain = null;
let autoBalanceWetGain = null;
let volumeGain = null;
let masterLimiter = null;
let outputCeiling = null;

// Pitch (key shift, 1.4.0): a worklet stage at the head of the DSP path, routed around unless a shift is set.
const PITCH_WORKLET = 'pitch-shifter.worklet.js';
let pitchNode = null;
let pitchDryGain = null;
let pitchWetGain = null;
let pitchError = null; // set if the worklet could not be loaded; the EQ still runs, pitch has no effect
let pitchPrimed = false; // the shifter reports when it is producing audio; its path opens only then (1.5.2)
let pitchHoldUntil = 0;  // after the shifter ran dry, the unshifted path stays open at least 0.5 s (no flapping)
let pitchHoldTimer = null;


// Dynamics alternatives (1.5.0, decision D-01): switchable stages beside the 1.4.0 ones. The defaults route exactly
// as 1.4.0 did; every alternative is a parallel path opened by a gain, so the default sound is unchanged (W-DYN-BASELINE).
const DYN_WORKLET = 'dynamics.worklet.js';
const DEFAULT_DYNAMICS = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean', room: 'off' };
let currentDynamics = { ...DEFAULT_DYNAMICS };
let dynError = null;                                       // set if the worklet module could not be loaded
let levelerOut = null;                                     // the sum of whichever leveler path is open
let bandLevelerNode = null, bandLevelerGain = null;        // AUTO "Bass only"
let matchNode = null, matchDryGain = null, matchWetGain = null; // MATCH (loudness match)
let limiterFastGain = null, lookaheadNode = null, lookaheadGain = null, limiterOut = null; // LIM
let warmPreGain = null, warmShaper = null, ceilingCleanGain = null, ceilingWarmGain = null, outputSum = null; // CEIL
let ceilingTap = null, ceilingBuf = null;                  // meter: what the ceiling is being asked to bend
const dynMeters = { band: 0, trim: 0, lookahead: 0, peaks: 0, truepeak: 0, unmud: 0 }; // last figures posted by the worklets
let dynMake = null;
let unmudNode = null, centreNode = null, bassPeaksNode = null, truePeakNode = null;
const br = emptyBass();

// Live display taps: what the tab sends (before the chain) and what you hear (after the ceiling).
let inputAnalyser = null;
let outputAnalyser = null;
let frameBuf = null;
const FRAME_POINTS = 72; // log-spaced 20 Hz .. 20 kHz

// Final safety ceiling after the limiter. DynamicsCompressorNode can overshoot on fast peaks
// (measured +0.2 dBFS at extreme settings), so samples above CEILING_KNEE are bent smoothly
// toward CEILING_MAX (-0.3 dBFS). Below the knee the curve is exact identity (no coloration).
const CEILING_KNEE = 0.93;
const CEILING_MAX = 0.966; // -0.3 dBFS

function makeCeilingCurve(points = 8193) {
  const curve = new Float32Array(points);
  const span = CEILING_MAX - CEILING_KNEE;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= CEILING_KNEE ? ax : CEILING_KNEE + span * Math.tanh((ax - CEILING_KNEE) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

// The warm ceiling (CEIL "Warm"): a soft clip, y = MAX * tanh(x / MAX), unity slope at zero, never above MAX. A gain
// of 0.5 in front of it and a doubled curve domain let it shape inputs up to +6 dBFS instead of clamping above 0 dBFS.
function makeWarmCurve(points = 8193) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = CEILING_MAX * Math.tanh(2 * x / CEILING_MAX);
  }
  return curve;
}
const ceilingCleanOf = (ax) => ax <= CEILING_KNEE ? ax : CEILING_KNEE + (CEILING_MAX - CEILING_KNEE) * Math.tanh((Math.min(ax, 1) - CEILING_KNEE) / (CEILING_MAX - CEILING_KNEE));
const ceilingWarmOf = (ax) => CEILING_MAX * Math.tanh(Math.min(ax, 2) / CEILING_MAX);

function normaliseDynamics(d) {
  const x = d || {};
  return {
    leveler: ['full', 'slow', 'bass', 'peaks'].includes(x.leveler) ? x.leveler : 'full',
    match: x.match === true,
    limiter: ['fast', 'lookahead', 'truepeak'].includes(x.limiter) ? x.limiter : 'fast',
    ceiling: ['clean', 'warm'].includes(x.ceiling) ? x.ceiling : 'clean',
    room: ['off', 'unmud', 'centre', 'both'].includes(x.room) ? x.room : 'off'
  };
}

// Legacy modes retain their original fallback. A failed new stage latches a visible output mute until restart.
// Bass peaks runs only while AUTO is on; the menu value is still reported. Room does not depend on AUTO.
function effectiveDynamics() {
  const d = normaliseDynamics(currentDynamics);
  if (br.fatal) return { ...d, match: d.match && !!matchNode };
  let leveler = d.leveler;
  let limiter = d.limiter;
  let room = d.room;
  // A null node before capture is "not created yet", not a failure. Sticky dynError only once capture
  // is up, or once a bass-room create was attempted and failed (peaksFailed / tpFailed / roomFailed).
  if (leveler === 'bass' && !bandLevelerNode) {
    leveler = 'full';
    if (isCapturing && !dynError) dynError = 'Bass only could not be loaded; Full band is in use.';
  }
  if (leveler === 'peaks' && br.peaksFailed) {
    leveler = 'full';
    if (!dynError) dynError = 'Bass peaks could not be loaded; Full band is in use.';
  }
  if (limiter === 'lookahead' && !lookaheadNode) {
    limiter = 'fast';
    if (isCapturing && !dynError) dynError = 'Look-ahead could not be loaded; Fast is in use.';
  }
  if (limiter === 'truepeak' && br.tpFailed) {
    limiter = lookaheadNode ? 'lookahead' : 'fast';
    if (!dynError) dynError = lookaheadNode
      ? 'True peak could not be loaded; Look-ahead is in use.'
      : 'True peak could not be loaded; Fast is in use.';
  }
  if (room !== 'off' && br.roomFailed) {
    room = 'off';
    if (!dynError) dynError = 'Room could not be loaded; Room stays off.';
  }
  return {
    leveler,
    match: d.match === true && !!matchNode,
    limiter,
    ceiling: d.ceiling,
    room
  };
}

let currentParams = {
  bass: 5.0,
  hpf: 30,
  mid: 1.5,
  high: 2.0,
  gain: 1.0,
  semitones: 0,
  autoBalance: true,
  bypass: false,
  stageBypass: {
    hpf: false,
    bass: false,
    mid: false,
    high: false,
    comp: false,
    gain: false,
    pitch: false
  }
};

// Which stages are switched off. `eq` is the pre-1.3 flag for the whole 3-band EQ and is still honoured.
function bypassState() {
  const b = currentParams.stageBypass || {};
  return {
    hpf: !!b.hpf,
    bass: !!(b.bass || b.eq),
    mid: !!(b.mid || b.eq),
    high: !!(b.high || b.eq),
    comp: !!b.comp || !currentParams.autoBalance,
    gain: !!b.gain,
    pitch: !!(b.pitch || b.speed) // `speed` is the pre-1.4 name of this switch
  };
}

// The shift the worklet should apply: 0 when the stage is switched off. Legacy `pitch` (a speed ratio) is ignored.
function pitchSetting() {
  const st = Number(currentParams.semitones);
  return bypassState().pitch || !isFinite(st) ? 0 : Math.max(-12, Math.min(12, st));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_AUDIO_CAPTURE':
    case 'START_CAPTURE':
      // Popup talks to the service worker. An untargeted start must not be answered here,
      // or this document wins the race and the worker never commits Movie mode.
      if (message.target !== 'offscreen') return false;
      startCapture(message.streamId, message.params, message.dynamics, message.movieMode)
        .then(res => sendResponse(res))
        .catch(err => sendResponse(latencyFields({ success: false, error: err.message })));
      return true;

    case 'SET_ENGINE_MOVIE_MODE':
      if (message.target !== 'offscreen') return false;
      setMovieMode(message.movieMode)
        .then(res => sendResponse(res))
        .catch(err => sendResponse(latencyFields({ success: false, error: err.message })));
      return true;

    case 'STOP_AUDIO_CAPTURE':
    case 'STOP_CAPTURE':
      // Same race as start: the popup's STOP_CAPTURE has no target, and the worker is the
      // one that returns movieMode / movieOverride. The worker then sends a targeted stop.
      if (message.target !== 'offscreen') return false;
      stopCapture();
      sendResponse({ success: true });
      return true;

    case 'UPDATE_AUDIO_PARAMS':
    case 'UPDATE_PARAMS':
      updateParams(message.params);
      sendResponse(latencyFields({ success: true, currentParams }));
      return true;

    case 'APPLY_ENGINE_STATE':
      if (message.target !== 'offscreen') return false;
      currentDynamics = normaliseDynamics(message.dynamics);
      updateParams(message.params);
      sendResponse({ success: !br.fatal, error: dynError, dynamics: currentDynamics });
      return true;

    case 'SET_DYNAMICS':
      updateDynamics(message.dynamics);
      sendResponse({ success: !br.fatal, error: dynError, dynamics: currentDynamics });
      return true;

    case 'GET_AUDIO_STATUS':
      sendResponse(latencyFields({ isCapturing, currentParams, pitchAvailable: !!pitchNode, pitchError, dynamics: currentDynamics, dynAvailable: !dynError, dynError }));
      return true;

    case 'GET_AUDIO_FRAME':
      // One snapshot of both spectra, in dB (0 = full-scale sine), for the popup's live display.
      if (isCapturing && inputAnalyser && outputAnalyser && audioCtx) {
        sendResponse({ isCapturing: true, input: spectrumPoints(inputAnalyser), output: spectrumPoints(outputAnalyser), dyn: dynamicsFrame() });
      } else {
        sendResponse({ isCapturing: false });
      }
      return true;
  }
});

// Collapse an analyser's bins into FRAME_POINTS log-spaced points (max within each span).
function spectrumPoints(analyser) {
  const n = analyser.frequencyBinCount;
  if (!frameBuf || frameBuf.length !== n) frameBuf = new Float32Array(n);
  analyser.getFloatFrequencyData(frameBuf);
  const hz = audioCtx.sampleRate / analyser.fftSize;
  const out = new Array(FRAME_POINTS);
  for (let i = 0; i < FRAME_POINTS; i++) {
    const f0 = 20 * Math.pow(1000, i / FRAME_POINTS);
    const f1 = 20 * Math.pow(1000, (i + 1) / FRAME_POINTS);
    const b0 = Math.floor(f0 / hz);
    const b1 = Math.max(b0 + 1, Math.floor(f1 / hz));
    let m = -Infinity;
    for (let b = b0; b < b1 && b < n; b++) if (frameBuf[b] > m) m = frameBuf[b];
    out[i] = isFinite(m) ? Math.round(m * 10) / 10 : -120;
  }
  return out;
}

// What each dynamics stage is doing right now, for the meters: reductions in dB (0 = resting), the match trim signed.
function dynamicsFrame() {
  const dyn = effectiveDynamics();
  const compOff = bypassState().comp;
  const r1 = (v) => Math.round(v * 10) / 10;
  const leveler = compOff ? 0
    : dyn.leveler === 'bass' ? dynMeters.band
    : dyn.leveler === 'peaks' ? dynMeters.peaks
    : Math.max(0, -(autoBalanceComp ? autoBalanceComp.reduction : 0));
  const match = dyn.match ? dynMeters.trim : 0;
  const limiter = dyn.limiter === 'lookahead' ? dynMeters.lookahead
    : dyn.limiter === 'truepeak' ? dynMeters.truepeak
    : Math.max(0, -(masterLimiter ? masterLimiter.reduction : 0));
  const roomDip = (dyn.room === 'unmud' || dyn.room === 'both') ? dynMeters.unmud : 0;
  let ceiling = 0, peak = 0;
  if (ceilingTap) {
    if (!ceilingBuf || ceilingBuf.length !== ceilingTap.fftSize) ceilingBuf = new Float32Array(ceilingTap.fftSize);
    ceilingTap.getFloatTimeDomainData(ceilingBuf);
    for (let i = 0; i < ceilingBuf.length; i++) { const a = Math.abs(ceilingBuf[i]); if (a > peak) peak = a; }
    if (peak > 1e-6) {
      const y = dyn.ceiling === 'warm' ? ceilingWarmOf(peak) : ceilingCleanOf(peak);
      ceiling = Math.max(0, 20 * Math.log10(peak / y));
    }
  }
  return { modes: dyn, available: !dynError, error: dynError, leveler: r1(leveler), match: r1(match), limiter: r1(limiter), ceiling: r1(ceiling), room: r1(roomDip), roomMode: dyn.room, peakIn: Math.round(peak * 1000) / 1000 };
}

function startCapture(streamId, initialParams = {}, initialDynamics = null, movieMode) {
  // Take the generation before queueing. Stop during the wait then makes this attempt stale,
  // instead of the body minting a fresh generation and starting capture after Stop.
  if (isCapturing) cleanupCaptureState();
  const myGen = ++captureGen;
  return enqueueEngine(() => startCaptureBody(streamId, initialParams, initialDynamics, movieMode, myGen));
}

async function startCaptureBody(streamId, initialParams = {}, initialDynamics = null, movieMode, myGen) {
  let stream = null;
  try {
    if (myGen !== captureGen) {
      return latencyFields({ success: false, stale: true, error: 'Capture stopped while queued' });
    }

    Object.assign(currentParams, initialParams || {});
    if (initialDynamics) currentDynamics = normaliseDynamics(initialDynamics);

    const wantMovie = typeof movieMode === 'boolean' ? !!movieMode : !!currentMovieMode;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    // Stop, or a newer start, won while the stream id was turning into a stream. Do not keep it.
    if (myGen !== captureGen) {
      stream.getTracks().forEach((t) => t.stop());
      return latencyFields({ success: false, stale: true, error: 'Capture stopped or superseded during startup' });
    }
    currentStream = stream;

    // The track ends when the captured tab closes or Chrome revokes capture: release everything
    // and tell the service worker so every surface shows EQ as OFF.
    stream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        if (currentStream !== stream) return;
        stopCapture();
        chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED' }).catch(() => {});
      });
    });

    const g = await buildAudioGraph(stream, wantMovie, myGen);
    if (!g || g.stale || myGen !== captureGen) {
      if (g && g.abortCtx) g.abortCtx();
      if (currentStream === stream) {
        stream.getTracks().forEach((t) => t.stop());
        currentStream = null;
      }
      return latencyFields({ success: false, stale: true, error: 'Capture stopped or superseded during startup' });
    }
    if (g.error || !g.audioCtx) {
      if (currentStream === stream) {
        stream.getTracks().forEach((t) => t.stop());
        currentStream = null;
      }
      return latencyFields({ success: false, error: g.error || 'Could not build audio graph' });
    }

    installGraph(g);
    applyRoutingState({ immediate: true });
    directPassThroughGain.connect(audioCtx.destination);
    outputSum.connect(audioCtx.destination);
    isCapturing = true;
    currentMovieMode = !!wantMovie;
    return latencyFields({ success: true, isCapturing: true });
  } catch (err) {
    if (stream && currentStream === stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      currentStream = null;
    }
    if (isCapturing || currentStream) stopCapture();
    return latencyFields({ success: false, error: err.message });
  }
}

// Builds a complete DSP graph on a fresh context without touching the live globals or the destination.
// Routing gains are set on this local bundle before it is installed, so the first samples are not both paths at once.
async function buildAudioGraph(stream, movieMode, gen) {
  const ctx = makeAudioContext(!!movieMode);
  const abortCtx = () => { try { ctx.close().catch(() => {}); } catch (_) {} };
  const stale = () => gen !== captureGen || currentStream !== stream;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    if (stale()) { abortCtx(); return { stale: true }; }

    const sourceNodeLocal = ctx.createMediaStreamSource(stream);

    // Pitch stage (key shift). The module is loaded per context; if that fails the EQ runs without it.
    let builtPitch = null;
    let pitchErrorLocal = null;
    try {
      await ctx.audioWorklet.addModule(chrome.runtime.getURL(PITCH_WORKLET));
      if (stale()) { abortCtx(); return { stale: true }; }
      builtPitch = new AudioWorkletNode(ctx, 'pitch-shifter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
      });
      const node = builtPitch;
      node.port.onmessage = (e) => {
        if (pitchNode !== node || audioCtx !== ctx || typeof e.data?.primed !== 'boolean') return;
        if (!e.data.primed && pitchPrimed && pitchTarget(currentMovieMode) !== 0) pitchHoldUntil = audioCtx.currentTime + 0.5;
        pitchPrimed = e.data.primed;
        if (pitchPrimed) reopenAfterHold(node);
        applyRoutingState();
      };
    } catch (err) {
      pitchErrorLocal = err.message;
    }
    if (stale()) { abortCtx(); return { stale: true }; }

    // The alternative dynamics stages (D-01) come from one worklet module; without it the 1.4.0 stages stand alone.
    let dynErrorLocal = null;
    let dynReady = false;
    try {
      await ctx.audioWorklet.addModule(chrome.runtime.getURL(DYN_WORKLET));
      dynReady = true;
    } catch (err) {
      dynErrorLocal = err.message;
    }
    if (stale()) { abortCtx(); return { stale: true }; }

    const makeDyn = (name, numberOfInputs) => {
      try {
        const node = new AudioWorkletNode(ctx, name, { numberOfInputs, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => {
          if (audioCtx !== ctx) return;
          if (name === 'band-leveler' && bandLevelerNode !== node) return;
          if (name === 'lookahead-limiter' && lookaheadNode !== node) return;
          if (name === 'loudness-match' && matchNode !== node) return;
          if (name === 'unmud' && br.unmud !== node) return;
          if (name === 'centre-bass' && br.centre !== node) return;
          if (name === 'bass-peaks' && br.peaks !== node) return;
          if (name === 'true-peak' && br.truepeak !== node) return;
          const d = e.data || {};
          if (name === 'band-leveler' && typeof d.red === 'number') dynMeters.band = d.red;
          if (name === 'lookahead-limiter' && typeof d.red === 'number') dynMeters.lookahead = d.red;
          if (name === 'loudness-match' && typeof d.trim === 'number') dynMeters.trim = d.trim;
          if (name === 'unmud' && typeof d.dip === 'number') { dynMeters.unmud = d.dip; br.callbacks++; }
          if (name === 'bass-peaks' && typeof d.red === 'number') { dynMeters.peaks = d.red; br.callbacks++; }
          if (name === 'true-peak' && typeof d.red === 'number') { dynMeters.truepeak = d.red; br.callbacks++; }
        };
        return node;
      } catch (err) {
        dynErrorLocal = dynErrorLocal || err.message;
        return null;
      }
    };

    // Nodes are configured from the params and dynamics as they stand now, after the worklet loads.
    const pitchDryGain = ctx.createGain();
    const pitchWetGain = ctx.createGain();

    const directPassThroughGain = ctx.createGain();
    const dspPathGain = ctx.createGain();

    const hpfNode = ctx.createBiquadFilter();
    hpfNode.type = 'highpass';
    // After every await (including the dynamics worklet). A pitch change that arrived while that
    // module was loading has to be the value this graph is installed with; Movie mode forces 0.
    if (builtPitch) builtPitch.parameters.get('semitones').value = pitchTarget(!!movieMode);
    const off = bypassState();
    hpfNode.frequency.value = off.hpf ? 20 : currentParams.hpf;
    hpfNode.Q.value = 0.707; // Butterworth response

    const bassNode = ctx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 120;
    bassNode.gain.value = off.bass ? 0 : currentParams.bass;

    const midNode = ctx.createBiquadFilter();
    midNode.type = 'peaking';
    midNode.frequency.value = 1000;
    midNode.Q.value = 0.8;
    midNode.gain.value = off.mid ? 0 : currentParams.mid;

    const highNode = ctx.createBiquadFilter();
    highNode.type = 'highshelf';
    highNode.frequency.value = 5000;
    highNode.gain.value = off.high ? 0 : currentParams.high;

    const autoBalanceComp = ctx.createDynamicsCompressor();
    autoBalanceComp.threshold.value = -18;
    autoBalanceComp.knee.value = 20;
    autoBalanceComp.ratio.value = 3.5;
    autoBalanceComp.attack.value = 0.01;
    autoBalanceComp.release.value = 0.2;

    const autoBalanceBypassGain = ctx.createGain();
    const autoBalanceWetGain = ctx.createGain();

    const levelerOut = ctx.createGain();
    const bandLevelerGain = ctx.createGain();
    const builtBand = dynReady ? makeDyn('band-leveler', 1) : null;

    const matchDryGain = ctx.createGain();
    const matchWetGain = ctx.createGain();
    const builtMatch = dynReady ? makeDyn('loudness-match', 2) : null;

    const volumeGain = ctx.createGain();
    volumeGain.gain.value = off.gain ? 1.0 : currentParams.gain;

    const masterLimiter = ctx.createDynamicsCompressor();
    masterLimiter.threshold.value = -0.3; // -0.3 dBFS safety margin
    masterLimiter.knee.value = 0.0;
    masterLimiter.ratio.value = 20.0;
    masterLimiter.attack.value = 0.001;
    masterLimiter.release.value = 0.05;

    const limiterFastGain = ctx.createGain();
    const lookaheadGain = ctx.createGain();
    const limiterOut = ctx.createGain();
    const builtLookahead = dynReady ? makeDyn('lookahead-limiter', 1) : null;

    const outputCeiling = ctx.createWaveShaper();
    outputCeiling.curve = makeCeilingCurve();
    outputCeiling.oversample = 'none';

    const ceilingCleanGain = ctx.createGain();
    const ceilingWarmGain = ctx.createGain();
    const warmPreGain = ctx.createGain();
    warmPreGain.gain.value = 0.5;
    const warmShaper = ctx.createWaveShaper();
    warmShaper.curve = makeWarmCurve();
    warmShaper.oversample = '4x';
    const outputSum = ctx.createGain();
    const ceilingTap = ctx.createAnalyser();
    ceilingTap.fftSize = 4096;
    ceilingTap.smoothingTimeConstant = 0;

    const inputAnalyser = ctx.createAnalyser();
    inputAnalyser.fftSize = 8192;
    inputAnalyser.smoothingTimeConstant = 0.75;
    const outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 8192;
    outputAnalyser.smoothingTimeConstant = 0.75;

    const g = {
      audioCtx: ctx,
      sourceNode: sourceNodeLocal,
      pitchNode: builtPitch,
      pitchError: pitchErrorLocal,
      pitchPrimed: false,
      pitchHoldUntil: 0,
      pitchDryGain,
      pitchWetGain,
      dynError: dynErrorLocal,
      directPassThroughGain,
      dspPathGain,
      hpfNode,
      bassNode,
      midNode,
      highNode,
      autoBalanceComp,
      autoBalanceBypassGain,
      autoBalanceWetGain,
      volumeGain,
      masterLimiter,
      outputCeiling,
      levelerOut,
      bandLevelerGain,
      bandLevelerNode: builtBand,
      matchDryGain,
      matchWetGain,
      matchNode: builtMatch,
      limiterFastGain,
      lookaheadGain,
      limiterOut,
      lookaheadNode: builtLookahead,
      ceilingCleanGain,
      ceilingWarmGain,
      warmPreGain,
      warmShaper,
      outputSum,
      ceilingTap,
      inputAnalyser,
      outputAnalyser,
      movieMode: !!movieMode,
      abortCtx
    };

    // Local routing only. The global applyRoutingState() runs after these nodes are installed.
    applyRoutingToGraph(g, { immediate: true });
    if (stale()) { abortCtx(); return { stale: true }; }

    sourceNodeLocal.connect(directPassThroughGain);
    sourceNodeLocal.connect(dspPathGain);
    dspPathGain.connect(pitchDryGain);
    pitchDryGain.connect(hpfNode);
    if (builtPitch) {
      dspPathGain.connect(builtPitch);
      builtPitch.connect(pitchWetGain);
      pitchWetGain.connect(hpfNode);
    }
    hpfNode.connect(bassNode);
    bassNode.connect(midNode);
    midNode.connect(highNode);

    highNode.connect(autoBalanceComp);
    autoBalanceComp.connect(autoBalanceWetGain);
    autoBalanceWetGain.connect(levelerOut);

    highNode.connect(autoBalanceBypassGain);
    autoBalanceBypassGain.connect(levelerOut);

    if (builtBand) {
      highNode.connect(builtBand);
      builtBand.connect(bandLevelerGain);
      bandLevelerGain.connect(levelerOut);
    }

    levelerOut.connect(matchDryGain);
    matchDryGain.connect(volumeGain);
    if (builtMatch) {
      levelerOut.connect(builtMatch, 0, 0);
      pitchDryGain.connect(builtMatch, 0, 1);
      if (builtPitch) pitchWetGain.connect(builtMatch, 0, 1);
      builtMatch.connect(matchWetGain);
      matchWetGain.connect(volumeGain);
    }

    volumeGain.connect(masterLimiter);
    masterLimiter.connect(limiterFastGain);
    limiterFastGain.connect(limiterOut);
    if (builtLookahead) {
      volumeGain.connect(builtLookahead);
      builtLookahead.connect(lookaheadGain);
      lookaheadGain.connect(limiterOut);
    }

    limiterOut.connect(outputCeiling);
    outputCeiling.connect(ceilingCleanGain);
    ceilingCleanGain.connect(outputSum);
    limiterOut.connect(warmPreGain);
    warmPreGain.connect(warmShaper);
    warmShaper.connect(ceilingWarmGain);
    ceilingWarmGain.connect(outputSum);
    limiterOut.connect(ceilingTap);

    sourceNodeLocal.connect(inputAnalyser);
    outputSum.connect(outputAnalyser);

    // Bass-room stages are spliced only when selected. The connections above stay the 1.4.0 default.
    g.wired = true;
    g.live = false;
    g.makeDyn = makeDyn;
    g._br = emptyBass();
    applyRoutingToGraph(g, { immediate: true });
    return g;
  } catch (err) {
    abortCtx();
    if (stale()) return { stale: true };
    return { error: err.message || String(err) };
  }
}

function installGraph(g) {
  audioCtx = g.audioCtx;
  sourceNode = g.sourceNode;
  pitchNode = g.pitchNode;
  pitchError = g.pitchError;
  pitchPrimed = g.pitchPrimed;
  pitchHoldUntil = g.pitchHoldUntil;
  pitchDryGain = g.pitchDryGain;
  pitchWetGain = g.pitchWetGain;
  dynError = g.dynError;
  directPassThroughGain = g.directPassThroughGain;
  dspPathGain = g.dspPathGain;
  hpfNode = g.hpfNode;
  bassNode = g.bassNode;
  midNode = g.midNode;
  highNode = g.highNode;
  autoBalanceComp = g.autoBalanceComp;
  autoBalanceBypassGain = g.autoBalanceBypassGain;
  autoBalanceWetGain = g.autoBalanceWetGain;
  volumeGain = g.volumeGain;
  masterLimiter = g.masterLimiter;
  outputCeiling = g.outputCeiling;
  levelerOut = g.levelerOut;
  bandLevelerGain = g.bandLevelerGain;
  bandLevelerNode = g.bandLevelerNode;
  matchDryGain = g.matchDryGain;
  matchWetGain = g.matchWetGain;
  matchNode = g.matchNode;
  limiterFastGain = g.limiterFastGain;
  lookaheadGain = g.lookaheadGain;
  limiterOut = g.limiterOut;
  lookaheadNode = g.lookaheadNode;
  ceilingCleanGain = g.ceilingCleanGain;
  ceilingWarmGain = g.ceilingWarmGain;
  warmPreGain = g.warmPreGain;
  warmShaper = g.warmShaper;
  outputSum = g.outputSum;
  ceilingTap = g.ceilingTap;
  inputAnalyser = g.inputAnalyser;
  outputAnalyser = g.outputAnalyser;
  currentMovieMode = !!g.movieMode;
  dynMake = g.makeDyn || null;
  if (g._br) {
    const timers = br.timers;
    Object.assign(br, g._br);
    br.timers = timers;
    g._br = br;
  }
  unmudNode = br.unmud;
  centreNode = br.centre;
  bassPeaksNode = br.peaks;
  truePeakNode = br.truepeak;
}

function setMovieMode(requestedMode) {
  const want = !!requestedMode;
  let myGen = null;
  if (isCapturing && currentStream && currentStream.getAudioTracks().some((t) => t.readyState === 'live')) {
    const same = want === currentMovieMode && audioCtx && audioCtx.state === 'running';
    if (!same) myGen = ++captureGen;
  }
  return enqueueEngine(() => setMovieModeBody(requestedMode, myGen));
}

async function setMovieModeBody(requestedMode, myGen) {
  if (myGen !== null && myGen !== captureGen) {
    return latencyFields({ success: false, stale: true, error: 'Capture stopped while queued' });
  }
  const want = !!requestedMode;
  if (!isCapturing || !currentStream) {
    currentMovieMode = want;
    return latencyFields({ success: true, isCapturing: false, baseLatency: null });
  }
  if (!currentStream.getAudioTracks().some((t) => t.readyState === 'live')) {
    return latencyFields({ success: false, error: 'Capture stream is not active' });
  }
  if (want === currentMovieMode && audioCtx && audioCtx.state === 'running') {
    return latencyFields({ success: true, isCapturing: true });
  }

  const gen = myGen !== null ? myGen : ++captureGen;
  const stream = currentStream;
  let g;
  try {
    g = await buildAudioGraph(stream, want, gen);
  } catch (err) {
    return latencyFields({ success: false, error: err.message });
  }
  if (!g || g.stale || gen !== captureGen || currentStream !== stream) {
    if (g && g.abortCtx) g.abortCtx();
    return latencyFields({ success: false, stale: true });
  }
  if (g.error || !g.audioCtx) {
    return latencyFields({ success: false, error: g.error || 'Could not build audio graph' });
  }
  if (g.audioCtx.state !== 'running') {
    try { await g.audioCtx.resume(); }
    catch (err) {
      if (g.abortCtx) g.abortCtx();
      return latencyFields({ success: false, error: err.message });
    }
    if (gen !== captureGen || currentStream !== stream) {
      if (g.abortCtx) g.abortCtx();
      return latencyFields({ success: false, stale: true });
    }
  }

  const oldCtx = audioCtx;
  const oldSource = sourceNode;
  const oldPitch = pitchNode;
  const oldBand = bandLevelerNode;
  const oldMatch = matchNode;
  const oldLa = lookaheadNode;
  const oldBass = [br.unmud, br.centre, br.peaks, br.truepeak];
  for (const n of [oldPitch, oldBand, oldMatch, oldLa, ...oldBass]) if (n && n.port) n.port.onmessage = null;
  clearTimeout(pitchHoldTimer);
  pitchHoldTimer = null;
  pitchPrimed = false;
  pitchHoldUntil = 0;
  dynMeters.band = dynMeters.trim = dynMeters.lookahead = dynMeters.peaks = dynMeters.truepeak = dynMeters.unmud = 0;
  releaseBassRoom();

  installGraph(g);
  currentMovieMode = want;
  applyRoutingState({ immediate: true });
  outputSum.connect(audioCtx.destination);
  directPassThroughGain.connect(audioCtx.destination);
  try { if (oldSource) oldSource.disconnect(); } catch (_) {}
  if (oldCtx && oldCtx !== audioCtx) oldCtx.close().catch(() => {});
  return latencyFields({ success: true, isCapturing: true });
}

function cleanupCaptureState() {
  for (const n of [pitchNode, bandLevelerNode, matchNode, lookaheadNode, br.unmud, br.centre, br.peaks, br.truepeak]) {
    if (n && n.port) n.port.onmessage = null;
  }
  releaseBassRoom();
  clearTimeout(pitchHoldTimer);
  pitchHoldTimer = null;
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  isCapturing = false;
  sourceNode = null;
  pitchNode = null;
  pitchPrimed = false;
  pitchHoldUntil = 0;
  pitchDryGain = null;
  pitchWetGain = null;
  inputAnalyser = null;
  outputAnalyser = null;
  levelerOut = bandLevelerNode = bandLevelerGain = null;
  matchNode = matchDryGain = matchWetGain = null;
  limiterFastGain = lookaheadNode = lookaheadGain = limiterOut = null;
  warmPreGain = warmShaper = ceilingCleanGain = ceilingWarmGain = outputSum = null;
  ceilingTap = null;
  dynMeters.band = dynMeters.trim = dynMeters.lookahead = dynMeters.peaks = dynMeters.truepeak = dynMeters.unmud = 0;
}

function stopCapture() {
  captureGen++;
  cleanupCaptureState();
}


function updateDynamics(d) {
  currentDynamics = normaliseDynamics({ ...currentDynamics, ...(d || {}) });
  if (!audioCtx || audioCtx.state === 'closed') return;
  applyRoutingState();
}

function updateParams(newParams) {
  if (!newParams) return;
  Object.assign(currentParams, newParams);

  if (!audioCtx || audioCtx.state === 'closed') return;

  const now = audioCtx.currentTime;
  const rampTime = 0.03; // 30ms smooth crossfade to eliminate pops
  const off = bypassState();

  if (hpfNode) hpfNode.frequency.setTargetAtTime(off.hpf ? 20 : (currentParams.hpf || 30), now, rampTime);
  if (bassNode) bassNode.gain.setTargetAtTime(off.bass ? 0 : (currentParams.bass || 0), now, rampTime);
  if (midNode) midNode.gain.setTargetAtTime(off.mid ? 0 : (currentParams.mid || 0), now, rampTime);
  if (highNode) highNode.gain.setTargetAtTime(off.high ? 0 : (currentParams.high || 0), now, rampTime);
  if (volumeGain) volumeGain.gain.setTargetAtTime(off.gain ? 1.0 : (currentParams.gain || 1.0), now, rampTime);
  if (pitchNode) schedulePitch(now, rampTime);

  applyRoutingState();
}

// Bass room (1.6.0, D-09). New stages are created when selected and removed when off.
// The fresh default start never inserts them. Fades are 40 ms complementary linear ramps;
// a temporary delay is removed with a 10 ms dip down and a 20 ms fade up.
const BASS_FADE = 0.04;
const BASS_DIP_DOWN = 0.01;
const BASS_DIP_UP = 0.02;

function emptyBass() {
  return {
    gen: 0, timers: [], retirement: { retired: 0, pending: 0, acked: 0, timedOut: 0 }, key: '', phase: 'idle', pending: null, ctx: null, graph: null, fatal: false, closed: false,
    unmud: null, centre: null, peaks: null, truepeak: null,
    roomDry: null, roomWet: null, peaksDry: null, peaksWet: null, tpGain: null, preLim: null,
    pad: { clean: null, warm: null, band: null, bypass: null, peaksDry: null, lookahead: null, fast: null, truepeak: null },
    roomSpliced: false, postSpliced: false, split: false,
    appliedCeiling: 'clean', appliedRoom: 'off', appliedPeaks: false, appliedLimiter: 'fast', appliedLeveler: 'full',
    peaksFailed: false, tpFailed: false, roomFailed: false, callbacks: 0
  };
}

function bassWant(g, slot) {
  const d = normaliseDynamics(currentDynamics);
  const compOff = bypassState().comp;
  const s = slot || br;
  const peaks = !compOff && d.leveler === 'peaks' && !s.peaksFailed;
  const truepeak = d.limiter === 'truepeak' && !s.tpFailed;
  let limiter = d.limiter;
  if (limiter === 'truepeak' && !truepeak) limiter = g && g.lookaheadNode ? 'lookahead' : 'fast';
  if (limiter === 'lookahead' && !(g && g.lookaheadNode)) limiter = 'fast';
  let leveler = compOff ? 'bypass' : d.leveler;
  if (leveler === 'bass' && !(g && g.bandLevelerNode)) leveler = 'full';
  if (leveler === 'peaks' && !peaks) leveler = compOff ? 'bypass' : 'full';
  const room = s.roomFailed ? 'off' : d.room;
  return { room, peaks, truepeak, limiter, leveler, compOff, ceiling: d.ceiling };
}

function wantKey(w) { return [w.room, w.peaks, w.truepeak, w.leveler, w.limiter, w.ceiling].join('|'); }

function heldGain(p, now) {
  if (!p) return 0;
  const f = p._brFade;
  if (!f || !(f.dur > 0)) return +p.value || 0;
  const t = Math.max(0, Math.min(1, ((now || 0) - f.start) / f.dur));
  return f.from + (f.to - f.from) * t;
}

function rampGain(node, to, dur, ctx) {
  if (!node || !node.gain) return;
  const p = node.gain;
  const now = ctx && typeof ctx.currentTime === 'number' ? ctx.currentTime : 0;
  if (!ctx || !(dur > 0) || typeof p.linearRampToValueAtTime !== 'function' || typeof p.setValueAtTime !== 'function') {
    try { if (p.cancelScheduledValues) p.cancelScheduledValues(now); } catch (_) {}
    p.value = to;
    p._brFade = null;
    return;
  }
  const from = heldGain(p, now);
  try { p.cancelScheduledValues(now); } catch (_) {}
  p.setValueAtTime(from, now);
  p.linearRampToValueAtTime(to, now + dur);
  p._brFade = { from, to, start: now, dur };
}

function rampLeveler(g, tgt, dur, ctx) {
  let wet = tgt.wet, bypass = tgt.bypass, band = tgt.band;
  const sum = wet + bypass + band;
  if (sum > 1.000001) { const s = 1 / sum; wet *= s; bypass *= s; band *= s; }
  rampGain(g.autoBalanceWetGain, wet, dur, ctx);
  rampGain(g.autoBalanceBypassGain, bypass, dur, ctx);
  rampGain(g.bandLevelerGain, band, dur, ctx);
}

function levelerTarget(want) {
  if (want.leveler === 'bass') return { wet: 0, bypass: 0, band: 1 };
  if (want.leveler === 'peaks' || want.leveler === 'bypass' || want.peaks) return { wet: 0, bypass: 1, band: 0 };
  return { wet: 1, bypass: 0, band: 0 };
}

function clearLater(slot) {
  if (!slot) return;
  for (const id of slot.timers) clearTimeout(id);
  slot.timers.length = 0;
}

// Wall-clock timers may run ahead of the audio clock (especially playback buffers).
// Never change a live wire until its scheduled fade has actually reached zero.
function later(slot, sec, fn) {
  const gen = slot.gen;
  const target = (slot.ctx ? slot.ctx.currentTime : 0) + sec;
  const tick = () => {
    if (slot.gen !== gen) return;
    const remaining = slot.ctx ? target - slot.ctx.currentTime : 0;
    if (remaining > 0.000001 && slot.ctx.state !== 'closed') { schedule(Math.max(1, remaining * 1000)); return; }
    fn();
  };
  const schedule = (ms) => {
    const id = setTimeout(() => {
      const i = slot.timers.indexOf(id);
      if (i >= 0) slot.timers.splice(i, 1);
      tick();
    }, ms);
    slot.timers.push(id);
  };
  schedule(Math.max(0, sec * 1000));
}

function makeGain(ctx, value) {
  const n = ctx.createGain();
  n.gain.value = value;
  return n;
}

function dropNode(node) {
  if (!node || node._brDropping) return;
  node._brDropping = true;
  let sink = null, finished = false, timeout = null;
  const counters = node._brWorklet && node._brOwner && node._brOwner().retirement;
  const ctx = node._brContext;
  const close = (acknowledged = false) => {
    if (finished) return;
    finished = true;
    if (timeout !== null) globalThis.clearTimeout(timeout);
    try { node.disconnect(); } catch (_) {}
    try { if (sink) sink.disconnect(); } catch (_) {}
    if (node.port) { node.port.onmessage = null; try { node.port.close(); } catch (_) {} }
    if (counters) {
      counters.pending--;
      if (acknowledged) counters.acked++;
      else if (ctx && ctx.state !== 'closed') counters.timedOut++;
    }
  };
  if (!node._brWorklet || !node.port) { close(); return; }
  if (counters) { counters.retired++; counters.pending++; }
  // Keep the terminal process block renderable even if its old fade gain is
  // disconnected during this cleanup. This silent sink lasts only until park ACK.
  if (ctx && ctx.state !== 'closed' && ctx.destination) {
    sink = makeGain(ctx, 0);
    node.connect(sink); sink.connect(ctx.destination);
  }
  node.port.onmessage = event => { if (event.data && event.data.parked) close(true); };
  // A wall-clock deadline, independent of transition/audio-clock scheduling.
  timeout = globalThis.setTimeout(() => close(false), 250);
  try { node.port.postMessage({ type: 'park' }); } catch (_) { close(false); }
}

function syncBassGlobals(slot) {
  unmudNode = slot.unmud || null;
  centreNode = slot.centre || null;
  bassPeaksNode = slot.peaks || null;
  truePeakNode = slot.truepeak || null;
}

function noteDynFail(g, slot, failFlag, errText) {
  slot[failFlag] = true;
  slot.fatal = true;
  errText = errText.split(';')[0] + '; output muted. Stop and restart the engine.';
  dynError = errText;
  if (g) g.dynError = errText;
  if (g && g.meters) g.meters.error = errText;
  for (const node of [g && g.outputSum, g && g.directPassThroughGain]) rampGain(node, 0, 0, g && g.audioCtx);
}

function makeWorklet(g, slot, field, proc, inputs, failFlag, errText) {
  if (slot[field]) return slot[field];
  if (typeof g.makeDyn !== 'function') {
    noteDynFail(g, slot, failFlag, errText);
    return null;
  }
  const node = g.makeDyn(proc, inputs);
  if (!node) {
    noteDynFail(g, slot, failFlag, errText);
    return null;
  }
  slot[field] = node;
  node._brWorklet = true;
  node._brOwner = () => g._br || slot;
  node._brContext = g.audioCtx;
  node.onprocessorerror = () => {
    const active = g._br || slot;
    if (active.closed || active[field] !== node) return;
    noteDynFail(g, active, failFlag, proc + ' processor failed');
  };
  syncBassGlobals(slot);
  return node;
}

function levelerDests(g) {
  const out = [];
  const pad = g._br && g._br.pad;
  if (g.autoBalanceComp) out.push(g.autoBalanceComp);
  if (g.autoBalanceBypassGain) out.push(pad && pad.bypass || g.autoBalanceBypassGain);
  if (g.bandLevelerNode) out.push(g.bandLevelerNode);
  return out;
}

function limiterFeeds(g) {
  const out = [];
  if (g.masterLimiter) out.push(g.masterLimiter);
  if (g.lookaheadNode) out.push(g.lookaheadNode);
  return out;
}

// Alignment belongs BEFORE a branch's fade gain. Delaying the gain envelope as
// well as audio destroys complementary fades and leaves an unprimed silent gap.
function padFeeds(slot, key) {
  const g = slot.graph;
  if (!g) return [];
  if (key === 'bypass') return slot.roomSpliced ? [slot.roomDry, slot.roomWet].filter(Boolean) : [g.highNode];
  if (key === 'clean') return [g.outputCeiling];
  if (key === 'warm') return [g.warmShaper];
  if (key === 'band') return [g.bandLevelerNode];
  if (key === 'peaksDry') return [g.volumeGain];
  if (key === 'fast') return [g.masterLimiter];
  if (key === 'lookahead') return [g.lookaheadNode];
  return [slot.truepeak];
}
function setPad(slot, key, fade, dest, samples, ctx) {
  const have = slot.pad[key];
  const feeds = padFeeds(slot, key).filter(Boolean);
  if (!(samples > 0)) {
    if (have) {
      for (const feed of feeds) { try { feed.disconnect(have); } catch (_) {} }
      try { have.disconnect(); } catch (_) {}
      if (fade) for (const feed of feeds) { try { feed.connect(fade); } catch (_) {} }
    }
    slot.pad[key] = null;
    return 0;
  }
  if (!fade || !ctx || typeof ctx.createDelay !== 'function') return 0;
  if (have) return 0;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = samples / ctx.sampleRate;
  for (const feed of feeds) {
    try { feed.disconnect(fade); } catch (_) {}
    feed.connect(delay);
  }
  delay.connect(fade);
  slot.pad[key] = delay;
  return samples / ctx.sampleRate;
}

function ensurePreLim(g, slot) {
  if (slot.postSpliced) return true;
  const ctx = g.audioCtx;
  if (!ctx || !g.volumeGain) return false;
  slot.preLim = makeGain(ctx, 1);
  for (const dest of limiterFeeds(g)) slot.preLim.connect(dest);
  g.volumeGain.connect(slot.preLim);
  for (const dest of limiterFeeds(g)) { try { g.volumeGain.disconnect(dest); } catch (_) {} }
  slot.postSpliced = true;
  return true;
}

function tearPost(g, slot) {
  setPad(slot, 'fast', g.limiterFastGain, g.limiterOut, 0, g.audioCtx);
  setPad(slot, 'lookahead', g.lookaheadGain, g.limiterOut, 0, g.audioCtx);
  // Reconnect the 1.4.0 limiter feeds only after a splice. Doing it on a fresh default graph
  // connects volumeGain to nodes it is already wired to, and Chrome throws InvalidAccessError.
  if (slot.postSpliced && g.volumeGain) {
    for (const dest of limiterFeeds(g)) { try { g.volumeGain.connect(dest); } catch (_) {} }
    try { if (slot.preLim) g.volumeGain.disconnect(slot.preLim); } catch (_) {}
    try { if (slot.peaks) g.volumeGain.disconnect(slot.peaks); } catch (_) {}
    try { if (slot.peaksDry) g.volumeGain.disconnect(slot.peaksDry); } catch (_) {}
  }
  if (slot.preLim && g.masterLimiter) { try { slot.preLim.disconnect(g.masterLimiter); } catch (_) {} }
  if (slot.preLim && g.lookaheadNode) { try { slot.preLim.disconnect(g.lookaheadNode); } catch (_) {} }
  if (slot.preLim && slot.truepeak) { try { if (slot.truepeak) slot.preLim.disconnect(slot.truepeak); } catch (_) {} }
  dropNode(slot.peaks); dropNode(slot.truepeak);
  dropNode(slot.peaksDry); dropNode(slot.peaksWet); dropNode(slot.tpGain); dropNode(slot.preLim);
  for (const key of ['peaksDry', 'lookahead', 'fast', 'truepeak']) {
    if (slot.pad[key]) { try { slot.pad[key].disconnect(); } catch (_) {} slot.pad[key] = null; }
  }
  slot.peaks = slot.truepeak = slot.peaksDry = slot.peaksWet = slot.tpGain = slot.preLim = null;
  slot.postSpliced = false;
  slot.split = false;
  syncBassGlobals(slot);
}

function tearRoom(g, slot) {
  const dests = levelerDests(g);
  if (slot.roomSpliced && g.highNode) {
    for (const dest of dests) { try { g.highNode.connect(dest); } catch (_) {} }
    try { if (slot.roomDry) g.highNode.disconnect(slot.roomDry); } catch (_) {}
    try { if (slot.unmud) g.highNode.disconnect(slot.unmud); } catch (_) {}
    try { if (slot.centre) g.highNode.disconnect(slot.centre); } catch (_) {}
  }
  if (g.hpfNode && slot.unmud) { try { if (slot.unmud) g.hpfNode.disconnect(slot.unmud); } catch (_) {} }
  dropNode(slot.unmud); dropNode(slot.centre); dropNode(slot.roomDry); dropNode(slot.roomWet);
  slot.unmud = slot.centre = slot.roomDry = slot.roomWet = null;
  slot.roomSpliced = false;
  syncBassGlobals(slot);
}

function wireRoomChain(g, slot, mode) {
  const ctx = g.audioCtx;
  const needUnmud = mode === 'unmud' || mode === 'both';
  const needCentre = mode === 'centre' || mode === 'both';
  if (needUnmud && !makeWorklet(g, slot, 'unmud', 'unmud', 2, 'roomFailed', 'Room could not be loaded; Room stays off.')) return false;
  if (needCentre && !makeWorklet(g, slot, 'centre', 'centre-bass', 1, 'roomFailed', 'Room could not be loaded; Room stays off.')) return false;
  if (!slot.roomWet) slot.roomWet = makeGain(ctx, 0);
  try { if (slot.unmud) slot.unmud.disconnect(); } catch (_) {}
  try { if (slot.centre) slot.centre.disconnect(); } catch (_) {}
  try { if (g.highNode) if (slot.unmud) g.highNode.disconnect(slot.unmud); } catch (_) {}
  try { if (g.highNode) if (slot.centre) g.highNode.disconnect(slot.centre); } catch (_) {}
  let tail = g.highNode;
  if (needUnmud) {
    g.highNode.connect(slot.unmud);
    if (g.hpfNode) {
      try { if (slot.unmud) g.hpfNode.disconnect(slot.unmud); } catch (_) {}
      g.hpfNode.connect(slot.unmud, 0, 1);
    }
    tail = slot.unmud;
  } else if (slot.unmud) {
    if (g.hpfNode) { try { if (slot.unmud) g.hpfNode.disconnect(slot.unmud); } catch (_) {} }
    dropNode(slot.unmud); slot.unmud = null;
  }
  if (needCentre) {
    tail.connect(slot.centre);
    tail = slot.centre;
  } else if (slot.centre) {
    dropNode(slot.centre); slot.centre = null;
  }
  try { slot.roomWet.disconnect(); } catch (_) {}
  tail.connect(slot.roomWet);
  for (const dest of levelerDests(g)) slot.roomWet.connect(dest);
  syncBassGlobals(slot);
  return true;
}

function spliceRoomDry(g, slot, ctx, gain) {
  if (!slot.roomDry) slot.roomDry = makeGain(ctx, gain);

  const dests = levelerDests(g);
  for (const dest of dests) { try { slot.roomDry.connect(dest); } catch (_) {} }
  if (!slot.roomSpliced && g.highNode) {
    g.highNode.connect(slot.roomDry);
    for (const dest of dests) { try { g.highNode.disconnect(dest); } catch (_) {} }
    slot.roomSpliced = true;
  } else if (g.highNode) {
    try { g.highNode.connect(slot.roomDry); } catch (_) {}
  }
}

function ensurePeaksSplit(g, slot, ctx) {
  if (!makeWorklet(g, slot, 'peaks', 'bass-peaks', 1, 'peaksFailed', 'Bass peaks could not be loaded; Full band is in use.')) return false;
  if (!ensurePreLim(g, slot)) return false;
  if (!slot.peaksWet) slot.peaksWet = makeGain(ctx, 0);
  if (!slot.peaksDry) slot.peaksDry = makeGain(ctx, heldGain(slot.peaksDry && slot.peaksDry.gain, ctx.currentTime) || 1);
  if (slot.split) return true;
  const vg = g.volumeGain;
  try { if (slot.preLim) vg.disconnect(slot.preLim); } catch (_) {}
  vg.connect(slot.pad.peaksDry || slot.peaksDry);
  slot.peaksDry.connect(slot.preLim);
  vg.connect(slot.peaks);
  slot.peaks.connect(slot.peaksWet);
  slot.peaksWet.connect(slot.preLim);
  slot.split = true;
  return true;
}

function ensureTruepeak(g, slot, ctx) {
  if (!makeWorklet(g, slot, 'truepeak', 'true-peak', 1, 'tpFailed', 'True peak could not be loaded; the previous limiter stays in use.')) return false;
  if (!ensurePreLim(g, slot)) return false;
  if (!slot.tpGain) {
    slot.tpGain = makeGain(ctx, 0);
    slot.preLim.connect(slot.truepeak);
    slot.truepeak.connect(slot.tpGain);
    if (g.limiterOut) slot.tpGain.connect(g.limiterOut);
  }
  syncBassGlobals(slot);
  return true;
}

function limDelay(kind, fs) {
  if (kind === 'fast') return Math.round(0.006 * fs);
  if (kind === 'lookahead') return Math.round(0.005 * fs) + 1;
  if (kind === 'truepeak') return Math.ceil(0.005 * fs) + 33;
  return 0;
}

function levelerDelay(kind, fs) {
  return (kind === 'full' || kind === 'slow') ? Math.round(0.006 * fs) : 0;
}

function commitBassRoom(g, { immediate = false } = {}) {
  if (!g || !g.wired || !g._br) return;
  const slot = g._br;
  slot.ctx = g.audioCtx;
  slot.graph = g;
  const want = bassWant(g, slot);
  if (slot.fatal) return;
  if (slot.phase === 'run') { slot.pending = want; return; }
  if (slot.key === wantKey(want)) return;
  startBassRequest(g, slot, want, immediate || !g.live);
}

function startBassRequest(g, slot, want, immediate) {
  slot.managesLeveler = want.peaks || slot.appliedPeaks || want.leveler !== slot.appliedLeveler;
  slot.managesLimiter = want.truepeak || slot.appliedLimiter === 'truepeak' || want.limiter !== slot.appliedLimiter;
  slot.key = wantKey(want);
  slot.gen++;
  clearLater(slot);
  if (immediate) applyBassSettled(g, slot, want);
  else runBassLive(g, slot, want);
}

function bassFinished(g, slot, want) {
  slot.phase = 'idle';
  slot.key = wantKey(want);
  syncBassGlobals(slot);
  const pending = slot.pending;
  slot.pending = null;
  if (pending && wantKey(pending) !== slot.key && !slot.fatal) startBassRequest(g, slot, pending, false);
}

function applyBassSettled(g, slot, want) {
  const ctx = g.audioCtx;
  rampLeveler(g, levelerTarget(want), 0, ctx);
  setPad(slot, 'bypass', g.autoBalanceBypassGain, g.levelerOut, 0, ctx);
  if (want.room === 'off') tearRoom(g, slot);
  else {
    spliceRoomDry(g, slot, ctx, 0);
    if (!wireRoomChain(g, slot, want.room)) {
      tearRoom(g, slot);
      want = { ...want, room: 'off' };
    } else {
      rampGain(slot.roomWet, 1, 0, ctx);
      try { if (slot.roomDry) g.highNode.disconnect(slot.roomDry); } catch (_) {}
      try { slot.roomDry.disconnect(); } catch (_) {}
    }
  }
  if (!want.peaks && !want.truepeak) tearPost(g, slot);
  else if (!buildPostSettled(g, slot, want)) {
    tearPost(g, slot);
    want = {
      ...want,
      peaks: false,
      truepeak: false,
      limiter: g.lookaheadNode ? 'lookahead' : 'fast',
      leveler: want.compOff ? 'bypass' : 'full'
    };
  }
  rampLeveler(g, levelerTarget(want), 0, ctx);
  rampGain(g.limiterFastGain, want.limiter === 'fast' ? 1 : 0, 0, ctx);
  rampGain(g.lookaheadGain, want.limiter === 'lookahead' ? 1 : 0, 0, ctx);
  rampGain(slot.tpGain, want.truepeak ? 1 : 0, 0, ctx);
  slot.appliedCeiling = want.ceiling;
  slot.appliedRoom = want.room;
  slot.appliedPeaks = !!want.peaks;
  slot.appliedLimiter = want.truepeak ? 'truepeak' : want.limiter;
  slot.appliedLeveler = want.leveler;
  bassFinished(g, slot, want);
}

function buildPostSettled(g, slot, want) {
  const ctx = g.audioCtx;
  if (want.truepeak && !ensureTruepeak(g, slot, ctx)) return false;
  if (want.peaks) {
    if (!ensurePeaksSplit(g, slot, ctx)) return false;
    rampGain(slot.peaksWet, 1, 0, ctx);
    rampGain(slot.peaksDry, 0, 0, ctx);
    setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, 0, ctx);
    try { if (slot.peaksDry) g.volumeGain.disconnect(slot.peaksDry); } catch (_) {}
    try { slot.peaksDry.disconnect(); } catch (_) {}
  } else if (slot.split) {
    try { if (slot.peaks) g.volumeGain.disconnect(slot.peaks); } catch (_) {}
    try { if (slot.peaksDry) g.volumeGain.disconnect(slot.peaksDry); } catch (_) {}
    dropNode(slot.peaks); dropNode(slot.peaksDry); dropNode(slot.peaksWet);
    slot.peaks = slot.peaksDry = slot.peaksWet = null;
    slot.split = false;
    try { g.volumeGain.connect(slot.preLim); } catch (_) {}
    setPad(slot, 'peaksDry', null, null, 0, ctx);
  } else if (!ensurePreLim(g, slot)) return false;
  if (!want.truepeak) {
    setPad(slot, 'truepeak', slot.tpGain, g.limiterOut, 0, ctx);
    if (slot.preLim && slot.truepeak) { try { if (slot.truepeak) slot.preLim.disconnect(slot.truepeak); } catch (_) {} }
    dropNode(slot.truepeak); dropNode(slot.tpGain);
    slot.truepeak = slot.tpGain = null;
  }
  syncBassGlobals(slot);
  return true;
}

function runBassLive(g, slot, want) {
  const ctx = g.audioCtx;
  // A newer request cancelled the previous timers (commit bumps gen). Restart from the topology
  // we actually have, not only from the last applied label: a cancelled enter has already spliced.
  slot.phase = 'run';
  const pending = [];
  const roomOn = want.room !== 'off';
  const roomLive = slot.appliedRoom !== 'off' || !!slot.roomSpliced;
  if (slot.appliedRoom !== want.room || roomLive !== roomOn) pending.push((done) => liveRoom(g, slot, want, ctx, done));
  if (slot.appliedPeaks !== !!want.peaks || !!slot.split !== !!want.peaks) pending.push((done) => livePeaks(g, slot, want, ctx, done));
  else if (!want.peaks && slot.appliedLeveler !== want.leveler) pending.push((done) => liveLegacyLeveler(g, slot, want, ctx, done));
  if (slot.appliedLimiter !== want.limiter || (slot.appliedLimiter === 'truepeak') !== !!want.truepeak || !!slot.truepeak !== !!want.truepeak) pending.push((done) => liveTruepeak(g, slot, want, ctx, done));
  if (slot.appliedCeiling !== want.ceiling) pending.push((done) => liveCeiling(g, slot, want, ctx, done));
  if (!pending.length) { finishBass(g, slot, want, ctx); return; }
  let left = pending.length;
  for (const start of pending) start(() => { if (--left === 0) finishBass(g, slot, want, ctx); });
}


function finishBass(g, slot, want, ctx) {
  if (slot.fatal) { slot.phase = 'idle'; slot.pending = null; return; }
  const now = ctx ? ctx.currentTime : 0;
  const near = (node, v) => !node || Math.abs(heldGain(node.gain, now) - v) < 0.02;
  if (slot.roomDry && slot.roomWet) {
    if (!near(slot.roomDry, want.room === 'off' ? 1 : 0) || !near(slot.roomWet, want.room === 'off' ? 0 : 1)) {
      later(slot, 0.02, () => finishBass(g, slot, want, ctx));
      return;
    }
  }
  if (slot.split && slot.peaksDry && slot.peaksWet) {
    if (!near(slot.peaksDry, want.peaks ? 0 : 1) || !near(slot.peaksWet, want.peaks ? 1 : 0)) {
      later(slot, 0.02, () => finishBass(g, slot, want, ctx));
      return;
    }
  }
  if ((g.limiterFastGain && !near(g.limiterFastGain, want.limiter === 'fast' ? 1 : 0))
    || (g.lookaheadGain && !near(g.lookaheadGain, want.limiter === 'lookahead' ? 1 : 0))
    || (slot.tpGain && !near(slot.tpGain, want.truepeak ? 1 : 0))) {
    later(slot, 0.02, () => finishBass(g, slot, want, ctx));
    return;
  }
  if (want.room === 'off') {
    if (!slot.roomWet || near(slot.roomWet, 0)) tearRoom(g, slot);
  } else if (slot.roomDry && near(slot.roomDry, 0)) {
    try { if (slot.roomDry) g.highNode.disconnect(slot.roomDry); } catch (_) {}
    try { slot.roomDry.disconnect(); } catch (_) {}
  }
  if (!want.peaks && slot.split && (!slot.peaksWet || near(slot.peaksWet, 0))) {
    if (slot.pad.peaksDry && slot.peaksDry && !near(slot.peaksDry, 0)) {
      dipRemove(slot, ctx, slot.peaksDry, () => setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, 0, ctx), () => finishBass(g, slot, want, ctx));
      return;
    }
    setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, 0, ctx);
    if (!want.truepeak) tearPost(g, slot);
    else {
      try { if (slot.peaks) g.volumeGain.disconnect(slot.peaks); } catch (_) {}
      try { if (slot.peaksDry) g.volumeGain.disconnect(slot.peaksDry); } catch (_) {}
      dropNode(slot.peaks); dropNode(slot.peaksDry); dropNode(slot.peaksWet);
      slot.peaks = slot.peaksDry = slot.peaksWet = null;
      slot.split = false;
      try { g.volumeGain.connect(slot.preLim); } catch (_) {}
    }
  }
  if (want.peaks && slot.peaksDry && near(slot.peaksDry, 0)) {
    setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, 0, ctx);
    try { if (slot.peaksDry) g.volumeGain.disconnect(slot.peaksDry); } catch (_) {}
    try { slot.peaksDry.disconnect(); } catch (_) {}
  }
  if (slot.pad.bypass && near(g.autoBalanceBypassGain, 0)) setPad(slot, 'bypass', g.autoBalanceBypassGain, g.levelerOut, 0, ctx);
  else if (slot.pad.bypass && near(g.autoBalanceBypassGain, 1) && !(want.leveler === 'full' || want.leveler === 'slow')) {
    dipRemove(slot, ctx, g.autoBalanceBypassGain, () => setPad(slot, 'bypass', g.autoBalanceBypassGain, g.levelerOut, 0, ctx), () => finishBass(g, slot, want, ctx));
    return;
  }
  for (const key of ['fast', 'lookahead', 'truepeak']) {
    if (!slot.pad[key]) continue;
    const node = key === 'fast' ? g.limiterFastGain : key === 'lookahead' ? g.lookaheadGain : slot.tpGain;
    const to = key === 'fast' ? g.limiterOut : key === 'lookahead' ? g.limiterOut : g.limiterOut;
    if (near(node, 0)) setPad(slot, key, node, to, 0, ctx);
  }
  if (!want.truepeak && slot.truepeak && near(slot.tpGain, 0)) {
    setPad(slot, 'truepeak', slot.tpGain, g.limiterOut, 0, ctx);
    if (slot.preLim) { try { if (slot.truepeak) slot.preLim.disconnect(slot.truepeak); } catch (_) {} }
    dropNode(slot.truepeak); dropNode(slot.tpGain);
    slot.truepeak = slot.tpGain = null;
    if (!want.peaks) tearPost(g, slot);
  }
  if (want.peaks && !slot.peaks) want = { ...want, peaks: false, leveler: want.compOff ? 'bypass' : 'full' };
  if (want.truepeak && !slot.truepeak) want = { ...want, truepeak: false, limiter: g.lookaheadNode ? 'lookahead' : 'fast' };
  if (want.room !== 'off' && !slot.unmud && !slot.centre) want = { ...want, room: 'off' };
  if (slot.managesLeveler) rampLeveler(g, levelerTarget(want), 0, ctx);
  if (slot.managesLimiter) {
    rampGain(g.limiterFastGain, want.limiter === 'fast' ? 1 : 0, 0, ctx);
    rampGain(g.lookaheadGain, want.limiter === 'lookahead' ? 1 : 0, 0, ctx);
    rampGain(slot.tpGain, want.truepeak ? 1 : 0, 0, ctx);
  }
  slot.appliedCeiling = want.ceiling;
  slot.appliedRoom = want.room;
  slot.appliedPeaks = !!want.peaks;
  slot.appliedLimiter = want.truepeak ? 'truepeak' : want.limiter;
  slot.appliedLeveler = want.leveler;
  bassFinished(g, slot, want);
}

function dipRemove(slot, ctx, node, atZero, after) {
  rampGain(node, 0, BASS_DIP_DOWN, ctx);
  later(slot, BASS_DIP_DOWN + 0.004, () => {
    const prime = atZero() || 0;
    later(slot, prime + 128 / ctx.sampleRate, () => {
      rampGain(node, 1, BASS_DIP_UP, ctx);
      later(slot, BASS_DIP_UP + 0.004, after);
    });
  });
}

function liveLegacyLeveler(g, slot, want, ctx, done) {
  const fs = ctx.sampleRate, from = slot.appliedLeveler, to = want.leveler;
  const source = from === 'bass' ? g.bandLevelerGain : from === 'bypass' ? g.autoBalanceBypassGain : g.autoBalanceWetGain;
  const target = to === 'bass' ? g.bandLevelerGain : to === 'bypass' ? g.autoBalanceBypassGain : g.autoBalanceWetGain;
  const fromKey = from === 'bass' ? 'band' : 'bypass', toKey = to === 'bass' ? 'band' : 'bypass';
  const fromN = levelerDelay(from, fs), toN = levelerDelay(to, fs);
  const cross = () => {
    rampLeveler(g, levelerTarget(want), BASS_FADE, ctx);
    later(slot, BASS_FADE + 0.004, () => {
      if (fromN < toN && slot.pad[fromKey]) setPad(slot, fromKey, source, g.levelerOut, 0, ctx);
      if (fromN > toN && slot.pad[toKey]) dipRemove(slot, ctx, target, () => setPad(slot, toKey, target, g.levelerOut, 0, ctx), done);
      else done();
    });
  };
  if (fromN > toN) {
    setPad(slot, toKey, target, g.levelerOut, fromN - toN, ctx);
    later(slot, (fromN - toN + 256) / fs, cross);
  } else if (toN > fromN) {
    dipRemove(slot, ctx, source, () => setPad(slot, fromKey, source, g.levelerOut, toN - fromN, ctx), cross);
  } else cross();
}

function liveRoom(g, slot, want, ctx, done) {
  if (want.room !== 'off' && slot.appliedRoom !== 'off' && slot.appliedRoom !== want.room) {
    spliceRoomDry(g, slot, ctx, 0);
    rampGain(slot.roomDry, 1, BASS_FADE, ctx);
    rampGain(slot.roomWet, 0, BASS_FADE, ctx);
    later(slot, BASS_FADE + 0.004, () => {
      if (!wireRoomChain(g, slot, want.room)) { tearRoom(g, slot); done(); return; }
      later(slot, 0.025, () => { rampGain(slot.roomDry, 0, BASS_FADE, ctx); rampGain(slot.roomWet, 1, BASS_FADE, ctx); });
      later(slot, BASS_FADE + 0.029, () => {
        try { if (slot.roomDry) g.highNode.disconnect(slot.roomDry); } catch (_) {}
        slot.appliedCeiling = want.ceiling;
  slot.appliedRoom = want.room;
        done();
      });
    });
    return;
  }
  if (want.room === 'off') {
    spliceRoomDry(g, slot, ctx, 0);
    rampGain(slot.roomDry, 1, BASS_FADE, ctx);
    rampGain(slot.roomWet, 0, BASS_FADE, ctx);
    later(slot, BASS_FADE + 0.004, () => { tearRoom(g, slot); slot.appliedRoom = 'off'; done(); });
    return;
  }
  spliceRoomDry(g, slot, ctx, 1);
  if (!wireRoomChain(g, slot, want.room)) { tearRoom(g, slot); slot.appliedRoom = 'off'; done(); return; }
  later(slot, 0.025, () => { rampGain(slot.roomDry, 0, BASS_FADE, ctx); rampGain(slot.roomWet, 1, BASS_FADE, ctx); });
  later(slot, BASS_FADE + 0.029, () => {
    try { if (slot.roomDry) g.highNode.disconnect(slot.roomDry); } catch (_) {}
    try { slot.roomDry.disconnect(); } catch (_) {}
    slot.appliedCeiling = want.ceiling;
  slot.appliedRoom = want.room;
    done();
  });
}

function livePeaks(g, slot, want, ctx, done) {
  const fs = ctx.sampleRate || 48000;
  const N = Math.round(0.005 * fs) + 1;
  if (want.peaks) {
    if (!ensurePeaksSplit(g, slot, ctx)) { slot.appliedPeaks = false; done(); return; }
    const fromN = levelerDelay(slot.appliedLeveler, fs);
    const arm = () => {
      if (fromN > 0) setPad(slot, 'bypass', g.autoBalanceBypassGain, g.levelerOut, fromN, ctx);
      rampLeveler(g, levelerTarget(want), BASS_FADE, ctx);
      rampGain(slot.peaksDry, 0, BASS_FADE, ctx);
      rampGain(slot.peaksWet, 1, BASS_FADE, ctx);
      later(slot, BASS_FADE + 0.004, () => {
        setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, 0, ctx);
        try { if (slot.peaksDry) g.volumeGain.disconnect(slot.peaksDry); } catch (_) {}
        try { slot.peaksDry.disconnect(); } catch (_) {}
        if (slot.pad.bypass) {
          dipRemove(slot, ctx, g.autoBalanceBypassGain, () => setPad(slot, 'bypass', g.autoBalanceBypassGain, g.levelerOut, 0, ctx), () => {
            slot.appliedPeaks = true; slot.appliedLeveler = 'peaks'; done();
          });
        } else {
          slot.appliedPeaks = true; slot.appliedLeveler = 'peaks'; done();
        }
      });
    };
    // The dry post-master path is audible and shorter than the catch. Dip, then pad, then crossfade.
    rampGain(slot.peaksDry, 0, BASS_DIP_DOWN, ctx);
    later(slot, BASS_DIP_DOWN + 0.004, () => {
      setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, N, ctx);
      later(slot, (N + 128) / fs, () => {
        rampGain(slot.peaksDry, 1, BASS_DIP_UP, ctx);
        later(slot, BASS_DIP_UP + 0.004, arm);
      });
    });
    return;
  }
  if (!slot.split) { slot.appliedPeaks = false; slot.appliedLeveler = want.leveler; rampLeveler(g, levelerTarget(want), BASS_FADE, ctx); done(); return; }
  if (!slot.peaksDry) slot.peaksDry = makeGain(ctx, 0);
  try { g.volumeGain.connect(slot.pad.peaksDry || slot.peaksDry); } catch (_) {}
  slot.peaksDry.connect(slot.preLim);
  setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, N, ctx);
  const toN = levelerDelay(want.leveler, fs);
  const cross = () => {
    rampGain(slot.peaksWet, 0, BASS_FADE, ctx);
    rampGain(slot.peaksDry, 1, BASS_FADE, ctx);
    rampLeveler(g, levelerTarget(want), BASS_FADE, ctx);
    later(slot, BASS_FADE + 0.004, () => {
      dipRemove(slot, ctx, slot.peaksDry, () => setPad(slot, 'peaksDry', slot.peaksDry, slot.preLim, 0, ctx), () => {
        slot.appliedPeaks = false;
        slot.appliedLeveler = want.leveler;
        done();
      });
    });
  };
  if (toN > 0) {
    dipRemove(slot, ctx, g.autoBalanceBypassGain, () => setPad(slot, 'bypass', g.autoBalanceBypassGain, g.levelerOut, toN, ctx), cross);
  } else cross();
}

// Chromium's 4x WaveShaper resampler adds 192 samples, measured by the
// offline impulse test at 48/96 kHz. Keep the old steady-state path; align only the fade.
function liveCeiling(g, slot, want, ctx, done) {
  const from = slot.appliedCeiling, to = want.ceiling;
  const old = from === 'warm' ? g.ceilingWarmGain : g.ceilingCleanGain;
  const next = to === 'warm' ? g.ceilingWarmGain : g.ceilingCleanGain;
  const fromN = from === 'warm' ? 192 : 0, toN = to === 'warm' ? 192 : 0;
  const cross = () => {
    rampGain(old, 0, BASS_FADE, ctx); rampGain(next, 1, BASS_FADE, ctx);
    later(slot, BASS_FADE + .004, () => {
      if (slot.pad[from]) setPad(slot, from, old, g.outputSum, 0, ctx);
      if (slot.pad[to]) dipRemove(slot, ctx, next, () => setPad(slot, to, next, g.outputSum, 0, ctx), done);
      else done();
    });
  };
  if (fromN > toN) {
    setPad(slot, to, next, g.outputSum, fromN - toN, ctx);
    later(slot, (fromN - toN + 256) / ctx.sampleRate, cross);
  } else dipRemove(slot, ctx, old, () => setPad(slot, from, old, g.outputSum, toN - fromN, ctx), cross);
}

function limiterGain(g, slot, kind) {
  if (kind === 'fast') return g.limiterFastGain;
  if (kind === 'lookahead') return g.lookaheadGain;
  return slot.tpGain;
}

function liveTruepeak(g, slot, want, ctx, done) {
  const fs = ctx.sampleRate || 48000;
  const from = slot.appliedLimiter || 'fast';
  const to = want.truepeak ? 'truepeak' : want.limiter;
  if (to === 'truepeak' && !ensureTruepeak(g, slot, ctx)) { done(); return; }
  const fromN = limDelay(from, fs);
  const toN = limDelay(to, fs);
  const fromNode = limiterGain(g, slot, from);
  const toNode = limiterGain(g, slot, to);
  const padKey = to === 'truepeak' ? 'truepeak' : to === 'lookahead' ? 'lookahead' : 'fast';
  const fromKey = from === 'truepeak' ? 'truepeak' : from === 'lookahead' ? 'lookahead' : 'fast';
  const dest = g.limiterOut;
  const cross = () => {
    rampGain(fromNode, 0, BASS_FADE, ctx);
    rampGain(toNode, 1, BASS_FADE, ctx);
    later(slot, BASS_FADE + 0.004, () => {
      if (slot.pad[fromKey]) setPad(slot, fromKey, fromNode, dest, 0, ctx);
      if (slot.pad[padKey]) {
        dipRemove(slot, ctx, toNode, () => setPad(slot, padKey, toNode, dest, 0, ctx), () => {
          slot.appliedLimiter = to; done();
        });
      } else {
        slot.appliedLimiter = to; done();
      }
    });
  };
  if (toN < fromN) {
    setPad(slot, padKey, toNode, dest, fromN - toN, ctx);
    later(slot, Math.max(fromN, toN) / fs + 256 / fs, cross);
  } else if (fromN < toN) {
    dipRemove(slot, ctx, fromNode, () => setPad(slot, fromKey, fromNode, dest, toN - fromN, ctx), () => {
      rampGain(fromNode, 1, BASS_DIP_UP, ctx);
      later(slot, BASS_DIP_UP + 0.004, cross);
    });
  } else later(slot, toN / fs + 256 / fs, cross);
}

function releaseBassRoom() {
  clearLater(br);
  for (const n of [br.unmud, br.centre, br.peaks, br.truepeak, br.roomDry, br.roomWet, br.peaksDry, br.peaksWet, br.tpGain, br.preLim]) dropNode(n);
  for (const k of Object.keys(br.pad)) if (br.pad[k]) { try { br.pad[k].disconnect(); } catch (_) {} }
  const timers = br.timers;
  Object.assign(br, emptyBass());
  br.timers = timers;
  br.timers.length = 0;
  unmudNode = centreNode = bassPeaksNode = truePeakNode = null;
}

function bassRoomProbe() {
  const now = audioCtx && typeof audioCtx.currentTime === 'number' ? audioCtx.currentTime : 0;
  const gv = (n) => n && n.gain ? heldGain(n.gain, now) : null;
  const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
  const leveler = [gv(autoBalanceWetGain), gv(autoBalanceBypassGain), gv(bandLevelerGain)];
  const posts = [gv(br.peaksDry), gv(br.peaksWet)].filter((v) => v != null);
  const lims = [gv(limiterFastGain), gv(lookaheadGain), gv(br.tpGain)].filter((v) => v != null);
  const rooms = [gv(br.roomDry), gv(br.roomWet)].filter((v) => v != null);
  const ceilings = [gv(ceilingCleanGain), gv(ceilingWarmGain)];
  return {
    unmud: !!unmudNode, centre: !!centreNode, peaks: !!bassPeaksNode, truepeak: !!truePeakNode,
    room: br.appliedRoom, peaksOn: br.appliedPeaks, limiter: br.appliedLimiter, leveler: br.appliedLeveler,
    callbacks: br.callbacks, retirement: { ...br.retirement }, failed: { room: br.roomFailed, peaks: br.peaksFailed, truepeak: br.tpFailed },
    delays: Object.keys(br.pad).filter((k) => br.pad[k]),
    error: dynError,
    gains: { roomDry: gv(br.roomDry), roomWet: gv(br.roomWet), peaksDry: gv(br.peaksDry), peaksWet: gv(br.peaksWet), tp: gv(br.tpGain), wet: gv(autoBalanceWetGain), bypass: gv(autoBalanceBypassGain), band: gv(bandLevelerGain), fast: gv(limiterFastGain), la: gv(lookaheadGain), clean: gv(ceilingCleanGain), warm: gv(ceilingWarmGain) },
    sums: { leveler: sum(leveler), post: posts.length ? sum(posts) : null, limiter: sum(lims), room: rooms.length ? sum(rooms) : null, ceiling: sum(ceilings) }
  };
}

function applyRoutingState({ immediate = false } = {}) {
  if (!audioCtx || audioCtx.state === 'closed') return;
  applyRoutingToGraph({
    audioCtx, pitchNode, pitchPrimed, pitchHoldUntil,
    dspPathGain, directPassThroughGain, autoBalanceWetGain, autoBalanceBypassGain, bandLevelerGain, autoBalanceComp,
    matchWetGain, matchDryGain, lookaheadGain, limiterFastGain, ceilingWarmGain, ceilingCleanGain, pitchWetGain, pitchDryGain,
    bandLevelerNode, matchNode, lookaheadNode,
    highNode, hpfNode, volumeGain, levelerOut, masterLimiter, limiterOut, outputSum, outputCeiling, warmShaper,
    movieMode: currentMovieMode,
    makeDyn: dynMake, wired: true, live: !immediate, _br: br
  }, { immediate });
}

// Gain routing for one graph bundle. `g` carries its own nodes, its own primed flag and its own context, so a graph
// that is still being built can be set before it replaces the live one. The live path calls this through applyRoutingState.
function applyRoutingToGraph(g, { immediate = false } = {}) {
  if (!g) return;
  const audioCtx = g.audioCtx;
  const pitchNode = g.pitchNode;
  const pitchPrimed = g.pitchPrimed;
  const pitchHoldUntil = g.pitchHoldUntil;
  const now = audioCtx ? audioCtx.currentTime : 0;
  const rampTime = 0.02;
  const set = (node, value) => {
    if (!node) return;
    const param = node.gain || node;
    param._brFade = null;
    if (immediate || !audioCtx || typeof param.setTargetAtTime !== 'function') param.value = value;
    else param.setTargetAtTime(value, now, rampTime);
  };
  if (!audioCtx && ('semitones' in g || 'pitchBypassed' in g || 'bypassed' in g)) {
    const active = !g.bypassed && !g.pitchBypassed && !g.movieMode && Math.abs(g.semitones || 0) >= 0.001;
    set(g.pitchWetGain, active ? 1.0 : 0.0);
    set(g.pitchDryGain, active ? 0.0 : 1.0);
    return;
  }
  if (!audioCtx || audioCtx.state === 'closed') return;

  const isBypass = currentParams.bypass === true;
  const isCompBypassed = bypassState().comp;
  const d = currentDynamics;
  const dyn = {
    leveler: d.leveler === 'bass' && !g.bandLevelerNode ? 'full' : d.leveler,
    match: d.match === true && !!g.matchNode,
    limiter: d.limiter === 'lookahead' && !g.lookaheadNode ? 'fast' : d.limiter,
    ceiling: d.ceiling
  };

  set(g.dspPathGain, isBypass ? 0.0 : 1.0);
  set(g.directPassThroughGain, isBypass ? 1.0 : 0.0);

  // AUTO: off = the dry path; on = the 1.4.0 compressor ("Full band", or "Slow release" = the same with a 0.6 s
  // release instead of 0.2 s) or the bass-only leveler. Bass peaks bypasses the compressor (linear fade below).
  const slot = g._br || br;
  const want = bassWant(g, slot);
  const ownLeveler = !!(want.peaks || slot.appliedPeaks || slot.phase === 'run' || (g.wired && slot.key && want.leveler !== slot.appliedLeveler));
  const ownLimiter = !!(want.truepeak || slot.appliedLimiter === 'truepeak' || slot.phase === 'run' || (g.wired && slot.key && want.limiter !== slot.appliedLimiter));
  const useBand = !isCompBypassed && !want.peaks && dyn.leveler === 'bass' && !!g.bandLevelerNode;
  if (!(ownLeveler && !immediate)) {
    if (want.peaks && !isCompBypassed) {
      set(g.autoBalanceWetGain, 0.0);
      set(g.autoBalanceBypassGain, 1.0);
      set(g.bandLevelerGain, 0.0);
    } else {
      set(g.autoBalanceWetGain, !isCompBypassed && !useBand ? 1.0 : 0.0);
      set(g.autoBalanceBypassGain, isCompBypassed || want.peaks ? 1.0 : 0.0);
      set(g.bandLevelerGain, useBand ? 1.0 : 0.0);
    }
  }
  if (g.autoBalanceComp) {
    const release = dyn.leveler === 'slow' ? 0.6 : 0.2;
    if (g.autoBalanceComp.release.value !== release) g.autoBalanceComp.release.value = release;
  }

  // MATCH, LIM, CEIL: each a pair of gains, the 1.4.0 stage open by default.
  set(g.matchWetGain, dyn.match ? 1.0 : 0.0);
  set(g.matchDryGain, dyn.match ? 0.0 : 1.0);
  if (!(ownLimiter && !immediate)) {
    if (want.truepeak) {
      set(g.lookaheadGain, 0.0);
      set(g.limiterFastGain, 0.0);
    } else {
      set(g.lookaheadGain, want.limiter === 'lookahead' ? 1.0 : 0.0);
      set(g.limiterFastGain, want.limiter === 'lookahead' ? 0.0 : 1.0);
    }
  }
  const ownCeiling = !immediate && g.wired && slot.key && (slot.phase === 'run' || slot.appliedCeiling !== dyn.ceiling);
  if (!ownCeiling) {
    set(g.ceilingWarmGain, dyn.ceiling === 'warm' ? 1.0 : 0.0);
    set(g.ceilingCleanGain, dyn.ceiling === 'warm' ? 0.0 : 1.0);
  }

  // The shifter is in the path only while a shift is set and it is producing audio (it adds about 0.14 s of delay);
  // 0 st is a true bypass, and the shifter is parked then. Movie mode (1.5.6, L-02) locks Pitch off for video sync.
  const shifting = !!pitchNode && pitchTarget() !== 0 && pitchPrimed && audioCtx.currentTime >= pitchHoldUntil;
  const pitchOpen = !g.movieMode && shifting && pitchTarget(!!g.movieMode) !== 0;
  set(g.pitchWetGain, pitchOpen ? 1.0 : 0.0);
  set(g.pitchDryGain, pitchOpen ? 0.0 : 1.0);
  if (g.wired) commitBassRoom(g, { immediate });
  if (slot.fatal) { rampGain(g.outputSum, 0, 0, audioCtx); rampGain(g.directPassThroughGain, 0, 0, audioCtx); }
}

// Re-route once the audio clock has passed the hold. A timer runs on the computer's clock and the audio clock lags it by
// the output buffer, so the check repeats until the hold is really over (or the shifter or the capture is replaced).
function reopenAfterHold(node) {
  clearTimeout(pitchHoldTimer);
  if (!audioCtx || pitchNode !== node) return;
  const wait = pitchHoldUntil - audioCtx.currentTime;
  if (wait <= 0) { applyRoutingState(); return; }
  pitchHoldTimer = setTimeout(() => reopenAfterHold(node), wait * 1000 + 20);
}

// The shift the worklet is given: below 0.05 st it is exactly 0, which parks it. Movie mode forces 0 without changing currentParams.
function pitchTarget(forMovieMode = currentMovieMode) {
  if (forMovieMode) return 0;
  const st = pitchSetting();
  return Math.abs(st) >= 0.05 ? st : 0;
}

// Glide to a new shift in 30 ms. Going to 0, the value is set to exactly 0 once the crossfade back to the unshifted path
// is over (250 ms), so the shifter parks.
function schedulePitch(now, rampTime) {
  const p = pitchNode.parameters.get('semitones');
  const st = pitchTarget(currentMovieMode);
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.setTargetAtTime(st, now, rampTime);
  if (st === 0) p.setValueAtTime(0, now + 0.25);
}
