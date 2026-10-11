// tools/diagramshot.mjs - Render an HTML diagram from docs/diagrams to a 2x PNG.
// Usage: node tools/diagramshot.mjs <name.html> <out.png>
// Same Chrome for Testing binary as the test harness; no extension, no network, no profile.
import { chromium } from '../tests/node_modules/playwright-core/index.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
// Usage: node tools/diagramshot.mjs <name.html> <out.png> [--variant x] [--width px]
//   <name.html> is resolved from docs/diagrams (../mockups/page.html reaches the mockups); --variant becomes ?variant=x.
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const [name, out] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!name || !out) { console.error('usage: node tools/diagramshot.mjs <name.html> <out.png> [--variant x] [--width px]'); process.exit(1); }
const variant = opt('--variant', '');
const width = +opt('--width', 1200);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
const tab = await ctx.newPage();
await tab.goto(pathToFileURL(join(root, 'docs/diagrams', name)).href + (variant ? `?variant=${variant}` : ''));
await tab.waitForTimeout(250);
const box = await tab.locator('.sheet').boundingBox();
await tab.screenshot({ path: resolve(root, out), clip: { x: box.x, y: box.y, width: Math.ceil(box.width), height: Math.ceil(box.height) } });
console.log(`${name}: ${Math.round(box.width)}x${Math.round(box.height)} -> ${out}`);
await browser.close();
