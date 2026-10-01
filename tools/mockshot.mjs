// tools/mockshot.mjs - Render a docs/mockups page's variants to PNG (2x) for design review.
// Usage: node tools/mockshot.mjs [--page round2.html] [--tag suffix] [variant ...]
// Uses the same Chrome for Testing binary as the test harness; no extension, no network, no profile.
import { chromium } from '../tests/node_modules/playwright-core/index.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
// Optional --tag <suffix> gives the files new names (chat clients cache images by path).
const argv = process.argv.slice(2);
const tagIdx = argv.indexOf('--tag');
const tag = tagIdx >= 0 ? argv[tagIdx + 1] : '';
const pageIdx = argv.indexOf('--page');
const pageFile = pageIdx >= 0 ? argv[pageIdx + 1] : 'popup-variants.html';
const rest = argv.filter((a, i) => i !== tagIdx && i !== tagIdx + 1 && i !== pageIdx && i !== pageIdx + 1);
const DEFAULTS = { 'popup-variants.html': ['pa', 'pb', 'pc', 'h1', 'h2', 'h3'], 'round2.html': ['c2', 'c1', 'p1', 'p2', 'p3', 'i2', 'i3', 'micro'] };
const variants = rest.length ? rest : (DEFAULTS[pageFile] || []);
const page = pathToFileURL(join(root, 'docs/mockups', pageFile)).href;
const prefix = pageFile === 'round2.html' ? 'r2-' : '';

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
const ctx = await browser.newContext({ viewport: { width: 560, height: 700 }, deviceScaleFactor: 2 });
const tab = await ctx.newPage();
for (const v of variants) {
  await tab.goto(`${page}?variant=${v}&shot=1`);
  await tab.waitForTimeout(200);
  const box = await tab.locator('.popup-container, .shot, .shot-micro').first().boundingBox();
  const out = join(root, 'docs/mockups', `${prefix}${v}${tag}.png`);
  await tab.screenshot({ path: out, clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 } });
  console.log(`${v}: ${Math.round(box.width)}x${Math.round(box.height)} -> docs/mockups/${prefix}${v}${tag}.png`);
}
await browser.close();
