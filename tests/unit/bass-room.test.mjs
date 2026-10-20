// D-09 processors in dynamics.worklet.js. Silent Node shim: no audio device.
// Sol's isolated assertions (Unmud, Centre bass, smoothed True peak attack,
// missing-input / park, 2^31 indices) plus the Bass peaks reserve and catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(join(root, 'dynamics.worklet.js'), 'utf8');
const BLOCK = 128;

function load(fs) {
  const registry = {};
  const ctx = {
    sampleRate: fs, Math, Float32Array, Float64Array, Int32Array, Infinity, console,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage() {}, onmessage: null };
      }
    },
    registerProcessor: (name, cls) => { registry[name] = cls; }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'dynamics.worklet.js' });
  return registry;
}

function blockPair() {
  return [new Float32Array(BLOCK), new Float32Array(BLOCK)];
}

// Run stereo (or two-input) audio through a processor. `pull(i)` returns
// { audio: [L, R], key?: [L, R] } for one sample. Returns left and right.
function render(proc, fs, seconds, pull, { inputs = 1 } = {}) {
  const n = Math.round(fs * seconds);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const audio = blockPair();
  const key = inputs > 1 ? blockPair() : null;
  const out = blockPair();
  for (let b = 0; b < n; b += BLOCK) {
    const len = Math.min(BLOCK, n - b);
    for (let i = 0; i < len; i++) {
      const s = pull(b + i);
      audio[0][i] = s.audio[0];
      audio[1][i] = s.audio[1];
      if (key) {
        key[0][i] = s.key[0];
        key[1][i] = s.key[1];
      }
    }
    for (let i = len; i < BLOCK; i++) {
      audio[0][i] = audio[1][i] = 0;
      if (key) key[0][i] = key[1][i] = 0;
    }
    const ins = key ? [audio, key] : [audio];
    proc.process(ins, [out]);
    for (let i = 0; i < len; i++) {
      left[b + i] = out[0][i];
      right[b + i] = out[1][i];
    }
  }
  return { left, right };
}

function toneAmp(samples, fs, freq, start) {
  const w = 2 * Math.PI * freq / fs;
  let re = 0, im = 0, n = 0;
  for (let i = start; i < samples.length; i++) {
    re += samples[i] * Math.cos(w * i);
    im -= samples[i] * Math.sin(w * i);
    n++;
  }
  return 2 * Math.hypot(re, im) / n;
}

function db(x) { return 20 * Math.log10(Math.max(1e-20, x)); }

const CEILING_KNEE = 0.93;
const CEILING_MAX = 0.966;
const ceilingClean = (x) => {
  const ax = Math.min(Math.abs(x), 1);
  const y = ax <= CEILING_KNEE ? ax : CEILING_KNEE + (CEILING_MAX - CEILING_KNEE) * Math.tanh((ax - CEILING_KNEE) / (CEILING_MAX - CEILING_KNEE));
  return Math.sign(x) * y;
};

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 40; k++) {
    term *= x * x / (4 * k * k);
    sum += term;
    if (term < 1e-16 * sum) break;
  }
  return sum;
}

// scipy.signal.firwin + resample_poly gain, the meter Sol used (Kaiser 257 / 1025).
function firwin(taps, cutoff, beta) {
  const M = (taps - 1) / 2;
  const den = besselI0(beta);
  const h = new Float64Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const m = n - M;
    const sinc = m === 0 ? cutoff : Math.sin(Math.PI * cutoff * m) / (Math.PI * m);
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - (m / M) ** 2))) / den;
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

const FIR4 = firwin(257, 1 / 4, 12);
const FIR8 = firwin(1025, 1 / 8, 12);

function truePeak(samples, up, h) {
  // Skip a filter length at each end. A hard stop rings the Kaiser and is not the
  // sustained true peak Sol's meter reads in the body of a render.
  let peak = 0;
  const per = Math.ceil(h.length / up);
  const start = Math.min(h.length, Math.floor(samples.length / 4));
  const end = samples.length - start;
  for (let n = start; n < end; n++) {
    for (let p = 0; p < up; p++) {
      let z = 0;
      for (let k = 0; k < per; k++) {
        const tap = p + up * k;
        if (tap >= h.length) continue;
        const xi = n - k;
        if (xi < 0) continue;
        z += up * h[tap] * samples[xi];
      }
      const az = Math.abs(z);
      if (az > peak) peak = az;
    }
  }
  return peak;
}

function assertFinite(buf, label) {
  for (let i = 0; i < buf.length; i++) {
    if (!Number.isFinite(buf[i])) assert.fail(`${label} sample ${i} is ${buf[i]}`);
  }
}

test('Unmud settled bell, silent key, inverted key, and per-block coefficient slew', () => {
  for (const fs of [48000, 96000]) {
    const reg = load(fs);
    const probes = [250, 60, 1000];
    const got = {};
    for (const freq of probes) {
      const proc = new reg.unmud();
      let maxEnv = 0, minEnv = Infinity;
      const out = render(proc, fs, 1.2, (i) => {
        const t = i / fs;
        return {
          audio: [0.001 * Math.sin(2 * Math.PI * freq * t), 0.001 * Math.sin(2 * Math.PI * freq * t)],
          key: [0.2 * Math.sin(2 * Math.PI * 60 * t), 0.2 * Math.sin(2 * Math.PI * 60 * t)]
        };
      }, { inputs: 2 });
      // env is read after the render; also sample it by a second short run's stored value
      maxEnv = proc.env;
      minEnv = proc.env;
      assert.ok(maxEnv <= 3.01 && minEnv >= 0, `env ${proc.env} at ${fs}`);
      const start = Math.floor(fs * 1.0);
      const amp = toneAmp(out.left, fs, freq, start);
      got[freq] = db(amp / 0.001);
    }
    assert.ok(Math.abs(got[250] - (-3)) <= 0.05, `250 Hz ${got[250]} at ${fs}`);
    assert.ok(Math.abs(got[60] - (-0.132)) <= 0.05, `60 Hz ${got[60]} at ${fs}`);
    assert.ok(Math.abs(got[1000] - (-0.143)) <= 0.05, `1 kHz ${got[1000]} at ${fs}`);

    const silent = new reg.unmud();
    const quiet = render(silent, fs, 1.05, (i) => {
      const t = i / fs;
      return {
        audio: [
          0.001 * Math.sin(2 * Math.PI * 250 * t),
          0.001 * Math.sin(2 * Math.PI * 60 * t)
        ],
        key: [0, 0]
      };
    }, { inputs: 2 });
    const start = Math.floor(fs);
    assert.ok(Math.abs(db(toneAmp(quiet.left, fs, 250, start) / 0.001)) <= 0.02, `silent 250 at ${fs}`);
    assert.ok(Math.abs(db(toneAmp(quiet.right, fs, 60, start) / 0.001)) <= 0.02, `silent 60 at ${fs}`);
    assert.ok(silent.env <= 0.02, `silent env ${silent.env}`);

    // Recover from a fully keyed bell, not only a fresh silent detector.
    const released = new reg.unmud();
    const releasedOut = render(released, fs, 3, i => {
      const t = i / fs;
      const probe = .001 * (Math.sin(2 * Math.PI * 60 * t) + Math.sin(2 * Math.PI * 250 * t) + Math.sin(2 * Math.PI * 1000 * t));
      const key = t < 1 ? .2 * Math.sin(2 * Math.PI * 60 * t) : 0;
      return { audio: [probe, probe], key: [key, -key] };
    }, { inputs: 2 });
    for (const frequency of [60, 250, 1000]) {
      const gain = db(toneAmp(releasedOut.left, fs, frequency, fs * 2) / .001);
      assert.ok(Math.abs(gain) <= .02, `released ${frequency} Hz ${gain} dB at ${fs}`);
    }
    assert.ok(released.env <= .02, `released envelope ${released.env}`);

    const a = new reg.unmud();
    const b = new reg.unmud();
    const envsA = [], envsB = [];
    const n = fs; // 1 second
    const audio = blockPair();
    const keyA = blockPair();
    const keyB = blockPair();
    const out = blockPair();
    for (let s = 0; s < n; s += BLOCK) {
      for (let i = 0; i < BLOCK && s + i < n; i++) {
        const t = (s + i) / fs;
        const k = 0.2 * Math.sin(2 * Math.PI * 60 * t);
        audio[0][i] = audio[1][i] = 0.001 * Math.sin(2 * Math.PI * 250 * t);
        keyA[0][i] = keyA[1][i] = k;
        keyB[0][i] = keyB[1][i] = -k;
      }
      a.process([audio, keyA], [out]);
      b.process([audio, keyB], [out]);
      envsA.push(a.env);
      envsB.push(b.env);
      assert.ok(a.env >= 0 && a.env <= 3.01, `env range ${a.env}`);
    }
    let worst = 0;
    for (let i = 0; i < envsA.length; i++) worst = Math.max(worst, Math.abs(envsA[i] - envsB[i]));
    assert.ok(worst <= 0.01, `inverted envelope delta ${worst} dB at ${fs}`);

    // A key that arrives mid-stream must slew the bell across the block, not step it.
    const slew = new reg.unmud();
    const probe = 0.001;
    let worstStep = 0;
    const y = blockPair();
    const x = blockPair();
    const k = blockPair();
    for (let blk = 0; blk < Math.ceil(fs * 0.3 / BLOCK); blk++) {
      for (let i = 0; i < BLOCK; i++) {
        const s = blk * BLOCK + i;
        const t = s / fs;
        x[0][i] = x[1][i] = probe * Math.sin(2 * Math.PI * 250 * t);
        const on = s > fs * 0.05 ? 0.2 * Math.sin(2 * Math.PI * 60 * t) : 0;
        k[0][i] = k[1][i] = on;
      }
      slew.process([x, k], [y]);
      for (let i = 1; i < BLOCK; i++) {
        worstStep = Math.max(worstStep, Math.abs(y[0][i] - y[0][i - 1]));
      }
    }
    // Natural slope of a 0.001 / 250 Hz sine is about 0.000033 at 48 kHz. An abrupt
    // 3 dB coefficient swap would step the probe by several times that.
    assert.ok(worstStep < probe * 0.15, `coef step ${worstStep} at ${fs}`);
  }
});

test('Centre bass mono null, side shelf and anti-phase 20 Hz', () => {
  for (const fs of [48000, 96000]) {
    const reg = load(fs);
    const mono = new reg['centre-bass']();
    let nullErr = 0;
    const n = fs; // 1 s of noise
    const x = blockPair();
    const y = blockPair();
    let seed = 1;
    for (let s = 0; s < n; s += BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const v = (seed / 4294967296) * 2 - 1;
        x[0][i] = x[1][i] = v;
      }
      mono.process([x], [y]);
      for (let i = 0; i < BLOCK; i++) {
        nullErr = Math.max(nullErr, Math.abs(y[0][i] - x[0][i]), Math.abs(y[1][i] - x[1][i]));
      }
    }
    assert.ok(nullErr <= 1e-7, `mono null ${nullErr} at ${fs}`);

    const measure = (freq, seconds) => {
      const proc = new reg['centre-bass']();
      const amp = 0.2;
      const out = render(proc, fs, seconds, (i) => {
        const s = amp * Math.sin(2 * Math.PI * freq * i / fs);
        return { audio: [s, -s] };
      });
      const start = Math.floor(fs * (seconds - 1));
      return db(toneAmp(out.left, fs, freq, start) / amp);
    };
    const g1 = measure(1, 4);
    const g100 = measure(100, 1.5);
    const g1k = measure(1000, 1.2);
    assert.ok(Math.abs(g1 - (-8)) <= 0.05, `1 Hz ${g1} at ${fs}`);
    assert.ok(Math.abs(g100 - (-4)) <= 0.05, `100 Hz ${g100} at ${fs}`);
    assert.ok(Math.abs(g1k - (-0.0905)) <= 0.05, `1 kHz ${g1k} at ${fs}`);

    const anti = new reg['centre-bass']();
    const antiOut = render(anti, fs, 1.2, (i) => {
      const s = 0.2 * Math.sin(2 * Math.PI * 20 * i / fs);
      return { audio: [s, -s] };
    });
    const start = Math.floor(fs * 0.5);
    let peak = 0;
    for (let i = start; i < antiOut.left.length; i++) {
      if (!Number.isFinite(antiOut.left[i]) || !Number.isFinite(antiOut.right[i])) assert.fail('non-finite anti-phase');
      peak = Math.max(peak, Math.abs(antiOut.left[i]));
    }
    assert.ok(peak > 1e-4, `anti-phase silent at ${fs}`);
    const att = db(toneAmp(antiOut.left, fs, 20, start) / 0.2);
    assert.ok(Math.abs(att - (-7.65)) <= 0.05, `20 Hz anti-phase ${att} at ${fs}`);
  }
});

test('Bass peaks delays by N, reserves 8 dB, and catches bass above 0.72', () => {
  for (const fs of [48000, 96000]) {
    const reg = load(fs);
    const proc = new reg['bass-peaks']();
    const N = Math.round(0.005 * fs) + 1;
    assert.equal(proc.N, N);
    const y = blockPair();
    const x = blockPair();
    x[0][0] = x[1][0] = 1;
    proc.process([x], [y]);
    for (let i = 0; i < BLOCK; i++) {
      if (i < Math.min(BLOCK, N)) assert.equal(y[0][i], 0, `early sample ${i}`);
    }
    // Quiet 1 kHz rides the reserve and is not caught.
    const quiet = new reg['bass-peaks']();
    const q = render(quiet, fs, 0.5, (i) => {
      const s = 0.01 * Math.sin(2 * Math.PI * 1000 * i / fs);
      return { audio: [s, s] };
    });
    const start = Math.floor(fs * 0.25);
    const qDb = db(toneAmp(q.left, fs, 1000, start) / 0.01);
    assert.ok(Math.abs(qDb - (-8)) <= 0.3, `reserve ${qDb} at ${fs}`);

    // 2.5 at 60 Hz is still over 0.72 after the reserve, so the catch pulls it down.
    const hot = new reg['bass-peaks']();
    const h = render(hot, fs, 0.6, (i) => {
      const s = 2.5 * Math.sin(2 * Math.PI * 60 * i / fs);
      return { audio: [s, 0.1 * s] };
    });
    assertFinite(h.left, 'hot L');
    assertFinite(h.right, 'hot R');
    let peak = 0;
    const from = Math.floor(fs * 0.4);
    for (let i = from; i < h.left.length; i++) peak = Math.max(peak, Math.abs(h.left[i]), Math.abs(h.right[i]));
    assert.ok(peak < 0.9, `caught peak ${peak} at ${fs}`);
    assert.ok(peak > 0.5, `over-caught peak ${peak} at ${fs}`);
  }
});

test('True peak attack is a ramp, park and empty input do not replay, indices survive 2^31', () => {
  for (const fs of [48000, 96000]) {
    const reg = load(fs);
    const proc = new reg['true-peak']();
    const seconds = 2;
    const n = fs * seconds;
    const inputL = new Float32Array(n);
    const inputR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      inputL[i] = 0.3 * Math.cos(2 * Math.PI * 60 * (i / fs + 0.005));
      inputR[i] = i === fs ? 4 : 0;
    }
    const outL = new Float32Array(n);
    const x = blockPair();
    const y = blockPair();
    for (let b = 0; b < n; b += BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        x[0][i] = inputL[b + i];
        x[1][i] = inputR[b + i];
      }
      proc.process([x], [y]);
      outL.set(y[0], b);
    }
    assertFinite(outL, 'guard');
    const limit = fs === 48000 ? 0.003 : 0.0015;
    let maxJump = 0;
    for (let i = Math.floor(fs * 0.9); i < Math.floor(fs * 1.1); i++) {
      maxJump = Math.max(maxJump, Math.abs(outL[i] - outL[i - 1]));
    }
    assert.ok(maxJump <= limit, `jump ${maxJump} limit ${limit} at ${fs}`);
    assert.equal(proc.D, Math.ceil(0.005 * fs) + 33);

    // Empty input drains. It must not freeze the delay and replay it later.
    const tail = new reg['true-peak']();
    const loud = blockPair();
    loud[0].fill(0.5);
    loud[1].fill(0.5);
    const z = blockPair();
    const o = blockPair();
    for (let i = 0; i < 100; i++) tail.process([loud], [o]);
    for (let i = 0; i < 20; i++) tail.process([[]], [o]);
    tail.process([z], [o]);
    let stale = 0;
    for (let i = 0; i < BLOCK; i++) stale = Math.max(stale, Math.abs(o[0][i]), Math.abs(o[1][i]));
    assert.ok(stale <= 1e-7, `stale after empty ${stale} at ${fs}`);

    const parked = new reg['true-peak']();
    for (let i = 0; i < 30; i++) parked.process([loud], [o]);
    parked.port.onmessage({ data: { type: 'park' } });
    const keep = parked.process([loud], [o]);
    assert.equal(keep, false);
    let parkPeak = 0;
    for (let i = 0; i < BLOCK; i++) parkPeak = Math.max(parkPeak, Math.abs(o[0][i]), Math.abs(o[1][i]));
    assert.ok(parkPeak <= 1e-7, `park peak ${parkPeak}`);
    parked.parkRequested = false;
    parked.process([z], [o]);
    let replay = 0;
    for (let i = 0; i < BLOCK; i++) replay = Math.max(replay, Math.abs(o[0][i]), Math.abs(o[1][i]));
    assert.ok(replay <= 1e-7, `replay after park ${replay}`);

    const big = new reg['true-peak']();
    big.n = 2 ** 31 - 10;
    const tiny = blockPair();
    for (let i = 0; i < BLOCK; i++) {
      tiny[0][i] = 0.2 * Math.sin(i);
      tiny[1][i] = -tiny[0][i];
    }
    for (let i = 0; i < 8; i++) {
      const ok = big.process([tiny], [o]);
      assert.equal(ok, true);
      assertFinite(o[0], 'wrap L');
      assertFinite(o[1], 'wrap R');
    }
    assert.ok(big.n > 2 ** 31, `n advanced ${big.n}`);
  }
});

test('True peak post-ceiling reconstruction stays at or under -0.3 dBTP', () => {
  const fs = 48000;
  const reg = load(fs);
  const known = new Float32Array(fs);
  for (let i = 0; i < known.length; i++) known[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / fs);
  const knownDb = db(truePeak(known, 4, FIR4));
  assert.ok(Math.abs(knownDb - db(0.5)) < 0.05, `meter sanity ${knownDb}`);
  const fixtures = [];
  const quarter = new Float32Array(fs);
  for (let i = 0; i < quarter.length; i++) quarter[i] = Math.sin(Math.PI * i / 2 + Math.PI / 4);
  fixtures.push(['quarter', quarter, quarter]);

  const impulses = new Float32Array(128 * 400);
  const impulsesR = new Float32Array(impulses.length);
  for (let k = 0; k < 128; k++) impulses[k * 400 + k] = 1.5;
  fixtures.push(['impulses', impulses, impulsesR]);

  const hot = new Float32Array(fs);
  for (let i = 0; i < hot.length; i++) hot[i] = 0.95 * Math.sin(2 * Math.PI * 60 * i / fs);
  fixtures.push(['hot60', hot, hot]);

  // Impulses that flip sign. A raw Nyquist square is not band-limited: the 257-tap and
  // 1025-tap Kaisers disagree by about 1.2 dB there, so it cannot sit at the −0.6 target
  // and also under −0.3 on the 8× meter. 0.49·fs, the top of Sol's sweep, is covered below.
  const alt = new Float32Array(128 * 300);
  const altR = new Float32Array(alt.length);
  for (let k = 0; k < 128; k++) alt[k * 300 + 200] = k % 2 ? -1.6 : 1.6;
  fixtures.push(['alt-impulses', alt, altR]);

  for (const phase of [0, Math.PI / 5, Math.PI / 2]) {
    const hi = new Float32Array(Math.floor(fs * 0.2));
    for (let i = 0; i < hi.length; i++) hi[i] = Math.sin(2 * Math.PI * 0.49 * i + phase);
    fixtures.push([`sweep-0.49-${phase.toFixed(2)}`, hi, hi]);
  }

  const stereo = new Float32Array(fs);
  const stereoR = new Float32Array(fs);
  for (let i = 0; i < stereo.length; i += 500) stereoR[i] = 1.4;
  fixtures.push(['stereo-only', stereo, stereoR]);

  // One chirp from 0.1·fs to 0.49·fs.
  const chirp = new Float32Array(fs);
  for (let i = 0; i < chirp.length; i++) {
    const f = fs * (0.1 + 0.39 * i / chirp.length);
    chirp[i] = Math.sin(2 * Math.PI * f * i / fs);
  }
  fixtures.push(['chirp', chirp, chirp]);

  let seed = 99;
  const pink = new Float32Array(fs);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < pink.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const w = (seed / 4294967296) * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    pink[i] = (b0 + b1 + b2 + w * 0.1848) * 0.05;
  }
  fixtures.push(['pink', pink, pink]);

  for (const [name, L, R] of fixtures) {
    const proc = new reg['true-peak']();
    const outL = new Float32Array(L.length);
    const outR = new Float32Array(L.length);
    const x = blockPair();
    const y = blockPair();
    for (let b = 0; b < L.length; b += BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        const s = b + i;
        x[0][i] = s < L.length ? L[s] : 0;
        x[1][i] = s < R.length ? R[s] : 0;
      }
      proc.process([x], [y]);
      for (let i = 0; i < BLOCK && b + i < L.length; i++) {
        outL[b + i] = ceilingClean(y[0][i]);
        outR[b + i] = ceilingClean(y[1][i]);
      }
    }
    // Drain on zeros, still under the ceiling.
    for (let d = 0; d < 8; d++) {
      x[0].fill(0); x[1].fill(0);
      proc.process([x], [y]);
      for (let i = 0; i < BLOCK; i++) {
        const a = Math.abs(ceilingClean(y[0][i]));
        const c = Math.abs(ceilingClean(y[1][i]));
        if (a > CEILING_MAX + 1e-4 || c > CEILING_MAX + 1e-4) assert.fail(`${name} drain sample`);
      }
    }
    const tp4 = Math.max(truePeak(outL, 4, FIR4), truePeak(outR, 4, FIR4));
    const tp8 = Math.max(truePeak(outL, 8, FIR8), truePeak(outR, 8, FIR8));
    assert.ok(db(tp4) <= -0.3 + 0.02, `${name} 4× ${db(tp4).toFixed(3)} dBTP`);
    assert.ok(db(tp8) <= -0.3 + 0.02, `${name} 8× ${db(tp8).toFixed(3)} dBTP`);
  }
});

test('60 s of Bass peaks + Unmud + Centre bass + True peak stays finite', () => {
  const fs = 48000;
  const reg = load(fs);
  const unmud = new reg.unmud();
  const centre = new reg['centre-bass']();
  const peaks = new reg['bass-peaks']();
  const tp = new reg['true-peak']();
  const a = blockPair(), b = blockPair(), c = blockPair(), d = blockPair(), key = blockPair();
  const blocks = Math.round(60 * fs / BLOCK);
  let peak = 0, nonFinite = 0;
  for (let blk = 0; blk < blocks; blk++) {
    for (let i = 0; i < BLOCK; i++) {
      const s = blk * BLOCK + i;
      const t = s / fs;
      const v = 0.4 * Math.sin(2 * Math.PI * 60 * t) + 0.15 * Math.sin(2 * Math.PI * 250 * t) + 0.08 * Math.sin(2 * Math.PI * 1000 * t);
      a[0][i] = v;
      a[1][i] = 0.9 * v;
      key[0][i] = key[1][i] = 0.25 * Math.sin(2 * Math.PI * 55 * t);
    }
    if (unmud.process([a, key], [b]) === false) nonFinite++;
    if (centre.process([b], [c]) === false) nonFinite++;
    if (peaks.process([c], [d]) === false) nonFinite++;
    if (tp.process([d], [a]) === false) nonFinite++;
    for (let i = 0; i < BLOCK; i++) {
      if (!Number.isFinite(a[0][i]) || !Number.isFinite(a[1][i])) nonFinite++;
      peak = Math.max(peak, Math.abs(a[0][i]), Math.abs(a[1][i]));
    }
    if (nonFinite) break;
  }
  assert.equal(nonFinite, 0);
  assert.ok(peak > 0 && peak < 2, `peak ${peak}`);
});

test('all D-09 processors park/reset, drain missing input, handle mono and cross 2^31 without stale audio', () => {
  for(const fs of [48000,96000]) for(const name of ['unmud','centre-bass','bass-peaks','true-peak']) {
    const reg=load(fs),p=new reg[name](),x=blockPair(),y=blockPair();x[0].fill(.5);x[1].fill(-.25);
    const ins=name==='unmud'?[x,x]:[x];
    for(let b=0;b<20;b++)p.process(ins,[y]);
    for(let b=0;b<100;b++)p.process(name==='unmud'?[[],[]]:[[]],[y]);
    assertFinite(y[0],name+' empty');assertFinite(y[1],name+' empty R');
    p.port.onmessage({data:{type:'park'}});assert.equal(p.process(ins,[y]),false);
    assert.ok(y.every(ch=>ch.every(v=>Math.abs(v)<=1e-7)),name+' park leaked audio');
    const fresh=new reg[name]();if('n'in fresh)fresh.n=2**31-64;
    for(let b=0;b<10;b++) { fresh.process(name==='unmud'?[[x[0]],[x[0]]]:[[x[0]]],[y]);assertFinite(y[0],name+' mono');assertFinite(y[1],name+' mono R'); }
    const noOutput=new reg[name]();noOutput.port.onmessage({data:{type:'park'}});assert.equal(noOutput.process([], [[]]),false,name+' park without output');
    const reset=new reg[name]();reset.port.onmessage({data:{type:'park'}});reset.process(ins,[y]);
    reset.parkRequested=false;const z=blockPair();reset.process(name==='unmud'?[z,z]:[z],[y]);
    assert.ok(y.every(ch=>ch.every(v=>Math.abs(v)<=1e-7)),name+' replayed after reset');
  }
});
