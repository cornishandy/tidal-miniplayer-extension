// R-29: display math only, extracted without booting the popup or creating audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../popup.js', import.meta.url), 'utf8');
const model = source.slice(source.indexOf('const EqCuts ='), source.indexOf('// ---------- End band cut model'));
const cuts = vm.runInNewContext(`${model}\nEqCuts`);
const near = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} ± ${tolerance}`);
const flat = { bass: 0, mid: 0, high: 0, gain: 1, semitones: 0, stageBypass: { hpf: true } };
const frame = (lift = -10) => ({
  isCapturing: true, input: Array(72).fill(-30), output: Array(72).fill(-30 + lift)
});

test('cut model: Web Audio shelves, peak and HPF have their known magnitudes', () => {
  near(cuts.biquadDb('lowshelf', 60, 120, 28, 0, 48000), 23.9, 0.1);
  for (const rate of [44100, 48000, 96000]) {
    near(cuts.biquadDb('peaking', 1000, 1000, 24, 0.8, rate), 24);
    near(cuts.biquadDb('peaking', 1000, 1000, -24, 0.8, rate), -24);
    near(cuts.biquadDb('lowshelf', 120, 120, 28, 0, rate), 14);
    near(cuts.biquadDb('highshelf', 5000, 5000, 24, 0, rate), 12);
    near(cuts.biquadDb('highshelf', 5000, 5000, -24, 0, rate), -12);
    // Q=.707 is dB for Web Audio highpass, NOT a linear Butterworth Q.
    near(cuts.biquadDb('highpass', 80, 80, 0, 0.707, rate), 0.707);
  }
});

test('cut model: asked-for response combines only enabled stages, including Master', () => {
  const p = { bass: 28, hpf: 80, mid: 24, high: 12, gain: 2.5 };
  const f = 1000;
  const components = {
    bass: cuts.biquadDb('lowshelf', f, 120, 28, 0, 48000),
    hpf: cuts.biquadDb('highpass', f, 80, 0, 0.707, 48000),
    mid: 24,
    high: cuts.biquadDb('highshelf', f, 5000, 12, 0, 48000),
    gain: 20 * Math.log10(2.5)
  };
  const total = Object.values(components).reduce((a, b) => a + b, 0);
  near(cuts.askedDb(p, f), total);
  for (const [band, db] of Object.entries(components)) {
    near(cuts.askedDb({ ...p, stageBypass: { [band]: true } }, f), total - db);
  }
  near(cuts.askedDb({ ...p, bypass: true }, f), 0);
  near(cuts.askedDb({ ...flat, mid: 24, gain: 2 }, f), 30.020599913279625);
});

test('cut model: each band selects the centres of the correct logarithmic spans', () => {
  assert.deepEqual(Array.from(cuts.points.bass), [8, 9, 10, 11, 12, 13]);
  assert.deepEqual(Array.from(cuts.points.mid), [38, 39, 40, 41, 42]);
  assert.deepEqual(Array.from(cuts.points.high), [59, 60, 61, 62, 63, 64]);
  near(cuts.frequencies[0], Math.sqrt(20 * (20 * 1000 ** (1 / 72))));
});

test('cut model: floor includes -70 dB; each band needs two finite input/output points', () => {
  const f = frame();
  f.input.fill(-70.01);
  const [a, b] = cuts.points.bass;
  f.input[a] = -70;
  f.output[a] = -74;
  assert.equal(cuts.measure(f, flat, true, false).bass, null);
  f.input[b] = -70;
  f.output[b] = -78;
  const measured = cuts.measure(f, flat, true, false);
  near(measured.bass, 6);
  assert.equal(measured.mid, null);
  assert.equal(measured.high, null);
  f.output[b] = NaN;
  assert.equal(cuts.measure(f, flat, true, false).bass, null);
  f.output[b] = -78;
  f.input[b] = Infinity;
  assert.equal(cuts.measure(f, flat, true, false).bass, null);
});

test('cut model: requested and measured boosts average over the same valid points at the frame sample rate', () => {
  const p = { ...flat, bass: 56, high: 24, gain: 2.5 };
  const f = frame();
  f.sampleRate = 96000;
  f.input.fill(-120);
  for (const band of Object.keys(cuts.points)) {
    for (const [j, i] of cuts.points[band].slice(0, 2).entries()) {
      f.input[i] = -40 - j * 10;
      f.output[i] = f.input[i] + cuts.askedDb(p, cuts.frequencies[i], 96000) - (j ? 8 : 4);
    }
  }
  for (const value of Object.values(cuts.measure(f, p, true, false))) near(value, 6);
  const fallback = { ...f, sampleRate: undefined };
  const explicit = { ...f, sampleRate: 48000 };
  assert.deepEqual(cuts.measure(fallback, p, true, false), cuts.measure(explicit, p, true, false));
  assert.ok(Math.abs(cuts.measure(fallback, p, true, false).high - 6) > 0.01);
});

test('cut model: global reduction appears at zero Mid/High, but cuts never go negative', () => {
  const f = frame(-12);
  for (const value of Object.values(cuts.measure(f, flat, true, false))) near(value, 12);
  for (const value of Object.values(cuts.measure(frame(5), flat, true, false))) near(value, 0);
});

test('cut model: Sol bass-plus-texture mixture cannot understate the full-band limiter', () => {
  // Captured by Sol's OfflineAudioContext reproduction at Bass +56 / Master 250% / AUTO off.
  // Independent output maxima include distortion, understating MID's cut at both rates.
  const mixtures = [
    { rate: 48000, limiter: 29.1, spectral: 11.539493689795624,
      input: [-67.7, -68.3, -54.4, -67.9, -67.4], output: [-59.2, -71.7, -69.7, -66.2, -73.5] },
    { rate: 96000, limiter: 29.2, spectral: 10.379493689795622,
      input: [-68.4, -67.5, -53.9, -66.5, -69.1], output: [-57.5, -73.7, -67.8, -62.6, -72.6] }
  ];
  const p = { bass: 56, hpf: 20, mid: 0, high: 0, gain: 2.5, autoBalance: false, stageBypass: {} };
  for (const mixture of mixtures) {
    // Shipped frames omit sampleRate, including in the 96 kHz reproduction.
    const f = frame();
    f.input.fill(-120);
    cuts.points.mid.forEach((i, j) => { f.input[i] = mixture.input[j]; f.output[i] = mixture.output[j]; });
    near(cuts.measure(f, p, true, false).mid, mixture.spectral);
    f.dyn = { modes: { leveler: 'full' }, limiter: mixture.limiter, leveler: 0, match: 0, ceiling: 4 };
    const measured = cuts.measure(f, p, true, false);
    near(measured.mid, mixture.limiter);
    assert.equal(measured.bass, null, `${mixture.rate} Hz: meters must not invent band availability`);
    assert.equal(measured.high, null);
    near(cuts.smooth({ value: 0, visible: false }, measured.mid, 600).value,
      mixture.limiter * (1 - Math.exp(-1)));
    f.input[cuts.points.mid[1]] = f.input[cuts.points.mid[2]]
      = f.input[cuts.points.mid[3]] = f.input[cuts.points.mid[4]] = -120;
    assert.equal(cuts.measure(f, p, true, false).mid, null, 'one valid point still hides the band');
  }
});

test('cut model: full-band and slow Leveler reductions add to the limiter before smoothing', () => {
  for (const leveler of ['full', 'slow']) {
    const f = { ...frame(-2), dyn: { modes: { leveler }, limiter: 6, leveler: 9, match: 0 } };
    for (const value of Object.values(cuts.measure(f, { ...flat, autoBalance: true }, true, false))) near(value, 15);
    // The spectral estimate remains authoritative when it exceeds the meter floor.
    for (const value of Object.values(cuts.measure({ ...f, output: Array(72).fill(-50) },
      { ...flat, autoBalance: true }, true, false))) near(value, 20);
  }
});

test('cut model: signed MATCH gain lowers the floor and negative trim raises it; ceiling is excluded', () => {
  const p = { ...flat, autoBalance: true };
  for (const [match, expected] of [[4, 11], [-4, 19], [30, 2]]) {
    const f = { ...frame(-2), dyn: { modes: { leveler: 'full' }, limiter: 6, leveler: 9, match, ceiling: 40 } };
    for (const value of Object.values(cuts.measure(f, p, true, false))) near(value, expected);
  }
  const f = { ...frame(5), dyn: { modes: { leveler: 'full' }, limiter: 6, leveler: 9, match: 30, ceiling: 40 } };
  for (const value of Object.values(cuts.measure(f, p, true, false))) near(value, 0);
});

test('cut model: Bass-only and disabled AUTO never supply a full-band Leveler floor', () => {
  const f = { ...frame(-2), dyn: { modes: { leveler: 'bass' }, limiter: 6, leveler: 20 } };
  const p = { ...flat, autoBalance: true };
  for (const value of Object.values(cuts.measure(f, p, true, false))) near(value, 6);
  f.dyn.modes.leveler = 'full';
  for (const value of Object.values(cuts.measure(f, { ...p, autoBalance: false }, true, false))) near(value, 6);
  for (const value of Object.values(cuts.measure(f,
    { ...p, stageBypass: { ...p.stageBypass, comp: true } }, true, false))) near(value, 6);
  // A failed Bass-only worklet reports the effective Full band fallback in the live frame.
  f.dyn.available = false;
  for (const value of Object.values(cuts.measure(f, p, true, false))) near(value, 26);
});

test('cut model: absent or non-finite meters contribute zero and unknown Leveler mode is excluded', () => {
  const p = { ...flat, autoBalance: true };
  for (const [dyn, expected] of [
    [undefined, 2], [{}, 2], [{ limiter: 7 }, 7], [{ match: -5 }, 5],
    [{ modes: { leveler: 'slow' }, leveler: 8 }, 8], [{ leveler: 30 }, 2],
    [{ modes: { leveler: 'other' }, leveler: 30 }, 2],
    [{ modes: { leveler: 'full' }, limiter: NaN, leveler: Infinity, match: -Infinity, ceiling: 40 }, 2]
  ]) {
    for (const value of Object.values(cuts.measure({ ...frame(-2), dyn }, p, true, false))) near(value, expected);
  }
});

test('cut model: off, idle, missing/malformed frames, bypass and active Pitch hide all bands', () => {
  const hidden = (value) => assert.ok(Object.values(value).every((v) => v === null));
  hidden(cuts.measure(frame(), flat, false, false));
  hidden(cuts.measure({ ...frame(), isCapturing: false }, flat, true, false));
  hidden(cuts.measure(null, flat, true, false));
  hidden(cuts.measure({ ...frame(), input: [1] }, flat, true, false));
  hidden(cuts.measure(frame(), { ...flat, bypass: true }, true, false));
  hidden(cuts.measure(frame(), { ...flat, semitones: 0.1 }, true, false));
  const shifted = { ...flat, semitones: -4 };
  assert.ok(cuts.measure(frame(), shifted, true, true).bass > 0, 'Movie locks Pitch off');
  assert.ok(cuts.measure(frame(), { ...shifted, stageBypass: { hpf: true, pitch: true } }, true, false).bass > 0);
});

test('cut model: exponential smoothing has a 0.6 s time constant independent of frame cadence', () => {
  const start = { value: 0, visible: false };
  const full = cuts.smooth(start, 10, 600);
  near(full.value, 10 * (1 - Math.exp(-1)));
  let stepped = start;
  for (let i = 0; i < 10; i++) stepped = cuts.smooth(stepped, 10, 60);
  near(stepped.value, full.value);
  near(cuts.smooth(full, -10, 600).value, full.value * Math.exp(-1));
});

test('cut model: show at 2 dB, retain down to 1 dB, and reset immediately when sound disappears', () => {
  assert.equal(cuts.smooth({ value: 1.99, visible: false }, 1.99, 66).visible, false);
  assert.equal(cuts.smooth({ value: 2, visible: false }, 2, 66).visible, true);
  assert.equal(cuts.smooth({ value: 1.5, visible: true }, 1.5, 66).visible, true);
  assert.equal(cuts.smooth({ value: 1, visible: true }, 1, 66).visible, true);
  assert.equal(cuts.smooth({ value: 0.99, visible: true }, 0.99, 66).visible, false);
  const reset = cuts.smooth({ value: 30, visible: true }, null, 66);
  assert.equal(reset.value, 0);
  assert.equal(reset.visible, false);
});

test('cut model: tick lands at slider value minus cut, clamped to both ends', () => {
  near(cuts.position(56, 28, 0, 56), 0.5);
  near(cuts.position(0, 12, -24, 24), 0.25);
  near(cuts.position(5, 20, 0, 56), 0);
  near(cuts.position(-24, 20, -24, 24), 0);
  near(cuts.position(70, 0, 0, 56), 1);
});
