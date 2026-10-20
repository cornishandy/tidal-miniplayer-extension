// R-30: exercise the shipped transport functions with deterministic time; no browser or audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const content = readFileSync(new URL('../../content.js', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../../popup.js', import.meta.url), 'utf8');
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { at: now + ms, fn }); return key; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]); due[1].fn();
        for (let i = 0; i < 12; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
  };
}
function transport({ media = false, routes = {}, next = null, tidal = true } = {}) {
  const time = clock(), calls = [];
  const state = { title: 'First', artist: 'Artist', currentTime: 5, duration: 60, isPlaying: false };
  const drive = (route, target) => { calls.push(route); return routes[route]?.(state, target); };
  const element = {
    duration: 60,
    get currentTime() { return state.currentTime; },
    set currentTime(value) { drive('media', value); }
  };
  const ctx = vm.createContext({
    ...time, performance: { now: time.now }, transportSeq: 1, isTidal: tidal,
    document: { querySelector: () => media ? element : null },
    getTrackInfo: () => ({ ...state }),
    getNextButton: () => next && ({ disabled: next.disabled, getAttribute: () => null, click: () => { calls.push('next'); next.click?.(state); } }),
    seekWithBar: (target) => drive('bar', target) ? 'range' : false,
    bridge: (op, args) => op === 'next' ? { next: drive('sessionNext') ? 'session' : false }
      : { seeked: drive(args.route, args.time) ? args.route : false }
  });
  vm.runInContext(between(content, '  async function nextTrack', "  // Tidal's page-world helper")
    + between(content, '  async function seekAudio', '  function seekWithBar'), ctx);
  return { state, calls, ctx, time, run: (s) => vm.runInContext(s, ctx) };
}
const moves = (s, t) => { s.currentTime = t; return true; };

test('seek: direct media must move; ignored assignments fall through in the original order', async () => {
  const p = transport({ media: true, routes: { bar: () => true, session: moves } });
  const result = p.run('seekAudio(35)');
  await p.time.advance(3000);
  assert.equal((await result).status, 'confirmed');
  assert.equal((await result).seeked, 'session');
  assert.deepEqual(p.calls, ['media', 'bar', 'session']);
});

test('seek: every refused route reports exhaustion, never truthy unverified success', async () => {
  const p = transport({ media: true, routes: { bar: () => true, session: () => true, element: () => true } });
  const result = p.run('seekAudio(35)');
  await p.time.advance(5000);
  assert.equal((await result).status, 'exhausted');
  assert.equal((await result).seeked, false);
  assert.equal((await result).reason, 'seek');
  assert.deepEqual(p.calls, ['media', 'bar', 'session', 'element']);
  assert.equal(p.state.currentTime, 5);
});

test('seek: an empty or absent page helper explains the required reload', async () => {
  for (const absent of [false, true]) {
    const p = transport({ routes: { bar: () => true } });
    if (absent) p.ctx.bridge = () => null;
    const result = p.run('seekAudio(35)');
    await p.time.advance(1500);
    assert.equal((await result).status, 'exhausted');
    assert.equal((await result).reason, 'helper');
  }
});

test('seek: a newer command or manual movement cancels without any fallback', async () => {
  for (const newer of [false, true]) {
    const p = transport({ routes: { bar: () => true, session: moves } });
    const result = p.run('seekAudio(35)');
    await p.time.advance(100);
    if (newer) p.run('transportSeq++');
    else p.state.currentTime = 12;
    await p.time.advance(2000);
    assert.equal((await result).status, 'cancelled');
    assert.equal((await result).seeked, false);
    assert.deepEqual(p.calls, ['bar']);
  }
});

test('seek: small refused jumps are not confirmed by target tolerance or normal playback', async () => {
  const p = transport({ media: true, tidal: false });
  p.state.currentTime = 1;
  const result = p.run('seekAudio(0)');
  await p.time.advance(1500);
  assert.equal((await result).status, 'exhausted');
  const q = transport({ tidal: false, routes: { bar: () => true } });
  q.state.isPlaying = true;
  q.ctx.getTrackInfo = () => ({ ...q.state, currentTime: 5 + q.time.now() / 1000 });
  const ordinary = q.run('seekAudio(6)');
  await q.time.advance(1500);
  assert.equal((await ordinary).status, 'exhausted');
});

test('Next: a button must show a new track and is never retried or followed by an end seek', async () => {
  for (const orEnd of [false, true]) {
    const p = transport({ next: { click() {} }, routes: { bar: moves } });
    p.state.currentTime = 45;
    const result = p.run(`nextTrack(${orEnd})`);
    await p.time.advance(5000);
    assert.equal((await result).status, 'exhausted');
    assert.equal((await result).reason, 'next');
    assert.deepEqual(p.calls, ['next']);
  }
  const p = transport({ next: { click(s) { s.title = 'Second'; s.currentTime = 0; } } });
  const result = p.run('nextTrack()');
  await p.time.advance(200);
  assert.equal((await result).status, 'confirmed');
});

test('Next: preserve disabled-queue and no-button/no-op handler end fallbacks', async () => {
  for (const next of [null, { disabled: true }]) {
    const p = transport({ next, routes: { sessionNext: () => true, bar: moves } });
    p.state.currentTime = 45;
    const result = p.run('nextTrack(true)');
    await p.time.advance(3500);
    assert.equal((await result).status, 'confirmed');
    assert.equal((await result).next, 'end');
    assert.equal(p.state.currentTime, 60);
    assert.deepEqual(p.calls, next ? ['bar'] : ['sessionNext', 'bar']);
  }
});

function screen() {
  const time = clock(), calls = [], classes = new Set();
  const hint = { textContent: '', hidden: true, classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s) } };
  const runtime = { lastError: undefined, sendMessage: (m, reply) => calls.push({ m, reply }) };
  const ctx = vm.createContext({
    ...time, Date: { now: time.now }, hintEl: hint, chrome: { runtime },
    currentTrackInfo: { title: 'First', currentTime: 5, duration: 60 },
    updatePlayerUI() {}, refreshTrackInfo() {}
  });
  vm.runInContext(between(popup, 'function showHint(', '// Stay-open window only:')
    + between(popup, 'function playerCommand(', 'function handleFav('), ctx);
  const run = (s) => vm.runInContext(s, ctx);
  return { time, hint, runtime, calls, run,
    reply(res, error, index = calls.length - 1) { runtime.lastError = error; calls[index].reply(res); runtime.lastError = undefined; } };
}
const confirmed = { status: 'confirmed', success: true, seeked: 'range', title: 'First', currentTime: 35, duration: 60 };

test('screen: progress starts after 400 ms only, then confirmed playback clears it', async () => {
  const p = screen();
  p.run('handleJump(30)');
  await p.time.advance(399);
  assert.equal(p.hint.hidden, true);
  await p.time.advance(1);
  assert.equal(p.hint.textContent, 'Moving playback…');
  p.reply(confirmed);
  assert.equal(p.hint.hidden, true);
  assert.equal(p.run('currentTrackInfo.currentTime'), 35);
  await p.time.advance(11000);
  assert.equal(p.hint.hidden, true);
});

test('screen: all exhausted routes show the exact approved text', () => {
  for (const [reason, text] of [
    ['seek', "This page isn't allowing seeking right now"],
    ['helper', 'Reload the Tidal tab once, then try again'],
    ['next', "Tidal didn't move to the next track"]
  ]) {
    const p = screen();
    p.run('handleJump(30)');
    p.reply({ status: 'exhausted', success: false, reason });
    assert.equal(p.hint.textContent, text);
    assert.equal(p.hint.hidden, false);
    assert.equal(p.run('currentTrackInfo.currentTime'), 5);
  }
});

test('screen: missing, failed, malformed, runtime-error and never-returning replies cannot fake movement', async () => {
  for (const res of [undefined, {}, { success: false }, { ...confirmed, success: false }, { success: true, unverified: true }]) {
    const p = screen();
    p.run('handleJump(30)');
    p.reply(res);
    assert.equal(p.hint.textContent, "The Tidal tab isn't reachable. Open it and try again");
    assert.equal(p.run('currentTrackInfo.currentTime'), 5);
  }
  const p = screen();
  p.run('handleJump(30)');
  p.reply(confirmed, { message: 'Port closed' });
  assert.equal(p.hint.textContent, "The Tidal tab isn't reachable. Open it and try again");
  const q = screen();
  q.run('handleJump(30)');
  await q.time.advance(10000);
  assert.equal(q.hint.textContent, "The Tidal tab isn't reachable. Open it and try again");
  q.reply(confirmed);
  assert.equal(q.run('currentTrackInfo.currentTime'), 5);
});

test('screen: held repeats explain the wait without a second command; start and unknown duration also explain', async () => {
  const p = screen();
  p.run('currentTrackInfo.currentTime = 45; handleJump(30); handleJump(30)');
  assert.equal(p.calls.length, 1);
  assert.equal(p.hint.textContent, 'Waiting for the next track');
  await p.time.advance(500);
  assert.equal(p.hint.textContent, 'Waiting for the next track');
  p.reply({ status: 'confirmed', success: true, next: 'button', title: 'Second', currentTime: 0, duration: 60 });
  assert.equal(p.hint.hidden, true);
  p.run('handleJump(-15)');
  assert.equal(p.hint.textContent, 'Already at the start');
  assert.equal(p.calls.length, 1);
  p.run('currentTrackInfo.duration = 0; handleJump(30)');
  assert.equal(p.hint.textContent, 'Reload the Tidal tab once, then try again');
  assert.equal(p.calls.length, 1);
});

test('screen: late responses and cancelled attempts never overwrite a newer hint or track', async () => {
  const p = screen();
  p.run('handleJump(30); handleJump(-15)');
  p.reply({ status: 'exhausted', reason: 'seek' });
  p.reply(confirmed, undefined, 0);
  assert.equal(p.hint.textContent, "This page isn't allowing seeking right now");
  assert.equal(p.run('currentTrackInfo.currentTime'), 5);
  p.run('handleJump(30)');
  await p.time.advance(450);
  p.reply({ status: 'cancelled', success: false });
  assert.equal(p.hint.hidden, true);
  assert.equal(p.run('currentTrackInfo.currentTime'), 5);
});
