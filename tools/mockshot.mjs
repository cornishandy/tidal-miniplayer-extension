// tools/mockshot.mjs - Render docs/mockups/popup-variants.html variants to PNG (2x) for design review.
// Usage: node tools/mockshot.mjs [variant ...]      (default: all)
// Uses the same Chrome for Testing binary as the test harness; no extension, no network, no profile.
import { chromium } from '../tests/node_modules/playwright-core/index.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = pathToFileURL(join(root, 'docs/mockups/popup-variants.html')).href;
const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ['pa', 'pb', 'pc', 'h1', 'h2', 'h3'];

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
const ctx = await browser.newContext({ viewport: { width: 560, height: 700 }, deviceScaleFactor: 2 });
const tab = await ctx.newPage();
for (const v of variants) {
  await tab.goto(`${page}?variant=${v}&shot=1`);
  await tab.waitForTimeout(200);
  const box = await tab.locator('.popup-container').boundingBox();
  const out = join(root, 'docs/mockups', `${v}.png`);
  await tab.screenshot({ path: out, clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 } });
  console.log(`${v}: ${Math.round(box.width)}x${Math.round(box.height)} -> docs/mockups/${v}.png`);
}
await browser.close();
