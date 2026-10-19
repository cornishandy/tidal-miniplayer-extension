// movie-sound-link.js (1.5.7) in a fake page: what it posts, when, and that it only reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(join(root, 'movie-sound-link.js'), 'utf8');
const ORIGIN = 'http://127.0.0.1:8791';
const SAVED = {
  presets: { 'max-max-0': { bass: 13, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: false } },
  currentPreset: 'max-max-0',
  currentParams: { bass: 13, hpf: 20, mid: 6, high: 0, gain: 1, semitones: 0, autoBalance: false },
  dynamics: { leveler: 'full', match: false, limiter: 'lookahead', ceiling: 'clean' },
  isAudioCapturing: true,
  capturedTabId: 42
};

function load({ origin = ORIGIN, top = true, getThrows = false, getRejects = false } = {}) {
  let now = 1000;
  const timers = [];
  const posted = [];
  const listeners = {};
  const changeListeners = [];
  const reads = [];
  const writes = [];
  const window = {
    postMessage(data, target) { posted.push({ data: JSON.parse(JSON.stringify(data)), target }); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
  };
  window.top = top ? window : {};
  const chrome = {
    runtime: { id: 'abc' },
    storage: {
      local: {
        get(keys) {
          reads.push(keys);
          if (getThrows) throw new Error('Extension context invalidated.');
          if (getRejects) return Promise.reject(new Error('Extension context invalidated.'));
          return Promise.resolve(Object.fromEntries(keys.filter((k) => k in SAVED).map((k) => [k, structuredClone(SAVED[k])])));
        },
        set(...args) { writes.push(args); return Promise.resolve(); },
        remove(...args) { writes.push(args); return Promise.resolve(); }
      },
      onChanged: { addListener(fn) { changeListeners.push(fn); } }
    }
  };
  const sandbox = {
    window, chrome, location: { origin },
    Date: { now: () => now },
    setTimeout(fn, ms) { const t = { fn, at: now + ms, cleared: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    setInterval(fn, ms) { const t = { fn, every: ms, cleared: false, interval: true }; timers.push(t); return t; },
    clearInterval(t) { if (t) t.cleared = true; }
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    posted, reads, writes, chrome, timers,
    ask(extra = {}) {
      for (const fn of listeners.message || []) fn({ source: window, origin: ORIGIN, data: { source: 'movie-sound', type: 'request-chrome-eq', version: 1, ...extra } });
    },
    send(event) { for (const fn of listeners.message || []) fn(event); },
    window,
    change(changes, area = 'local') { for (const fn of changeListeners) fn(changes, area); },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.find((t) => !t.cleared && !t.interval && t.at <= now);
        if (!due) break;
        due.cleared = true;
        due.fn();
        await settle();
      }
      for (const t of timers.filter((t) => t.interval && !t.cleared)) t.fn();
      await settle();
    },
    settle
  };
}

const settingsPosts = (page) => page.posted.filter((p) => p.data.type === 'chrome-eq-settings');

test('does nothing on any other origin or in a frame', () => {
  for (const opts of [{ origin: 'http://127.0.0.1:8792' }, { origin: 'http://localhost:8791' }, { top: false }]) {
    const page = load(opts);
    assert.equal(page.posted.length, 0);
    page.ask();
    assert.equal(page.reads.length, 0);
  }
});

test('says it is ready, but posts no settings until the page asks', async () => {
  const page = load();
  assert.deepEqual(page.posted.map((p) => p.data.type), ['chrome-eq-link-ready']);
  page.change({ currentParams: { newValue: {} } });
  await page.advance(500);
  assert.equal(settingsPosts(page).length, 0, 'a storage change before the page asks posts nothing');
});

test('answers a request with the four EQ keys only, to the page origin only', async () => {
  const page = load();
  page.ask();
  await page.advance(0);
  const posts = settingsPosts(page);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].target, ORIGIN);
  const { source, version, type, ...payload } = posts[0].data;
  assert.deepEqual([source, version, type], ['tidal-eq-link', 1, 'chrome-eq-settings']);
  assert.deepEqual(Object.keys(payload).sort(), ['currentParams', 'currentPreset', 'dynamics', 'presets']);
  assert.deepEqual(payload.currentParams, SAVED.currentParams);
  assert.ok(!('isAudioCapturing' in payload), 'the AUDIO EQ switch is not sent');
  assert.equal(page.writes.length, 0, 'never writes storage');
});

test('ignores requests from other windows, origins or senders', async () => {
  const page = load();
  page.send({ source: {}, origin: ORIGIN, data: { source: 'movie-sound', type: 'request-chrome-eq', version: 1 } });
  page.send({ source: page.window, origin: 'http://evil.example', data: { source: 'movie-sound', type: 'request-chrome-eq', version: 1 } });
  page.send({ source: page.window, origin: ORIGIN, data: { source: 'someone', type: 'request-chrome-eq', version: 1 } });
  page.send({ source: page.window, origin: ORIGIN, data: { source: 'movie-sound', type: 'request-chrome-eq', version: 2 } });
  await page.advance(500);
  assert.equal(page.reads.length, 0);
});

test('follows EQ changes after the request, ignores other keys and other storage areas', async () => {
  const page = load();
  page.ask();
  await page.advance(0);
  page.change({ isAudioCapturing: { newValue: false } });
  page.change({ currentParams: { newValue: {} } }, 'sync');
  await page.advance(500);
  assert.equal(settingsPosts(page).length, 1, 'no post for the power switch or sync storage');
  page.change({ currentPreset: { oldValue: 'a' } }); // a deletion entry still means "read again"
  await page.advance(500);
  assert.equal(settingsPosts(page).length, 2);
});

test('a long slider drag keeps posting at most every 100 ms, and the last value always arrives', async () => {
  const page = load();
  page.ask();
  await page.advance(0);
  const before = settingsPosts(page).length;
  for (let ms = 0; ms < 1000; ms += 10) {
    page.change({ currentParams: { newValue: { bass: ms } } });
    await page.advance(10);
  }
  await page.advance(200);
  const during = settingsPosts(page).length - before;
  assert.ok(during >= 8 && during <= 11, `posts during a 1 s drag: ${during}`);
  page.change({ currentParams: { newValue: { bass: 99 } } });
  await page.advance(200);
  assert.equal(settingsPosts(page).length - before, during + 1, 'the final change is posted');
});

test('after an extension reload it says the link is lost once and goes quiet', async () => {
  for (const opts of [{ getThrows: true }, { getRejects: true }]) {
    const page = load(opts);
    page.ask();
    await page.advance(0);
    page.ask();
    await page.advance(500);
    assert.equal(page.posted.filter((p) => p.data.type === 'chrome-eq-link-lost').length, 1);
    assert.equal(settingsPosts(page).length, 0);
  }
  const page = load();
  page.ask();
  await page.advance(0);
  delete page.chrome.runtime.id;
  await page.advance(3000);
  await page.advance(3000);
  assert.equal(page.posted.filter((p) => p.data.type === 'chrome-eq-link-lost').length, 1, 'the watch notices a silent orphan');
});
