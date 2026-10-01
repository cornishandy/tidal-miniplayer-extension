# Plan and Acceptance Evidence

Living document. Dated history of *why* is in [ASSESSMENT_2026-09-24.md](ASSESSMENT_2026-09-24.md). Decisions are in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

## Evidence levels

`static` code or manifest inspection · `unit` Node tests (`tests/unit`) · `installed-browser` the unpacked build in Chrome for Testing 1208 with a temp profile, network blocked, muted (`tests/browser/run.mjs`) · `objective-audio` AnalyserNode FFT and peak measured inside the offscreen DSP graph on synthetic tones · `user-listening` your ears on real music · `real-tidal` your signed-in Tidal · `user-visual` you looking at the review build.

A mocked or automated check does **not** prove how real music sounds or that real Tidal works. Those rows stay NOT RUN or BLOCKED until you try them.

## Acceptance matrix

Current review build: **v1.2.0**, runtime commit `a92a3c0`, fingerprint `467808d118953de1…`, 2026-10-01. Previous review build: v1.1.1 (`d0b6d53`). Baseline for comparison: `f03383e`, same harness where the check existed.

| ID | Workflow / requirement | Level | Baseline | v1.1.1 | **v1.2.0** |
|---|---|---|---|---|---|
| W-LOAD | Unpacked build loads; worker starts | installed-browser | PASS | PASS | PASS |
| W-POPUP-RENDER | Popup renders; 8 factory presets load | installed-browser | PASS | PASS | PASS |
| W-SURFACES-REMOVED | Playlists, Lab and favourite gone from popup and page script (R-01, R-04) | installed-browser | — | — | PASS |
| W-NO-DEAD-SPACE | No empty band above/below sliders; height follows content (R-03) | installed-browser | — | — | PASS (0 px slack, 336 px tall) |
| W-TRACK-INFO | Title/artist read from Tidal footer only | installed-browser (fake Tidal DOM) | PASS | PASS | PASS |
| W-TRANSPORT-SCOPE | Play/Prev/Next hit footer, never playlist cards; page favourite never touched | installed-browser (decoy) | PASS | PASS | PASS |
| W-SKIP-25 | +25 % skip moves ~25 % of duration | installed-browser | PASS | PASS | PASS |
| W-THEME-KEEPS-LAYOUT | Theme cycle keeps Wide/Micro | installed-browser | FAIL | PASS | PASS |
| W-PRESET-RESET-SAFE | Reset on custom preset keeps all custom presets | installed-browser | **FAIL (data loss)** | PASS | PASS |
| W-PHYSICS-SIDE | Physics opens beside the controls, sliders clickable, closes to 360 px, state remembered (R-02) | installed-browser | — | — | PASS |
| W-STAGE-BYPASS-SYNC | A/B stage bypass saved and shown on reopen | installed-browser | FAIL | PASS | PASS |
| W-CAPTURE-START | EQ attaches; offscreen graph runs | installed-browser* | PASS | PASS | PASS |
| W-AUDIO-TRANSPARENT | Flat settings keep input level (peak 0.15) | objective-audio | PASS | PASS | PASS |
| W-AUDIO-BASS | Bass +10 dB → +9.3 dB at 60 Hz, 1 kHz unchanged | objective-audio | PASS | PASS | PASS |
| W-AUDIO-HPF | HPF 200 Hz → −21 dB at 60 Hz | objective-audio | PASS | PASS | PASS |
| W-AUDIO-LIMITER | Worst case never exceeds −0.3 dBFS | objective-audio | FAIL (peak 1.024) | PASS (0.965) | PASS (0.965) |
| W-CAPTURE-STOP | Stop releases stream + context; OFF everywhere | installed-browser | PASS | PASS | PASS |
| W-CAPTURE-RESTART | Re-attach after stop | installed-browser | PASS | PASS | PASS |
| W-TAB-CLOSE-CLEANUP | Closing captured tab → OFF | installed-browser | PASS | PASS | PASS |
| W-TAB-CLOSE-AFTER-SW-RESTART | Same, after worker restart | installed-browser | FAIL | PASS | PASS |
| W-FALLBACK-WINDOW | Standalone mini-player window works | installed-browser | FAIL (crash) | PASS | PASS |
| W-FALLBACK-SINGLE | Only one standalone window | installed-browser | FAIL | PASS | PASS |
| W-NO-REMOTE-REQUESTS | No requests beyond the local fixture server (no Tidal API, no telemetry) | installed-browser | — | — | PASS (18 requests, all local) |
| W-NO-PAGE-ERRORS | No uncaught errors during run | installed-browser | PASS | PASS | PASS |
| ~~W-PLAYLIST-ESCAPE / W-PLAYLIST-ADD-HONEST / W-LAB-AUTOSELECT / W-LAB-HONESTY~~ | Playlist/Lab honesty | installed-browser | FAIL | PASS | **RETIRED** (surfaces removed, R-01) |
| U-MANIFEST / U-COMMANDS / U-PERMS / U-SYNTAX / U-FALLBACK | Static integrity, commands wired, permissions unchanged | unit | — | PASS (5/5) | PASS |
| U-NO-NETWORK | No `fetch`/XHR/Tidal API in shipped scripts | unit | — | — | PASS |
| U-RETIRED | Playlists/Lab/favourite markup and commands stay out | unit | — | — | PASS |
| W-TOOLBAR-INVOKE | EQ via a real toolbar click (activeTab grant) | user | NOT RUN | NOT RUN | NOT RUN |
| W-PHYSICS-VISUAL | Side panel looks right in your Chrome (width, animation, Retina) | user-visual | — | — | NOT RUN (1.2.0 is now loaded in your review profile) |
| W-PIP-FLOATING | Document PiP from the in-page floating button | user | NOT RUN | NOT RUN | NOT RUN |
| W-SHORTCUTS | Alt+M / Alt+E in real Chrome | user | NOT RUN | NOT RUN | NOT RUN |
| W-REAL-TIDAL-TRANSPORT | Transport and metadata on real listen.tidal.com | real-tidal | BLOCKED | BLOCKED | **PARTLY PASS (your report, 2026-10-01)**: title and artist correct, play/pause works. Prev/next, seek, skips and volume not yet reported. |
| ~~W-REAL-TIDAL-PLAYLISTS~~ | Lab on real playlists | real-tidal | BLOCKED | BLOCKED | RETIRED |
| W-LISTEN | Sound quality, presets, no pumping or distortion | user-listening | NOT RUN | NOT RUN | **PARTLY**: you reported liking the sound (2026-10-01); extreme-boost check still open |
| W-LIVE-INSTALL | Everyday install untouched | static | PASS | PASS | PASS (old folder byte-identical; profile unreadable, so ID unconfirmed) |

\* Capture was authorised with `--allowlisted-extension-id` in place of the toolbar click. The graph, stop and cleanup behaviour is real.

## Done

- **2026-09-24 takeover**: identity and preservation verified; assessment; build script with fingerprint; isolated harness; 13 fixes (`9b01e83`); v1.1.1; operating README; review build.
- **2026-10-01 round 1**: Playlists, Lab and favourite removed; Physics as a side panel; dead space removed; v1.2.0 (`a92a3c0`). Harness 24/24, unit 7/7. Design mockups for the open questions in `docs/mockups/`.

## Changes from inherited decisions or claims

- The “−0.3 dBFS brickwall” is now actually enforced by a final ceiling stage. The limiter alone overshot.
- Playlist “add/remove current track” was never implemented; the whole Playlists/Lab area has since been removed (R-01).
- The fallback mini-player is the existing undocked popup. `miniplayer.html`/`.js` (truncated, broken) are unused but kept pending your decision.
- The Physics drawer no longer claims “60 FPS real-time physics”; it is labelled as a model of the settings.
- The extension no longer reads Tidal's session token from the page or contacts Tidal.

## Open (design review; see [DESIGN_REVIEW_MAP.md](DESIGN_REVIEW_MAP.md))

R-05 player bar (A/B/C) · R-06 header (1/2/3) · R-07 preset list from your everyday copy · EQ target-tab rules · Pitch vs Speed · PiP keep/drop · fate of `miniplayer.*` and `tidal-bridge.js` · cut-over plan (presets migration).

## Known risks

- Tidal DOM changes can break metadata and transport. Real-Tidal checks are blocked.
- The ceiling softly bends samples above −0.63 dBFS. That only happens with heavy settings. It still needs a listening check at extreme boosts.
- The popup polls the media tab every second while open. That's cheap, but continuous.
- Content scripts run on every http(s) page (existing behaviour; permission scope unchanged).
- Chrome resizes the popup to follow the width transition when the Physics panel opens; if it looks stepped on your Mac, the animation can be dropped.

## Next bounded milestone

Your picks for R-05 and R-06, then implement that slice, verify, sync, and move to batch 3 (EQ section).
