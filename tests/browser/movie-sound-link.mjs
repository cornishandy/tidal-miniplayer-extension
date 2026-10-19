// Real-Chrome check for movie-sound-link.js (1.5.7): the manifest injects it on the Movie Sound page and nowhere else.
// Run: node browser/movie-sound-link.mjs   (from tests/)
// Port 8791 belongs to the real Movie Sound page, so this builds a scratch copy whose link (manifest match and the
// script's own origin check) points at a free port instead, and checks a second free port gets nothing.
// Same isolation as run.mjs: temp profile, every non-local host blocked, no audio output at all (no audio is played).
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const PAGE = `<!doctype html><title>stand-in</title><script>
  window.got = [];
  addEventListener('message', (e) => { if (e.source === window && e.data && e.data.source === 'tidal-eq-link') got.push(e.data); });
  postMessage({ source: 'movie-sound', type: 'request-chrome-eq', version: 1 }, location.origin);
</script>`;
const listen = () => new Promise((r) => {
  const s = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  s.listen(0, '127.0.0.1', () => r(s));
});
const linkServer = await listen();
const otherServer = await listen();
const LINK = linkServer.address().port;
const OTHER = otherServer.address().port;

const work = mkdtempSync(join(tmpdir(), 'tme-msl-'));
const extDir = join(work, 'ext');
execFileSync(process.execPath, [join(root, 'tools/build.mjs'), extDir], { stdio: 'ignore' });
const manifestPath = join(extDir, 'manifest.json');
const manifest = readFileSync(manifestPath, 'utf8');
if (!manifest.includes('"http://127.0.0.1:8791/*"')) throw new Error('manifest no longer matches the Movie Sound page');
writeFileSync(manifestPath, manifest.replace('"http://127.0.0.1:8791/*"', `"http://127.0.0.1:${LINK}/*"`));
const linkPath = join(extDir, 'movie-sound-link.js');
const link = readFileSync(linkPath, 'utf8');
if (!link.includes("'http://127.0.0.1:8791'")) throw new Error('link script no longer names the Movie Sound origin');
writeFileSync(linkPath, link.replace("'http://127.0.0.1:8791'", `'http://127.0.0.1:${LINK}'`));

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--mute-audio', '--disable-audio-output',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--no-proxy-server',
    '--no-first-run'
  ]
});
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); };
try {
  // Write known settings through the extension's own worker (onInstalled seeding isn't reliable headless).
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const FIXTURE = {
    presets: { 'test-a': { bass: 9, hpf: 20, mid: 1, high: 0, gain: 1, semitones: 0, autoBalance: true } },
    currentPreset: 'test-a',
    currentParams: { bass: 9, hpf: 20, mid: 1, high: 0, gain: 1, semitones: 0, autoBalance: true },
    dynamics: { leveler: 'full', match: false, limiter: 'lookahead', ceiling: 'clean' }
  };
  await sw.evaluate((f) => chrome.storage.local.set({ ...f, isAudioCapturing: true }), FIXTURE);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${LINK}/`);
  const latest = () => page.evaluate(() => window.got.filter((m) => m.type === 'chrome-eq-settings').pop() || null);
  let settings = null;
  for (let i = 0; i < 20 && !(settings && settings.currentParams); i++) { await page.waitForTimeout(250); settings = await latest(); }
  // The install step may write its defaults around the same time, so compare with what storage holds once it settles.
  await page.waitForTimeout(1000);
  settings = await latest();
  const stored = await sw.evaluate(() => chrome.storage.local.get(['presets', 'currentPreset', 'currentParams', 'dynamics']));
  const same = (k) => JSON.stringify(settings && settings[k]) === JSON.stringify(stored[k] ?? null);
  check('the Movie Sound page gets the saved EQ, exactly as stored', !!settings && !!settings.currentParams && ['presets', 'currentPreset', 'currentParams', 'dynamics'].every(same), { settings, stored });
  check('only the four EQ keys are sent', !!settings && Object.keys(settings).sort().join() === 'currentParams,currentPreset,dynamics,presets,source,type,version', settings && Object.keys(settings));
  await sw.evaluate(() => chrome.storage.local.set({ currentParams: { bass: 4, hpf: 20, mid: 1, high: 0, gain: 1, semitones: 0, autoBalance: true } }));
  let updated = null;
  for (let i = 0; i < 20 && !(updated && updated.currentParams && updated.currentParams.bass === 4); i++) { await page.waitForTimeout(250); updated = await latest(); }
  check('a slider change in the extension reaches the page', !!updated && updated.currentParams.bass === 4, updated);
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${OTHER}/`);
  await other.waitForTimeout(2000);
  const otherGot = await other.evaluate(() => window.got);
  check('any other page gets nothing', otherGot.length === 0, otherGot);
} finally {
  await context.close();
  linkServer.close();
  otherServer.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} passed; scratch build on port ${LINK}; no audio played`);
if (results.some((ok) => !ok)) process.exitCode = 1;
