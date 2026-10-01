// tools/build.mjs - Copy the runtime extension files into an unpacked build directory
// and write BUILD_INFO.json (source commit, dirty flag, per-file SHA-256, fingerprint).
//
// Usage: node tools/build.mjs [outDir]   (default: build/unpacked)
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.argv[2] || 'build/unpacked');

// Runtime files only. Docs, tests and tooling are never shipped.
const RUNTIME = [
  'manifest.json',
  'background.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'physics-view.js',
  'themes.css',
  'icons'
];

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(cmd) {
  try { return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; }
}

// Validate that every file the manifest references exists.
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])
].filter(Boolean);
const exposed = (manifest.web_accessible_resources || []).flatMap((w) => w.resources).filter((r) => !r.includes('*'));
const missing = required.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error(`Manifest references missing files: ${missing.join(', ')}`);
  process.exit(1);
}
const missingExposed = exposed.filter((f) => !existsSync(join(root, f)));
if (missingExposed.length) console.warn(`WARNING: web_accessible_resources lists missing files: ${missingExposed.join(', ')}`);

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
for (const entry of RUNTIME) cpSync(join(root, entry), join(outDir, entry), { recursive: true });

const files = {};
for (const f of listFiles(outDir).sort()) files[relative(outDir, f)] = sha256(f);
const fingerprint = createHash('sha256')
  .update(Object.entries(files).map(([f, h]) => `${h}  ${f}`).join('\n'))
  .digest('hex');

const info = {
  name: manifest.name,
  version: manifest.version,
  sourceCommit: git('rev-parse HEAD'),
  sourceBranch: git('rev-parse --abbrev-ref HEAD'),
  sourceDirty: (git('status --porcelain -- ' + RUNTIME.join(' ')) || '') !== '',
  builtAt: new Date().toISOString(),
  fingerprint,
  files
};
writeFileSync(join(outDir, 'BUILD_INFO.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`Built ${Object.keys(files).length} files -> ${outDir}`);
console.log(`version ${info.version}  commit ${info.sourceCommit?.slice(0, 7)}${info.sourceDirty ? ' (dirty)' : ''}  fingerprint ${fingerprint.slice(0, 16)}`);
