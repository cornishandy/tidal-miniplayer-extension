// dynamics.worklet.js - The alternative dynamics stages, each an AudioWorkletProcessor:
//
//   band-leveler       a leveler that acts only below 150 Hz: the "Bass only" mode of the AUTO stage (1.5.0, D-01)
//   loudness-match     trims the gain so the processed music is as loud as the untouched tab: the MATCH stage
//   lookahead-limiter  a peak limiter that sees 5 ms ahead and never lets a sample over its ceiling: the "Look-ahead" mode
//   unmud              a bass-keyed 250 Hz bell, 0 to −3 dB (1.6.0, D-09)
//   centre-bass        a side-only low shelf that narrows very wide bass (1.6.0, D-09)
//   bass-peaks         −8 dB reserve, then a bass-only peak catch after Master (1.6.0, D-09)
//   true-peak          a 4× Kaiser detector with a smoothed attack (1.6.0, D-09)
//
// None of them is in the signal path unless its mode is selected (offscreen.js routes around them with gains), so the
// default chain is the 1.4.0 chain unchanged. Each posts its working figure to the main thread every ~40 ms for the meters.
// The four D-09 processors treat a missing input as zeros, and a {type:'park'} message clears them and stops the node.

const METER_BLOCKS = 16; // 16 x 128 frames = 43 ms at 48 kHz

// ---- RBJ biquads (Direct Form I, one state per channel) ----
function coefs(type, f0, Q, fs, gainDb = 0) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cosw = Math.cos(w0), sinw = Math.sin(w0);
  const alpha = sinw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
    a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
  } else { // highshelf
    const A = Math.pow(10, gainDb / 40), sA = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cosw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cosw); b2 = A * ((A + 1) + (A - 1) * cosw - sA);
    a0 = (A + 1) - (A - 1) * cosw + sA; a1 = 2 * ((A - 1) - (A + 1) * cosw); a2 = (A + 1) - (A - 1) * cosw - sA;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  run(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const onePole = (seconds) => 1 - Math.exp(-1 / (seconds * sampleRate));
const dbOf = (ms) => 10 * Math.log10(ms + 1e-20);

// ---- Bass-only leveler ----
// Linkwitz-Riley 4th-order crossover at 150 Hz (two Butterworth sections per band); the two bands sum back flat.
// The low band drives a soft-knee gain computer (threshold -20 dBFS RMS, knee 20 dB, ratio 3.5:1, attack 10 ms,
// release 200 ms, detector 30 ms) and only the low band is turned down. No makeup gain: it never adds loudness.
const XOVER_HZ = 150;
class BandLeveler extends AudioWorkletProcessor {
  constructor() {
    super();
    const lp = coefs('lowpass', XOVER_HZ, Math.SQRT1_2, sampleRate);
    const hp = coefs('highpass', XOVER_HZ, Math.SQRT1_2, sampleRate);
    this.lp = [[new Biquad(lp), new Biquad(lp)], [new Biquad(lp), new Biquad(lp)]];
    this.hp = [[new Biquad(hp), new Biquad(hp)], [new Biquad(hp), new Biquad(hp)]];
    this.ms = 0;
    this.aDet = onePole(0.03);
    this.aAtt = onePole(0.01);
    this.aRel = onePole(0.2);
    this.T = -20; this.W = 20; this.R = 3.5;
    this.redDb = 0; // current reduction, <= 0
    this.meterMax = 0; this.blocks = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const oL = output[0], oR = output[1] || output[0];
    if (!input || input.length === 0) { oL.fill(0); if (oR !== oL) oR.fill(0); this.tick(0); return true; }
    const L = input[0], R = input[1] || input[0];
    const slope = 1 / this.R - 1;
    let maxRed = 0;
    for (let n = 0; n < L.length; n++) {
      const lowL = this.lp[0][1].run(this.lp[0][0].run(L[n]));
      const lowR = this.lp[1][1].run(this.lp[1][0].run(R[n]));
      const highL = this.hp[0][1].run(this.hp[0][0].run(L[n]));
      const highR = this.hp[1][1].run(this.hp[1][0].run(R[n]));
      const m = 0.5 * (lowL + lowR);
      this.ms += (m * m - this.ms) * this.aDet;
      const over = dbOf(this.ms) - this.T;
      let red = 0;
      if (2 * over > this.W) red = slope * over;
      else if (2 * over >= -this.W) { const k = over + this.W / 2; red = slope * k * k / (2 * this.W); }
      this.redDb += (red - this.redDb) * (red < this.redDb ? this.aAtt : this.aRel);
      const g = Math.pow(10, this.redDb / 20);
      oL[n] = highL + lowL * g;
      if (oR !== oL) oR[n] = highR + lowR * g;
      if (-this.redDb > maxRed) maxRed = -this.redDb;
    }
    this.tick(maxRed);
    return true;
  }
  tick(red) {
    if (red > this.meterMax) this.meterMax = red;
    if (++this.blocks >= METER_BLOCKS) { this.port.postMessage({ red: this.meterMax }); this.meterMax = 0; this.blocks = 0; }
  }
}

// ---- Loudness match ----
// Input 0: the processed signal (after the leveler, before Master Volume). Input 1: the untouched signal (before the
// HPF). Both are measured with the K-weighting of ITU-R BS.1770 (the measure streaming services use) over about 3 s,
// and the output is input 0 scaled so the two loudnesses agree; the scale moves slowly (0.4 s) and stays within
// -14 .. +6 dB. In silence the last value is held.
class LoudnessMatch extends AudioWorkletProcessor {
  constructor() {
    super();
    const shelf = coefs('highshelf', 1681.974450955533, 0.7071752369554196, sampleRate, 3.999843853973347);
    const hpf = coefs('highpass', 38.13547087602444, 0.5003270373238773, sampleRate);
    const chain = () => [new Biquad(shelf), new Biquad(hpf)];
    this.kProc = [chain(), chain()];
    this.kRef = [chain(), chain()];
    this.msProc = 0; this.msRef = 0;
    this.aMs = onePole(1.5);
    this.aG = onePole(0.4);
    this.g = 1; this.targetDb = 0;
    this.blocks = 0;
  }
  weigh(chains, L, R, n) {
    const a = chains[0][1].run(chains[0][0].run(L[n]));
    const b = chains[1][1].run(chains[1][0].run(R[n]));
    return 0.5 * (a * a + b * b);
  }
  process(inputs, outputs) {
    const proc = inputs[0], ref = inputs[1], output = outputs[0];
    const oL = output[0], oR = output[1] || output[0];
    if (!proc || proc.length === 0) { oL.fill(0); if (oR !== oL) oR.fill(0); this.tick(); return true; }
    const pL = proc[0], pR = proc[1] || proc[0];
    const hasRef = ref && ref.length > 0;
    const rL = hasRef ? ref[0] : null, rR = hasRef ? (ref[1] || ref[0]) : null;
    for (let n = 0; n < pL.length; n++) {
      this.msProc += (this.weigh(this.kProc, pL, pR, n) - this.msProc) * this.aMs;
      if (hasRef) this.msRef += (this.weigh(this.kRef, rL, rR, n) - this.msRef) * this.aMs;
      const gT = Math.pow(10, this.targetDb / 20);
      this.g += (gT - this.g) * this.aG;
      oL[n] = pL[n] * this.g;
      if (oR !== oL) oR[n] = pR[n] * this.g;
    }
    // New target once per block (the averages move slowly); hold in silence.
    if (this.msRef > 1e-7 && this.msProc > 1e-7) {
      this.targetDb = Math.max(-14, Math.min(6, dbOf(this.msRef) - dbOf(this.msProc)));
    }
    this.tick();
    return true;
  }
  tick() {
    if (++this.blocks >= METER_BLOCKS) { this.port.postMessage({ trim: 20 * Math.log10(this.g) }); this.blocks = 0; }
  }
}

// ---- Look-ahead limiter ----
// The audio is delayed by L = 5 ms. For every incoming sample the gain that would keep it under the ceiling is computed;
// a sliding minimum over the last L+1 of those, a release of 80 ms that can only raise the gain slowly, and a moving
// average over L+1 samples give the gain applied to the delayed sample. Every term of that average is a minimum over a
// window that contains the delayed sample, so the applied gain is never above what that sample needs: no sample can
// exceed the ceiling, and the gain reaches each peak by a straight 5 ms ramp instead of a step.
const LA_CEILING = 0.93; // -0.63 dBFS: just under the point where the clean output ceiling starts to bend
class LookaheadLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = Math.round(0.005 * sampleRate);
    const N = this.N = this.L + 1;
    this.dL = new Float32Array(N); this.dR = new Float32Array(N); this.dIdx = 0;
    // deque (ring). Sample indices are kept as doubles: an Int32Array wrapped after 2^31 samples (6.2 hours at 96 kHz) and
    // the expiry loop below then never ended, which stalled the whole audio engine (fixed in 1.5.2).
    this.qVal = new Float32Array(N + 1); this.qIdx = new Float64Array(N + 1); this.qHead = 0; this.qTail = 0;
    this.box = new Float64Array(N).fill(1); this.boxIdx = 0; this.boxSum = N;
    this.rel = 1; this.aRel = onePole(0.08);
    this.n = 0; this.since = 0;
    this.meterMin = 1; this.blocks = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const oL = output[0], oR = output[1] || output[0];
    const silent = !input || input.length === 0;
    const L = silent ? null : input[0], R = silent ? null : (input[1] || input[0]);
    const N = this.N, cap = N + 1;
    let minG = 1;
    for (let i = 0; i < oL.length; i++) {
      const xL = silent ? 0 : L[i], xR = silent ? 0 : R[i];
      const peak = Math.max(Math.abs(xL), Math.abs(xR));
      const gT = peak > LA_CEILING ? LA_CEILING / peak : 1;
      // sliding minimum over the last N targets (monotonic deque)
      while (this.qTail !== this.qHead) {
        const back = (this.qTail - 1 + cap) % cap;
        if (this.qVal[back] >= gT) this.qTail = back; else break;
      }
      this.qVal[this.qTail] = gT; this.qIdx[this.qTail] = this.n; this.qTail = (this.qTail + 1) % cap;
      while (this.qIdx[this.qHead] <= this.n - N) this.qHead = (this.qHead + 1) % cap;
      const m = this.qVal[this.qHead];
      // release: fall at once, rise slowly
      this.rel = m < this.rel ? m : this.rel + (m - this.rel) * this.aRel;
      // moving average over N
      this.boxSum += this.rel - this.box[this.boxIdx];
      this.box[this.boxIdx] = this.rel;
      this.boxIdx = this.boxIdx + 1 === N ? 0 : this.boxIdx + 1;
      const g = this.boxSum / N;
      // delayed sample out, new sample in
      const yL = this.dL[this.dIdx] * g, yR = this.dR[this.dIdx] * g;
      this.dL[this.dIdx] = xL; this.dR[this.dIdx] = xR;
      this.dIdx = this.dIdx + 1 === N ? 0 : this.dIdx + 1;
      oL[i] = yL; if (oR !== oL) oR[i] = yR;
      if (g < minG) minG = g;
      this.n++;
    }
    // re-sum the window now and then so rounding cannot drift the average
    if (++this.since >= 2048) { let s = 0; for (let k = 0; k < N; k++) s += this.box[k]; this.boxSum = s; this.since = 0; }
    if (minG < this.meterMin) this.meterMin = minG;
    if (++this.blocks >= METER_BLOCKS) { this.port.postMessage({ red: -20 * Math.log10(this.meterMin) }); this.meterMin = 1; this.blocks = 0; }
    return true;
  }
}

registerProcessor('band-leveler', BandLeveler);
registerProcessor('loudness-match', LoudnessMatch);
registerProcessor('lookahead-limiter', LookaheadLimiter);

// ---- D-09 helpers. The processors above are unchanged. ----
function peakingCoefs(f0, Q, fs, gainDb) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cosw = Math.cos(w0), sinw = Math.sin(w0);
  const alpha = sinw / (2 * Q);
  const A = Math.pow(10, gainDb / 40);
  const b0 = 1 + alpha * A, b1 = -2 * cosw, b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A, a1 = -2 * cosw, a2 = 1 - alpha / A;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function lerpCoef(a, b, t) {
  return {
    b0: a.b0 + (b.b0 - a.b0) * t, b1: a.b1 + (b.b1 - a.b1) * t, b2: a.b2 + (b.b2 - a.b2) * t,
    a1: a.a1 + (b.a1 - a.a1) * t, a2: a.a2 + (b.a2 - a.a2) * t
  };
}
function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 30; k++) {
    term *= x * x / (4 * k * k);
    sum += term;
    if (term < 1e-16 * sum) break;
  }
  return sum;
}
// Four 65-tap phases of a 257-tap Kaiser β12 lowpass, normalised so each phase sums to 1.
function kaiserPhases(beta) {
  const den = besselI0(beta);
  const phases = [];
  for (let p = 0; p < 4; p++) {
    const a = new Float64Array(65);
    let sum = 0;
    for (let k = 0; k < 65; k++) {
      const j = p + 4 * k;
      if (j > 256) continue;
      const m = j - 128;
      const z = m / 4;
      const sinc = m === 0 ? 1 : Math.sin(Math.PI * z) / (Math.PI * z);
      a[k] = sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - (m / 128) ** 2))) / den;
      sum += a[k];
    }
    for (let k = 0; k < 65; k++) a[k] /= sum;
    phases.push(a);
  }
  return phases;
}
function armPark(proc) {
  proc.parkRequested = false;
  proc.port.onmessage = (event) => {
    if (event.data && event.data.type === 'park') proc.parkRequested = true;
  };
}
function parked(proc) {
  proc.port.postMessage({ parked: true });
  return false;
}
function outs(outputs) {
  const output = outputs[0] || [];
  const oL = output[0];
  const oR = output[1] || oL;
  return { oL, oR, len: oL ? oL.length : 128 };
}
// A missing channel is zeros. A missing input is zeros for the whole block. Never copy one channel onto the other.
function sampleAt(input, channel, i) {
  if (!input || !input[channel]) return 0;
  const v = input[channel][i];
  return v === undefined ? 0 : v;
}

// ---- Unmud: bass-keyed bell after the high shelf ----
// Detector (input 1) is the HPF output, before the shelves. Stereo mean power, never (L+R)².
// 140 Hz lowpass, 20 ms RMS, −24 dBFS, 2:1, cap 3 dB, attack 5 ms, release 120 ms.
// The bell is 250 Hz, Q 1.2, depth 0 to −3 dB. Its coefficients are computed once per block and
// slewed across the block, so a block never replaces them in one sample and never calls trig per sample.
class Unmud extends AudioWorkletProcessor {
  constructor() {
    super();
    armPark(this);
    const lp = coefs('lowpass', 140, Math.SQRT1_2, sampleRate);
    this.det = [new Biquad(lp), new Biquad(lp)];
    const flat = peakingCoefs(250, 1.2, sampleRate, 0);
    this.bell = [new Biquad(flat), new Biquad(flat)];
    this.from = flat;
    this.target = flat;
    this.env = 0;
    this.ms = 0;
    this.aDet = onePole(0.02);
    this.aAtt = onePole(0.005);
    this.aRel = onePole(0.12);
    this.meterMax = 0;
    this.blocks = 0;
  }
  reset() {
    for (const b of this.det.concat(this.bell)) b.x1 = b.x2 = b.y1 = b.y2 = 0;
    const flat = peakingCoefs(250, 1.2, sampleRate, 0);
    this.from = flat;
    this.target = flat;
    this.bell[0].c = this.bell[1].c = flat;
    this.env = 0;
    this.ms = 0;
    this.meterMax = 0;
  }
  process(inputs, outputs) {
    const { oL, oR, len } = outs(outputs);
    if (!oL) return true;
    if (this.parkRequested) {
      this.reset();
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return parked(this);
    }
    const audio = inputs[0];
    const key = inputs[1];
    let maxDip = 0;
    for (let i = 0; i < len; i++) {
      const t = (i + 1) / len;
      const c = lerpCoef(this.from, this.target, t);
      this.bell[0].c = c;
      this.bell[1].c = c;
      const kL = this.det[0].run(sampleAt(key, 0, i));
      const kR = this.det[1].run(sampleAt(key, 1, i));
      const power = 0.5 * (kL * kL + kR * kR);
      this.ms += (power - this.ms) * this.aDet;
      const over = Math.max(0, dbOf(this.ms) + 24);
      const want = Math.min(3, over / 2);
      this.env += (want - this.env) * (want > this.env ? this.aAtt : this.aRel);
      if (this.env < 0) this.env = 0;
      if (this.env > 3) this.env = 3;
      oL[i] = this.bell[0].run(sampleAt(audio, 0, i));
      if (oR !== oL) oR[i] = this.bell[1].run(sampleAt(audio, 1, i));
      if (this.env > maxDip) maxDip = this.env;
    }
    this.from = this.target;
    this.target = peakingCoefs(250, 1.2, sampleRate, -this.env);
    if (maxDip > this.meterMax) this.meterMax = maxDip;
    if (++this.blocks >= METER_BLOCKS) {
      this.port.postMessage({ dip: this.meterMax });
      this.meterMax = 0;
      this.blocks = 0;
    }
    return true;
  }
}

// ---- Centre bass: side-only first-order shelf, mid untouched ----
// Analogue prototype (s + √g·ω) / (s + ω/√g), g = 10^(−8/20), bilinearly prewarped at 100 Hz.
// DC −8 dB, −4 dB at 100 Hz, unity at Nyquist. M = (L+R)/2 is not filtered.
class CentreBass extends AudioWorkletProcessor {
  constructor() {
    super();
    armPark(this);
    const a = Math.tan(Math.PI * 100 / sampleRate);
    const g = Math.pow(10, -8 / 40); // √(10^(−8/20))
    const den = 1 + a / g;
    this.b0 = (1 + g * a) / den;
    this.b1 = (g * a - 1) / den;
    this.a1 = (a / g - 1) / den;
    this.x = 0;
    this.y = 0;
  }
  reset() { this.x = 0; this.y = 0; }
  process(inputs, outputs) {
    const { oL, oR, len } = outs(outputs);
    if (!oL) return true;
    if (this.parkRequested) {
      this.reset();
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return parked(this);
    }
    const input = inputs[0];
    for (let i = 0; i < len; i++) {
      const l = sampleAt(input, 0, i);
      const r = sampleAt(input, 1, i);
      const mid = 0.5 * (l + r);
      const side = 0.5 * (l - r);
      const z = this.b0 * side + this.b1 * this.x - this.a1 * this.y;
      this.x = side;
      this.y = z;
      oL[i] = mid + z;
      if (oR !== oL) oR[i] = mid - z;
    }
    return true;
  }
}

// ---- Bass peaks: −8 dB common reserve, then a bass-only linked peak catch ----
// The reserve is applied here, before the crossover, and is not part of the meter.
// Linkwitz-Riley 4 at 150 Hz. The low band is held to 0.72 by a sliding minimum over
// N = round(0.005·fs)+1, an 80 ms release, and a moving average of that same length.
// The high band is delayed by N and summed back. Stereo linked on the low-band peak.
class BassPeaks extends AudioWorkletProcessor {
  constructor() {
    super();
    armPark(this);
    const lp = coefs('lowpass', XOVER_HZ, Math.SQRT1_2, sampleRate);
    const hp = coefs('highpass', XOVER_HZ, Math.SQRT1_2, sampleRate);
    this.lp = [[new Biquad(lp), new Biquad(lp)], [new Biquad(lp), new Biquad(lp)]];
    this.hp = [[new Biquad(hp), new Biquad(hp)], [new Biquad(hp), new Biquad(hp)]];
    this.N = Math.round(0.005 * sampleRate) + 1;
    const N = this.N;
    this.low = [new Float64Array(N), new Float64Array(N)];
    this.high = [new Float64Array(N), new Float64Array(N)];
    this.at = 0;
    this.qi = new Float64Array(N + 1);
    this.qv = new Float64Array(N + 1);
    this.head = 0;
    this.tail = 0;
    this.n = 0;
    this.box = new Float64Array(N).fill(1);
    this.boxSum = N;
    this.g = 1;
    this.aRel = onePole(0.08);
    this.reserve = Math.pow(10, -8 / 20);
    this.since = 0;
    this.meterMax = 0;
    this.blocks = 0;
  }
  reset() {
    const N = this.N;
    for (const ch of [0, 1]) {
      this.low[ch].fill(0);
      this.high[ch].fill(0);
      for (const pair of [this.lp[ch], this.hp[ch]]) for (const b of pair) b.x1 = b.x2 = b.y1 = b.y2 = 0;
    }
    this.at = 0;
    this.head = 0;
    this.tail = 0;
    this.n = 0;
    this.box.fill(1);
    this.boxSum = N;
    this.g = 1;
    this.since = 0;
    this.meterMax = 0;
  }
  process(inputs, outputs) {
    const { oL, oR, len } = outs(outputs);
    if (!oL) return true;
    if (this.parkRequested) {
      this.reset();
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return parked(this);
    }
    const input = inputs[0];
    const N = this.N;
    const cap = N + 1;
    let minG = 1;
    for (let i = 0; i < len; i++) {
      const xL = sampleAt(input, 0, i) * this.reserve;
      const xR = sampleAt(input, 1, i) * this.reserve;
      const lowL = this.lp[0][1].run(this.lp[0][0].run(xL));
      const lowR = this.lp[1][1].run(this.lp[1][0].run(xR));
      const highL = this.hp[0][1].run(this.hp[0][0].run(xL));
      const highR = this.hp[1][1].run(this.hp[1][0].run(xR));
      const peak = Math.max(Math.abs(lowL), Math.abs(lowR));
      const req = Math.min(1, 0.72 / Math.max(1e-30, peak));
      while (this.head !== this.tail) {
        const back = (this.tail - 1 + cap) % cap;
        if (this.qv[back] < req) break;
        this.tail = back;
      }
      this.qi[this.tail] = this.n;
      this.qv[this.tail] = req;
      this.tail = (this.tail + 1) % cap;
      while (this.qi[this.head] <= this.n - N) this.head = (this.head + 1) % cap;
      const want = this.qv[this.head];
      this.g = want < this.g ? want : this.g + (want - this.g) * this.aRel;
      this.boxSum += this.g - this.box[this.at];
      this.box[this.at] = this.g;
      const applied = this.boxSum / N;
      oL[i] = this.high[0][this.at] + this.low[0][this.at] * applied;
      if (oR !== oL) oR[i] = this.high[1][this.at] + this.low[1][this.at] * applied;
      this.low[0][this.at] = lowL;
      this.low[1][this.at] = lowR;
      this.high[0][this.at] = highL;
      this.high[1][this.at] = highR;
      this.at = this.at + 1 === N ? 0 : this.at + 1;
      if (applied < minG) minG = applied;
      this.n++;
    }
    if (++this.since >= 2048) {
      let s = 0;
      for (let k = 0; k < N; k++) s += this.box[k];
      this.boxSum = s;
      this.since = 0;
    }
    const red = -20 * Math.log10(Math.max(1e-12, minG));
    if (red > this.meterMax) this.meterMax = red;
    if (++this.blocks >= METER_BLOCKS) {
      this.port.postMessage({ red: this.meterMax });
      this.meterMax = 0;
      this.blocks = 0;
    }
    return true;
  }
}

// ---- True peak: Kaiser β12 257-tap 4× detector, smoothed attack ----
// Target −0.6 dBFS, release 50 ms. The gain is a sliding minimum over N = ceil(0.005·fs)+1
// followed by a moving average of that length (the same construction as the look-ahead limiter),
// so the attack is a ramp and not a step. The audio delay is N+32 samples, which lines the
// detector's 32-sample group delay up with the smoothed gain. Oversampling is the detector only.
class TruePeak extends AudioWorkletProcessor {
  constructor() {
    super();
    armPark(this);
    this.N = Math.ceil(0.005 * sampleRate) + 1;
    this.D = this.N + 32;
    const D = this.D;
    this.ring = [new Float64Array(D + 1), new Float64Array(D + 1)];
    this.hist = [new Float64Array(65), new Float64Array(65)];
    this.box = new Float64Array(this.N).fill(1);
    this.boxSum = this.N;
    this.boxAt = 0;
    this.since = 0;
    this.n = 0;
    this.g = 1;
    this.aRel = onePole(0.05);
    this.C = Math.pow(10, -0.6 / 20);
    this.cap = D + 4;
    this.qi = new Float64Array(this.cap);
    this.qv = new Float64Array(this.cap);
    this.head = 0;
    this.tail = 0;
    this.LA = this.N - 1;
    this.k = kaiserPhases(12);
    this.meterMax = 0;
    this.blocks = 0;
  }
  reset() {
    this.ring[0].fill(0);
    this.ring[1].fill(0);
    this.hist[0].fill(0);
    this.hist[1].fill(0);
    this.box.fill(1);
    this.boxSum = this.N;
    this.boxAt = 0;
    this.since = 0;
    this.n = 0;
    this.g = 1;
    this.head = 0;
    this.tail = 0;
    this.qi.fill(0);
    this.qv.fill(0);
    this.meterMax = 0;
  }
  process(inputs, outputs) {
    const { oL, oR, len } = outs(outputs);
    if (!oL) return true;
    if (this.parkRequested) {
      this.reset();
      oL.fill(0);
      if (oR !== oL) oR.fill(0);
      return parked(this);
    }
    const input = inputs[0];
    const D = this.D;
    const N = this.N;
    const cap = this.cap;
    const span = D + 1;
    let minG = 1;
    for (let j = 0; j < len; j++) {
      const h = this.n % 65;
      const r = this.n % span;
      const vL = sampleAt(input, 0, j);
      const vR = sampleAt(input, 1, j);
      this.hist[0][h] = vL;
      this.hist[1][h] = vR;
      this.ring[0][r] = vL;
      this.ring[1][r] = vR;
      let pk = 0;
      for (let c = 0; c < 2; c++) {
        const b = this.hist[c];
        for (let p = 0; p < 4; p++) {
          const a = this.k[p];
          let z = 0;
          for (let k = 0; k < 65; k++) {
            let q = h - k;
            if (q < 0) q += 65;
            z += a[k] * b[q];
          }
          const az = Math.abs(z);
          if (az > pk) pk = az;
        }
      }
      const req = Math.min(1, this.C / Math.max(1e-30, pk));
      while (this.head !== this.tail && this.qi[this.head] < this.n - this.LA) this.head = (this.head + 1) % cap;
      while (this.head !== this.tail) {
        const prev = (this.tail - 1 + cap) % cap;
        if (this.qv[prev] < req) break;
        this.tail = prev;
      }
      this.qi[this.tail] = this.n;
      this.qv[this.tail] = req;
      this.tail = (this.tail + 1) % cap;
      const want = this.qv[this.head];
      this.g = want < this.g ? want : this.g + (want - this.g) * this.aRel;
      this.boxSum += this.g - this.box[this.boxAt];
      this.box[this.boxAt] = this.g;
      this.boxAt = this.boxAt + 1 === N ? 0 : this.boxAt + 1;
      const applied = this.boxSum / N;
      let o = (this.n - D) % span;
      if (o < 0) o += span;
      const yL = this.n >= D ? this.ring[0][o] * applied : 0;
      const yR = this.n >= D ? this.ring[1][o] * applied : 0;
      oL[j] = yL;
      if (oR !== oL) oR[j] = yR;
      if (applied < minG) minG = applied;
      this.n++;
    }
    if (++this.since >= 262144) {
      let s = 0;
      for (let k = 0; k < N; k++) s += this.box[k];
      this.boxSum = s;
      this.since = 0;
    }
    const red = -20 * Math.log10(Math.max(1e-12, minG));
    if (red > this.meterMax) this.meterMax = red;
    if (++this.blocks >= METER_BLOCKS) {
      this.port.postMessage({ red: this.meterMax });
      this.meterMax = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('unmud', Unmud);
registerProcessor('centre-bass', CentreBass);
registerProcessor('bass-peaks', BassPeaks);
registerProcessor('true-peak', TruePeak);
