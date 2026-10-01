# Plan and Acceptance Evidence

Living document. Dated history of *why* is in [ASSESSMENT_2026-09-24.md](ASSESSMENT_2026-09-24.md). Decisions are in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

## Evidence levels

`static` code or manifest inspection · `unit` Node tests (`tests/unit`) · `installed-browser` the unpacked build in Chrome for Testing 1208 with a temp profile, network blocked, muted (`tests/browser/run.mjs`) · `objective-audio` AnalyserNode FFT and peak measured inside the offscreen DSP graph on synthetic tones · `user-listening` your ears on real music · `real-tidal` your signed-in Tidal · `user-visual` you looking at the review build.

A mocked or automated check does **not** prove how real music sounds or that real Tidal works. Those rows stay NOT RUN or BLOCKED until you try them.

## Acceptance matrix

Current review build: **v1.3.0**, runtime commit `dccf108`, fingerprint `dfac61d0babdd57c…`, 2026-10-01. Earlier columns are kept where the check still exists; checks for removed surfaces are marked RETIRED.

| ID | Workflow / requirement | Level | 1.2.1 | **1.3.0** |
|---|---|---|---|---|
| W-LOAD | Unpacked build loads; worker starts | installed-browser | PASS | PASS |
| W-POPUP-RENDER | Screen renders; 8 factory presets load | installed-browser | PASS | PASS |
| W-SURFACES-REMOVED | Header icons, tabs, floating button, side panel gone; page script ignores their commands | installed-browser | PASS (tabs) | PASS |
| W-NO-DEAD-SPACE | Rows pack from the top; 440 px wide; under Chrome's 600 px cap | installed-browser | PASS | PASS (585 px) |
| W-TRACK-INFO | Title/artist read from Tidal footer only | installed-browser (fake Tidal DOM) | PASS | PASS |
| W-TRANSPORT-SCOPE | Play/Prev/Next hit footer, never playlist cards | installed-browser (decoy) | PASS | PASS |
| W-HEART | Heart clicks the footer heart and shows its state | installed-browser | — | PASS |
| W-JUMP | +30 s / −15 s jumps | installed-browser | — (was W-SKIP-25) | PASS (+29.7 / −13.7 while playing) |
| W-THEME-DOTS | Theme dots switch and remember the theme | installed-browser | — (was W-THEME-KEEPS-LAYOUT) | PASS |
| W-PRESET-RESET-SAFE | Reset on custom preset keeps all custom presets | installed-browser | PASS | PASS |
| W-NO-LAYOUT-SHIFT | Changing a value does not move the controls | installed-browser | PASS | PASS |
| W-BAND-SWITCH-SYNC | Band tag switches the stage off, keeps the value, persists | installed-browser | — | PASS |
| W-PHYSICS-INLINE | Wave and curve on the main screen, animating | installed-browser | — (was W-PHYSICS-SIDE) | PASS |
| W-CAPTURE-START | EQ attaches; offscreen graph runs | installed-browser* | PASS | PASS |
| W-AUDIO-TRANSPARENT | Flat settings keep input level (peak 0.15) | objective-audio | PASS | PASS |
| W-AUDIO-BASS | Bass +10 dB → +9.3 dB at 60 Hz, 1 kHz unchanged | objective-audio | PASS | PASS |
| W-AUDIO-BAND-SWITCH | LOW off: bass +10 dB has no effect (60 Hz back to flat) | objective-audio | — | PASS |
| W-AUDIO-HPF | HPF 200 Hz → −21 dB at 60 Hz | objective-audio | PASS | PASS |
| W-AUDIO-LIMITER | Worst case never exceeds −0.3 dBFS | objective-audio | PASS (0.965) | PASS (0.965) |
| W-CAPTURE-STOP / W-CAPTURE-RESTART | Stop releases everything; re-attach works | installed-browser | PASS | PASS |
| W-TAB-CLOSE-CLEANUP / W-TAB-CLOSE-AFTER-SW-RESTART | Closing the captured tab → OFF, also after a worker restart | installed-browser | PASS | PASS |
| W-STAY-OPEN | On: icon opens the window, no popup; off: popup restored | installed-browser | — | PASS |
| W-FALLBACK-WINDOW / W-FALLBACK-SINGLE | Stay-open window works; only one instance | installed-browser | PASS | PASS |
| W-MINIBAR | Mini bar opens as Document PiP from the Stay-open page by a real click | installed-browser | — | PASS |
| W-NO-REMOTE-REQUESTS | No requests beyond the local fixture server | installed-browser | PASS | PASS (real Tidal: cover image only) |
| W-NO-PAGE-ERRORS | No uncaught errors during run | installed-browser | PASS | PASS |
| ~~W-PHYSICS-SIDE, W-SKIP-25, W-THEME-KEEPS-LAYOUT, W-PLAYLIST-*, W-LAB-*~~ | Removed surfaces | — | — | RETIRED |
| U-* (8) | Manifest, commands, permissions unchanged, syntax, fallback URL, no network code, retired surfaces and dead files stay out, no emoji | unit | 7/7 | **8/8** |
| W-TOOLBAR-INVOKE | EQ via a real toolbar click (activeTab grant) | user | NOT RUN | NOT RUN |
| W-LOOK-1.3.0 | The new screen, strip, physics and band switches look right in your Chrome | user-visual | — | NOT RUN |
| W-MINIBAR-DESKTOP | Mini bar floats over other apps on your desktop | user | — | NOT RUN |
| W-SHORTCUTS | Alt+M / Alt+E in real Chrome | user | NOT RUN | NOT RUN |
| W-REAL-TIDAL-TRANSPORT | Transport and metadata on real listen.tidal.com | real-tidal | PARTLY (title, ▶) | PARTLY (title, ▶ on 1.2.0); heart, jumps, cover art not yet reported |
| W-LISTEN | Sound quality, presets, no pumping or distortion | user-listening | PARTLY | PARTLY (you liked 1.1.0's sound; 1.2.x+ ceiling not yet judged) |
| W-LIVE-INSTALL | Everyday install untouched | static | PASS | PASS |

\* Capture was authorised with `--allowlisted-extension-id` in place of the toolbar click. The graph, stop and cleanup behaviour is real.

## Done

- **2026-09-24 takeover**: identity and preservation verified; assessment; build script with fingerprint; isolated harness; 13 fixes (`9b01e83`); v1.1.1; operating README; review build.
- **2026-10-01 round 1**: Playlists, Lab and favourite removed; Physics as a side panel; dead space removed; v1.2.0 (`a92a3c0`). Harness 24/24, unit 7/7. Design mockups for the open questions in `docs/mockups/`.
- **2026-10-01 round 2**: layout-shift fix (R-14), v1.2.1 (`44599e5`). Harness 25/25, unit 7/7. Round-2 mockups (`docs/mockups/round2.html`).\n- **2026-10-01 round 3**: the new main screen, v1.3.0 (`dccf108`): legible size, no header, art strip, jumps, heart, per-band switches, physics on screen, Stay open, mini bar; dead files removed. Harness 29/29, unit 8/8.

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
