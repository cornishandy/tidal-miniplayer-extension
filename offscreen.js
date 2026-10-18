// offscreen.js - Web Audio DSP Pipeline & Tab Audio Routing Engine

let audioCtx = null;
let currentStream = null;
let sourceNode = null;
let isCapturing = false;

// Movie mode (1.5.5, L-01): 'interactive' shortens the device buffer for video. Audio-only stays on 'playback'.
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
    baseLatency: audioCtx ? audioCtx.baseLatency : null
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
const DEFAULT_DYNAMICS = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' };
let currentDynamics = { ...DEFAULT_DYNAMICS };
let dynError = null;                                       // set if the worklet module could not be loaded
let levelerOut = null;                                     // the sum of whichever leveler path is open
let bandLevelerNode = null, bandLevelerGain = null;        // AUTO "Bass only"
let matchNode = null, matchDryGain = null, matchWetGain = null; // MATCH (loudness match)
let limiterFastGain = null, lookaheadNode = null, lookaheadGain = null, limiterOut = null; // LIM
let warmPreGain = null, warmShaper = null, ceilingCleanGain = null, ceilingWarmGain = null, outputSum = null; // CEIL
let ceilingTap = null, ceilingBuf = null;                  // meter: what the ceiling is being asked to bend
const dynMeters = { band: 0, trim: 0, lookahead: 0 };     // last figures posted by the worklets

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
    leveler: ['full', 'slow', 'bass'].includes(x.leveler) ? x.leveler : 'full',
    match: x.match === true,
    limiter: ['fast', 'lookahead'].includes(x.limiter) ? x.limiter : 'fast',
    ceiling: ['clean', 'warm'].includes(x.ceiling) ? x.ceiling : 'clean'
  };
}

// The modes actually in force: an alternative that needs a worklet falls back to the 1.4.0 stage if the module failed.
function effectiveDynamics() {
  const d = currentDynamics;
  return {
    leveler: d.leveler === 'bass' && !bandLevelerNode ? 'full' : d.leveler,
    match: d.match && !!matchNode,
    limiter: d.limiter === 'lookahead' && !lookaheadNode ? 'fast' : d.limiter,
    ceiling: d.ceiling
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
      sendResponse({ success: true, currentParams });
      return true;

    case 'SET_DYNAMICS':
      updateDynamics(message.dynamics);
      sendResponse({ success: true, dynamics: currentDynamics });
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
  const leveler = compOff ? 0 : dyn.leveler === 'bass' ? dynMeters.band : Math.max(0, -(autoBalanceComp ? autoBalanceComp.reduction : 0));
  const match = dyn.match ? dynMeters.trim : 0;
  const limiter = dyn.limiter === 'lookahead' ? dynMeters.lookahead : Math.max(0, -(masterLimiter ? masterLimiter.reduction : 0));
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
  return { modes: dyn, available: !dynError, error: dynError, leveler: r1(leveler), match: r1(match), limiter: r1(limiter), ceiling: r1(ceiling), peakIn: Math.round(peak * 1000) / 1000 };
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
        if (!e.data.primed && pitchPrimed && pitchTarget() !== 0) pitchHoldUntil = audioCtx.currentTime + 0.5;
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
          const d = e.data || {};
          if (name === 'band-leveler' && typeof d.red === 'number') dynMeters.band = d.red;
          if (name === 'lookahead-limiter' && typeof d.red === 'number') dynMeters.lookahead = d.red;
          if (name === 'loudness-match' && typeof d.trim === 'number') dynMeters.trim = d.trim;
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
    // module was loading has to be the value this graph is installed with.
    if (builtPitch) builtPitch.parameters.get('semitones').value = pitchTarget();
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
  for (const n of [oldPitch, oldBand, oldMatch, oldLa]) if (n && n.port) n.port.onmessage = null;
  clearTimeout(pitchHoldTimer);
  pitchHoldTimer = null;
  pitchPrimed = false;
  pitchHoldUntil = 0;
  dynMeters.band = dynMeters.trim = dynMeters.lookahead = 0;

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
  for (const n of [pitchNode, bandLevelerNode, matchNode, lookaheadNode]) {
    if (n && n.port) n.port.onmessage = null;
  }
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
  dynMeters.band = dynMeters.trim = dynMeters.lookahead = 0;
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

function applyRoutingState({ immediate = false } = {}) {
  if (!audioCtx || audioCtx.state === 'closed') return;
  applyRoutingToGraph({
    audioCtx, pitchNode, pitchPrimed, pitchHoldUntil,
    dspPathGain, directPassThroughGain, autoBalanceWetGain, autoBalanceBypassGain, bandLevelerGain, autoBalanceComp,
    matchWetGain, matchDryGain, lookaheadGain, limiterFastGain, ceilingWarmGain, ceilingCleanGain, pitchWetGain, pitchDryGain,
    bandLevelerNode, matchNode, lookaheadNode
  }, { immediate });
}

// Gain routing for one graph bundle. `g` carries its own nodes, its own primed flag and its own context, so a graph
// that is still being built can be set before it replaces the live one. The live path calls this through applyRoutingState.
function applyRoutingToGraph(g, { immediate = false } = {}) {
  const audioCtx = g.audioCtx;
  const pitchNode = g.pitchNode;
  const pitchPrimed = g.pitchPrimed;
  const pitchHoldUntil = g.pitchHoldUntil;
  if (!audioCtx || audioCtx.state === 'closed') return;
  const now = audioCtx.currentTime;
  const rampTime = 0.02;
  const set = (node, value) => {
    if (!node) return;
    if (immediate) node.gain.value = value;
    else node.gain.setTargetAtTime(value, now, rampTime);
  };

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
  // release instead of 0.2 s) or the bass-only leveler.
  const useBand = !isCompBypassed && dyn.leveler === 'bass';
  set(g.autoBalanceWetGain, !isCompBypassed && !useBand ? 1.0 : 0.0);
  set(g.autoBalanceBypassGain, isCompBypassed ? 1.0 : 0.0);
  set(g.bandLevelerGain, useBand ? 1.0 : 0.0);
  if (g.autoBalanceComp) {
    const release = dyn.leveler === 'slow' ? 0.6 : 0.2;
    if (g.autoBalanceComp.release.value !== release) g.autoBalanceComp.release.value = release;
  }

  // MATCH, LIM, CEIL: each a pair of gains, the 1.4.0 stage open by default.
  set(g.matchWetGain, dyn.match ? 1.0 : 0.0);
  set(g.matchDryGain, dyn.match ? 0.0 : 1.0);
  set(g.lookaheadGain, dyn.limiter === 'lookahead' ? 1.0 : 0.0);
  set(g.limiterFastGain, dyn.limiter === 'lookahead' ? 0.0 : 1.0);
  set(g.ceilingWarmGain, dyn.ceiling === 'warm' ? 1.0 : 0.0);
  set(g.ceilingCleanGain, dyn.ceiling === 'warm' ? 0.0 : 1.0);

  // The shifter is in the path only while a shift is set and it is producing audio (it adds about 0.14 s of delay);
  // 0 st is a true bypass, and the shifter is parked then.
  const shifting = !!pitchNode && pitchTarget() !== 0 && pitchPrimed && audioCtx.currentTime >= pitchHoldUntil;
  set(g.pitchWetGain, shifting ? 1.0 : 0.0);
  set(g.pitchDryGain, shifting ? 0.0 : 1.0);
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

// The shift the worklet is given: below 0.05 st it is exactly 0, which parks it.
function pitchTarget() {
  const st = pitchSetting();
  return Math.abs(st) >= 0.05 ? st : 0;
}

// Glide to a new shift in 30 ms. Going to 0, the value is set to exactly 0 once the crossfade back to the unshifted path
// is over (250 ms), so the shifter parks.
function schedulePitch(now, rampTime) {
  const p = pitchNode.parameters.get('semitones');
  const st = pitchTarget();
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.setTargetAtTime(st, now, rampTime);
  if (st === 0) p.setValueAtTime(0, now + 0.25);
}
