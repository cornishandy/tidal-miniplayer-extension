// tools/panelshot.mjs - Screenshot the real side-panel page of a built extension, optionally with a mockup injected.
// Usage: node tools/panelshot.mjs <builtDir> <out.png> [--width 360] [--height 1250] [--inject docs/mockups/x.html] [--variant name] [--full]
// The inject file holds <style> blocks, <template data-variant="a b" data-before=".foot"> blocks (inserted before that
// element; data-class="x" adds a body class instead) and <script data-variant="a b"> blocks (run in the page). A block
// without data-variant applies to every variant. Isolated and silent like the harness: temp profile, every host
// blocked, no audio output. Never point it at a folder you want to keep unchanged by Chrome (use a scratch build).
import { chromium } from '../tests/node_modules/playwright-core/index.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const [dir, out] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!dir || !out) { console.error('usage: node tools/panelshot.mjs <builtDir> <out.png> [--width px] [--height px] [--inject file] [--variant name]'); process.exit(1); }
const width = +opt('--width', 360), height = +opt('--height', 1250);
const inject = opt('--inject', ''), variant = opt('--variant', '');

const extDir = realpathSync(resolve(dir));
const hex = createHash('sha256').update(extDir).digest('hex').slice(0, 32);
const EXT_ID = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const profile = mkdtempSync(join(tmpdir(), 'tme-panelshot-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--allowlisted-extension-id=${EXT_ID}`,
    '--mute-audio', '--disable-audio-output', '--host-resolver-rules=MAP * ~NOTFOUND', '--no-first-run', '--no-default-browser-check'],
  viewport: { width, height },
  deviceScaleFactor: 2
});
try {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/popup.html?panel=1`);
  await page.waitForTimeout(1500);
  if (inject) {
    const html = readFileSync(resolve(root, inject), 'utf8');
    await page.evaluate(({ html, variant }) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const applies = (el) => !el.dataset.variant || el.dataset.variant.split(/\s+/).includes(variant);
      for (const s of doc.querySelectorAll('style')) if (applies(s)) document.head.appendChild(document.importNode(s, true));
      for (const t of doc.querySelectorAll('template')) {
        if (!applies(t)) continue;
        if (t.dataset.class) document.body.classList.add(...t.dataset.class.split(/\s+/));
        if (t.dataset.before) document.querySelector(t.dataset.before).before(document.importNode(t.content, true));
      }
      window.__mockScripts = [...doc.querySelectorAll('script')].filter(applies).map((s) => s.textContent);
    }, { html, variant });
    for (const src of await page.evaluate(() => window.__mockScripts)) await page.evaluate(src);
    await page.waitForTimeout(400);
  }
  if (argv.includes('--full')) { // grow the viewport to the content so nothing is cut off below the panel's fold
    const full = await page.evaluate(() => document.body.scrollHeight);
    if (full > height) { await page.setViewportSize({ width, height: full }); await page.waitForTimeout(300); }
  }
  await page.screenshot({ path: resolve(root, out) });
  console.log(`panel ${width}x${height}${variant ? ` variant ${variant}` : ''} -> ${out}`);
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
