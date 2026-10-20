// R-28: a saved preset may remember Leveler, MATCH, Limiter and Ceiling.
// The worker commits them in one storage write. Older entries are never backfilled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const backgroundSrc = readFileSync(join(root, 'background.js'), 'utf8');
const linkSrc = readFileSync(join(root, 'movie-sound-link.js'), 'utf8');
const ORIGIN = 'http://127.0.0.1:8791';

const EQ = { bass: 3, hpf: 20, mid: 1, high: 0, gain: 1, semitones: 0, autoBalance: false, bypass: false };
const MOVIE = { leveler: 'bass', match: true, limiter: 'lookahead', ceiling: 'warm' };
const MUSIC = { leveler: 'slow', match: false, limiter: 'fast', ceiling: 'clean' };
const DEFAULT_DYN = { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' };

function pick(bag, keys) {
  if (keys == null) return { ...bag };
  const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const out = {};
  for (const k of names) if (k in bag) out[k] = bag[k];
  return structuredClone(out);
}

function loadBackground() {
  const local = {};
  const session = {};
  const localSets = [];
  const offscreenMsgs = [];
  const changeListeners = [];
  const setWaiters = [];
  let holdSets = false;
  let offscreenOpen = false;
  let onMessage = null;
  let onInstalled = null;
  const area = (bag, record) => ({
    get: (keys) => Promise.resolve(pick(bag, keys)),
    set: (obj) => {
      const copy = structuredClone(obj);
      const apply = () => {
        Object.assign(bag, copy);
        if (record) {
          localSets.push(copy);
          const changes = {};
          for (const k of Object.keys(copy)) changes[k] = { newValue: copy[k] };
          for (const fn of changeListeners) fn(changes, 'local');
        }
      };
      if (record && holdSets) return new Promise((resolve) => setWaiters.push(() => { apply(); resolve(); }));
      apply();
      return Promise.resolve();
    },
    remove: (keys) => { for (const k of [].concat(keys)) delete bag[k]; return Promise.resolve(); }
  });
  const chrome = {
    runtime: {
      lastError: null,
      id: 'abc',
      getURL: (p) => 'chrome-extension://id/' + p,
      getContexts: async () => (offscreenOpen ? [{ documentUrl: 'chrome-extension://id/offscreen.html' }] : []),
      onMessage: { addListener(fn) { onMessage = fn; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener(fn) { onInstalled = fn; } },
      sendMessage(msg, cb) {
        if (msg && msg.target === 'offscreen') {
          offscreenMsgs.push({ type: msg.type, params: msg.params ? structuredClone(msg.params) : null, dynamics: msg.dynamics ? structuredClone(msg.dynamics) : null });
          if (typeof cb === 'function') cb({ isCapturing: false });
          return;
        }
        if (typeof cb === 'function') cb(null);
      }
    },
    storage: {
      local: area(local, true),
      session: area(session, false),
      onChanged: { addListener(fn) { changeListeners.push(fn); } }
    },
    action: { onClicked: { addListener() {} }, setPopup: async () => {}, getPopup: async () => 'popup.html' },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      query: async () => [],
      get: async () => null,
      sendMessage(_id, _msg, cb) { if (typeof cb === 'function') cb(null); }
    },
    commands: { onCommand: { addListener() {} } },
    tabCapture: { getMediaStreamId: async () => 'stream' },
    offscreen: { createDocument: async () => { offscreenOpen = true; } },
    scripting: { executeScript: async () => [] },
    windows: { getLastFocused: async () => ({ id: 1 }), create: async () => ({ id: 2 }), update: async () => {}, remove: async () => {} }
  };
  const sandbox = {
    console, Math, Number, Object, Array, Error, String, Boolean, Date, Promise, isFinite, Infinity, Map, Set,
    setTimeout, clearTimeout, setInterval, clearInterval, chrome
  };
  vm.createContext(sandbox);
  vm.runInContext(backgroundSrc, sandbox, { filename: 'background.js' });
  function send(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response for ' + message.type)), 3000);
      const ret = onMessage(message, {}, (res) => {
        clearTimeout(timer);
        // The worker runs in a vm, so its objects have a different prototype. Clone them
        // into this realm before deepEqual, which treats that as a mismatch.
        resolve(res == null ? res : structuredClone(res));
      });
      if (ret !== true) { clearTimeout(timer); resolve({ returned: ret }); }
    });
  }
  return {
    local, session, localSets, offscreenMsgs, setWaiters, send, chrome, sandbox, changeListeners,
    hold(v) { holdSets = v; },
    releaseOneSet() { const w = setWaiters.shift(); if (w) w(); },
    setOffscreen(v) { offscreenOpen = v; },
    install: () => onInstalled(),
    async ready() { await new Promise((r) => setTimeout(r, 30)); }
  };
}

function attachLink(chrome) {
  let now = 1000;
  const timers = [];
  const posted = [];
  const listeners = {};
  const window = {
    postMessage(data, target) { posted.push({ data: structuredClone(data), target }); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
  };
  window.top = window;
  const linkDate = { now: () => now };
  const setTimeoutLink = (fn, ms) => { const t = { fn, at: now + ms, cleared: false }; timers.push(t); return t; };
  const clearTimeoutLink = (t) => { if (t) t.cleared = true; };
  const setIntervalLink = (fn, ms) => { const t = { fn, every: ms, cleared: false, interval: true }; timers.push(t); return t; };
  const clearIntervalLink = (t) => { if (t) t.cleared = true; };
  const sandbox = { chrome, window, location: { origin: ORIGIN }, Date: linkDate, setTimeout: setTimeoutLink, clearTimeout: clearTimeoutLink, setInterval: setIntervalLink, clearInterval: clearIntervalLink };
  vm.createContext(sandbox);
  vm.runInContext(linkSrc, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    posted,
    ask() {
      for (const fn of listeners.message || []) fn({ source: window, origin: ORIGIN, data: { source: 'movie-sound', type: 'request-chrome-eq', version: 1 } });
    },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.find((t) => !t.cleared && !t.interval && t.at <= now);
        if (!due) break;
        due.cleared = true;
        due.fn();
        await settle();
      }
      await settle();
    }
  };
}

const settingsOf = (link) => link.posted.filter((p) => p.data.type === 'chrome-eq-settings').map((p) => p.data);
const norm = (d) => {
  const x = d || {};
  return {
    leveler: ['full', 'slow', 'bass'].includes(x.leveler) ? x.leveler : 'full',
    match: x.match === true,
    limiter: ['fast', 'lookahead'].includes(x.limiter) ? x.limiter : 'fast',
    ceiling: ['clean', 'warm'].includes(x.ceiling) ? x.ceiling : 'clean'
  };
};
const factoriesIn = (src) => {
  const m = src.match(/const FACTORY_PRESETS = (\{[^]*?\n\});/);
  return new Function(`return ${m[1]}`)();
};
const FACTORIES = factoriesIn(backgroundSrc);

async function until(fn, label) {
  for (let i = 0; i < 40; i++) {
    if (fn()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('timed out waiting for ' + label);
}

function snapshot(bag) { return structuredClone(bag); }

function viewOf(bg) {
  return {
    expectedRev: Number.isInteger(bg.local.presetRev) ? bg.local.presetRev : 0,
    expectedPreset: bg.local.currentPreset || 'Punchy Bass & Clarity'
  };
}

test('save and update store normalised switches and strip them out of currentParams', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  bg.local.dynamics = { ...DEFAULT_DYN };
  const odd = { leveler: 'BASS', match: 1, limiter: 'lookahead', ceiling: 'warm' };
  const saved = await bg.send({ type: 'SAVE_PRESET', name: 'Movie night', params: { ...EQ, dynamics: { junk: true } }, dynamics: odd, ...viewOf(bg) });
  assert.equal(saved.success, true);
  assert.deepEqual(saved.dynamics, { leveler: 'full', match: false, limiter: 'lookahead', ceiling: 'warm' });
  assert.equal(bg.local.presets['Movie night'].dynamics.leveler, 'full');
  assert.equal('junk' in bg.local.presets['Movie night'], false);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.equal(bg.local.currentParams.bass, EQ.bass);
  assert.deepEqual(bg.local.dynamics, saved.dynamics);
  const before = snapshot(bg.local.presets['Movie night']);
  const updated = await bg.send({ type: 'UPDATE_PRESET', name: 'Movie night', params: { ...EQ, bass: 8 }, dynamics: MOVIE, ...viewOf(bg) });
  assert.equal(updated.success, true);
  assert.deepEqual(bg.local.presets['Movie night'].dynamics, MOVIE);
  assert.equal(bg.local.presets['Movie night'].bass, 8);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.notDeepEqual(bg.local.presets['Movie night'], before);
  // A save that omits dynamics stores the switches in force, not an invented set.
  bg.local.dynamics = { ...MUSIC };
  const snapped = await bg.send({ type: 'SAVE_PRESET', name: 'From storage', params: EQ, ...viewOf(bg) });
  assert.deepEqual(snapped.dynamics, MUSIC);
  assert.deepEqual(bg.local.presets['From storage'].dynamics, MUSIC);
});

test('factory names are refused with no storage change', async () => {
  const bg = loadBackground();
  await bg.ready();
  const state = await bg.send({ type: 'GET_STATE' });
  assert.deepEqual(state.factoryPresets, Object.keys(FACTORIES));
  bg.local.presets = snapshot(FACTORIES);
  bg.local.dynamics = { ...DEFAULT_DYN };
  bg.local.currentPreset = 'Flat (Bypass)';
  for (const name of state.factoryPresets) {
    const before = snapshot(bg.local);
    bg.hold(true);
    const save = await bg.send({ type: 'SAVE_PRESET', name, params: EQ, dynamics: MOVIE });
    const update = await bg.send({ type: 'UPDATE_PRESET', name, params: EQ, dynamics: MOVIE });
    assert.equal(bg.setWaiters.length, 0, 'a factory name must not wait on storage');
    bg.hold(false);
    assert.deepEqual(save, { success: false, error: 'factory-name' });
    assert.deepEqual(update, { success: false, error: 'factory-name' });
    assert.deepEqual(bg.local, before);
  }
  for (const name of ['flat (bypass)', 'PUNCHY BASS & CLARITY', 'Deep Sub-Bass (dub/trap)']) {
    const before = snapshot(bg.local);
    const save = await bg.send({ type: 'SAVE_PRESET', name, params: EQ, dynamics: MOVIE });
    const update = await bg.send({ type: 'UPDATE_PRESET', name, params: EQ, dynamics: MOVIE });
    assert.deepEqual(save, { success: false, error: 'factory-name' });
    assert.deepEqual(update, { success: false, error: 'factory-name' });
    assert.deepEqual(bg.local, before);
  }
  const custom = await bg.send({ type: 'SAVE_PRESET', name: 'My copy', params: EQ, dynamics: MOVIE, ...viewOf(bg) });
  assert.equal(custom.success, true);
  assert.deepEqual(bg.local.presets['My copy'].dynamics, MOVIE);
});

test('picking or resetting a preset with switches is one local set; a legacy preset leaves them', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  const legacy = { ...EQ, bass: 9, hpf: 40 };
  bg.local.presets = {
    Movie: { ...EQ, bass: 1, dynamics: { ...MOVIE } },
    Music: { ...EQ, bass: 2, dynamics: { ...MUSIC } },
    Legacy: { ...legacy },
    'Punchy Bass & Clarity': { ...FACTORIES['Punchy Bass & Clarity'], bass: 99 }
  };
  bg.local.dynamics = { ...DEFAULT_DYN };
  bg.local.currentParams = { ...EQ };
  bg.local.currentPreset = 'Legacy';

  const beforeMovie = snapshot(bg.local.presets.Movie);
  const start = bg.localSets.length;
  const offStart = bg.offscreenMsgs.length;
  const applied = await bg.send({ type: 'APPLY_PRESET', presetName: 'Movie', params: { ...EQ, bass: 1, dynamics: { junk: true } }, dynamics: MOVIE });
  const sets = bg.localSets.slice(start);
  assert.equal(sets.length, 1);
  assert.deepEqual(Object.keys(sets[0]).sort(), ['currentParams', 'currentPreset', 'dynamics', 'presetRev']);
  assert.equal('dynamics' in sets[0].currentParams, false);
  assert.deepEqual(sets[0].dynamics, MOVIE);
  assert.equal(applied.dynamicsApplied, true);
  assert.equal(applied.saved, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.offscreen.ok, true);
  assert.deepEqual(bg.local.presets.Movie, beforeMovie, 'picking a preset does not rewrite its entry');
  assert.equal(bg.session.presetSwitchBaseline, undefined);
  const told = bg.offscreenMsgs.slice(offStart).map((m) => m.type);
  assert.deepEqual(told, ['UPDATE_AUDIO_PARAMS', 'SET_DYNAMICS']);

  const legacyBefore = snapshot(bg.local.dynamics);
  const entryBefore = snapshot(bg.local.presets.Legacy);
  const mark = bg.localSets.length;
  const offMark = bg.offscreenMsgs.length;
  const legacyApply = await bg.send({ type: 'APPLY_PRESET', presetName: 'Legacy', params: legacy });
  const legacySets = bg.localSets.slice(mark);
  assert.equal(legacySets.length, 1);
  assert.equal('dynamics' in legacySets[0], false);
  assert.equal(legacyApply.dynamicsApplied, false);
  assert.deepEqual(bg.local.dynamics, legacyBefore);
  assert.deepEqual(bg.local.presets.Legacy, entryBefore);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.deepEqual(bg.offscreenMsgs.slice(offMark).map((m) => m.type), ['UPDATE_AUDIO_PARAMS']);

  bg.local.currentPreset = 'Movie';
  bg.local.dynamics = { ...MUSIC };
  const presetBefore = snapshot(bg.local.presets.Movie);
  const resetMark = bg.localSets.length;
  const reset = await bg.send({ type: 'RESET_DEFAULT_PRESETS', currentPreset: 'Movie', ...viewOf(bg) });
  const resetSets = bg.localSets.slice(resetMark);
  assert.equal(reset.success, true);
  assert.equal(reset.dynamicsApplied, true);
  assert.equal(resetSets.length, 1);
  assert.deepEqual(resetSets[0].dynamics, MOVIE);
  assert.equal('presets' in resetSets[0], false, 'reset of a custom preset does not rewrite the list');
  assert.deepEqual(bg.local.presets.Movie, presetBefore);
  assert.deepEqual(bg.local.dynamics, MOVIE);
  assert.equal('dynamics' in bg.local.currentParams, false);

  bg.local.dynamics = { ...MOVIE };
  const legacyDyn = snapshot(bg.local.dynamics);
  const legacyEntry = snapshot(bg.local.presets.Legacy);
  const legacyResetMark = bg.localSets.length;
  const legacyReset = await bg.send({ type: 'RESET_DEFAULT_PRESETS', currentPreset: 'Legacy', ...viewOf(bg) });
  const legacyResetSets = bg.localSets.slice(legacyResetMark);
  assert.equal(legacyReset.dynamicsApplied, false);
  assert.equal('dynamics' in legacyResetSets[0], false);
  assert.deepEqual(bg.local.dynamics, legacyDyn);
  assert.deepEqual(bg.local.presets.Legacy, legacyEntry);
  assert.equal(bg.session.presetSwitchBaseline, undefined);

  const factoryDyn = snapshot(bg.local.dynamics);
  const factoryReset = await bg.send({ type: 'RESET_DEFAULT_PRESETS', currentPreset: 'Punchy Bass & Clarity', ...viewOf(bg) });
  assert.equal(factoryReset.dynamicsApplied, false);
  assert.deepEqual(bg.local.dynamics, factoryDyn);
  assert.deepEqual(bg.local.presets['Punchy Bass & Clarity'], FACTORIES['Punchy Bass & Clarity']);
  assert.equal('dynamics' in bg.local.presets['Punchy Bass & Clarity'], false);
});

test('a slider does not put the switches back, and the last preset write wins', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  bg.local.presets = {
    A: { ...EQ, bass: 1, dynamics: { ...MOVIE } },
    B: { ...EQ, bass: 2, dynamics: { ...MUSIC } }
  };
  bg.local.dynamics = { ...DEFAULT_DYN };
  await bg.send({ type: 'SET_DYNAMICS', dynamics: MOVIE });
  const off = bg.offscreenMsgs.length;
  const mark = bg.localSets.length;
  await bg.send({ type: 'UPDATE_AUDIO_PARAMS', params: { ...EQ, bass: 4, dynamics: { leveler: 'bass', match: false, limiter: 'fast', ceiling: 'clean' } }, presetName: 'A' });
  assert.deepEqual(bg.local.dynamics, MOVIE);
  assert.equal(bg.local.currentParams.bass, 4);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.equal('dynamics' in bg.localSets[bg.localSets.length - 1], false);
  assert.equal(bg.localSets.length, mark + 1);
  assert.equal('presetRev' in bg.localSets[bg.localSets.length - 1], false);
  assert.equal(bg.local.presetRev, undefined);
  assert.deepEqual(bg.offscreenMsgs.slice(off).map((m) => m.type), ['UPDATE_AUDIO_PARAMS']);

  bg.hold(true);
  const first = bg.send({ type: 'APPLY_PRESET', presetName: 'A', params: { ...EQ, bass: 1 }, dynamics: MOVIE });
  await until(() => bg.setWaiters.length === 1, 'first apply held');
  const second = bg.send({ type: 'APPLY_PRESET', presetName: 'B', params: { ...EQ, bass: 2 }, dynamics: MUSIC });
  assert.equal(bg.setWaiters.length, 1, 'the second apply waits until the first write finishes');
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'second apply held');
  bg.releaseOneSet();
  await first;
  await second;
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(bg.local.currentParams.bass, 2);
  assert.deepEqual(bg.local.dynamics, MUSIC);
  assert.deepEqual(bg.offscreenMsgs.at(-1).dynamics, MUSIC);
});

test('Movie Sound never sees one preset\'s EQ with another\'s switches', async () => {
  const bg = loadBackground();
  await bg.ready();
  const legacy = { ...EQ, bass: 9, hpf: 40 };
  bg.local.presets = {
    A: { ...EQ, bass: 1, dynamics: { ...MOVIE } },
    B: { ...EQ, bass: 2, dynamics: { ...MUSIC } },
    Legacy: { ...legacy }
  };
  bg.local.currentPreset = 'A';
  bg.local.currentParams = { ...EQ, bass: 1 };
  bg.local.dynamics = { ...MOVIE };
  const link = attachLink(bg.chrome);
  link.ask();
  await link.advance(0);
  assert.equal(settingsOf(link).length, 1);

  bg.hold(true);
  const applyA = bg.send({ type: 'APPLY_PRESET', presetName: 'A', params: { ...EQ, bass: 1 }, dynamics: MOVIE });
  await until(() => bg.setWaiters.length === 1, 'A held');
  await link.advance(500);
  assert.equal(settingsOf(link).length, 1, 'a held write is invisible to Movie Sound');
  bg.releaseOneSet();
  await applyA;
  const applyB = bg.send({ type: 'APPLY_PRESET', presetName: 'B', params: { ...EQ, bass: 2 }, dynamics: MUSIC });
  await until(() => bg.setWaiters.length === 1, 'B held');
  await link.advance(100);
  bg.releaseOneSet();
  await applyB;
  await link.advance(100);
  bg.hold(false);

  const posts = settingsOf(link);
  assert.ok(posts.length >= 3);
  for (const post of posts) {
    const preset = bg.local.presets[post.currentPreset] || null;
    assert.equal(post.currentParams != null && 'dynamics' in post.currentParams, false);
    if (preset && preset.dynamics) {
      assert.equal(post.currentParams.bass, preset.bass, post.currentPreset);
      assert.deepEqual(norm(post.dynamics), norm(preset.dynamics), post.currentPreset);
    }
  }
  const last = posts.at(-1);
  assert.equal(last.currentPreset, 'B');
  assert.deepEqual(norm(last.dynamics), MUSIC);

  const legacyApply = bg.send({ type: 'APPLY_PRESET', presetName: 'Legacy', params: legacy });
  await legacyApply;
  await link.advance(100);
  assert.deepEqual(bg.local.dynamics, MUSIC, 'a legacy preset leaves the switches in force');
  assert.equal(bg.local.currentParams.bass, 9);
  const afterLegacy = settingsOf(link).at(-1);
  assert.equal(afterLegacy.currentPreset, 'Legacy');
  assert.equal(afterLegacy.currentParams.bass, 9);
  assert.deepEqual(norm(afterLegacy.dynamics), MUSIC);
});

test('a switch then Save stores the new switches, not the ones still in flight', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  bg.local.presets = {};
  bg.local.dynamics = { ...DEFAULT_DYN };
  bg.hold(true);
  const stale = bg.send({ type: 'SET_DYNAMICS', dynamics: DEFAULT_DYN });
  await until(() => bg.setWaiters.length === 1, 'stale switch held');
  const save = bg.send({ type: 'SAVE_PRESET', name: 'Snap', params: EQ, dynamics: MOVIE, ...viewOf(bg) });
  assert.equal(bg.setWaiters.length, 1);
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'save held');
  bg.releaseOneSet();
  await stale;
  const saved = await save;
  assert.equal(saved.success, true);
  assert.deepEqual(bg.local.presets.Snap.dynamics, MOVIE);
  assert.deepEqual(bg.local.dynamics, MOVIE);
  assert.deepEqual(bg.offscreenMsgs.at(-1).dynamics, MOVIE);
});

test('install and upgrade leave stored preset entries identical', async () => {
  const bg = loadBackground();
  await bg.ready();
  const max = { bass: 13, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: false };
  const kept = { bass: 4, dynamics: { leveler: 'bass', match: true, limiter: 'fast', ceiling: 'warm', extra: 'leave me' } };
  const edited = { ...FACTORIES['Flat (Bypass)'], bass: 7 };
  bg.local.presets = { 'max-max-0': max, 'Kept switches': kept, 'Flat (Bypass)': edited };
  const before = {};
  for (const name of Object.keys(bg.local.presets)) before[name] = JSON.stringify(bg.local.presets[name]);
  await bg.install();
  for (const [name, json] of Object.entries(before)) {
    assert.equal(JSON.stringify(bg.local.presets[name]), json, name);
  }
  assert.equal(bg.local.presets['max-max-0'].dynamics, undefined);
  assert.equal(bg.local.presets['Kept switches'].dynamics.extra, 'leave me');
  assert.equal(bg.local.presets['Flat (Bypass)'].bass, 7);
  assert.ok(bg.local.presets['Punchy Bass & Clarity'], 'a missing factory preset is still added');
});

test('GET_STATE does not read a switch baseline from session storage', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.local.presets = { Movie: { ...EQ, dynamics: { ...MOVIE } } };
  bg.local.currentPreset = 'Movie';
  bg.local.currentParams = { ...EQ };
  bg.local.dynamics = { ...MUSIC };
  bg.session.presetSwitchBaseline = { name: 'Movie', dynamics: { ...MOVIE } };
  const same = await bg.send({ type: 'GET_STATE' });
  assert.equal(same.switchBaseline, undefined);
  assert.deepEqual(same.dynamics, MUSIC, 'reopening reports the switches in force, not the saved copy');
  assert.deepEqual(bg.session.presetSwitchBaseline.dynamics, MOVIE, 'session is left untouched');
});

test('APPLY_PRESET publishes the stored preset, not the caller cache', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  const storedDyn = { ...MUSIC, leveler: 'full' };
  bg.local.presets = { B: { ...EQ, bass: 5, dynamics: storedDyn } };
  bg.local.currentPreset = 'A';
  bg.local.currentParams = { ...EQ, bass: 1 };
  bg.local.dynamics = { ...MOVIE };
  const applied = await bg.send({
    type: 'APPLY_PRESET',
    presetName: 'B',
    params: { ...EQ, bass: 99 },
    dynamics: MOVIE
  });
  assert.equal(applied.success, true);
  assert.equal(applied.saved, true);
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(bg.local.currentParams.bass, 5);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.deepEqual(bg.local.dynamics, storedDyn);
  assert.deepEqual(bg.offscreenMsgs.at(-1).dynamics, storedDyn);
});

test('a queued preset read happens after writes that were already waiting', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  bg.local.presets = { Movie: { ...EQ, bass: 1, dynamics: { ...MOVIE } } };
  bg.local.currentPreset = 'Movie';
  bg.local.currentParams = { ...EQ, bass: 4 };
  bg.local.dynamics = { ...DEFAULT_DYN };
  bg.hold(true);
  const reset = bg.send({ type: 'RESET_DEFAULT_PRESETS', currentPreset: 'Movie', ...viewOf(bg) });
  await until(() => bg.setWaiters.length === 1, 'reset held');
  const edit = bg.send({ type: 'SET_DYNAMICS', dynamics: { ...MOVIE, leveler: 'full' } });
  const read = bg.send({ type: 'READ_PRESET_STATE' });
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'switch held');
  bg.releaseOneSet();
  bg.hold(false);
  await reset;
  await edit;
  const snap = await read;
  assert.equal(snap.success, true);
  assert.equal(snap.currentPreset, 'Movie');
  assert.equal(snap.currentParams.bass, 1);
  assert.equal(snap.dynamics.leveler, 'full');
  assert.equal(bg.local.dynamics.leveler, 'full');
});

// The popup controller, loaded for real against the fake DOM and the same worker.
const popupSrc = readFileSync(join(root, 'popup.js'), 'utf8');

function openPopup(bg, search = '') {
  const elements = new Map();
  const pending = new Set();
  const replies = [];
  const held = new Set();
  const docListeners = {};
  const winListeners = {};
  class El {
    constructor(id = '') {
      this.id = id;
      this.style = {};
      this.dataset = {};
      this.children = [];
      this._value = '';
      this.textContent = '';
      this.hidden = false;
      this.checked = false;
      this.disabled = false;
      this.attributes = {};
      this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      this.firstElementChild = { style: {} };
    }
    get value() { return this._value; }
    set value(x) { this._value = String(x); }
    set innerHTML(x) { this.children = []; }
    get innerHTML() { return ''; }
    appendChild(x) { this.children.push(x); return x; }
    setAttribute(k, v) { this.attributes[k] = v; }
    removeAttribute(k) { delete this.attributes[k]; }
    getAttribute(k) { return this.attributes[k] ?? null; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    closest() { return null; }
    addEventListener() {}
    removeEventListener() {}
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  const document = {
    getElementById: get,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: new El('body'),
    createElement: () => new El(),
    visibilityState: 'hidden',
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); }
  };
  const local = {
    ...bg.chrome.storage.local,
    get(keys, cb) {
      const p = bg.chrome.storage.local.get(keys);
      if (cb) p.then(cb);
      return p;
    }
  };
  class PhysicsView {
    constructor() { this.params = null; this.capturing = null; }
    updateState(params, isCapturing) {
      if (params) this.params = { ...params };
      if (typeof isCapturing === 'boolean') this.capturing = isCapturing;
    }
    setFrame() {}
    resize() {}
  }
  const chrome = {
    ...bg.chrome,
    storage: { ...bg.chrome.storage, local },
    runtime: {
      ...bg.chrome.runtime,
      onMessage: { addListener() {} },
      sendMessage(message, cb) {
        const p = bg.send(structuredClone(message)).then((res) => {
          if (!cb) return;
          const deliver = () => cb(res);
          if (held.has(message.type)) replies.push({ type: message.type, deliver });
          else deliver();
        });
        pending.add(p);
        p.finally(() => pending.delete(p));
        return p;
      }
    }
  };
  const sandbox = {
    console,
    document,
    chrome,
    window: {
      location: { search },
      addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); }
    },
    URLSearchParams,
    PhysicsView,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame() {},
    confirm: () => true,
    prompt: () => sandbox.saveName || 'Saved test',
    Event: class {},
    Math,
    Number,
    Object,
    Array,
    parseFloat,
    isNaN,
    isFinite
  };
  vm.createContext(sandbox);
  vm.runInContext(popupSrc, sandbox, { filename: 'popup.js' });
  return {
    get,
    run: (source) => vm.runInContext(source, sandbox),
    sandbox,
    select(name) {
      get('preset-select').value = name;
      get('preset-select').onchange();
    },
    mode(name, value) {
      get('mode-' + name).value = value;
      get('mode-' + name).onchange();
    },
    held,
    replies,
    save(name) {
      sandbox.saveName = name;
      get('btn-save-preset').onclick();
    },
    update() { get('btn-update-preset').onclick(); },
    reset() { get('btn-reset-defaults').onclick(); },
    release(type) {
      const i = replies.findIndex((r) => r.type === type);
      assert.ok(i >= 0, 'held reply ' + type);
      const [r] = replies.splice(i, 1);
      r.deliver();
    },
    focus() {
      document.visibilityState = 'visible';
      for (const fn of docListeners.visibilitychange || []) fn();
      for (const fn of winListeners.focus || []) fn();
    },
    async idle() {
      for (let i = 0; i < 30; i++) {
        if (pending.size) await Promise.all([...pending]);
        await new Promise((r) => setImmediate(r));
        if (!pending.size) return;
      }
      throw new Error('popup did not settle');
    },
    state() {
      return JSON.parse(vm.runInContext(
        'JSON.stringify({name:currentPresetName,dynamics,switchBaseline,params:getParamsFromUI(),badge:presetStatusBadge.textContent,update:btnUpdatePreset.style.display,curve:physics.params&&physics.params.bass,hint:hintEl?hintEl.textContent:"",saveDisabled:!!btnSavePreset.disabled,updateDisabled:!!btnUpdatePreset.disabled})',
        sandbox
      ));
    }
  };
}

async function seedSurfaces() {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  Object.assign(bg.local, {
    presets: {
      A: { ...EQ, bass: 1, dynamics: structuredClone(MOVIE) },
      B: { ...EQ, bass: 2, dynamics: structuredClone(MUSIC) },
      Legacy: { ...EQ, bass: 9 }
    },
    currentPreset: 'A',
    currentParams: { ...EQ, bass: 1 },
    dynamics: structuredClone(MOVIE)
  });
  return bg;
}

test('a late Reset reply does not paint over a newer switch edit', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  await popup.idle();
  bg.hold(true);
  popup.reset();
  await until(() => bg.setWaiters.length === 1, 'Reset storage held');
  popup.mode('leveler', 'full');
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'newer switch held');
  bg.releaseOneSet();
  bg.hold(false);
  await popup.idle();
  assert.equal(popup.state().dynamics.leveler, 'full');
  assert.equal(bg.local.dynamics.leveler, 'full');
  assert.equal(bg.offscreenMsgs.filter((m) => m.type === 'SET_DYNAMICS').at(-1).dynamics.leveler, 'full');
  popup.save('After reset');
  await popup.idle();
  assert.equal(bg.local.presets['After reset'].dynamics.leveler, 'full');
  assert.equal(bg.local.dynamics.leveler, 'full');
  assert.equal(bg.offscreenMsgs.filter((m) => m.type === 'SET_DYNAMICS').at(-1).dynamics.leveler, 'full');
});

test('a Save stores the switches from the click and does not repaint over a newer switch edit', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  await popup.idle();
  bg.hold(true);
  popup.save('Kept');
  await until(() => bg.setWaiters.length === 1, 'save held');
  popup.mode('leveler', 'full');
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'switch after save held');
  bg.releaseOneSet();
  bg.hold(false);
  await popup.idle();
  assert.equal(bg.local.presets.Kept.dynamics.leveler, 'bass');
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().dynamics.leveler, 'full');
  assert.equal(bg.local.dynamics.leveler, 'full');
});

test('a side panel refreshes on focus, and a stale Update writes nothing', async () => {
  const bg = await seedSurfaces();
  delete bg.local.presets.B.dynamics;
  const panel = openPopup(bg, '?panel=1');
  const popup = openPopup(bg);
  await panel.idle();
  await popup.idle();
  const link = attachLink(bg.chrome);
  link.ask();
  await link.advance(0);
  popup.select('B');
  await popup.idle();
  popup.mode('leveler', 'full');
  await popup.idle();
  popup.update();
  await popup.idle();
  assert.equal(bg.local.presets.B.dynamics.leveler, 'full');
  assert.equal(panel.state().name, 'A', 'the panel does not follow another screen live');
  panel.focus();
  await panel.idle();
  assert.equal(panel.state().name, 'B');
  assert.equal(panel.state().params.bass, 2);
  assert.equal(panel.state().dynamics.leveler, 'full');
  assert.match(panel.run('presetSwitchLabel.textContent'), /EQ \+ switches/);
  await link.advance(200);
  const followed = settingsOf(link).at(-1);
  assert.equal(followed.currentParams.bass, 2);
  assert.equal(followed.dynamics.leveler, 'full');
  panel.update();
  await panel.idle();
  assert.equal(bg.local.presets.B.dynamics.leveler, 'full');
  assert.equal(bg.local.presets.B.bass, 2);
  const savedB = snapshot(bg.local.presets.B);
  popup.select('A');
  await popup.idle();
  assert.equal(panel.state().name, 'B');
  panel.update();
  await panel.idle();
  assert.deepEqual(bg.local.presets.B, savedB);
  assert.equal(bg.local.currentPreset, 'A');
  assert.equal(panel.state().name, 'A');
  assert.equal(panel.state().params.bass, 1);
  assert.equal(panel.state().dynamics.leveler, 'bass');
  assert.equal(panel.get('hint').textContent, 'Another window changed your presets, so this one has been refreshed. Please try again.');
  await link.advance(200);
  const after = settingsOf(link).at(-1);
  assert.equal(after.currentPreset, 'A');
  assert.equal(after.currentParams.bass, 1);
  assert.equal(after.dynamics.leveler, 'bass');
});

test('picking a preset redraws currentParams, and an EQ-only switch change stays Saved', async () => {
  const bg = await seedSurfaces();
  bg.local.currentPreset = 'Legacy';
  bg.local.currentParams = { ...bg.local.presets.Legacy };
  const popup = openPopup(bg);
  await popup.idle();
  popup.mode('leveler', 'full');
  await popup.idle();
  const edited = popup.state();
  assert.match(edited.badge, /Saved/);
  assert.equal(edited.update, 'inline-block');
  const reopened = openPopup(bg);
  await reopened.idle();
  assert.match(reopened.state().badge, /Saved/);
  assert.equal(reopened.state().update, 'inline-block');
  assert.equal(bg.session.presetSwitchBaseline, undefined);
  popup.select('B');
  await popup.idle();
  const picked = popup.state();
  assert.equal(picked.curve, 2);
  assert.equal(picked.params.bass, 2);
  assert.equal(popup.run('currentParams.bass'), 2);
  assert.equal(picked.dynamics.leveler, 'slow');
});

const STALE_HINT = 'Another window changed your presets, so this one has been refreshed. Please try again.';

test('a late Save reply cannot make Update copy the other preset onto the saved one', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  const panel = openPopup(bg, '?panel=1');
  await popup.idle();
  await panel.idle();
  popup.held.add('SAVE_PRESET');
  popup.save('Saved A');
  await popup.idle();
  assert.equal(bg.local.presets['Saved A'].bass, 1);
  assert.deepEqual(bg.local.presets['Saved A'].dynamics, MOVIE);
  panel.select('B');
  await panel.idle();
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().params.bass, 1);
  assert.deepEqual(popup.state().dynamics, MOVIE);
  popup.release('SAVE_PRESET');
  await popup.idle();
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().params.bass, 1);
  popup.update();
  await popup.idle();
  assert.equal(bg.local.presets['Saved A'].bass, 1);
  assert.deepEqual(bg.local.presets['Saved A'].dynamics, MOVIE);
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(popup.state().name, 'B');
  assert.equal(popup.state().params.bass, 2);
  assert.equal(popup.state().dynamics.leveler, 'slow');
  assert.equal(popup.get('hint').textContent, STALE_HINT);
});

test('a delayed preset read does not let Save publish the preset another screen has left', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  const panel = openPopup(bg, '?panel=1');
  await popup.idle();
  await panel.idle();
  const link = attachLink(bg.chrome);
  link.ask();
  await link.advance(0);
  popup.held.add('RESET_DEFAULT_PRESETS');
  popup.held.add('READ_PRESET_STATE');
  popup.reset();
  await popup.idle();
  popup.mode('leveler', 'full');
  await popup.idle();
  popup.release('RESET_DEFAULT_PRESETS');
  await popup.idle();
  assert.equal(popup.replies[0].type, 'READ_PRESET_STATE');
  panel.select('B');
  await panel.idle();
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().dynamics.leveler, 'full');
  popup.release('READ_PRESET_STATE');
  await popup.idle();
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().dynamics.leveler, 'full');
  const before = snapshot(bg.local.presets);
  popup.save('Saved after remote B');
  await popup.idle();
  await link.advance(200);
  assert.equal(bg.local.presets['Saved after remote B'], undefined);
  assert.deepEqual(bg.local.presets, before);
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(popup.state().name, 'B');
  assert.equal(popup.state().dynamics.leveler, 'slow');
  assert.equal(popup.get('hint').textContent, STALE_HINT);
  const posted = settingsOf(link).at(-1);
  assert.equal(posted.currentParams.bass, 2);
  assert.equal(posted.dynamics.leveler, 'slow');
});

test('a delayed Reset reply does not repaint a newer selection, and Save is refused', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  const panel = openPopup(bg, '?panel=1');
  await popup.idle();
  await panel.idle();
  popup.held.add('RESET_DEFAULT_PRESETS');
  popup.reset();
  await popup.idle();
  panel.select('B');
  await panel.idle();
  assert.equal(popup.state().name, 'A');
  const sets = bg.localSets.length;
  popup.release('RESET_DEFAULT_PRESETS');
  await popup.idle();
  assert.equal(bg.localSets.length, sets);
  assert.equal(popup.state().name, 'A');
  assert.equal(bg.local.currentPreset, 'B');
  popup.save('Late reset');
  await popup.idle();
  assert.equal(bg.local.presets['Late reset'], undefined);
  assert.equal(popup.state().name, 'B');
  assert.equal(popup.state().params.bass, 2);
  assert.equal(popup.state().dynamics.leveler, 'slow');
  assert.equal(popup.get('hint').textContent, STALE_HINT);
});

test('an older storage event does not replace a newer local pick, and Save waits until that pick lands', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  await popup.idle();
  bg.hold(true);
  popup.select('B');
  await until(() => bg.setWaiters.length === 1, 'B pick held');
  popup.select('Legacy');
  assert.equal(popup.state().name, 'Legacy');
  assert.equal(popup.state().params.bass, 9);
  assert.equal(popup.state().saveDisabled, true);
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'Legacy pick held');
  assert.equal(popup.state().name, 'Legacy');
  assert.equal(popup.state().params.bass, 9);
  popup.save('Rapid picks');
  assert.equal(bg.local.presets['Rapid picks'], undefined);
  bg.releaseOneSet();
  bg.hold(false);
  await popup.idle();
  assert.equal(bg.local.currentPreset, 'Legacy');
  assert.equal(bg.local.currentParams.bass, 9);
  assert.equal(popup.state().saveDisabled, false);
  popup.save('Rapid picks');
  await popup.idle();
  assert.equal(bg.local.presets['Rapid picks'].bass, 9);
});

test('reversed pick replies keep the newer preset, then Save stores that preset\'s edited switches', async () => {
  const bg = await seedSurfaces();
  const popup = openPopup(bg);
  await popup.idle();
  popup.held.add('APPLY_PRESET');
  popup.select('A');
  popup.select('B');
  await popup.idle();
  assert.equal(popup.replies.length, 2);
  const pending = popup.replies.splice(0).reverse();
  for (const reply of pending) reply.deliver();
  await popup.idle();
  assert.equal(popup.state().name, 'B');
  assert.equal(popup.state().dynamics.leveler, 'slow');
  assert.deepEqual(popup.state().switchBaseline, MUSIC);
  popup.mode('leveler', 'bass');
  await popup.idle();
  popup.save('Toggle then Save');
  await popup.idle();
  assert.equal(bg.local.presets['Toggle then Save'].dynamics.leveler, 'bass');
  assert.equal(bg.local.presets['Toggle then Save'].bass, 2);
});
