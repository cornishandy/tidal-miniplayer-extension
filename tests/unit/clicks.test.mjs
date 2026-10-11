// tests/unit/clicks.test.mjs - The click fixes of 1.5.2 (K-01): what changed, and proof that the sound did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(join(root, f), 'utf8');
// The same file as it was in 1.5.1 (tag-free: the last commit before the fix that touched it on main).
const before = (f) => execFileSync('git', ['show', `dbc1dd7:${f}`], { cwd: root, encoding: 'utf8' });

// Load worklet source in a small shim: no browser, no audio device.
function load(source, fs = 96000) {
  const registry = {};
  const posted = [];
  const ctx = vm.createContext({
    sampleRate: fs, Math, Float32Array, Float64Array, Int32Array, Infinity,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } },
    registerProcessor: (name, cls) => { registry[name] = cls; }
  });
  vm.runInContext(source, ctx);
  return { registry, posted, ctx };
}
const chord = (fs, i, ch) => { let s = 0; for (const f of [130.81, 164.81, 196, 261.63, 523.25]) s += 0.12 * Math.sin(2 * Math.PI * f * i / fs + ch); return s; };
function run(proc, blocks, { fs = 96000, st = () => 0, gain = 1, start = 0 } = {}) {
  const out = [];
  const inp = [[new Float32Array(128), new Float32Array(128)]];
  const o = [[new Float32Array(128), new Float32Array(128)]];
  for (let b = 0; b < blocks; b++) {
    for (let c = 0; c < 2; c++) for (let n = 0; n < 128; n++) inp[0][c][n] = gain * chord(fs, start + b * 128 + n, c);
    proc.process(inp, o, { semitones: new Float32Array([st(b)]) });
    out.push(Float32Array.from(o[0][0]), Float32Array.from(o[0][1]));
  }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x.length === b[i].length && x.every((v, j) => Object.is(v, b[i][j])));

test('engine: bigger device buffer, pitch gated on primed', () => {
  const off = read('offscreen.js');
  assert.match(off, /new AudioContext\(\{ latencyHint: 'playback' \}\)/);
  assert.match(off, /const shifting = !!pitchNode && pitchTarget\(\) !== 0 && pitchPrimed && audioCtx\.currentTime >= pitchHoldUntil;/);
  assert.match(off, /if \(st === 0\) p\.setValueAtTime\(0, now \+ 0\.25\);/, 'the shift returns to exactly 0, which parks the worklet');
});

test('look-ahead limiter: no hang after 2^31 samples, and the same samples as 1.5.1', () => {
  const now = load(read('dynamics.worklet.js'));
  const proc = new now.registry['lookahead-limiter']();
  proc.n = 2 ** 31 - 4096; // 6.2 hours of audio at 96 kHz, minus a moment
  now.ctx.proc = proc;
  now.ctx.inp = [[new Float32Array(128).fill(0.1), new Float32Array(128).fill(0.1)]];
  now.ctx.out = [[new Float32Array(128), new Float32Array(128)]];
  assert.doesNotThrow(() => vm.runInContext('for (let b = 0; b < 80; b++) proc.process(inp, out)', now.ctx, { timeout: 1500 }), 'the limiter hangs when its sample counter passes 2^31');
  // Loud enough to limit: identical output to the 1.5.1 code over 2 s.
  const old = load(before('dynamics.worklet.js'));
  const a = run(new old.registry['lookahead-limiter'](), 1500, { gain: 1.6 });
  const b = run(new now.registry['lookahead-limiter'](), 1500, { gain: 1.6 });
  assert.ok(same(a, b), 'the limiter output changed');
});

test('pitch: parked at 0 st (silence, no work), afresh when a shift is set, and the same shifted sound as 1.5.1', () => {
  const now = load(read('pitch-shifter.worklet.js'));
  const old = load(before('pitch-shifter.worklet.js'));
  const P = now.registry['pitch-shifter'];
  // Parked: silence and next to no time per block.
  const parked = new P();
  const t0 = process.hrtime.bigint();
  const silent = run(parked, 750); // 1 s at 96 kHz
  const msPerBlock = Number(process.hrtime.bigint() - t0) / 1e6 / 750;
  assert.ok(silent.every((x) => x.every((v) => v === 0)), 'parked output is not silent');
  assert.ok(msPerBlock < 0.2, `parked block took ${msPerBlock.toFixed(3)} ms`);
  // A steady shift: the samples of the 1.5.1 shifter, bit for bit.
  const st = () => 2;
  assert.ok(same(run(new old.registry['pitch-shifter'](), 1500, { st }), run(new P(), 1500, { st })), 'the shifted sound changed');
  // Parked for a second, then +2 st: the same as a new shifter started at that moment.
  const later = new P();
  run(later, 750);
  const a = run(later, 1500, { st, start: 750 * 128 });
  const b = run(new P(), 1500, { st, start: 750 * 128 });
  assert.ok(same(a, b), 'leaving the parked state is not a clean start');
  // It says when it produces audio, and when it parks again.
  now.posted.length = 0;
  const p2 = new P();
  run(p2, 300, { st });
  run(p2, 5);
  assert.deepEqual(now.posted.map((m) => m.primed), [true, false]);
});
