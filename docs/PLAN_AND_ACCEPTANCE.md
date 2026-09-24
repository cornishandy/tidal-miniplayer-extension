# Plan and Acceptance Evidence

Living document. Dated history of *why* is in [ASSESSMENT_2026-09-24.md](ASSESSMENT_2026-09-24.md).

## Evidence levels

`static` code or manifest inspection · `unit` Node tests (`tests/unit`) · `installed-browser` the unpacked build in Chrome for Testing 1208 with a temp profile, network blocked, muted (`tests/browser/run.mjs`) · `objective-audio` AnalyserNode FFT and peak measured inside the offscreen DSP graph on synthetic tones · `user-listening` your ears on real music · `real-tidal` your signed-in Tidal.

A mocked or automated check does **not** prove how real music sounds or that real Tidal works. Those rows stay NOT RUN or BLOCKED until you try them.

## Acceptance matrix

Current review build: v1.1.1, commit `d0b6d53`, fingerprint `d1a3f475ed1a5121…`, 2026-09-24. Baseline for comparison: `f03383e`, same harness.

| ID | Workflow / requirement | Level | Baseline | Now |
|---|---|---|---|---|
| W-LOAD | Unpacked build loads; worker starts | installed-browser | PASS | PASS |
| W-POPUP-RENDER | Popup renders; 8 factory presets load | installed-browser | PASS | PASS |
| W-TRACK-INFO | Title/artist read from Tidal footer only | installed-browser (fake Tidal DOM) | PASS | PASS |
| W-TRANSPORT-SCOPE | Play/Prev/Next/♥ hit footer, never playlist cards | installed-browser (decoy) | PASS | PASS |
| W-SKIP-25 | +25 % skip moves ~25 % of duration | installed-browser | PASS | PASS |
| W-THEME-KEEPS-LAYOUT | Theme cycle keeps Wide/Micro | installed-browser | FAIL | PASS |
| W-PRESET-RESET-SAFE | Reset on custom preset keeps all custom presets | installed-browser | **FAIL (data loss)** | PASS |
| W-STAGE-BYPASS-SYNC | A/B stage bypass saved and shown on reopen | installed-browser | FAIL | PASS |
| W-CAPTURE-START | EQ attaches; offscreen graph runs | installed-browser* | PASS | PASS |
| W-AUDIO-TRANSPARENT | Flat settings keep input level (peak 0.15) | objective-audio | PASS | PASS |
| W-AUDIO-BASS | Bass +10 dB → +9.3 dB at 60 Hz, 1 kHz unchanged | objective-audio | PASS | PASS |
| W-AUDIO-HPF | HPF 200 Hz → −21 dB at 60 Hz | objective-audio | PASS | PASS |
| W-AUDIO-LIMITER | Worst case never exceeds −0.3 dBFS | objective-audio | FAIL (peak 1.024) | PASS (0.965) |
| W-CAPTURE-STOP | Stop releases stream + context; OFF everywhere | installed-browser | PASS | PASS |
| W-CAPTURE-RESTART | Re-attach after stop | installed-browser | PASS | PASS |
| W-TAB-CLOSE-CLEANUP | Closing captured tab → OFF | installed-browser | PASS | PASS |
| W-TAB-CLOSE-AFTER-SW-RESTART | Same, after worker restart | installed-browser | FAIL | PASS |
| W-FALLBACK-WINDOW | Standalone mini-player window works | installed-browser | FAIL (crash) | PASS |
| W-FALLBACK-SINGLE | Only one standalone window | installed-browser | FAIL | PASS |
| W-PLAYLIST-ESCAPE | Titles shown as text, not HTML | installed-browser | FAIL | PASS |
| W-PLAYLIST-ADD-HONEST | Add/remove doesn't pretend | installed-browser | FAIL | PASS |
| W-LAB-AUTOSELECT | Lab picks A = “A+”, B = “Super A+” | installed-browser | FAIL | PASS |
| W-LAB-HONESTY | No invented tracks, BPM/Key or fake “created” | installed-browser | FAIL | PASS |
| W-NO-PAGE-ERRORS | No uncaught errors during run | installed-browser | PASS | PASS |
| U-MANIFEST / U-COMMANDS / U-PERMS / U-SYNTAX / U-FALLBACK | Static integrity, commands wired, permissions unchanged | unit | — | PASS (5/5) |
| W-TOOLBAR-INVOKE | EQ via a real toolbar click (activeTab grant) | user | NOT RUN | NOT RUN |
| W-PIP-FLOATING | Document PiP from the in-page floating button | user | NOT RUN | NOT RUN (automation can't click with page activation) |
| W-SHORTCUTS | Alt+M / Alt+E in real Chrome | user | NOT RUN | NOT RUN (static fix + unit test only) |
| W-REAL-TIDAL-TRANSPORT | Transport and metadata on real listen.tidal.com | real-tidal | BLOCKED | BLOCKED (needs your session; I don't contact Tidal) |
| W-REAL-TIDAL-PLAYLISTS | Lab reads real playlists/tracks; create works | real-tidal | BLOCKED | BLOCKED (API host `listen.tidal.com/v1` unverified) |
| W-LISTEN | Sound quality, presets, no pumping or distortion | user-listening | NOT RUN | NOT RUN |
| W-LIVE-INSTALL | Everyday install untouched | static | PASS | PASS (old folder byte-identical; profile unreadable, so ID unconfirmed) |

\* Capture was authorised with `--allowlisted-extension-id` in place of the toolbar click. The graph, stop and cleanup behaviour is real.

## Done in this takeover (2026-09-24)

Identity and preservation verified. Assessment recorded. Build script with fingerprint. Isolated harness (24 browser + 5 unit checks). 13 fixes (see commit `9b01e83`). Version 1.1.1. Operating README. Review build at `build/review-unpacked`.

## Changes from inherited decisions or claims

- The “−0.3 dBFS brickwall” is now actually enforced by a final ceiling stage. The limiter alone overshot.
- Playlist “add/remove current track” was never implemented. It now says so rather than faking success. Building it for real is a design-review decision.
- The fallback mini-player is now the existing undocked popup. `miniplayer.html`/`.js` (truncated, broken) are no longer used but are kept in the repo pending your decision.

## Deferred (design interview; see [DESIGN_REVIEW_MAP.md](DESIGN_REVIEW_MAP.md))

EQ target-tab rules and showing which tab is affected · what 📌 “On Top” should do · Pitch vs Speed and why it only works while EQ is on in the popup · PiP window parity (heart, skips, nudges) · the blank band in the EQ tab and title truncation · the header icon row · building real playlist add/remove · fate of `miniplayer.*` and `tidal-bridge.js`.

## Known risks

- Tidal DOM or API changes can break metadata, transport or playlists. Real-Tidal checks are blocked.
- The ceiling softly bends samples above −0.63 dBFS. That only happens with heavy settings. It still needs a listening check at extreme boosts.
- The popup polls the media tab every second while open. That's cheap, but continuous.
- Content scripts run on every http(s) page (existing behaviour; permission scope unchanged).

## Next bounded milestone

Walk through the design review batches with you, then implement the first agreed slice (see the map's “Next review point”).
