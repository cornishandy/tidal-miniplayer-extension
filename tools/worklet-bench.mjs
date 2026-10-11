// tools/worklet-bench.mjs - Time every 128-frame block of each AudioWorklet processor at several sample rates.
// Usage: node tools/worklet-bench.mjs [seconds=20] [rates=44100,48000,96000,192000]
// Runs the shipped worklet files unchanged in a small shim (no browser, no audio device, no network). The input is a
// synthetic sustained chord at about -12 dBFS. A block that takes longer than its own duration (128 / rate) cannot be
// rendered in real time; Chrome then plays silence for it, which is heard as a click.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seconds = +(process.argv[2] || 20);
const rates = (process.argv[3] || '44100,48000,96000,192000').split(',').map(Number);
const N = 128;

function load(file, fs) {
  const registry = {};
  const ctx = {
    sampleRate: fs, Math, Float32Array, Float64Array, Int32Array, Infinity, console,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (name, cls) => { registry[name] = cls; }
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, file), 'utf8'), ctx, { filename: file });
  return registry;
}

function chord(fs, frame, ch) {
  const t = frame / fs;
  const f = [130.81, 164.81, 196.0, 261.63, 523.25];
  let s = 0;
  for (let i = 0; i < f.length; i++) s += Math.sin(2 * Math.PI * f[i] * t + ch * 0.3 + i);
  return 0.05 * s;
}

function bench(cls, fs, numberOfInputs, params) {
  const proc = new cls();
  const blocks = Math.ceil(seconds * fs / N);
  const ins = Array.from({ length: numberOfInputs }, () => [new Float32Array(N), new Float32Array(N)]);
  const outs = [[new Float32Array(N), new Float32Array(N)]];
  const times = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    for (const inp of ins) for (let c = 0; c < 2; c++) for (let n = 0; n < N; n++) inp[c][n] = chord(fs, b * N + n, c);
    const t0 = performance.now();
    proc.process(ins, outs, params);
    times[b] = performance.now() - t0;
  }
  return times;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const rows = [];
for (const fs of rates) {
  const budgetMs = N / fs * 1000;
  const pitch = load('pitch-shifter.worklet.js', fs);
  const dyn = load('dynamics.worklet.js', fs);
  const runs = [
    ['pitch-shifter (0 st)', bench(pitch['pitch-shifter'], fs, 1, { semitones: new Float32Array([0]) })],
    ['band-leveler', bench(dyn['band-leveler'], fs, 1, {})],
    ['loudness-match', bench(dyn['loudness-match'], fs, 2, {})],
    ['lookahead-limiter', bench(dyn['lookahead-limiter'], fs, 1, {})]
  ];
  const sum = new Float64Array(runs[0][1].length);
  for (const [, t] of runs) for (let i = 0; i < sum.length; i++) sum[i] += t[i];
  runs.push(['all four, same block', sum]);
  for (const [name, t] of runs) {
    const warm = Array.from(t.slice(Math.floor(t.length * 0.1))).sort((a, b) => a - b); // skip JIT warm-up
    const over = warm.filter((x) => x > budgetMs).length;
    const meanMs = warm.reduce((a, b) => a + b, 0) / warm.length;
    rows.push({ rate: fs, stage: name, budget_ms: +budgetMs.toFixed(3), mean_ms: +meanMs.toFixed(4), p99_ms: +pct(warm, 0.99).toFixed(3),
      max_ms: +warm[warm.length - 1].toFixed(3), load_pct: +(100 * meanMs / budgetMs).toFixed(1), blocks_over_budget_per_s: +(over / (warm.length * N / fs)).toFixed(2) });
  }
}
console.table(rows);
console.log(`node ${process.version}; ${seconds} s of audio per stage and rate; block = ${N} frames.`);
