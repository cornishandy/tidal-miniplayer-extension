// tests/browser/glitch-check.mjs - Count audio dropouts in the extension's live engine (diagnostic, 2026-10-10).
//
// Same isolation as run.mjs (do not weaken): fresh temporary profile, every host except the local fixture server
// resolves to NOTFOUND, --mute-audio, synthetic tone only. The engine runs at the Mac's default output rate.
// A dropout is a stretch where the engine did not deliver audio in time and Chrome played silence instead
// (AudioContext.playoutStats: fallback frames). Each one is heard as a click.
//
// Usage: node browser/glitch-check.mjs <unpackedDir> [--seconds 20] [--scenarios a,b,c]
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extDir = realpathSync(resolve(process.argv[2]));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SECONDS = +arg('--seconds', 20);
const CHROME = process.env.CHROME_BIN || join(process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const unpackedId = (p) => [...createHash('sha256').update(p).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const EXT_ID = unpackedId(extDir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A sustained chord, the kind of music where a dropout is easiest to hear.
function chordWav(seconds = 90, rate = 48000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const f = [130.81, 164.81, 196.0, 261.63, 523.25];
  for (let i = 0; i < n; i++) { let s = 0; for (const x of f) s += AMP * Math.sin(2 * Math.PI * x * i / rate); buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2); }
  return buf;
}
// The fixture loops; Chrome's player leaves a ~68 ms gap at each loop point, so a run must be shorter than the file
// (or the gaps at multiples of --loop-seconds are the fixture's, not the engine's).
const LOOP_SECONDS = +arg('--loop-seconds', 90);
const AMP = +arg('--amp', 0.05); // per tone; 0.0005 is about -80 dB below normal, for checks that need no sound
const BURST = +arg('--burst-ms', 0); // a stall of this many ms once every 64 blocks (~11 per second at 96 kHz); copy tests/fixtures/stress.worklet.js into the scratch build first
const STRESS = +arg('--stress', BURST ? 1 : 0); // test-only audio-thread load (iterations per block; needs stress.worklet.js in the scratch build)
const WAV = chordWav(LOOP_SECONDS);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/tone.wav') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = +m[1], end = m[2] ? +m[2] : WAV.length - 1;
      res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${WAV.length}` });
      return res.end(WAV.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': WAV.length });
    return res.end(WAV);
  }
  const p = join(here, '../fixtures', 'media.html');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const MEDIA_URL = `http://127.0.0.1:${server.address().port}/media.html`;

const profile = mkdtempSync(join(tmpdir(), 'tme-glitch-'));
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME, headless: true,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--allowlisted-extension-id=${EXT_ID}`,
    '--mute-audio', '--disable-audio-output', // --mute-audio alone left the offscreen engine audible on the user's DAC (2026-10-10); no output device at all now
    '--enable-blink-features=AudioContextPlayoutStats', ...(process.argv.includes('--real-autoplay') ? [] : ['--autoplay-policy=no-user-gesture-required']), '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--no-proxy-server', // a system proxy would otherwise resolve names itself
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,MediaRouter', `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--no-default-browser-check'],
  viewport: { width: 800, height: 600 }
});

async function evalOffscreen(expression) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const t = list.find((x) => x.url === `chrome-extension://${EXT_ID}/offscreen.html`);
  if (!t) return { missing: true };
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const reply = new Promise((r) => { ws.onmessage = (m) => r(JSON.parse(m.data)); });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await reply; ws.close();
  if (msg.result?.exceptionDetails) return { error: msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text };
  return { value: msg.result?.result?.value };
}

const STATS = `(() => { const s = audioCtx && audioCtx.playoutStats; const tr = currentStream && currentStream.getAudioTracks()[0]; const ts = audioCtx ? audioCtx.getOutputTimestamp() : null; return { ts, now: performance.now(), ct: audioCtx && audioCtx.currentTime, track: tr ? tr.getSettings() : null, rate: audioCtx && audioCtx.sampleRate, base: audioCtx && audioCtx.baseLatency, out: audioCtx && audioCtx.outputLatency,
  stats: s ? { events: s.fallbackFramesEvents, fallbackMs: s.fallbackFramesDuration, totalMs: s.totalFramesDuration, avgLatMs: s.averageLatency, maxLatMs: s.maximumLatency } : null }; })()`;


// Gap probe (test-only): two analysers, on the captured tab audio and on the output, read every 100 ms. The synthetic
// chord changes by at most ~0.005 per sample at 96 kHz; a jump bigger than 0.05 between neighbouring samples, or a
// run of 8+ exact zeros inside the chord, is a discontinuity (a gap or a skip in the stream). Overlapping reads are
// de-duplicated by their position in context time.
const PROBE_START = `(() => {
  const mk = (src) => { const a = audioCtx.createAnalyser(); a.fftSize = 32768; a.smoothingTimeConstant = 0; src.connect(a); return a; };
  const taps = { input: mk(sourceNode), output: mk(outputSum) };
  const buf = new Float32Array(32768);
  window.__gap = { input: [], output: [], reads: 0, from: audioCtx.currentTime + 0.5 }; // the analysers start empty: skip their first 0.34 s
  window.__ts = []; window.__tsTimer = setInterval(() => { const o = audioCtx.getOutputTimestamp(); if (o.performanceTime > 0) window.__ts.push([o.performanceTime / 1000, o.contextTime]); }, 1000);
  window.__gapTimer = setInterval(() => {
    const fs = audioCtx.sampleRate, end = audioCtx.currentTime;
    window.__gap.reads++;
    for (const k of ['input', 'output']) {
      taps[k].getFloatTimeDomainData(buf);
      let e = 0; for (let i = 0; i < buf.length; i += 16) e += buf[i] * buf[i];
      if (Math.sqrt(e / (buf.length / 16)) < 1e-4 && audioCtx.currentTime > window.__gap.from) window.__gap[k + 'Silent'] = (window.__gap[k + 'Silent'] || 0) + 1; // a whole read without sound
      let zeros = 0;
      for (let i = 2; i < buf.length; i++) {
        const d2 = Math.abs(buf[i] - 2 * buf[i - 1] + buf[i - 2]);
        zeros = buf[i] === 0 ? zeros + 1 : 0;
        if (d2 > 0.05 || zeros === 8) {
          const t = end - (buf.length - i) / fs;
          if (t < window.__gap.from) { i += 64; continue; }
          let run = 0;
          if (zeros === 8) { let j = i - 7; while (j < buf.length && buf[j] === 0) { run++; j++; } if (j >= buf.length) { i += 64; continue; } } // run cut off by the window end: read it next time
          const list = window.__gap[k];
          if (!list.some((x) => Math.abs(x.t - t) < 0.003)) list.push({ t: +t.toFixed(4), kind: zeros === 8 ? 'zeros' : 'jump', size: +d2.toFixed(3), samples: run || undefined, ms: run ? +(run / fs * 1000).toFixed(2) : undefined });
          i += Math.max(64, run);
        }
      }
    }
  }, 100);
  return true;
})()`;
const PROBE_READ = `(() => { const g = window.__gap; clearInterval(window.__gapTimer); clearInterval(window.__tsTimer);
  const P = window.__ts, n = P.length; let ppm = null;
  if (n > 10) { let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const [x, y] of P) { sx += x; sy += y; sxx += x * x; sxy += x * y; } const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); ppm = +((b - 1) * 1e6).toFixed(2); }
  return { silentReadsIn: g.inputSilent || 0, silentReadsOut: g.outputSilent || 0, clockPpmFit: ppm, clockSamples: n, allInput: g.input, allOutput: g.output, reads: g.reads, input: g.input.length, output: g.output.length, firstInput: g.input.slice(0, 5), firstOutput: g.output.slice(0, 5) }; })()`;

// Test-only changes to the running graph (nothing is changed in the extension's files).
const CUT = {
  pitch: `dspPathGain.disconnect(pitchNode); pitchNode.disconnect();`,
  dynamics: `highNode.disconnect(bandLevelerNode); bandLevelerNode.disconnect();
    levelerOut.disconnect(matchNode); pitchDryGain.disconnect(matchNode); pitchWetGain.disconnect(matchNode); matchNode.disconnect();
    volumeGain.disconnect(lookaheadNode); lookaheadNode.disconnect();`,
  warm: `limiterOut.disconnect(warmPreGain); warmPreGain.disconnect(); warmShaper.disconnect();`
};

const SCENARIOS = {
  a: { name: 'as built (1.5.1 defaults)', cut: [] },
  b: { name: 'pitch worklet disconnected', cut: ['pitch'] },
  c: { name: 'pitch + dynamics worklets disconnected', cut: ['pitch', 'dynamics'] },
  d: { name: 'pitch + dynamics + warm shaper disconnected', cut: ['pitch', 'dynamics', 'warm'] },
  e: { name: 'dynamics worklets disconnected, pitch kept', cut: ['dynamics'] },
  p: { name: 'Pitch set to +2 st (shifter in use)', cut: [], params: { semitones: 2 } }
};
// Load (optional): N busy tabs spinning the main thread, standing in for a heavy web app; and an open popup that polls frames.
let loadPages = [];
async function startLoad(n) {
  for (let i = 0; i < n; i++) {
    const p = await context.newPage();
    await p.goto(MEDIA_URL.replace('media.html', 'busy.html'));
    await p.evaluate(() => { const spin = () => { const t = performance.now(); while (performance.now() - t < 12) Math.sqrt(Math.random()); setTimeout(spin, 4); }; spin(); });
    loadPages.push(p);
  }
}
async function stopLoad() { for (const p of loadPages) await p.close(); loadPages = []; }
SCENARIOS.U = { name: 'as built, popup open with live display', cut: [], live: true };
SCENARIOS.L = { name: 'as built, 6 busy tabs', cut: [], load: 6 };
SCENARIOS.Lb = { name: 'pitch worklet disconnected, 6 busy tabs', cut: ['pitch'], load: 6 };
SCENARIOS.Lp = { name: 'Pitch +2 st, 6 busy tabs', cut: [], load: 6, params: { semitones: 2 } };
const order = arg('--scenarios', 'a,b,a,c,d').split(',');

const out = [];
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const media = await context.newPage();
  await media.goto(MEDIA_URL);
  await media.mouse.click(5, 5); // a real input event, so the fixture page may play under Chrome's normal autoplay rule
  await media.evaluate(() => document.getElementById('a').play());
  await sleep(700);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, MEDIA_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await sleep(1200);
  const send = (m) => popup.evaluate((x) => new Promise((r) => chrome.runtime.sendMessage(x, (res) => r(res ?? null))), m);
  for (const key of order) {
    const sc = SCENARIOS[key];
    await send({ type: 'STOP_CAPTURE' }); await sleep(400);
    const start = await send({ type: 'START_CAPTURE_FOR_TAB', tabId });
    await sleep(1500);
    if (process.argv.includes('--real-autoplay')) console.log('  start:', JSON.stringify(start), JSON.stringify((await evalOffscreen(`({ ctx: audioCtx && audioCtx.state, srcEl: window.__srcEl ? { paused: window.__srcEl.paused } : null })`)).value));
    if (sc.live) { await popup.reload(); await sleep(1500); }
    if (STRESS) { const r = await evalOffscreen(`(async () => { await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('stress.worklet.js'));
      const n = new AudioWorkletNode(audioCtx, 'stress', { processorOptions: { iters: ${STRESS > 1 ? STRESS : 0}, burstMs: ${BURST} } }); const g = audioCtx.createGain(); g.gain.value = 0; window.__stress = []; n.port.onmessage = (e) => window.__stress.push(e.data); sourceNode.connect(n); n.connect(g); g.connect(audioCtx.destination); return true; })()`); if (r.error) throw new Error('stress: ' + r.error); }
    if (sc.params) await evalOffscreen(`updateParams(${JSON.stringify(sc.params)})`);
    for (const c of sc.cut) { const r = await evalOffscreen(`(() => { ${CUT[c]} return true; })()`); if (r.error) throw new Error(`${c}: ${r.error}`); }
    await sleep(2500); // settle
    if (sc.load) await startLoad(sc.load);
    await evalOffscreen(PROBE_START);
    const s0 = (await evalOffscreen(STATS)).value;
    await sleep(SECONDS * 1000);
    const s1 = (await evalOffscreen(STATS)).value;
    const gaps = (await evalOffscreen(PROBE_READ)).value;
    if (STRESS) console.log('  stress:', JSON.stringify((await evalOffscreen('window.__stress && window.__stress.slice(-3)')).value));
    if (sc.load) await stopLoad();
    const row = { scenario: sc.name, started: start?.success === true, rate: s1?.rate, baseLatencyMs: s1?.base != null ? +(s1.base * 1000).toFixed(2) : null,
      outputLatencyMs: s1?.out != null ? +(s1.out * 1000).toFixed(2) : null };
    if (s0?.ts && s1?.ts && s1.ts.performanceTime > s0.ts.performanceTime) {
      const wall = (s1.ts.performanceTime - s0.ts.performanceTime) / 1000, ctx = s1.ts.contextTime - s0.ts.contextTime;
      row.clockPpm = +(((ctx - wall) / wall) * 1e6).toFixed(1);
      const wall2 = (s1.now - s0.now) / 1000; row.clockPpmCurrentTime = +((((s1.ct - s0.ct) - wall2) / wall2) * 1e6).toFixed(1);
    }
    row.clockPpmFit = gaps?.clockPpmFit;
    row.silentReadsIn = gaps?.silentReadsIn; row.silentReadsOut = gaps?.silentReadsOut;
    Object.assign(row, { trackRate: s1?.track?.sampleRate ?? null, trackChannels: s1?.track?.channelCount ?? null, gapsIn: gaps?.input, gapsOut: gaps?.output, reads: gaps?.reads });
    if (gaps && (gaps.input || gaps.output)) console.log('  gaps:', JSON.stringify({ input: gaps.allInput, output: gaps.allOutput }));
    if (s0?.stats && s1?.stats) {
      const secs = (s1.stats.totalMs - s0.stats.totalMs) / 1000;
      Object.assign(row, { seconds: +secs.toFixed(1), dropouts: s1.stats.events - s0.stats.events,
        dropoutsPerSec: +((s1.stats.events - s0.stats.events) / secs).toFixed(2), silencedMs: +(s1.stats.fallbackMs - s0.stats.fallbackMs).toFixed(1),
        maxLatencyMs: +s1.stats.maxLatMs.toFixed(1) });
    } else row.playoutStats = 'not available in this Chrome';
    out.push(row);
    console.log(JSON.stringify(row));
  }
} catch (e) {
  console.error('glitch-check failed:', e?.stack || e);
} finally {
  console.table(out);
  console.log(`Chrome ${context.browser()?.version?.() || 'for Testing (chromium-1208)'}; ${SECONDS} s per scenario; extension ${extDir}`);
  await context.close(); server.close(); rmSync(profile, { recursive: true, force: true });
}
