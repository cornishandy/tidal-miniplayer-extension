// Static checks that need no browser: manifest integrity, command wiring, JS syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const background = readFileSync(join(root, 'background.js'), 'utf8');

test('every file the manifest references exists', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources).filter((r) => !r.includes('*'))
  ];
  for (const f of files) assert.ok(existsSync(join(root, f)), `missing ${f}`);
});

test('every manifest command has a handler in background.js', () => {
  for (const name of Object.keys(manifest.commands)) {
    assert.match(background, new RegExp(`command === '${name}'`), `no handler for command "${name}"`);
  }
});

test('permissions have not been broadened', () => {
  // sidePanel was added on 2026-10-01 (decision R-20): a UI-only permission, no access to pages or devices.
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabCapture', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.content_security_policy, undefined, 'CSP must stay at the MV3 default unless explicitly approved');
});

test('all extension scripts parse', () => {
  for (const f of readdirSync(root).filter((n) => n.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', join(root, f)]);
  }
});

test('fallback window is the working undocked popup, not the broken miniplayer page', () => {
  assert.match(background, /FALLBACK_WINDOW_URL = 'popup\.html\?undocked=true'/);
  assert.doesNotMatch(background, /getURL\('miniplayer\.html'\)/);
});

test('no network code: the shipped scripts never contact Tidal or any server', () => {
  for (const f of ['background.js', 'content.js', 'popup.js', 'offscreen.js', 'physics-view.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|tidal\.com\/v1|api\.tidal\.com/, `${f} contains network code`);
  }
});

test('retired surfaces stay out: no Playlists, Lab, header icons, floating button or dead files (decisions 2026-10-01)', () => {
  const popup = readFileSync(join(root, 'popup.html'), 'utf8');
  const content = readFileSync(join(root, 'content.js'), 'utf8');
  assert.doesNotMatch(popup, /tab-btn-playlists|tab-btn-lab|lab-btn-create|btn-size-toggle|btn-micro-toggle|btn-always-on-top|btn-undock|toggle-floating-btn|btn-open-router/);
  assert.doesNotMatch(content, /FETCH_USER_PLAYLISTS|CREATE_PLAYLIST_WITH_TRACKS|getTidalSession|injectFloatingButton|documentPictureInPicture/);
  for (const f of ['tidal-bridge.js', 'miniplayer.html', 'miniplayer.js', 'router-visualizer.js']) assert.ok(!existsSync(join(root, f)), `${f} should be gone`);
  assert.deepEqual(manifest.content_scripts.map((c) => c.js).flat(), ['content.js']);
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing needs to be web-accessible any more');
});

test('no emoji in the popup markup (icons are drawn)', () => {
  const popup = readFileSync(join(root, 'popup.html'), 'utf8');
  assert.doesNotMatch(popup, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2728}\u{2B50}]/u, 'emoji found in popup.html');
});
