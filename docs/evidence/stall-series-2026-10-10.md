# Stall series, 2026-10-10 (K-01)

What: the audio thread of the extension's engine stalled on purpose for a fixed time once every 64 blocks (about 11 times a
second at 96 kHz), and Chrome's own dropout counter read (`AudioContext.playoutStats`, enabled with
`--enable-blink-features=AudioContextPlayoutStats`). Tool: `tests/browser/glitch-check.mjs --burst-ms N`, with
`tests/fixtures/stress.worklet.js` copied into scratch builds (never into `build/review-unpacked`).

Conditions: isolated Chrome for Testing 145.0.7632.6, temporary profile, network blocked, synthetic chord, 15 s per row,
engine at 96 kHz on the Mac's default output device (iFi Pro iDSD; engine clock 10 to 11 ppm fast against the system clock).
This was before `--disable-audio-output` was added: the counter only exists on a real output device, so this series cannot be
repeated silently (doing so needs the user's OK at a time they are not listening).

Builds: 1.5.1 as shipped (fingerprint of the scratch copy: commit febabc2) and the 1.5.2 candidate (`latencyHint: 'playback'`,
parked pitch worklet).

| Stall | 1.5.1: dropouts (per second) | 1.5.1: silenced | 1.5.2 candidate: dropouts | 1.5.2: silenced |
|---|---|---|---|---|
| 3 ms | 0 (0) | 0 ms | 0 | 0 ms |
| 4 ms | 6 (0.4) | 16 ms | 0 | 0 ms |
| 5 ms | 67 (4.41) | 178.6 ms | 0 | 0 ms |
| 6 ms | 183 (11.81) | 487.9 ms | 0 | 0 ms |
| 12 ms | 270 (17.14) | 719.8 ms | 0 | 0 ms |
| 18 ms | 368 (22.98) | 981.1 ms | 0 | 0 ms |
| 24 ms | 285 (18.01) | 759.8 ms | 0 | 0 ms |

Device buffer: 1.5.1 256 frames (baseLatency 2.67 ms, outputLatency 8 ms); candidate 2048 frames (21.33 ms; outputLatency 32 to
40 ms). A steady (not bursty) load broke both builds at the same level (about 1.2 million loop iterations per block): the larger
buffer absorbs stalls, it does not add computing power.

Also measured on the same device, same day: 600 s with a tone that does not loop, 1.5.1 and the candidate: 0 gaps, 0 dropouts.
