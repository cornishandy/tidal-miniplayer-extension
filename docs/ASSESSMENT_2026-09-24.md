# Takeover Assessment — 2026-09-24

Historical record written **before** any application change in this takeover. Do not rewrite; later status lives in [PLAN_AND_ACCEPTANCE.md](PLAN_AND_ACCEPTANCE.md).

Assessed source: `main` @ `f03383e` (= extraction baseline `1b7bedb` + `FINAL_HANDOFF.md`). Baseline build fingerprint `8cf516e32edf107a…` (see `tests/results/baseline-f03383e/results.json`, gitignored; key numbers are copied below).

## 1. Project identity (verified)

| Check | Result |
|---|---|
| Working directory | `~/Documents/ChatGPT/tidal-miniplayer-extension` = handoff `NEW_PROJECT_ROOT` |
| Git top-level / common dir | same folder / `.git` — standalone repo, not a worktree of the old project |
| Remote | `cornishandy/tidal-miniplayer-extension`, **PRIVATE**, default branch `main` |
| Remote refs | `main` = `f03383e`, tag `v1.1.0-extraction-baseline` → `1b7bedb` — match local |
| Working tree | clean at start |
| T3 app project binding | Not inspectable from this session; verified by repository evidence only |

## 2. Preservation and extraction

- Old copy `…/T3 Code/t3-nightly-toy/tidal-miniplayer-extension` is **byte-identical** to the new source (`diff -rq`: only `.gitignore` and `FINAL_HANDOFF.md` are new). Left untouched.
- Old workspace git has **no commits** (the old copy was never under version control), so the only history is the new repo plus the backup.
- Backup `…/t3-nightly-toy/backups/pre-extraction-backup/`: `CHECKSUMS.sha256` re-verified **18/18 OK**; tarball lists 20 entries. Not copied or published.
- No symlinks, no parent-workspace dependencies, no native helpers, no build step. The extension loads from the new root alone (the browser harness loaded a copy with no reference to the old tree).
- Secrets: none in source. `content.js` / `tidal-bridge.js` read Tidal's session token from the Tidal page's own `localStorage` at runtime and only send it to Tidal hosts; nothing is stored or transmitted elsewhere.

## 3. Installation, identity and state

- `manifest.json` has **no `key`**, so an unpacked extension's ID is derived from its folder path. Expected IDs (derived with Chrome's path formula, which the harness confirmed for its temp path):
  - old live install path → `ijpeopehiemfiifapjkkidppddmojdip`
  - new repo root → `enccabkecldgiobangagllgmmjfkjnmd`
  - stable review build `build/review-unpacked` → `gponppchadgoilnlbogcdldbmpdoaeno`
- **I could not read the live Chrome profile.** macOS blocks access to `~/Library/Application Support/Google/Chrome` (“Operation not permitted”), so I can't confirm the live install's ID, enabled state or stored settings. I did not attempt a workaround.
- All state is in `chrome.storage.local`. No `storage.sync` and no backend, so a review copy can't sync settings into the daily install. Keys: `presets`, `currentPreset`, `currentParams`, `showFloatingButton`, `showFloatingButton_userExplicit`, `visualTheme`, `capturedTabId`, `isAudioCapturing`.
- Consequence: a review install at a different path gets a **different ID and empty/default settings**. Custom presets in the live install are **not** migrated. No key was generated, and nothing was uninstalled or reinstalled.

## 4. Real purpose and surfaces (from code + handoff)

The extension is a Tidal-first mini-player and tab audio enhancer. It has four parts:

1. **Audio EQ (tab capture)**: `popup` → `background` (`tabCapture.getMediaStreamId`) → `offscreen` Web Audio chain: HPF (12 dB/oct, 20–200 Hz) → low-shelf 120 Hz (0…+14 dB) → peaking 1 kHz Q0.8 (±6) → high-shelf 5 kHz (±6) → wet/dry compressor (“Auto-Balancing”) → gain (50–250 %) → limiter (DynamicsCompressor, −0.3 dB threshold, ratio 20) → speakers. There's also a true-bypass path used by the *Flat (Bypass)* preset.
2. **Player controls** for Tidal (scraped from `#footerPlayer`) or any tab's `<audio>/<video>`: play/pause, prev/next, favorite, seek bar with 25 % ticks, −25 %/+25 % skip, and page media volume.
3. **Mini-player surfaces**: the toolbar popup; a **Micro** mode; a **Wide** size; an **Undocked** window (`popup.html?undocked=true`); an in-page **Document PiP** window (built by `content.js`, reduced controls); a **floating in-page button** (off by default); and `miniplayer.html` as the PiP fallback.
4. **Playlists / Playlist Lab** (Tidal): a playlist checklist, plus set operations (A∖B∖C, A∩B, AΔB, A∪B∪C) with a sortable table and “Create New Playlist in Tidal”.

Extras: a Physics/signal-path drawer (`router-visualizer.js`) with per-stage A/B bypass; 5 themes; presets (8 factory + custom); keyboard commands Alt+M and Alt+E.

## 5. Handoff claims vs evidence

| Claim | Evidence | Verdict |
|---|---|---|
| “Browser runtime verified: YES” | No artifacts in repo | Unsupported; now tested (below) |
| Scoped transport never hits playlist cards | Harness decoy test | **Confirmed** (W-TRANSPORT-SCOPE) |
| −0.3 dBFS brickwall limiter | Worst-case settings measured **peak 1.025 (+0.2 dBFS)** | **Not true**: overshoot past full scale |
| Bass low-shelf / HPF work | FFT: +10 dB bass → +9.3 dB at 60 Hz, 1 kHz unchanged; HPF 200 Hz → −21 dB at 60 Hz | **Confirmed** (objective, synthetic) |
| README “Low-shelf 100 Hz + Sub-peak 65 Hz”, “up to 400 %” | Code: 120 Hz shelf, no sub-peak, max 250 % | README stale |
| Playlist manager pre-checks and adds/removes tracks | `checkTrackInPlaylist` always false; add clicks an unrelated menu and returns success; remove does nothing | **Not implemented** (fake success) |
| Playlist Lab computes real set operations | Real API path exists (unverified). Otherwise: demo playlists, a two-track **mock DB returned for every real playlist**, **invented BPM/Key/date**, and **fake “Successfully created” when nothing was created** | **Misleading**, reproduced (W-LAB-HONESTY) |
| Alt+M shows/hides mini-player | Manifest command `toggle-miniplayer`; handler listens for `toggle-pip-miniplayer` | **Broken** (static) |
| 📌 On Top opens Document PiP | PiP requires a user click *in the page* (Chrome docs). Popup/shortcut messages have no page activation, so it always falls back to `miniplayer.html` | Falls through to the fallback, which is **broken** |
| Fallback window works | `miniplayer.js` references undefined `sliderBass`, `sendAudioUpdate`, `isEqActive`, `findActiveTab`. The file appears truncated. | **Broken**: ReferenceError (W-FALLBACK-WINDOW) |
| `tidal-bridge.js` talks to Tidal APIs | Never injected anywhere; exposed as a web-accessible resource only | Dead code |

## 6. Baseline acceptance run (isolated Chrome for Testing 1208, temp profile, network blocked except localhost, muted)

13 PASS / 7 FAIL. Levels: installed-browser (unpacked extension in a real browser build) and objective-audio (AnalyserNode FFT inside the offscreen document). Tab capture was authorised with `--allowlisted-extension-id`, which stands in for the toolbar click that automation cannot perform.

FAIL (reproduced defects):
- **W-PRESET-RESET-SAFE**: “↺ Reset to Default” with a *custom* preset selected **deletes every custom preset** (data loss).
- **W-LAB-HONESTY**: mock tracks with invented BPM/Key, and a fake “Successfully created … in your Tidal library” alert.
- **W-FALLBACK-WINDOW**: `miniplayer.html` throws ReferenceError; its controls are dead.
- **W-TAB-CLOSE-AFTER-SW-RESTART**: after the service worker has restarted, closing the captured tab leaves EQ reported ON with a dead stream and a running AudioContext.
- **W-PLAYLIST-ESCAPE**: playlist and track titles are inserted as HTML (a title `<b>Bold</b>` renders bold). Extension CSP blocks script, but the markup is still injected.
- **W-STAGE-BYPASS-SYNC**: the Physics-drawer stage bypass is dropped from saved state by the next slider move, and the drawer always reopens showing “● ON” even while a stage is bypassed in the audio engine.
- **W-THEME-KEEPS-LAYOUT**: cycling the theme wipes Wide/Micro layout classes.

PASS: load, popup render, footer metadata, transport scoping, +25 % skip, capture start/stop/restart, normal tab-close cleanup, bass/HPF spectrum, limiter keeps below +0.25 dBFS (tolerance check only; see claim table), no page errors.

## 7. Static findings (not yet runtime-tested)

- Offscreen start: both the bypass path and the DSP path begin at gain 1.0 and ramp afterwards, so the first ~50 ms plays both summed (up to +6 dB, and the direct path skips the limiter). The compressor wet and dry paths have the same issue.
- The EQ targets the “best” media tab (audible Tidal first). Chrome only allows capture of a tab the extension was **invoked on**, so turning EQ on while looking at a different tab fails, and the error text doesn't say why.
- The Alt+E path has no error handling (unhandled rejection in the worker).
- The manifest exposes the non-existent `miniplayer.css`. `FACTORY_PRESET_NAMES` lists one preset twice.
- The visualizer readout says “Bass … @ 65Hz”, but the shelf is at 120 Hz.
- Pitch/Speed sets `playbackRate` with pitch preserved (Chrome default), so it's speed only. In the popup it only applies while EQ is ON; in PiP it always applies.
- The PiP window duplicates the popup UI inline in `content.js` with fewer controls and an emoji heart, which contradicts the white SVG heart decision.
- Content scripts run on every http(s) page. The floating button is off by default.
- Blank band in the EQ tab (`.controls-area { justify-content:center }` inside a fixed 540 px container), and the track title is truncated to one or two letters at 360 px. These are design-review items.
- The Tidal API host in `content.js` is `listen.tidal.com/v1/…`, while `tidal-bridge.js` uses `api.tidal.com/v1/…`. Correctness against real Tidal is **unverifiable** without your logged-in session. I won't contact Tidal.

## 8. Keep / repair / defer

- **Keep**: the DSP chain and presets, transport scoping, 25 % skip and ticks, nudge buttons and double-click reset, surfaces and themes, Physics drawer, set-operation UI.
- **Repair now** (bounded, reversible): preset-reset data loss; Lab/Playlist honesty (no fabricated data or success, visible demo/limited-data labels, exact “A+” auto-select); HTML escaping; fallback window → the working undocked popup; Alt+M handler; single mini-window toggle; capture cleanup on track end and after worker restart; start-transient gains; true output ceiling; stage-bypass persistence and display; theme class bug; clearer capture error; manifest/duplicate-name/readout nits.
- **Defer to design interview**: EQ target-tab rules and showing which tab is affected; what “On Top” should do given PiP needs an in-page click; Pitch vs Speed semantics and gating; PiP feature parity; the blank band and title truncation; the header icon row; whether Playlists add/remove should be built for real; the fate of the dead `miniplayer.*` and `tidal-bridge.js` files.
- **Blocked**: anything that needs your real Tidal login, your live Chrome profile, or listening judgement.
