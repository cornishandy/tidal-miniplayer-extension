// Finder behavior only: no browser, capture engine, or live services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A cached base file lets the same regression exercise the unmodified finders.
const source = readFileSync(process.env.MEDIA_TAB_BACKGROUND || new URL('../../background.js', import.meta.url), 'utf8');
const declarations = source.slice(0, source.indexOf('// Movie mode'));
const finders = source.slice(source.indexOf('// Target tab finder specifically for player'),
  source.indexOf('// Clean up when tabs close.'));
assert.ok(declarations && finders, 'real background declarations and finders are present');

async function select(finder, tabs, { captured = null, preferred = null } = {}) {
  const context = vm.createContext({ URL, chrome: { tabs: { query: async () => tabs } } });
  vm.runInContext(declarations + '\n' + finders + `
    capturedTabId = ${JSON.stringify(captured)};
    globalThis.choose = () => ${finder}(${JSON.stringify(preferred)});
  `, context, { filename: 'background.js' });
  return (await context.choose())?.id ?? null;
}

const domains = ['youtube.com', 'spotify.com', 'soundcloud.com', 'music.apple.com', 'netflix.com'];
const finderNames = ['findMediaTabForPlayer', 'findAudioCaptureTab'];
for (const finder of finderNames) {
  for (const domain of domains) {
    for (const host of [domain, `player.${domain}`, `a.b.${domain}`]) {
      test(`${finder}: paused ${host} beats active fallback`, async () => {
        assert.equal(await select(finder, [
          { id: 1, url: 'https://example.org/', active: true },
          { id: 2, url: `https://${host}/watch` }
        ]), 2);
      });
    }
    const impostors = [
      `https://example.org/?next=https://${domain}/watch`,
      `https://example.org/articles/${domain}/watch`,
      `https://not${domain}/watch`,
      `https://${domain}.example.org/watch`,
      `https://${domain}@example.org/watch`
    ];
    for (const url of impostors) {
      test(`${finder}: ${url} cannot steal paused ${domain}`, async () => {
        assert.equal(await select(finder, [
          { id: 1, url }, { id: 2, url: `https://${domain}/watch` }
        ]), 2);
      });
    }
  }
  for (const url of ['not a URL youtube.com', 'https://[youtube.com', '', undefined]) {
    test(`${finder}: invalid or missing URL ${String(url)} is skipped`, async () => {
      assert.equal(await select(finder, [
        { id: 1, url }, { id: 2, url: 'https://netflix.com/watch' }
      ]), 2);
    });
  }
}

// Expected results document the existing differences between the two finders.
const controls = [
  { name: 'active Tidal beats audible Tidal', tabs: [
    { id: 1, url: 'https://listen.tidal.com/', audible: true },
    { id: 2, url: 'https://tidal.com/', active: true }
  ], expected: [2, 1] },
  { name: 'audible Tidal beats arbitrary audible and paused Tidal', tabs: [
    { id: 1, url: 'https://example.org/', audible: true },
    { id: 2, url: 'https://tidal.com/' },
    { id: 3, url: 'https://listen.tidal.com/', audible: true }
  ], expected: [3, 3] },
  { name: 'paused Tidal retains player priority over arbitrary audible', tabs: [
    { id: 1, url: 'https://example.org/', audible: true },
    { id: 2, url: 'https://tidal.com/' }
  ], expected: [2, 1] },
  { name: 'paused Tidal beats paused service', tabs: [
    { id: 1, url: 'https://youtube.com/' }, { id: 2, url: 'https://tidal.com/' }
  ], expected: [2, 2] },
  { name: 'arbitrary audible lookalike stays eligible', tabs: [
    { id: 1, url: 'https://youtube.com/' },
    { id: 2, url: 'https://notyoutube.com/', audible: true }
  ], expected: [2, 2] },
  { name: 'captured player beats audible while capture ignores previous capture', captured: 2, tabs: [
    { id: 1, url: 'https://example.org/', audible: true },
    { id: 2, url: 'https://notyoutube.com/' }
  ], expected: [2, 1] },
  { name: 'Tidal retains player priority over captured tab', captured: 1, tabs: [
    { id: 1, url: 'https://example.org/' }, { id: 2, url: 'https://tidal.com/' }
  ], expected: [2, 2] },
  { name: 'explicit preferred capture beats audible Tidal', preferred: 1, tabs: [
    { id: 1, url: 'https://notyoutube.com/' },
    { id: 2, url: 'https://tidal.com/', audible: true }
  ], expected: [2, 1] },
  { name: 'missing preferred and captured IDs are ignored', preferred: 99, captured: 99, tabs: [
    { id: 1, url: 'https://spotify.com/' }
  ], expected: [1, 1] },
  { name: 'Chrome preferred tab is ignored', preferred: 1, tabs: [
    { id: 1, url: 'chrome://settings', active: true },
    { id: 2, url: 'https://soundcloud.com/' }
  ], expected: [2, 2] },
  { name: 'active fallback includes lookalikes', tabs: [
    { id: 1, url: 'chrome://settings', active: true },
    { id: 2, url: 'https://notyoutube.com/', active: true }
  ], expected: [2, 2] },
  { name: 'no eligible inactive tabs', tabs: [{ id: 1, url: 'https://example.org/' }], expected: [null, null] },
  { name: 'no open tabs', tabs: [], expected: [null, null] }
];
for (const { name, tabs, expected, ...options } of controls) {
  for (const [index, finder] of finderNames.entries()) {
    test(`${finder}: ${name}`, async () => {
      assert.equal(await select(finder, tabs, options), expected[index]);
    });
  }
}
