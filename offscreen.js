// offscreen.js - Web Audio DSP Pipeline & Tab Audio Routing Engine

let audioCtx = null;
let currentStream = null;
let sourceNode = null;
let isCapturing = false;

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
      startCapture(message.streamId, message.params)
        .then(res => sendResponse(res))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_AUDIO_CAPTURE':
    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse({ success: true });
      return true;

    case 'UPDATE_AUDIO_PARAMS':
    case 'UPDATE_PARAMS':
      updateParams(message.params);
      sendResponse({ success: true, currentParams });
      return true;

    case 'GET_AUDIO_STATUS':
      sendResponse({ isCapturing, currentParams, pitchAvailable: !!pitchNode, pitchError });
      return true;

    case 'GET_AUDIO_FRAME':
      // One snapshot of both spectra, in dB (0 = full-scale sine), for the popup's live display.
      if (isCapturing && inputAnalyser && outputAnalyser && audioCtx) {
        sendResponse({ isCapturing: true, input: spectrumPoints(inputAnalyser), output: spectrumPoints(outputAnalyser) });
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

async function startCapture(streamId, initialParams = {}) {
  try {
    if (isCapturing) stopCapture();

    Object.assign(currentParams, initialParams);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
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

    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    sourceNode = audioCtx.createMediaStreamSource(currentStream);

    // Pitch stage (key shift). The module is loaded per context; if that fails the EQ runs without it.
    pitchNode = null;
    pitchError = null;
    try {
      await audioCtx.audioWorklet.addModule(chrome.runtime.getURL(PITCH_WORKLET));
      pitchNode = new AudioWorkletNode(audioCtx, 'pitch-shifter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
      });
      pitchNode.parameters.get('semitones').value = pitchSetting();
    } catch (err) {
      pitchError = err.message;
    }
    pitchDryGain = audioCtx.createGain();
    pitchWetGain = audioCtx.createGain();

    // 1. Dual-Path Gain Nodes (True Bypass vs DSP Chain)
    directPassThroughGain = audioCtx.createGain();
    dspPathGain = audioCtx.createGain();

    // 2. High-Pass Filter (Anti-Distortion Sub-Bass Barrier)
    hpfNode = audioCtx.createBiquadFilter();
    hpfNode.type = 'highpass';
    const off = bypassState();
    hpfNode.frequency.value = off.hpf ? 20 : currentParams.hpf;
    hpfNode.Q.value = 0.707; // Butterworth response

    // 3. Low-Shelf & Peaking EQ
    bassNode = audioCtx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 120;
    bassNode.gain.value = off.bass ? 0 : currentParams.bass;

    midNode = audioCtx.createBiquadFilter();
    midNode.type = 'peaking';
    midNode.frequency.value = 1000;
    midNode.Q.value = 0.8;
    midNode.gain.value = off.mid ? 0 : currentParams.mid;

    // 4. High-Shelf Filter (Silky 5000Hz highs)
    highNode = audioCtx.createBiquadFilter();
    highNode.type = 'highshelf';
    highNode.frequency.value = 5000;
    highNode.gain.value = off.high ? 0 : currentParams.high;

    // 5. Auto-Balance Compressor (Gentle, musical leveler)
    autoBalanceComp = audioCtx.createDynamicsCompressor();
    autoBalanceComp.threshold.value = -18;
    autoBalanceComp.knee.value = 20;
    autoBalanceComp.ratio.value = 3.5;
    autoBalanceComp.attack.value = 0.01;
    autoBalanceComp.release.value = 0.2;

    autoBalanceBypassGain = audioCtx.createGain();
    autoBalanceWetGain = audioCtx.createGain();

    // 6. Master Volume / Gain
    volumeGain = audioCtx.createGain();
    volumeGain.gain.value = off.gain ? 1.0 : currentParams.gain;

    // 7. Master Brickwall Safety Limiter (Prevents DAC clipping & distortion)
    masterLimiter = audioCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -0.3; // -0.3 dBFS safety margin
    masterLimiter.knee.value = 0.0;
    masterLimiter.ratio.value = 20.0;
    masterLimiter.attack.value = 0.001;
    masterLimiter.release.value = 0.05;

    outputCeiling = audioCtx.createWaveShaper();
    outputCeiling.curve = makeCeilingCurve();
    outputCeiling.oversample = 'none';

    // 8. Display taps (no audio output of their own)
    inputAnalyser = audioCtx.createAnalyser();
    inputAnalyser.fftSize = 8192;
    inputAnalyser.smoothingTimeConstant = 0.75;
    outputAnalyser = audioCtx.createAnalyser();
    outputAnalyser.fftSize = 8192;
    outputAnalyser.smoothingTimeConstant = 0.75;

    // === Signal Routing Architecture ===
    // Source -> Split into:
    //   Path A: Direct Passthrough (for true bypass)
    //   Path B: DSP Chain -> Pitch (dry, or the shifter when a shift is set) -> HPF -> Bass -> Mid -> High -> Split into:
    //             -> AutoBalance Wet (Comp)
    //             -> AutoBalance Dry (Bypass)
    //          -> Sum -> Master Volume -> Master Limiter -> Output Ceiling -> Destination

    // Set routing gains before anything is connected so the first samples are not the
    // bypass and DSP paths summed together (both GainNodes default to 1.0).
    applyRoutingState({ immediate: true });

    sourceNode.connect(directPassThroughGain);
    directPassThroughGain.connect(audioCtx.destination);

    sourceNode.connect(dspPathGain);
    dspPathGain.connect(pitchDryGain);
    pitchDryGain.connect(hpfNode);
    if (pitchNode) {
      dspPathGain.connect(pitchNode);
      pitchNode.connect(pitchWetGain);
      pitchWetGain.connect(hpfNode);
    }
    hpfNode.connect(bassNode);
    bassNode.connect(midNode);
    midNode.connect(highNode);

    // Compressor wet/dry split
    highNode.connect(autoBalanceComp);
    autoBalanceComp.connect(autoBalanceWetGain);
    autoBalanceWetGain.connect(volumeGain);

    highNode.connect(autoBalanceBypassGain);
    autoBalanceBypassGain.connect(volumeGain);

    volumeGain.connect(masterLimiter);
    masterLimiter.connect(outputCeiling);
    outputCeiling.connect(audioCtx.destination);

    sourceNode.connect(inputAnalyser);
    outputCeiling.connect(outputAnalyser);

    isCapturing = true;

    return { success: true };
  } catch (err) {
    stopCapture();
    return { success: false, error: err.message };
  }
}

function stopCapture() {
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
  pitchDryGain = null;
  pitchWetGain = null;
  inputAnalyser = null;
  outputAnalyser = null;
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
  if (pitchNode) pitchNode.parameters.get('semitones').setTargetAtTime(pitchSetting(), now, rampTime);

  applyRoutingState();
}

function applyRoutingState({ immediate = false } = {}) {
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

  set(dspPathGain, isBypass ? 0.0 : 1.0);
  set(directPassThroughGain, isBypass ? 1.0 : 0.0);
  set(autoBalanceWetGain, isCompBypassed ? 0.0 : 1.0);
  set(autoBalanceBypassGain, isCompBypassed ? 1.0 : 0.0);

  // The shifter is in the path only while a shift is set (it adds about 0.14 s of delay); 0 st is a true bypass.
  const shifting = !!pitchNode && Math.abs(pitchSetting()) >= 0.05;
  set(pitchWetGain, shifting ? 1.0 : 0.0);
  set(pitchDryGain, shifting ? 0.0 : 1.0);
}
