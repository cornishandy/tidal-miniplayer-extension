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
  const boot = () => {
    const sandbox = {
      console, Math, Number, Object, Array, Error, String, Boolean, Date, Promise, isFinite, Infinity, Map, Set,
      setTimeout, clearTimeout, setInterval, clearInterval, chrome
    };
    vm.createContext(sandbox);
    vm.runInContext(backgroundSrc, sandbox, { filename: 'background.js' });
    return sandbox;
  };
  let sandbox = boot();
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
    // MV3 stops an idle worker; the next message starts a fresh one. Memory (the write queue) is gone,
    // chrome.storage is not.
    async restart() { sandbox = boot(); this.sandbox = sandbox; await new Promise((r) => setTimeout(r, 30)); },
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

// Direct sends act as one up-to-date screen: its id, and the revision stored now.
function viewOf(bg, surfaceId = 'test-surface') {
  return { surfaceId, viewRev: Number.isInteger(bg.local.stateRev) ? bg.local.stateRev : 0 };
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
  const applied = await bg.send({ type: 'APPLY_PRESET', presetName: 'Movie', params: { ...EQ, bass: 1, dynamics: { junk: true } }, dynamics: MOVIE, ...viewOf(bg) });
  const sets = bg.localSets.slice(start);
  assert.equal(sets.length, 1);
  assert.deepEqual(Object.keys(sets[0]).sort(), ['currentParams', 'currentPreset', 'dynamics', 'lastWriter', 'stateRev']);
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
  const legacyApply = await bg.send({ type: 'APPLY_PRESET', presetName: 'Legacy', params: legacy, ...viewOf(bg) });
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

test('a slider does not put the switches back or rename the preset, and the last preset write wins', async () => {
  const bg = loadBackground();
  await bg.ready();
  bg.setOffscreen(true);
  bg.local.presets = {
    A: { ...EQ, bass: 1, dynamics: { ...MOVIE } },
    B: { ...EQ, bass: 2, dynamics: { ...MUSIC } }
  };
  bg.local.currentPreset = 'B';
  bg.local.dynamics = { ...DEFAULT_DYN };
  await bg.send({ type: 'EDIT_DYNAMICS', dynamics: MOVIE, ...viewOf(bg) });
  const off = bg.offscreenMsgs.length;
  const mark = bg.localSets.length;
  await bg.send({ type: 'EDIT_PARAMS', params: { ...EQ, bass: 4, dynamics: { leveler: 'bass', match: false, limiter: 'fast', ceiling: 'clean' } }, presetName: 'A', ...viewOf(bg) });
  assert.deepEqual(bg.local.dynamics, MOVIE);
  assert.equal(bg.local.currentParams.bass, 4);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.equal('dynamics' in bg.localSets[bg.localSets.length - 1], false);
  assert.equal(bg.localSets.length, mark + 1);
  // One set: the EQ, the revision and the writer. A stale `presetName` is ignored: a slider never renames the preset.
  assert.deepEqual(Object.keys(bg.localSets.at(-1)).sort(), ['currentParams', 'lastWriter', 'stateRev']);
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(bg.local.stateRev, 2);
  assert.equal(bg.local.lastWriter, 'test-surface');
  assert.deepEqual(bg.offscreenMsgs.slice(off).map((m) => m.type), ['UPDATE_AUDIO_PARAMS']);

  bg.hold(true);
  const first = bg.send({ type: 'APPLY_PRESET', presetName: 'A', params: { ...EQ, bass: 1 }, dynamics: MOVIE, ...viewOf(bg) });
  await until(() => bg.setWaiters.length === 1, 'first apply held');
  const second = bg.send({ type: 'APPLY_PRESET', presetName: 'B', params: { ...EQ, bass: 2 }, dynamics: MUSIC, ...viewOf(bg) });
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
  const applyA = bg.send({ type: 'APPLY_PRESET', presetName: 'A', params: { ...EQ, bass: 1 }, dynamics: MOVIE, ...viewOf(bg) });
  await until(() => bg.setWaiters.length === 1, 'A held');
  await link.advance(500);
  assert.equal(settingsOf(link).length, 1, 'a held write is invisible to Movie Sound');
  bg.releaseOneSet();
  await applyA;
  const applyB = bg.send({ type: 'APPLY_PRESET', presetName: 'B', params: { ...EQ, bass: 2 }, dynamics: MUSIC, ...viewOf(bg) });
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

  const legacyApply = bg.send({ type: 'APPLY_PRESET', presetName: 'Legacy', params: legacy, ...viewOf(bg) });
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
  const stale = bg.send({ type: 'EDIT_DYNAMICS', dynamics: DEFAULT_DYN, ...viewOf(bg) });
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
    dynamics: MOVIE,
    ...viewOf(bg)
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
  const edit = bg.send({ type: 'EDIT_DYNAMICS', dynamics: { ...MOVIE, leveler: 'full' }, ...viewOf(bg) });
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
  const sent = [];
  const faults = new Map();
  const timers = new Set();
  let now = 0;
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
    dispatchEvent(event) { this['on' + event.type]?.({ target: this }); }
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  const tags = ['hpf', 'bass', 'mid', 'high', 'comp', 'gain', 'pitch', 'match'].map((band) => {
    const tag = get('tag-' + band);
    tag.dataset.band = band;
    return tag;
  });
  const nudges = ['bass', 'hpf', 'mid', 'high', 'gain', 'pitch'].flatMap((band) => {
    const slider = get('slider-' + band);
    const [min, max, step] = { bass: [0, 28, 0.5], hpf: [20, 200, 5], mid: [-12, 12, 0.5], high: [-12, 12, 0.5], gain: [0.5, 2.5, 0.05], pitch: [-12, 12, 0.5] }[band];
    Object.assign(slider, { min, max, defaultValue: 0 });
    return ['up', 'down'].map((action) => {
      const button = get(`nudge-${band}-${action}`);
      button.setAttribute('data-target', slider.id);
      button.setAttribute('data-action', action);
      button.setAttribute('data-step', step);
      return button;
    });
  });
  const document = {
    getElementById: get,
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '.band-tag' || selector === 'button.band-tag') return tags;
      if (selector === '.eq-nudge-btn') return nudges;
      return [];
    },
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
        sent.push(structuredClone(message));
        const fault = faults.get(message.type);
        if (fault) {
          faults.delete(message.type);
          if (fault === 'throw') throw new Error('injected port exception');
          if (fault === 'error') { cb({ success: false, error: 'injected reply error' }); return; }
          if (fault === 'missing') { cb(); return; }
          if (fault === 'port') {
            chrome.runtime.lastError = { message: 'injected port error' };
            cb();
            chrome.runtime.lastError = null;
            return;
          }
        }
        const p = bg.send(structuredClone(message)).then((res) => {
          if (!cb) return;
          if (fault === 'timeout') return;
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
    setTimeout(fn, ms) { const timer = { fn, at: now + ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame() {},
    confirm: () => true,
    prompt: () => sandbox.saveName || 'Saved test',
    Event: class { constructor(type) { this.type = type; } },
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
    faults,
    advance(ms) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now && timers.delete(timer)) timer.fn();
      }
    },
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
    sent,
    slider(id, value) {
      const el = get('slider-' + id);
      el.value = value;
      el.oninput({ target: el });
    },
    remove() { get('btn-delete-preset').onclick(); },
    releaseAll(type) {
      const mine = replies.filter((r) => r.type === type);
      for (const r of mine) replies.splice(replies.indexOf(r), 1);
      for (const r of mine) r.deliver();
    },
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
  assert.equal(popup.state().name, 'Kept', 'the merged edit reply confirms the saved name too');
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
  // The panel's Update made it the last writer, and the popup has not painted that: its pick writes
  // nothing, and it shows the stored state with the hint. Picked again, it goes through.
  const beforePick = bg.localSets.length;
  popup.select('A');
  await popup.idle();
  assert.equal(bg.localSets.length, beforePick);
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(popup.state().name, 'B');
  assert.equal(popup.state().dynamics.leveler, 'full');
  assert.equal(popup.get('hint').textContent, 'Another window changed your presets, so this one has been refreshed. Please try again.');
  popup.select('A');
  await popup.idle();
  assert.equal(bg.local.currentPreset, 'A');
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
  // The panel paints the Save when focused (its pick would otherwise be refused), then picks B.
  panel.focus();
  await panel.idle();
  assert.equal(panel.state().name, 'Saved A');
  panel.select('B');
  await panel.idle();
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().params.bass, 1);
  assert.deepEqual(popup.state().dynamics, MOVIE);
  popup.release('SAVE_PRESET');
  await popup.idle();
  // The late reply paints only the Save it acknowledges: the name and the controls are Saved A's.
  assert.equal(popup.state().name, 'Saved A');
  assert.equal(popup.state().params.bass, 1);
  assert.deepEqual(popup.state().dynamics, MOVIE);
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
  panel.focus();
  await panel.idle();
  panel.select('B');
  await panel.idle();
  assert.equal(bg.local.currentPreset, 'B');
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
  panel.focus();
  await panel.idle();
  panel.select('B');
  await panel.idle();
  assert.equal(bg.local.currentPreset, 'B');
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
  assert.equal(popup.state().name, 'A', 'keep the confirmed selection until the newest pick replies');
  assert.equal(popup.state().params.bass, 1);
  assert.equal(popup.state().saveDisabled, true);
  bg.releaseOneSet();
  await until(() => bg.setWaiters.length === 1, 'Legacy pick held');
  assert.equal(popup.state().name, 'A');
  assert.equal(popup.state().params.bass, 1);
  popup.save('Rapid picks');
  assert.equal(bg.local.presets['Rapid picks'], undefined);
  bg.releaseOneSet();
  bg.hold(false);
  await popup.idle();
  assert.equal(bg.local.currentPreset, 'Legacy');
  assert.equal(bg.local.currentParams.bass, 9);
  assert.equal(popup.state().name, 'Legacy');
  assert.equal(popup.state().params.bass, 9);
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

// Round 3: one write rule. A write is accepted from the screen that wrote last, or from a screen whose
// controls show the stored revision; anything else writes nothing and that screen repaints the stored state.

const linkKept = (link) => {
  for (const post of settingsOf(link)) {
    if (post.currentPreset === 'A') assert.deepEqual(norm(post.dynamics), MOVIE, 'A with its own switches');
    if (post.currentPreset === 'B') assert.deepEqual(norm(post.dynamics), MUSIC, 'B with its own switches');
  }
};

test('a write without its screen id and revision, or from a screen that is out of date, is refused and writes nothing', async () => {
  const bg = await seedSurfaces();
  const base = snapshot(bg.local);
  const writes = [
    { type: 'EDIT_PARAMS', params: { ...EQ, bass: 7 } },
    { type: 'EDIT_DYNAMICS', dynamics: MUSIC },
    { type: 'APPLY_PRESET', presetName: 'B' },
    { type: 'SET_ACTIVE_PRESET', presetName: 'B' },
    { type: 'SAVE_PRESET', name: 'Untagged', params: EQ, dynamics: MUSIC },
    { type: 'UPDATE_PRESET', name: 'A', params: EQ, dynamics: MUSIC },
    { type: 'DELETE_PRESET', name: 'A' },
    { type: 'RESET_DEFAULT_PRESETS', currentPreset: 'A' },
    { type: 'RESET_DEFAULT_PRESETS' }
  ];
  for (const msg of writes) {
    for (const tag of [{}, { surfaceId: 'one' }, { viewRev: 0 }, { surfaceId: '', viewRev: 0 }, { surfaceId: 'one', viewRev: '0' }]) {
      const mark = bg.localSets.length;
      const res = await bg.send({ ...msg, ...tag });
      assert.equal(res.success, false, msg.type);
      assert.equal(res.error, 'stale-view', msg.type);
      assert.equal(res.stateRev, 0);
      assert.equal(res.state.currentPreset, 'A');
      assert.equal(bg.localSets.length, mark, msg.type + ' must not write');
    }
  }
  assert.deepEqual(bg.local, base);
  // Accepted: the revision and the writer go out in the write's own set.
  const ok = await bg.send({ type: 'EDIT_DYNAMICS', dynamics: MUSIC, surfaceId: 'one', viewRev: 0 });
  assert.equal(ok.success, true);
  assert.equal(ok.stateRev, 1);
  assert.deepEqual(bg.localSets.at(-1), { dynamics: MUSIC, stateRev: 1, lastWriter: 'one' });
  // Another screen still showing revision 0 is refused. The last writer is not, whatever revision it sends.
  const mark = bg.localSets.length;
  const other = await bg.send({ type: 'EDIT_PARAMS', params: { ...EQ, bass: 7 }, surfaceId: 'two', viewRev: 0 });
  assert.equal(other.error, 'stale-view');
  assert.equal(other.state.stateRev, 1);
  assert.deepEqual(other.state.dynamics, MUSIC);
  assert.equal(bg.localSets.length, mark);
  const again = await bg.send({ type: 'EDIT_PARAMS', params: { ...EQ, bass: 7 }, surfaceId: 'one', viewRev: 0 });
  assert.equal(again.success, true);
  assert.equal(again.stateRev, 2);
  // A screen showing revision 2 may write, and becomes the last writer.
  const current = await bg.send({ type: 'APPLY_PRESET', presetName: 'B', surfaceId: 'two', viewRev: 2 });
  assert.equal(current.success, true);
  assert.equal(current.stateRev, 3);
  assert.equal(bg.local.lastWriter, 'two');
  const refusedNow = await bg.send({ type: 'EDIT_DYNAMICS', dynamics: MOVIE, surfaceId: 'one', viewRev: 2 });
  assert.equal(refusedNow.error, 'stale-view');
  assert.deepEqual(bg.local.dynamics, MUSIC);
});

test('Sol r3 stale-slider: a screen that has not painted another screen\'s pick cannot move a slider', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  const link = attachLink(bg.chrome);
  link.ask();
  await link.advance(0);
  q.select('B');
  await q.idle();
  const afterPick = snapshot(bg.local);
  const mark = bg.localSets.length;
  p.held.add('READ_PRESET_STATE');
  p.focus();
  await p.idle();
  assert.equal(p.state().name, 'A');
  p.slider('bass', 17);
  await p.idle();
  await link.advance(200);
  assert.equal(bg.localSets.length, mark, 'the stale slider writes nothing');
  assert.deepEqual(bg.local, afterPick);
  const shown = p.state();
  assert.equal(shown.name, 'B');
  assert.equal(shown.params.bass, 2);
  assert.deepEqual(shown.dynamics, MUSIC);
  assert.equal(shown.hint, STALE_HINT);
  const out = settingsOf(link).at(-1);
  assert.equal(out.currentPreset, 'B');
  assert.equal(out.currentParams.bass, 2);
  assert.deepEqual(norm(out.dynamics), MUSIC);
  linkKept(link);
  p.releaseAll('READ_PRESET_STATE');
  await p.idle();
  assert.equal(p.state().name, 'B');
  assert.equal(bg.localSets.length, mark);
});

test('Sol r3 stale-switch: a Ceiling change on a screen that has not painted another screen\'s pick writes nothing', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  const link = attachLink(bg.chrome);
  link.ask();
  await link.advance(0);
  q.select('B');
  await q.idle();
  const afterPick = snapshot(bg.local);
  const mark = bg.localSets.length;
  p.held.add('READ_PRESET_STATE');
  p.focus();
  await p.idle();
  p.mode('ceiling', 'clean');
  await p.idle();
  await link.advance(200);
  assert.equal(bg.localSets.length, mark, 'the stale switch writes nothing');
  assert.deepEqual(bg.local, afterPick);
  assert.deepEqual(bg.local.dynamics, MUSIC, 'B keeps its leveler, MATCH and limiter');
  const shown = p.state();
  assert.equal(shown.name, 'B');
  assert.deepEqual(shown.dynamics, MUSIC);
  assert.equal(shown.hint, STALE_HINT);
  const out = settingsOf(link).at(-1);
  assert.equal(out.currentPreset, 'B');
  assert.equal(out.currentParams.bass, 2);
  assert.deepEqual(norm(out.dynamics), MUSIC);
  linkKept(link);
  p.releaseAll('READ_PRESET_STATE');
  await p.idle();
  assert.equal(bg.localSets.length, mark);
});

test('Sol r3 same-name: an edit on a screen that has not painted another screen\'s Update is refused before Update exists', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  q.slider('bass', 8);
  await q.idle();
  q.mode('leveler', 'slow');
  await q.idle();
  q.update();
  await q.idle();
  const updatedA = snapshot(bg.local.presets.A);
  assert.equal(updatedA.bass, 8);
  assert.equal(updatedA.dynamics.leveler, 'slow');
  assert.equal(p.state().params.bass, 1);
  assert.equal(p.run('viewRev'), 0);
  assert.equal(bg.local.stateRev, 3);
  p.held.add('READ_PRESET_STATE');
  p.focus();
  await p.idle();
  const mark = bg.localSets.length;
  p.mode('ceiling', 'clean');
  await p.idle();
  assert.equal(bg.localSets.length, mark, 'the stale switch writes nothing');
  assert.deepEqual(bg.local.presets.A, updatedA);
  const shown = p.state();
  assert.equal(shown.name, 'A');
  assert.equal(shown.params.bass, 8);
  assert.equal(shown.dynamics.leveler, 'slow');
  assert.equal(shown.dynamics.ceiling, 'warm');
  assert.match(shown.badge, /Saved/);
  assert.equal(shown.update, 'none', 'nothing is modified, so Update is not offered');
  assert.equal(shown.hint, STALE_HINT);
  // Pressed anyway, Update now stores what this screen shows: the stored A. Nothing newer is lost.
  p.update();
  await p.idle();
  assert.deepEqual(bg.local.presets.A, updatedA);
  p.releaseAll('READ_PRESET_STATE');
  await p.idle();
  assert.deepEqual(bg.local.presets.A, updatedA);
});

test('two up-to-date screens each move a slider: the second is refused, refreshed, then accepted', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  p.slider('bass', 5);
  await p.idle();
  assert.equal(bg.local.currentParams.bass, 5);
  assert.equal(bg.local.lastWriter, p.run('surfaceId'));
  let mark = bg.localSets.length;
  q.slider('mid', 4);
  await q.idle();
  assert.equal(bg.localSets.length, mark, 'q had not painted p\'s slider');
  assert.equal(bg.local.currentParams.mid, 1);
  assert.equal(q.state().params.bass, 5);
  assert.equal(q.state().params.mid, 1);
  assert.equal(q.state().hint, STALE_HINT);
  q.slider('mid', 4);
  await q.idle();
  assert.equal(bg.local.currentParams.bass, 5);
  assert.equal(bg.local.currentParams.mid, 4);
  assert.equal(bg.local.currentPreset, 'A');
  assert.deepEqual(bg.local.dynamics, MOVIE);
  assert.equal(bg.local.lastWriter, q.run('surfaceId'));
  assert.notEqual(p.run('surfaceId'), q.run('surfaceId'));
  // Now p is the one out of date.
  mark = bg.localSets.length;
  p.slider('high', 3);
  await p.idle();
  assert.equal(bg.localSets.length, mark);
  assert.equal(bg.local.currentParams.high, 0);
  assert.equal(p.state().params.mid, 4);
  assert.equal(p.state().params.high, 0);
  assert.equal(p.state().hint, STALE_HINT);
});

test('a drag across a refusal converges on the fresh view, and storage never mixes two presets', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  const link = attachLink(bg.chrome);
  link.ask();
  await link.advance(0);
  const start = bg.localSets.length;
  q.select('B');
  await q.idle();
  const afterPick = snapshot(bg.local);
  const mark = bg.localSets.length;
  // One message per input event, all sent before the first reply comes back.
  p.held.add('EDIT_PARAMS');
  for (const v of [10, 11, 12]) p.slider('bass', v);
  await p.idle();
  await link.advance(200);
  assert.equal(p.replies.length, 3);
  assert.equal(bg.localSets.length, mark);
  assert.deepEqual(bg.local, afterPick);
  // The first two refusals arrive after newer input and leave the screen alone; the last repaints it.
  p.release('EDIT_PARAMS');
  await p.idle();
  p.release('EDIT_PARAMS');
  await p.idle();
  assert.equal(p.state().params.bass, 12);
  assert.equal(p.state().hint, '');
  p.release('EDIT_PARAMS');
  await p.idle();
  assert.equal(p.state().name, 'B');
  assert.equal(p.state().params.bass, 2);
  assert.deepEqual(p.state().dynamics, MUSIC);
  assert.equal(p.state().hint, STALE_HINT);
  // The next input event edits the fresh view.
  p.held.delete('EDIT_PARAMS');
  p.slider('bass', 13);
  await p.idle();
  await link.advance(200);
  assert.equal(bg.local.currentPreset, 'B');
  assert.equal(bg.local.currentParams.bass, 13);
  assert.deepEqual(bg.local.dynamics, MUSIC);
  assert.equal(bg.local.lastWriter, p.run('surfaceId'));
  for (const set of bg.localSets.slice(start)) {
    if (set.currentParams) assert.ok(![10, 11, 12].includes(set.currentParams.bass), 'a refused drag value was written');
  }
  linkKept(link);
  const out = settingsOf(link).at(-1);
  assert.equal(out.currentParams.bass, 13);
  assert.deepEqual(norm(out.dynamics), MUSIC);
});

test('the last writer keeps writing across a worker restart; a screen that is out of date is still refused', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  // A drag whose replies have not come back: p's controls still carry revision 0.
  p.held.add('EDIT_PARAMS');
  p.slider('bass', 5);
  await p.idle();
  assert.equal(bg.local.stateRev, 1);
  assert.equal(bg.local.lastWriter, p.run('surfaceId'));
  const before = bg.sandbox;
  await bg.restart();
  assert.notEqual(bg.sandbox, before);
  p.slider('bass', 6);
  await p.idle();
  assert.equal(p.sent.at(-1).viewRev, 0);
  assert.equal(bg.local.currentParams.bass, 6, 'the restarted worker still knows the last writer');
  assert.equal(bg.local.stateRev, 2);
  p.releaseAll('EDIT_PARAMS');
  await p.idle();
  assert.equal(p.state().params.bass, 6);
  assert.equal(p.state().hint, '');
  assert.equal(p.run('viewRev'), 2);
  const mark = bg.localSets.length;
  q.slider('mid', 4);
  await q.idle();
  assert.equal(bg.localSets.length, mark);
  assert.equal(q.state().params.bass, 6);
  assert.equal(q.state().hint, STALE_HINT);
});

test('a late refusal does not paint over an edit accepted after the screen refreshed', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  q.select('B');
  await q.idle();
  p.held.add('EDIT_PARAMS');
  p.slider('bass', 17);
  await p.idle();
  assert.equal(p.replies.length, 1, 'the refusal is late');
  assert.equal(bg.local.currentParams.bass, 2);
  p.focus();
  await p.idle();
  assert.equal(p.state().name, 'B');
  assert.equal(p.state().params.bass, 2);
  assert.equal(p.state().hint, '');
  p.mode('leveler', 'bass');
  await p.idle();
  assert.equal(bg.local.dynamics.leveler, 'bass');
  assert.equal(bg.local.lastWriter, p.run('surfaceId'));
  const settled = snapshot(bg.local);
  p.release('EDIT_PARAMS');
  await p.idle();
  assert.equal(p.state().dynamics.leveler, 'bass', 'the late refusal must not repaint B\'s slow leveler');
  assert.equal(p.state().params.bass, 2);
  assert.equal(p.state().hint, '');
  assert.deepEqual(bg.local, settled);
});

test('every preset-state message from a screen carries its id and revision; a slider carries no preset name', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  await p.idle();
  p.slider('bass', 4);
  await p.idle();
  p.mode('leveler', 'slow');
  await p.idle();
  p.select('B');
  await p.idle();
  p.save('Tagged');
  await p.idle();
  p.update();
  await p.idle();
  p.reset();
  await p.idle();
  p.remove();
  await p.idle();
  const id = p.run('surfaceId');
  const kinds = ['EDIT_PARAMS', 'EDIT_DYNAMICS', 'APPLY_PRESET', 'SAVE_PRESET', 'UPDATE_PRESET', 'RESET_DEFAULT_PRESETS', 'DELETE_PRESET'];
  const writes = p.sent.filter((m) => kinds.includes(m.type));
  assert.deepEqual([...new Set(writes.map((m) => m.type))].sort(), [...kinds].sort());
  for (const m of writes) {
    assert.equal(m.surfaceId, id, m.type);
    assert.ok(Number.isInteger(m.viewRev), m.type);
    assert.equal('expectedRev' in m || 'expectedPreset' in m, false, m.type);
  }
  for (const m of writes.filter((x) => x.type === 'EDIT_PARAMS')) assert.equal('presetName' in m, false);
  // The offscreen document answers an untargeted UPDATE_AUDIO_PARAMS or SET_DYNAMICS itself (it would apply a refused
  // edit and reply before the worker). A screen therefore never sends those names; only the worker does, targeted.
  const offscreenSrc = readFileSync(join(root, 'offscreen.js'), 'utf8');
  for (const name of ['UPDATE_AUDIO_PARAMS', 'SET_DYNAMICS']) {
    assert.match(offscreenSrc, new RegExp(`case '${name}':`), name + ' is answered by the offscreen document');
    assert.equal(p.sent.some((m) => m.type === name && m.target !== 'offscreen'), false, name + ' sent from a screen');
  }
  assert.equal(/type: '(UPDATE_AUDIO_PARAMS|SET_DYNAMICS)'/.test(popupSrc), false, 'popup.js names an engine message');
  assert.equal(bg.local.presets.Tagged, undefined, 'deleted again');
  assert.equal(p.state().hint, '', 'one screen is never refused');
});

test('neither an unpainted refresh read nor an unpainted refusal makes a screen current (Sol r3 finding 2)', async () => {
  const bg = await seedSurfaces();
  const p = openPopup(bg);
  const q = openPopup(bg, '?panel=1');
  await p.idle();
  await q.idle();
  q.select('B');
  await q.idle();
  const afterPick = snapshot(bg.local);
  const mark = bg.localSets.length;
  p.held.add('READ_PRESET_STATE');
  p.held.add('EDIT_PARAMS');
  p.focus();
  await p.idle();
  p.slider('bass', 10);
  await p.idle();
  // The focus reads arrive after that edit, so they are not painted, and the screen still shows A.
  p.releaseAll('READ_PRESET_STATE');
  await p.idle();
  assert.equal(p.state().name, 'A');
  assert.equal(p.run('viewRev'), 0);
  p.slider('bass', 11);
  await p.idle();
  // The first refusal arrives after a newer edit: not painted either.
  p.release('EDIT_PARAMS');
  await p.idle();
  assert.equal(p.state().params.bass, 11);
  assert.equal(p.run('viewRev'), 0);
  p.slider('bass', 12);
  await p.idle();
  assert.equal(bg.localSets.length, mark, 'every edit from the view that was never painted is refused');
  assert.deepEqual(bg.local, afterPick);
  assert.ok(p.sent.filter((m) => m.type === 'EDIT_PARAMS').every((m) => m.viewRev === 0));
  p.releaseAll('EDIT_PARAMS');
  await p.idle();
  assert.equal(p.state().name, 'B');
  assert.equal(p.state().params.bass, 2);
  assert.deepEqual(p.state().dynamics, MUSIC);
  assert.equal(p.state().hint, STALE_HINT);
  assert.equal(p.run('viewRev'), 1);
});

test('an absent or invalid stored revision counts as 0, install leaves it alone, and restore-defaults counts once', async () => {
  for (const oldRev of [undefined, 0, 7, -5, 'invalid', 2.5]) {
    const bg = await seedSurfaces();
    if (oldRev !== undefined) bg.local.stateRev = oldRev;
    await bg.install();
    assert.deepEqual(bg.local.stateRev, oldRev, 'install does not write the revision');
    assert.equal(bg.local.lastWriter, undefined);
    const want = Number.isInteger(oldRev) && oldRev >= 0 ? oldRev : 0;
    assert.equal((await bg.send({ type: 'READ_PRESET_STATE' })).stateRev, want);
    assert.equal((await bg.send({ type: 'GET_STATE' })).stateRev, want);
    const mark = bg.localSets.length;
    const restored = await bg.send({ type: 'RESET_DEFAULT_PRESETS', surfaceId: 'opened', viewRev: want });
    assert.equal(restored.success, true);
    assert.equal(restored.stateRev, want + 1);
    assert.equal(bg.localSets.length, mark + 1);
    assert.equal(bg.local.stateRev, want + 1);
    assert.ok(bg.local.presets.A && bg.local.presets.Legacy, 'custom presets are kept');
    for (const [name, preset] of Object.entries(FACTORIES)) assert.deepEqual(bg.local.presets[name], preset);
  }
});

// Round 4: confirm selections before painting; merge only the edited fields in the worker queue.
test('Sol r4 late-update: a delayed Update and re-pick cannot restore cached Bass-only on a Ceiling edit', async () => {
  const bg = await seedSurfaces(), p = openPopup(bg);
  await p.idle();
  const link = attachLink(bg.chrome); link.ask(); await link.advance(0);
  p.mode('leveler', 'slow'); await p.idle();
  p.held.add('UPDATE_PRESET'); p.update(); await p.idle();
  assert.equal(bg.local.presets.A.dynamics.leveler, 'slow');
  assert.equal(p.get('preset-select').disabled, true);
  // Deliberately invoke disabled handlers, as Sol's probe does, to also test out-of-order delivery.
  p.select('B'); await p.idle();
  p.held.add('APPLY_PRESET'); p.select('A'); await p.idle();
  assert.equal(p.state().name, 'B', 'A has not been confirmed to this screen');
  assert.equal(bg.local.dynamics.leveler, 'slow');
  p.mode('ceiling', 'clean'); await p.idle();
  assert.deepEqual(p.sent.filter(x => x.type === 'EDIT_DYNAMICS').at(-1).dynamics, { ceiling: 'clean' });
  p.release('APPLY_PRESET'); await p.idle();
  p.release('UPDATE_PRESET'); p.held.delete('UPDATE_PRESET'); await p.idle();
  assert.equal(p.run('presets.A.dynamics.leveler'), 'slow', 'every newer snapshot refreshes the preset cache');
  p.update(); await p.idle(); await link.advance(200);
  assert.equal(bg.local.presets.A.dynamics.leveler, 'slow');
  assert.equal(bg.local.dynamics.leveler, 'slow');
  assert.equal(p.state().dynamics.leveler, 'slow');
  for (const post of settingsOf(link).slice(1)) assert.equal(post.dynamics.leveler, 'slow', 'Movie Sound never gets Bass-only back');
  for (const message of bg.offscreenMsgs.filter(x => x.type === 'SET_DYNAMICS').slice(1)) assert.equal(message.dynamics.leveler, 'slow');
});

test('Sol r4 failed-pick: one rejected storage set restores confirmed A before Mid writes only Mid 6', async () => {
  const bg = await seedSurfaces(), p = openPopup(bg);
  await p.idle(); p.slider('bass', 8); await p.idle();
  const link = attachLink(bg.chrome); link.ask(); await link.advance(0);
  const before = snapshot(bg.local), set = bg.chrome.storage.local.set;
  let once = true;
  bg.chrome.storage.local.set = (payload) => {
    if (once) { once = false; return Promise.reject(new Error('one failed selection')); }
    return set(payload);
  };
  p.select('B');
  assert.equal(p.state().name, 'A'); assert.equal(p.state().params.bass, 8);
  await p.idle(); bg.chrome.storage.local.set = set;
  assert.deepEqual(bg.local, before);
  assert.equal(p.state().name, 'A'); assert.equal(p.get('preset-select').value, 'A');
  assert.deepEqual(p.state().dynamics, MOVIE);
  assert.equal(p.sent.at(-1).type, 'READ_PRESET_STATE');
  p.slider('mid', 6); await p.idle(); await link.advance(200);
  assert.deepEqual(p.sent.filter(x => x.type === 'EDIT_PARAMS').at(-1).params, { mid: 6 });
  assert.deepEqual(bg.local.currentParams, { ...before.currentParams, mid: 6 });
  assert.equal(bg.local.currentPreset, 'A'); assert.deepEqual(bg.local.dynamics, MOVIE);
  assert.equal(settingsOf(link).at(-1).currentParams.bass, 8);
  assert.equal(settingsOf(link).at(-1).currentParams.mid, 6);
  assert.deepEqual(settingsOf(link).at(-1).dynamics, MOVIE);
  assert.deepEqual(bg.offscreenMsgs.filter(x => x.type === 'UPDATE_AUDIO_PARAMS').at(-1).params, asEngineSees(bg.local.currentParams));
});

const controlIds = ['preset-select', 'btn-save-preset', 'btn-update-preset', 'btn-delete-preset', 'btn-reset-defaults',
  'slider-bass', 'slider-hpf', 'slider-mid', 'slider-high', 'slider-gain', 'slider-pitch', 'mode-leveler', 'mode-limiter', 'mode-ceiling',
  ...['hpf', 'bass', 'mid', 'high', 'comp', 'gain', 'pitch', 'match'].map(x => 'tag-' + x),
  ...['bass', 'hpf', 'mid', 'high', 'gain', 'pitch'].flatMap(x => [`nudge-${x}-up`, `nudge-${x}-down`])];
const assertLocked = (p, locked) => controlIds.forEach(id => assert.equal(p.get(id).disabled, locked, id));

test('preset controls lock through confirmation and queued recovery on success, error, missing response, port error and timeout', async () => {
  for (const operation of ['pick', 'reset', 'delete', 'save', 'update']) {
    for (const fault of ['success', 'storage', 'error', 'missing', 'port', 'throw', 'timeout']) {
      const bg = await seedSurfaces(), p = openPopup(bg); await p.idle();
      const type = { pick: 'APPLY_PRESET', reset: 'RESET_DEFAULT_PRESETS', delete: 'DELETE_PRESET', save: 'SAVE_PRESET', update: 'UPDATE_PRESET' }[operation];
      const set = bg.chrome.storage.local.set;
      if (fault === 'storage') {
        let once = true;
        bg.chrome.storage.local.set = (obj) => { if (once) { once = false; return Promise.reject(Error('one storage failure')); } return set(obj); };
      } else if (fault !== 'success') p.faults.set(type, fault);
      if (fault === 'success') p.held.add(type);
      else p.held.add('READ_PRESET_STATE');
      const old = p.state();
      ({ pick: () => p.select('B'), reset: () => p.reset(), delete: () => p.remove(), save: () => p.save('Locked save'), update: () => p.update() })[operation]();
      assertLocked(p, true);
      const messages = p.sent.length;
      p.get('val-mid').ondblclick({ preventDefault() {} });
      assert.equal(p.sent.length, messages, 'neutral/restore cannot edit through the lock');
      assert.equal(p.state().name, old.name, operation + '/' + fault + ': no optimistic name');
      assert.deepEqual(p.state().params, old.params, operation + '/' + fault + ': no optimistic EQ');
      await p.idle();
      if (fault === 'success') p.release(type);
      else {
        if (fault === 'timeout') { p.advance(5000); await p.idle(); }
        assertLocked(p, true);
        assert.equal(p.replies.at(-1).type, 'READ_PRESET_STATE');
        p.release('READ_PRESET_STATE');
      }
      await p.idle(); assertLocked(p, false);
      assert.equal(p.state().name, bg.local.currentPreset);
      assert.deepEqual(p.state().dynamics, bg.local.dynamics);
      assert.equal(p.state().params.bass, bg.local.currentParams.bass);
      assert.equal(p.run('authoritativePresetPaint'), true);
    }
  }
});

test('a lost recovery response unlocks; Save waits for an authoritative paint; a late pick reply cannot repaint', async () => {
  const bg = await seedSurfaces(), p = openPopup(bg); await p.idle();
  p.held.add('APPLY_PRESET'); p.select('B'); await p.idle();
  p.faults.set('READ_PRESET_STATE', 'timeout');
  p.advance(5000); await p.idle(); assertLocked(p, true);
  p.advance(5000); await p.idle(); assertLocked(p, false);
  assert.equal(p.run('authoritativePresetPaint'), false);
  p.save('Unconfirmed'); await p.idle();
  assert.equal(bg.local.presets.Unconfirmed, undefined);
  assert.equal(p.state().name, 'B'); assert.equal(p.run('authoritativePresetPaint'), true);
  p.held.delete('APPLY_PRESET'); p.select('Legacy'); await p.idle();
  p.release('APPLY_PRESET'); await p.idle();
  assert.equal(p.state().name, 'Legacy'); assertLocked(p, false);
  p.save('Confirmed'); await p.idle(); assert.equal(bg.local.presets.Confirmed.bass, 9);
});

test('a stale-but-admitted switch sends one field and preserves the other three stored switches', async () => {
  const bg = await seedSurfaces(), p = openPopup(bg); await p.idle();
  p.held.add('EDIT_DYNAMICS'); p.mode('leveler', 'slow'); await p.idle();
  p.run('dynamics = { leveler: "bass", match: false, limiter: "fast", ceiling: "warm" }; applyDynamicsToUI()');
  p.mode('ceiling', 'clean'); await p.idle();
  assert.deepEqual(bg.local.dynamics, { ...MOVIE, leveler: 'slow', ceiling: 'clean' });
  const replies = p.replies.splice(0).reverse(); replies.forEach(r => r.deliver());
  assert.deepEqual(p.state().dynamics, bg.local.dynamics);
  assert.equal(p.run('viewRev'), bg.local.stateRev);
  assert.deepEqual(p.sent.filter(x => x.type === 'EDIT_DYNAMICS').map(x => x.dynamics), [{ leveler: 'slow' }, { ceiling: 'clean' }]);
});

test('slider, nudge, band, MATCH and neutral/restore send minimal deltas; edits never select a preset', async () => {
  const bg = await seedSurfaces(), p = openPopup(bg); await p.idle();
  const last = () => p.sent.filter(x => x.type.startsWith('EDIT_')).at(-1);
  p.slider('mid', 6); await p.idle(); assert.deepEqual(last().params, { mid: 6 });
  p.get('nudge-high-up').onclick({ preventDefault() {}, shiftKey: false }); await p.idle();
  assert.deepEqual(last().params, { high: 0.5 });
  p.get('tag-bass').onclick(); await p.idle(); assert.deepEqual(last().params, { stageBypass: { bass: true } });
  p.get('tag-high').onclick(); await p.idle(); assert.deepEqual(last().params, { stageBypass: { high: true } });
  assert.deepEqual(bg.local.currentParams.stageBypass, { bass: true, high: true });
  p.get('tag-comp').onclick(); await p.idle(); assert.deepEqual(last().params, { autoBalance: true });
  p.get('tag-match').onclick(); await p.idle(); assert.deepEqual(last().dynamics, { match: false });
  p.get('val-mid').ondblclick({ preventDefault() {} }); await p.idle(); assert.deepEqual(last().params, { mid: 0 });
  p.get('val-mid').ondblclick({ preventDefault() {} }); await p.idle(); assert.deepEqual(last().params, { mid: 6 });
  p.slider('pitch', 2); await p.idle(); assert.deepEqual(last().params, { semitones: 2 });
  assert.equal(bg.local.currentPreset, 'A');
  assert.equal(bg.local.currentParams.bass, 1); assert.equal(bg.local.currentParams.high, 0.5);
  for (const set of bg.localSets) assert.equal('currentPreset' in set, false);
});

test('edit deltas merge once inside the queue and normalise changed fields without rewriting presets', async () => {
  const bg = await seedSurfaces();
  const before = snapshot(bg.local.presets);
  bg.local.currentParams.stageBypass = { bass: true, high: true };
  const mark = bg.localSets.length;
  const reply = await bg.send({ type: 'EDIT_PARAMS', params: { mid: 99, gain: NaN, stageBypass: { bass: false }, dynamics: MUSIC, unknown: 'ignored' }, ...viewOf(bg) });
  assert.equal(bg.localSets.length, mark + 1);
  assert.equal(bg.local.currentParams.mid, 12); assert.equal(bg.local.currentParams.gain, 1);
  assert.deepEqual(bg.local.currentParams.stageBypass, { bass: false, high: true });
  assert.equal('unknown' in bg.local.currentParams, false);
  assert.equal('dynamics' in bg.local.currentParams, false);
  assert.deepEqual(reply.currentParams, bg.local.currentParams);
  assert.deepEqual(reply.dynamics, MOVIE); assert.equal(reply.currentPreset, 'A');
  assert.deepEqual(bg.local.presets, before);
  const dyn = await bg.send({ type: 'EDIT_DYNAMICS', dynamics: { ceiling: 'invalid' }, ...viewOf(bg) });
  assert.deepEqual(dyn.dynamics, { ...MOVIE, ceiling: 'clean' });
});

test('minimal band edits override legacy aliases in live params without migrating the saved preset', async () => {
  const bg = await seedSurfaces();
  const legacy = { ...EQ, autoBalance: true, stageBypass: { eq: true, comp: true, speed: true } };
  bg.local.currentPreset = 'Legacy'; bg.local.currentParams = snapshot(legacy); bg.local.presets.Legacy = snapshot(legacy);
  const p = openPopup(bg); await p.idle();
  p.get('tag-bass').onclick(); await p.idle();
  assert.deepEqual(bg.local.currentParams.stageBypass, { bass: false, mid: true, high: true, pitch: true });
  p.get('tag-comp').onclick(); await p.idle(); assert.equal(bg.local.currentParams.autoBalance, true);
  p.get('tag-pitch').onclick(); await p.idle(); assert.equal(bg.local.currentParams.stageBypass.pitch, false);
  assert.deepEqual(bg.local.presets.Legacy, legacy);
});

// Real offscreen message handling, with audio creation and media capture forbidden.
function attachSilentEngine(bg) {
  let listener;
  const delivered = [];
  const box = {
    console, Math, Number, Object, Array, Error, Date, Promise, Map, Set, Float32Array, Uint8Array, parseFloat, isFinite,
    setTimeout: () => 0, clearTimeout() {},
    AudioContext: class { constructor() { throw Error('Audio prohibited in unit tests'); } },
    navigator: { mediaDevices: { getUserMedia() { throw Error('Capture prohibited in unit tests'); } } },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: () => Promise.resolve(),
      getURL: p => 'chrome-extension://id/' + p
    } },
    seedParams: snapshot(bg.local.currentParams), seedDynamics: snapshot(bg.local.dynamics)
  };
  vm.createContext(box);
  vm.runInContext(readFileSync(join(root, 'offscreen.js'), 'utf8'), box, { filename: 'offscreen.js' });
  vm.runInContext('currentParams = seedParams; currentDynamics = seedDynamics;', box);
  const send = bg.chrome.runtime.sendMessage;
  bg.chrome.runtime.sendMessage = (message, callback) => {
    if (message.target !== 'offscreen') return send(message, callback);
    delivered.push(snapshot(message));
    return listener(snapshot(message), {}, callback || (() => {}));
  };
  return {
    delivered,
    state: () => JSON.parse(vm.runInContext('JSON.stringify({params:currentParams,dynamics:currentDynamics})', box)),
    diverge: () => vm.runInContext("currentParams = {...currentParams, bass:28}; currentDynamics = {leveler:'full',match:false,limiter:'fast',ceiling:'clean'};", box)
  };
}

// What the engine should hold for a stored EQ, written independently of the worker: the engine merges what it is
// sent, so the worker sends every field the 1.5.7 screen sent (bypass and all six stage flags explicit, semitones 0
// when missing, legacy eq/comp/speed aliases read as the screen reads them).
const asEngineSees = (stored) => {
  const p = { ...stored };
  delete p.dynamics;
  const raw = { ...(p.stageBypass || {}) };
  if (raw.eq) raw.bass = raw.mid = raw.high = true;
  if (raw.comp) p.autoBalance = false;
  p.stageBypass = { hpf: !!raw.hpf, bass: !!raw.bass, mid: !!raw.mid, high: !!raw.high, gain: !!raw.gain, pitch: !!(raw.pitch || raw.speed) };
  p.bypass = stored.bypass === true;
  if (typeof stored.semitones !== 'number') p.semitones = 0;
  return p;
};

const assertEngineMatches = (engine, stored) => {
  assert.deepEqual(engine.state().params, asEngineSees(stored.currentParams), 'engine EQ matches storage');
  assert.deepEqual(engine.state().dynamics, stored.dynamics, 'engine switches match storage');
};

for (const operation of ['pick', 'reset', 'delete']) {
  test(`Sol r5 ${operation}: a failed post-commit read cannot skip engine dispatch, recovery or the next Mid edit`, async () => {
    const bg = await seedSurfaces(), engine = attachSilentEngine(bg), p = openPopup(bg);
    await p.idle();
    if (operation === 'reset') {
      p.mode('leveler', 'full'); await p.idle();
      p.slider('bass', 8); await p.idle();
    }
    const get = bg.chrome.storage.local.get, set = bg.chrome.storage.local.set;
    let armed = false, failed = 0, engineAtRead, storedAtRead;
    const writes = bg.localSets.length;
    bg.chrome.storage.local.set = async payload => {
      await set(payload);
      if (payload.currentPreset) armed = true;
    };
    bg.chrome.storage.local.get = async keys => {
      if (armed && Array.isArray(keys) && keys.includes('presets') && keys.includes('stateRev')) {
        armed = false; failed++;
        engineAtRead = engine.state(); storedAtRead = snapshot(bg.local);
        throw Error('one rejected post-commit presentation read');
      }
      return get(keys);
    };
    ({ pick: () => p.select('B'), reset: () => p.reset(), delete: () => p.remove() })[operation]();
    await p.idle();
    bg.chrome.storage.local.get = get; bg.chrome.storage.local.set = set;
    assert.equal(failed, 1, 'the post-commit fault fired exactly once');
    assert.equal(bg.localSets.length, writes + 1, 'selection and recovery publish only once');
    assert.deepEqual(engineAtRead.params, asEngineSees(storedAtRead.currentParams), 'committed EQ reached engine BEFORE the failed read');
    assert.deepEqual(engineAtRead.dynamics, storedAtRead.dynamics, 'committed switches reached engine BEFORE the failed read');
    assert.equal(p.sent.at(-1).type, 'READ_PRESET_STATE');
    assertLocked(p, false); assertEngineMatches(engine, bg.local);
    assert.equal(p.state().name, bg.local.currentPreset);
    assert.equal(p.state().params.bass, bg.local.currentParams.bass);
    assert.deepEqual(p.state().dynamics, bg.local.dynamics);
    p.slider('mid', 6); await p.idle();
    assert.deepEqual(p.sent.at(-1).params, { mid: 6 });
    assertEngineMatches(engine, bg.local);
    assert.equal(p.state().params.mid, 6);
    assert.deepEqual(p.state().dynamics, bg.local.dynamics);
    const link = attachLink(bg.chrome); link.ask(); await link.advance(0);
    const movie = settingsOf(link).at(-1);
    assert.deepEqual(movie.currentParams, bg.local.currentParams);
    assert.deepEqual(movie.dynamics, bg.local.dynamics);
  });
}

test('queued recovery reconciles the real engine before replying after every preset-operation failure', async () => {
  const operations = { pick: 'APPLY_PRESET', reset: 'RESET_DEFAULT_PRESETS', delete: 'DELETE_PRESET', save: 'SAVE_PRESET', update: 'UPDATE_PRESET' };
  for (const [operation, type] of Object.entries(operations)) {
    for (const fault of ['storage', 'read', 'error', 'missing', 'port', 'throw', 'timeout']) {
      const bg = await seedSurfaces(), engine = attachSilentEngine(bg), p = openPopup(bg);
      await p.idle(); engine.diverge();
      if (fault === 'storage' || fault === 'read') {
        const method = fault === 'storage' ? 'set' : 'get', original = bg.chrome.storage.local[method];
        let once = true;
        bg.chrome.storage.local[method] = value => {
          if (once) { once = false; return Promise.reject(Error('one operation ' + method + ' failure')); }
          return original(value);
        };
      } else p.faults.set(type, fault);
      p.held.add('READ_PRESET_STATE');
      ({ pick: () => p.select('B'), reset: () => p.reset(), delete: () => p.remove(), save: () => p.save('Recovered'), update: () => p.update() })[operation]();
      await p.idle();
      if (fault === 'timeout') { p.advance(5000); await p.idle(); }
      assertLocked(p, true);
      assert.equal(p.replies.at(-1).type, 'READ_PRESET_STATE', operation + '/' + fault);
      assertEngineMatches(engine, bg.local);
      const [params, dynamics] = engine.delivered.slice(-2);
      assert.equal(params.type, 'UPDATE_AUDIO_PARAMS'); assert.equal(params.target, 'offscreen');
      assert.equal(dynamics.type, 'SET_DYNAMICS'); assert.equal(dynamics.target, 'offscreen');
      p.release('READ_PRESET_STATE'); await p.idle();
      assertLocked(p, false); assertEngineMatches(engine, bg.local);
      assert.equal(p.state().name, bg.local.currentPreset);
      assert.deepEqual(p.state().dynamics, bg.local.dynamics);
    }
  }
});

test('queued state reads wait for both engine acknowledgements and never create an offscreen document', async () => {
  const bg = await seedSurfaces();
  bg.setOffscreen(false);
  const stored = snapshot(bg.local), writes = bg.localSets.length;
  await bg.send({ type: 'READ_PRESET_STATE' });
  assert.equal(bg.offscreenMsgs.length, 0);
  assert.equal((await bg.chrome.runtime.getContexts()).length, 0);
  bg.setOffscreen(true);
  const pending = [], sent = [];
  bg.chrome.runtime.sendMessage = (message, callback) => { sent.push(snapshot(message)); pending.push(callback); };
  let replied = false;
  const read = bg.send({ type: 'READ_PRESET_STATE' }).then(result => { replied = true; return result; });
  await until(() => pending.length === 1, 'EQ acknowledgement');
  assert.equal(replied, false); assert.equal(sent[0].target, 'offscreen');
  assert.deepEqual(sent[0].params, asEngineSees(stored.currentParams));
  pending.shift()({ success: true });
  await until(() => pending.length === 1, 'switch acknowledgement');
  assert.equal(replied, false); assert.equal(sent[1].target, 'offscreen');
  assert.deepEqual(sent[1].dynamics, stored.dynamics);
  pending.shift()({ success: true });
  const state = await read;
  assert.equal(state.applied, true);
  assert.deepEqual(state.currentParams, stored.currentParams);
  assert.deepEqual(state.dynamics, stored.dynamics);
  assert.deepEqual(bg.local, stored); assert.equal(bg.localSets.length, writes);
});

test('Fable r3: a factory pick after Flat (Bypass) clears the engine bypass, and a band switched off does not survive a factory pick', async () => {
  const bg = await seedSurfaces(), engine = attachSilentEngine(bg), p = openPopup(bg);
  await p.idle();
  p.select('Flat (Bypass)'); await p.idle();
  assert.equal(engine.state().params.bypass, true, 'Flat bypasses the engine');
  p.select('Punchy Bass & Clarity'); await p.idle();
  let e = engine.state().params;
  assert.equal(e.bypass, false, 'engine must not stay bypassed after picking Punchy');
  assert.equal(e.bass, 5, 'Punchy bass reaches the engine');
  assert.deepEqual(e.stageBypass, { hpf: false, bass: false, mid: false, high: false, gain: false, pitch: false }, 'every stage on for a factory preset');
  p.slider('mid', 6); await p.idle();
  assert.equal(engine.state().params.bypass, false, 'a Mid edit after the pick stays un-bypassed');
  // A band switched off on the live EQ, then a factory pick: the factory preset has every band on.
  bg.local.currentParams = { ...bg.local.currentParams, stageBypass: { hpf: false, bass: true, mid: false, high: false, gain: false, pitch: false } };
  await bg.send({ type: 'READ_PRESET_STATE' });
  assert.equal(engine.state().params.stageBypass.bass, true, 'the recovery read re-sends the stored band-off state');
  p.select('Deep Sub-Bass (Dub/Trap)'); await p.idle();
  e = engine.state().params;
  assert.equal(e.stageBypass.bass, false, 'the bass band is back on after picking Deep Sub-Bass');
  assert.equal(e.bypass, false);
});
