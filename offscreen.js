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
  pitch: 1.0,
  autoBalance: true,
  bypass: false,
  stageBypass: {
    hpf: false,
    eq: false,
    comp: false,
    gain: false
  }
};

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
      sendResponse({ isCapturing, currentParams });
      return true;
  }
});

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

    // 1. Dual-Path Gain Nodes (True Bypass vs DSP Chain)
    directPassThroughGain = audioCtx.createGain();
    dspPathGain = audioCtx.createGain();

    // 2. High-Pass Filter (Anti-Distortion Sub-Bass Barrier)
    hpfNode = audioCtx.createBiquadFilter();
    hpfNode.type = 'highpass';
    hpfNode.frequency.value = currentParams.stageBypass?.hpf ? 20 : currentParams.hpf;
    hpfNode.Q.value = 0.707; // Butterworth response

    // 3. Low-Shelf & Peaking EQ
    bassNode = audioCtx.createBiquadFilter();
    bassNode.type = 'lowshelf';
    bassNode.frequency.value = 120;
    bassNode.gain.value = currentParams.stageBypass?.eq ? 0 : currentParams.bass;

    midNode = audioCtx.createBiquadFilter();
    midNode.type = 'peaking';
    midNode.frequency.value = 1000;
    midNode.Q.value = 0.8;
    midNode.gain.value = currentParams.stageBypass?.eq ? 0 : currentParams.mid;

    // 4. High-Shelf Filter (Silky 5000Hz highs)
    highNode = audioCtx.createBiquadFilter();
    highNode.type = 'highshelf';
    highNode.frequency.value = 5000;
    highNode.gain.value = currentParams.stageBypass?.eq ? 0 : currentParams.high;

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
    volumeGain.gain.value = currentParams.stageBypass?.gain ? 1.0 : currentParams.gain;

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

    // === Signal Routing Architecture ===
    // Source -> Split into:
    //   Path A: Direct Passthrough (for true bypass)
    //   Path B: DSP Chain -> HPF -> Bass -> Mid -> High -> Split into:
    //             -> AutoBalance Wet (Comp)
    //             -> AutoBalance Dry (Bypass)
    //          -> Sum -> Master Volume -> Master Limiter -> Output Ceiling -> Destination

    // Set routing gains before anything is connected so the first samples are not the
    // bypass and DSP paths summed together (both GainNodes default to 1.0).
    applyRoutingState({ immediate: true });

    sourceNode.connect(directPassThroughGain);
    directPassThroughGain.connect(audioCtx.destination);

    sourceNode.connect(dspPathGain);
    dspPathGain.connect(hpfNode);
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
}

function updateParams(newParams) {
  if (!newParams) return;
  Object.assign(currentParams, newParams);

  if (!audioCtx || audioCtx.state === 'closed') return;

  const now = audioCtx.currentTime;
  const rampTime = 0.03; // 30ms smooth crossfade to eliminate pops

  if (hpfNode) {
    const targetHpf = currentParams.stageBypass?.hpf ? 20 : (currentParams.hpf || 30);
    hpfNode.frequency.setTargetAtTime(targetHpf, now, rampTime);
  }

  if (bassNode) {
    const targetBass = currentParams.stageBypass?.eq ? 0 : (currentParams.bass || 0);
    bassNode.gain.setTargetAtTime(targetBass, now, rampTime);
  }

  if (midNode) {
    const targetMid = currentParams.stageBypass?.eq ? 0 : (currentParams.mid || 0);
    midNode.gain.setTargetAtTime(targetMid, now, rampTime);
  }

  if (highNode) {
    const targetHigh = currentParams.stageBypass?.eq ? 0 : (currentParams.high || 0);
    highNode.gain.setTargetAtTime(targetHigh, now, rampTime);
  }

  if (volumeGain) {
    const targetGain = currentParams.stageBypass?.gain ? 1.0 : (currentParams.gain || 1.0);
    volumeGain.gain.setTargetAtTime(targetGain, now, rampTime);
  }

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
  const isCompBypassed = currentParams.stageBypass?.comp || !currentParams.autoBalance;

  set(dspPathGain, isBypass ? 0.0 : 1.0);
  set(directPassThroughGain, isBypass ? 1.0 : 0.0);
  set(autoBalanceWetGain, isCompBypassed ? 0.0 : 1.0);
  set(autoBalanceBypassGain, isCompBypassed ? 1.0 : 0.0);
}
