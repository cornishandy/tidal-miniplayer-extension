# Plan and Acceptance Evidence

Living document. Dated history of *why* is in [ASSESSMENT_2026-09-24.md](ASSESSMENT_2026-09-24.md). Decisions are in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

## Evidence levels

`static` code or manifest inspection · `unit` Node tests (`tests/unit`) · `installed-browser` the unpacked build in Chrome for Testing 1208 with a temp profile, network blocked, muted (`tests/browser/run.mjs`) · `objective-audio` AnalyserNode FFT and peak measured inside the offscreen DSP graph on synthetic tones · `user-listening` your ears on real music · `real-tidal` your signed-in Tidal · `user-visual` you looking at the review build.

A mocked or automated check does **not** prove how real music sounds or that real Tidal works. Those rows stay NOT RUN or BLOCKED until you try them.

## Acceptance matrix

Current review build: **v1.5.5**, runtime commit `e1f8be48c0df03a7a7bb3956cdf8f663ae1d18e9` (`e1f8be4`), fingerprint `90f0d65b3aa40e3c8e242cb2c60fcb2d891df9382b34b8222701b3e2f0258680`, `sourceDirty: false`, 2026-10-18. Evidence: `tests/results/review-v1.5.5/results.json` (61/61 on `build/review-unpacked`, silent and host-isolated) and unit 37/37. Earlier review builds: 1.5.4 `cab3906` / `0c852570af9e8f8b…`, 1.5.2 `7317469`, 1.5.1 `f0a5adc` / `c6004b1723af49e5…`, 1.5.0 `553e23b`, 1.4.0 `4b4975a`, 1.3.6 `ea7832f`, 1.3.5 `41ab5ca`, 1.3.4 `075e241`, 1.3.3 `f018f0c`, 1.3.2 `18bc5d1`, 1.3.1 `ca30d42`, 1.3.0 `dccf108`. Earlier results stand where a check is unchanged. Earlier columns are kept where the check still exists; checks for removed surfaces are marked RETIRED.

| ID | Workflow / requirement | Level | 1.2.1 | **1.3.x / 1.4.0 / 1.5.x (latest 1.5.5)** |
|---|---|---|---|---|
| W-LOAD | Unpacked build loads; worker starts | installed-browser | PASS | PASS |
| W-POPUP-RENDER | Screen renders; 8 factory presets load | installed-browser | PASS | PASS |
| W-SURFACES-REMOVED | Header icons, tabs, floating button, side panel gone; page script ignores their commands | installed-browser | PASS (tabs) | PASS |
| W-NO-DEAD-SPACE | Rows pack from the top; 440 px wide; under Chrome's 600 px cap. 1.5.5: all four MOVIE labels (MOVIE, MOVIE · AUTO, MOVIE · ON, MOVIE · OFF), with a long badge title, stay on one line at 300, 360, 400, 440 and 480 px (no wrap, no overlap, no clipping, status-bar height unchanged). At 440 px the popup stays under 600 px in every label | installed-browser | PASS | PASS (592 px with ten rows, 1.5.0; 585 px in 1.4.0; 1.5.5: 592 px, MOVIE on one line in all four labels) |
| W-TRACK-INFO | Title/artist read from Tidal footer only | installed-browser (fake Tidal DOM) | PASS | PASS |
| W-ART-HIRES | Cover requested at 1280 px; steps down to 640 when missing | installed-browser | — | PASS |
| W-TRANSPORT-SCOPE | Play/Prev/Next hit footer, never playlist cards | installed-browser (decoy) | PASS | PASS |
| W-HEART | Heart clicks the footer heart and shows its state | installed-browser | — | PASS |
| W-JUMP | +30 s / −15 s jumps through the footer seek bar (media element out of reach, as on Tidal) | installed-browser | — (was W-SKIP-25) | PASS (+29.2 / −14.0 while playing) |
| W-EQ-AFTER-ICON | 1.5.4: an EQ switch-on refused in the side panel for lack of Chrome's permission names the icon click, and that click on the same tab turns the EQ on (a click on another tab does nothing) | installed-browser (refusal simulated) | — | PASS |
| W-JUMP-NARROW | 1.5.3: with the seek bar and time labels gone (a narrow Tidal page) and the player element out of reach, +30 s / −15 s go through Tidal's own seek handler via the page helper, and the time still shows | installed-browser (fixture served as https://tidal.com from this machine) | — | PASS (+30.3 / −12.6; 2 handler seeks, 0 seek-bar events) |
| W-JUMP-NARROW-ELEMENT | 1.5.3: the same with no media-session handler and the player in a closed shadow root: +30 s moves the element that played | installed-browser | — | PASS (+30.3) |
| W-JUMP-END | 1.5.3: +30 s with less than 30 s left presses Next once, with no seek; a quick second click neither skips the new track nor moves it (J-02) | installed-browser | — | PASS |
| W-JUMP-END-QUEUE-END | 1.5.3: at the end of the queue (Next disabled, a next-track handler present) +30 s near the end plays the track out | installed-browser | — | PASS |
| W-JUMP-END-NO-NEXT | 1.5.3: with no Next button and no handler, +30 s near the end plays the track out; paused, it goes to the very end | installed-browser | — | PASS (ended at 60 s, both) |
| W-NEXT-THEN-JUMP | 1.5.3: Next on the screen and +30 straight after: one new track, not skipped and not moved | installed-browser | — | PASS |
| W-JUMP-NOOP-HANDLER | 1.5.3: a Tidal seek handler that does nothing hands over to the player element | installed-browser | — | PASS (+30.2) |
| W-JUMP-END-NOOP-NEXT | 1.5.3: no Next button and a next-track handler that does nothing: after 3 s the track still ends | installed-browser | — | PASS |
| W-JUMP-DEADBAR | 1.5.3: a seek bar that is there but does nothing hands over to Tidal's seek handler after the check | installed-browser | — | PASS (+29.7) |
| W-JUMP-USER-WINS | 1.5.3: playback moved in Tidal itself during the check stays where it was put (no fallback seek) | installed-browser | — | PASS |
| W-BRIDGE-PAUSE-TIME | 1.5.3: time from Tidal's position report alone stops while paused and goes on from there | installed-browser | — | PASS (21.0, 21.0, 22.0 s) |
| W-BRIDGE-SCOPE | 1.5.3: outside Tidal the page helper is absent (play() and the media session untouched) | installed-browser | — | PASS |
| W-NO-REMOTE-REQUESTS-LATE | 1.5.3: no request left the two exact local fixture origins during the whole run | installed-browser | — | PASS |
| W-THEME-DOTS | Theme dots switch and remember the theme | installed-browser | — (was W-THEME-KEEPS-LAYOUT) | PASS |
| W-PRESET-RESET-SAFE | Reset on custom preset keeps all custom presets | installed-browser | PASS | PASS |
| W-NO-LAYOUT-SHIFT | Changing a value does not move the controls | installed-browser | PASS | PASS |
| W-BAND-SWITCH-SYNC | Band tag switches the stage off, keeps the value, persists | installed-browser | — | PASS |
| W-PHYSICS-INLINE | Live strip and curve on the main screen; still while the EQ is off | installed-browser | — (was W-PHYSICS-SIDE) | PASS |
| W-LIVE-SPECTRUM | The live strip is real: input shows the tone peaks; output shows the +10 dB bass lift at 60 Hz only | objective-audio | — | PASS (+10.0 dB at 60 Hz, +0.2 at 1 kHz) |
| W-CAPTURE-START | EQ attaches; offscreen graph runs | installed-browser* | PASS | PASS |
| W-AUDIO-TRANSPARENT | Flat settings keep the input level: peak 0.15; 1 kHz and 8 kHz within 0.3 dB of the untouched source; 60 Hz within +1.0 / −0.3 dB (the 20 Hz high-pass sits +0.5 dB there, Web Audio reads a high-pass Q in dB, and the limiter adds +0.17 dB of static makeup; both part of the sound since 1.0, frozen with it) | objective-audio | PASS | PASS (1.5.1: +0.7 dB at 60 Hz, +0.2 at 1 kHz and 8 kHz) |
| W-AUDIO-BASS | Bass +10 dB → +9.3 dB at 60 Hz, 1 kHz unchanged | objective-audio | PASS | PASS |
| W-AUDIO-BAND-SWITCH | LOW off: bass +10 dB has no effect (60 Hz back to flat) | objective-audio | — | PASS |
| W-AUDIO-HPF | HPF 200 Hz → −21 dB at 60 Hz | objective-audio | PASS | PASS |
| W-AUDIO-LIMITER | Worst case never exceeds −0.3 dBFS | objective-audio | PASS (0.965) | PASS (0.965) |
| W-PITCH | Pitch is a key shift (P-01): +12 st moves the 1 kHz tone to 2 kHz and −12 st to 500 Hz at the final output at the same level; the page's playback rate stays 1; 0 st and the PITCH tag route around the shifter; the tag text fits | objective-audio | — | PASS (1.4.0: 2 kHz −39.9 dB vs 1 kHz −39.9 flat; 1 kHz −131.7 when shifted) |
| W-DYN-BASELINE | The default modes reproduce the sound of 1.4.0: six settings (flat, bass +10, worst case, AUTO on flat, AUTO on bass +14 at 150 %, AUTO on bass +8 / HPF 25 / high +1) within 0.3 dB at 60 Hz, 1 kHz and 8 kHz and 0.004 in peak. Provenance: FFT-bin constants measured on 1.4.0 at 48 kHz, reproduced by 1.5.0 with no difference; then re-derived at 48 kHz with the exact-frequency reading, which does not depend on the output device's rate (A-03, H-03). Sample peaks do depend on the rate: the 96 kHz peaks were measured on 1.5.1 (H-04) | objective-audio | — | **PASS (1.5.0 and 1.5.1: no difference; 1.5.2 at 96 kHz: levels identical, peaks within 0.001)** |
| W-DYN-LEVELER-BASS | Leveler → Bass only: with bass +14 dB, 60 Hz down 2 dB or more while 1 kHz and 8 kHz stay within 0.5 dB of AUTO off; Full band moves 1 kHz too; routing and meter agree | objective-audio | — | PASS (60 Hz −3.5 dB, 1 kHz and 8 kHz 0.0 dB; Full band +2.2 dB at 1 kHz; meter 3.6 dB) |
| W-CLICK-PATH | The device buffer is the large one (`latencyHint: 'playback'`, at least 10 ms; 21.3 ms at 96 kHz) and the pitch shifter is parked while no shift is set (not primed, target exactly 0, its path closed) (K-01, 1.5.2) | installed-browser | — | **1.5.2: PASS; 1.5.5 audio capture: PASS (21.3 ms)** |
| W-MOVIE-MODE | 1.5.5: audio capture stays on the large buffer; with every extension screen closed, hiding the video switches to playback and showing it switches back to interactive (automatic), including after a worker restart; an unrelated video tab is ignored; MOVIE · ON and MOVIE · OFF survive reopening and a worker restart; the button forces either way and keeps the stream, the EQ and the dynamics; Shift-click returns to automatic; stopping clears the choice | installed-browser | — | **PASS (1.5.5: playback base 21.3 ms, interactive base 2.7 ms, at 96 kHz)** |
| W-MOVIE-CONTRAST | 1.5.5: MOVIE button text is at least 4.5:1 on all five themes, in off, on and manual-off | installed-browser | — | **PASS (1.5.5: lowest 12.18:1, amber, off)** |
| W-PITCH-RECOVER | After a jump from −12 to +12 st the shifter may run dry; within 3 s the shifted path is open again and the tone is at 2 kHz; back at 0 st the shifter parks (value exactly 0) (K-01) | objective-audio | — | **1.5.2: PASS** |
| S-CLICK-STALL | Diagnostic, not part of the regular run (tests/browser/glitch-check.mjs `--burst-ms`, scratch builds with tests/fixtures/stress.worklet.js): the audio thread stalled for 3 to 24 ms about 11 times a second. 1.5.1: dropouts from 4 ms (0.4/s), 5 ms (4.4/s), 6 to 24 ms (12 to 23/s). Candidate 1.5.2: none up to 24 ms. Run 2026-10-10 at 96 kHz on the real output device (the DAC's clock; playoutStats counts dropouts only there), before the harness was made silent; it cannot be repeated silently, so the table is kept in [docs/evidence/stall-series-2026-10-10.md](evidence/stall-series-2026-10-10.md) | installed-browser | — | **1.5.2: PASS** |
| W-DYN-LEVELER-SLOW | Leveler → Slow release: release 0.6 s, same steady level as Full band within 0.3 dB, the output held lower for longer after the boosts are removed; Full band restores 0.2 s | objective-audio | — | PASS (deficit 0.144 vs 0.001; minimum 3.4 % below the settled level) |
| W-DYN-MATCH | MATCH on: with bass +14 dB the K-weighted level (ITU-R BS.1770) is within 1 dB of the untouched tab where it was 3 dB or more louder without it; the trim is reported; off restores the level | objective-audio | — | PASS (untouched −33.75, without MATCH −28.59, with MATCH −34.09 dB; trim −5.5 dB) |
| W-DYN-LIMITER-LOOKAHEAD | Limiter → Look-ahead: worst case never above 0.93 at the output, the ceiling bends nothing while the limiter meter shows work; Fast restores the 1.4.0 peak | objective-audio | — | PASS (peak 0.930; ceiling 0; distortion products −90 / −137 / −132 dB vs −67 / −96 / −80 with Fast) |
| W-DYN-CEILING-WARM | Ceiling → Warm: never above 0.966 at the worst case, within 0.15 dB of Clean at the quiet level, 6 dB or more of added colour at the worst case; the ceiling meter reports the bend; Clean restores the 1.4.0 output | objective-audio | — | PASS (peak 0.759; +13.1 dB at 180 Hz; quiet level identical) |
| W-DYN-METERS-UI | The screen's bars: with AUTO on at the worst case the leveler, limiter and ceiling bars show work and MATCH reads 0.0 dB while off; the Leveler menu and the MATCH tag persist, reach the engine and survive a reopen; meters read idle after stop | installed-browser | — | PASS (−1.1 / −2.2 / −0.9 dB shown; stored, applied, reopened) |
| S-DYN-LISTEN | The switches on real music: Bass only stops the voice and hats dipping; Slow release breathes less; MATCH keeps loudness put; Look-ahead and Warm at high Master | user-listening | — | NOT RUN (your ears) |
| S-PITCH-LISTEN | Pitch on real music: key moves, speed does not; warble and doubling acceptable within the range you use | user-listening | — | NOT RUN (your ears) |
| W-CAPTURE-STOP / W-CAPTURE-RESTART | Stop releases everything; re-attach works | installed-browser | PASS | PASS |
| W-TAB-CLOSE-CLEANUP / W-TAB-CLOSE-AFTER-SW-RESTART | Closing the captured tab → OFF, also after a worker restart | installed-browser | PASS | PASS |
| W-STAY-OPEN | Real click: the screen hands over to Chrome's side panel and the icon opens it; off restores the popup | installed-browser | — | PASS |
| W-SIDE-PANEL-OPEN | The side-panel document opened from the click | installed-browser | — | PASS |
| W-PANEL-LAYOUT | Panel adapts live: stacked player at 300 and 360 px (no art slice, 56 px cover top right, full-width transport, wrapping title), normal layout at 400, 440 and 480 px with the 76 px cover top right; cover right of the title and flush with the player's edge in both; no overflow; sliders ≥ 130/150/150/250 px; the dynamics rows' menus and bars fit; the band tags are the popup's words, all ten fit and toggle with a strike-through (R-21 revised); 1.5.5: all four MOVIE labels, with a long badge title, stay on one line at 300, 360, 400, 440 and 480 px (no wrap, no overlap, no clipping, status-bar height unchanged); no errors; screenshots | installed-browser | — | PASS (1.5.1; 1.5.5 adds 440 px and the MOVIE button) |
| W-FALLBACK-WINDOW / W-FALLBACK-SINGLE | Stay-open window works; only one instance | installed-browser | PASS | PASS |
| W-KEYBOARD | Tab reaches the sliders, buttons and switches with a visible ring (measured in pixels); arrows move a slider and save it; Space/Enter press buttons and band switches; every control has a name | installed-browser | — | **PASS** (1.3.4; FAIL on 1.3.3: no rings, six unnamed sliders) |
| W-REINJECT-ORPHAN | A tab whose page script is not listening (orphaned by an update or a Reload) gets it re-injected by the worker; the screen shows its track | installed-browser | — | **PASS** (1.3.4; FAIL on 1.3.3: "Connecting…", no re-injection) |
| W-MINIBAR | Mini bar opens as Document PiP from the Stay-open page by a real click | installed-browser | — | PASS |
| W-NO-REMOTE-REQUESTS | No requests beyond the local fixture server | installed-browser | PASS | PASS (real Tidal: cover image only) |
| W-NO-PAGE-ERRORS | No uncaught errors during run | installed-browser | PASS | PASS |
| ~~W-PHYSICS-SIDE, W-SKIP-25, W-THEME-KEEPS-LAYOUT, W-PLAYLIST-*, W-LAB-*~~ | Removed surfaces | — | — | RETIRED |
| U-* (37) | Manifest, commands, permissions unchanged, syntax, fallback URL, no network code, retired surfaces and dead files stay out, no emoji, injected files exist, names and states present (menus and meters too), focus never hidden, pitch worklet ships and no speed path remains, dynamics worklet ships with the 1.4.0 stage values and defaults frozen and the rows in chain order; 1.5.2: large buffer and gated pitch path, look-ahead limiter cannot hang after 2^31 samples and its output is bit-identical to 1.5.1, the parked shifter is silent and restarts cleanly, and its shifted output is bit-identical to 1.5.1; 1.5.3: the page helper runs on Tidal pages only (exact names), in the top frame, before the page, and reads no login, storage or cookies; every test browser keeps its isolation and silence flags; 1.5.5: movie mode (`tests/unit/movie-mode.test.mjs`, 19): playback and interactive constructors, a rebuild that keeps the stream, a stop during startup, a missing engine acknowledgement, a manual choice that wins over a queued automatic switch, wake recovery with the screen closed, video detection, a queued start that does not run after Stop, a pitch change kept across the dynamics worklet load, Stop during the startup storage writes, Stop during wake recovery, a wake save still in flight cannot overwrite Stop, and an ancestor or open-shadow hint | unit | 7/7 | **37/37 (1.5.5)** |
| W-STAY-OPEN-MAC | Stay open on your Mac | user | — | 1.3.0/1.3.1 window: failed for you (window went behind the page). 1.3.3 side panel: **PASS (your report, 2026-10-03)** |
| W-TOOLBAR-INVOKE | EQ via a real toolbar click (activeTab grant) | user | NOT RUN | covered by your report of 2026-10-03 ("everything working"), not itemised |
| W-LOOK-1.3.0 | The new screen, strip, physics and band switches look right in your Chrome | user-visual | — | **PASS (your report, 2026-10-03)** |
| W-MINIBAR-DESKTOP | Mini bar floats over other apps on your desktop | user | — | **PASS (your report, 2026-10-03)** |
| W-SHORTCUTS | Alt+M / Alt+E in real Chrome | user | NOT RUN | NOT RUN (asked 2026-10-03) |
| W-REAL-TIDAL-TRANSPORT | Transport and metadata on real listen.tidal.com | real-tidal | PARTLY (title, ▶) | **PASS (your report, 2026-10-03: heart, jumps, time, cover art)** |
| W-LISTEN | Sound quality, presets, no pumping or distortion | user-listening | PARTLY | PARTLY (2026-10-04: you heard both "more bass" and "squashed"; the 1.5.0 switches are the answer, S-DYN-LISTEN) |
| W-LIVE-INSTALL | Everyday install untouched | static | PASS | PASS |

\* Capture was authorised with `--allowlisted-extension-id` in place of the toolbar click. The graph, stop and cleanup behaviour is real.

## Done

- **2026-10-18 Movie mode**: 1.5.5 (`e1f8be48c0df03a7a7bb3956cdf8f663ae1d18e9`, fingerprint `90f0d65b3aa40e3c8e242cb2c60fcb2d891df9382b34b8222701b3e2f0258680`): a video tab uses the short buffer by itself; the MOVIE button in the AUDIO EQ bar forces either way; Shift-click returns to automatic (L-01). Music with no video keeps the 1.5.2 buffer. Harness 61/61 on the exact review folder (`tests/results/review-v1.5.5/results.json`, silent and host-isolated), unit 37/37.
- **2026-10-10 click report**: 1.5.2 (`7317469`): 21 ms device buffer, pitch stage at rest at 0 st, 6-hour freeze fixed (K-01); drift and the media-element route ruled out (K-02, K-03); silent harness. Harness 45/45, unit 16/16; stall series in docs/evidence.
- **2026-10-04 round 12**: 1.5.1 (`f0a5adc`): the side panel's band tags are the popup's words again (R-21 revised, your request); the harness reads levels at exact frequencies so the Mac's output device rate no longer matters (H-03). Harness 43/43 on the exact review folder, unit 13/13.
- **2026-10-04 round 11**: 1.5.0 (`553e23b`): the alternatives as switches (Leveler Full band / Slow release / Bass only, MATCH, Limiter Fast / Look-ahead, Ceiling Clean / Warm; D-01), live bars on the four dynamics rows (D-02), rows in signal order with LIM and CEIL added (D-03), the leveler diagram (D-04), the audio-processing freeze rule (A-03) with its baseline check; the EQ's target tab kept (C-01). Harness 43/43 on the exact review folder, unit 13/13.
- **2026-10-03 round 10**: 1.4.0 (`4b4975a`): Pitch is a key shift in semitones (P-01), the speed control is gone; the 1.1.0 folder archived and removed (R-24 done); transport row kept (C-01); the EQ's target tab clarified; the listening check explained (LISTENING_CHECK.md). Harness 36/36 on the exact review folder, unit 12/12.
- **2026-10-03 round 9**: 1.3.6 (`ea7832f`): the stacked panel keeps the cover top right at 56 px (R-23 revised on your look). Your batch of answers: no year (R-08 closed), cut-over decided (R-24: `build/review-unpacked` becomes the everyday extension, steps on your side), MIT licence, repository description, account name out of the current docs (R-25). Harness 35/35 on the exact review folder, unit 11/11.
- **2026-09-24 takeover**: identity and preservation verified; assessment; build script with fingerprint; isolated harness; 13 fixes (`9b01e83`); v1.1.1; operating README; review build.
- **2026-10-01 round 1**: Playlists, Lab and favourite removed; Physics as a side panel; dead space removed; v1.2.0 (`a92a3c0`). Harness 24/24, unit 7/7. Design mockups for the open questions in `docs/mockups/`.
- **2026-10-03 round 8**: 1.3.5 (`41ab5ca`): the side panel stacks its player under 400 px and returns to the normal layout above; no art slice in the panel (R-23). Chrome's own floor is 360 px. Harness 35/35, unit 11/11.
- **2026-10-03 round 7**: your all-clear on 1.3.3. 1.3.4 (`075e241`): page script re-injected after a Reload/update (H-02), keyboard focus rings and accessible names (A-01). Harness 35/35, unit 11/11; both new checks fail on 1.3.3.
- **2026-10-01 round 6**: 1.3.3 (`f018f0c`): side-panel band buttons are icons (R-21, option A). Harness 33/33, unit 8/8.
- **2026-10-01 round 2**: layout-shift fix (R-14), v1.2.1 (`44599e5`). Harness 25/25, unit 7/7. Round-2 mockups (`docs/mockups/round2.html`).
- **2026-10-01 round 5**: 1.3.2 (`18bc5d1`): Stay open = Chrome side panel (sidePanel permission, R-20), full-resolution cover art. Harness 33/33, unit 8/8.
- **2026-10-01 round 4**: 1.3.1 (`ca30d42`): live before/after spectrum ("make it real"), cover-art centre slice + full cover, jumps via the page's seek bar. Harness 30/30, unit 8/8.
- **2026-10-01 round 3**: the new main screen, v1.3.0 (`dccf108`): legible size, no header, art strip, jumps, heart, per-band switches, physics on screen, Stay open, mini bar; dead files removed. Harness 29/29, unit 8/8.

## Changes from inherited decisions or claims

- The “−0.3 dBFS brickwall” is now actually enforced by a final ceiling stage. The limiter alone overshot.
- Playlist “add/remove current track” was never implemented; the whole Playlists/Lab area has since been removed (R-01).
- The fallback mini-player is the existing undocked popup. `miniplayer.html`/`.js` (truncated, broken) are unused but kept pending your decision.
- The Physics drawer no longer claims “60 FPS real-time physics”; it is labelled as a model of the settings.
- The extension no longer reads Tidal's session token from the page or contacts Tidal.

## Open (design review; see [DESIGN_REVIEW_MAP.md](DESIGN_REVIEW_MAP.md))

Your listening to the switches (D-01, S-DYN-LISTEN) and to the pitch shift (P-01) · your look at the new rows (D-03), the diagram (D-04) and the 56 px cover (R-23) · Alt+M / Alt+E on your Mac. Closed: the EQ's target tab (C-01 kept, 2026-10-04), transport row (C2 kept), R-08 (no year), R-07 list (gone with the cut-over), R-24 (cut-over done), R-06, PiP (mini bar kept), dead files (gone).

## Known risks

- Tidal DOM changes can break metadata and transport. Real-Tidal checks are blocked.
- The ceiling softly bends samples above −0.63 dBFS. That only happens with heavy settings. It still needs a listening check at extreme boosts (what to listen for: [LISTENING_CHECK.md](LISTENING_CHECK.md)).
- The 1.5.0 alternatives are objectively right on tones and routed around by default; on music they need your ears (S-DYN-LISTEN). MATCH follows the music over a few seconds, so a section change can be heard as a slow level settle. Look-ahead adds 5 ms of delay while selected. The audio processing is frozen otherwise (A-03): W-DYN-BASELINE must stay green.
- The pitch shifter (WSOLA) is objectively right on tones; on music it will warble slightly on long notes and can double drum hits at large shifts, and it adds about 0.14 s of delay while a shift is set. Needs your listening (S-PITCH-LISTEN).
- 1.5.2: up to about 50 ms more delay, about 35 to 60 ms in all by Chrome's figures (the larger device buffer; corrected 2026-10-11 from "about 30 ms"); a video tab's sound lags its picture by that much more. Switching Pitch on now plays about 0.15 s unshifted first. A jump across the whole Pitch range at once can still run the shifter dry for a moment (a click; it was so in 1.4.0 too); fixing that changes how Pitch glides and waits for your OK.
- 1.5.5: while a video is showing, the device buffer is the short one (2.7 ms base at 96 kHz in `tests/results/review-v1.5.5/results.json`). That is the buffer that clicked on a busy Mac before 1.5.2, so it is used only for video, or when Movie mode is forced on. Music with no video stays on the large buffer (21.3 ms base in the same run). Pitch still adds its own delay while a shift is set.
- 1.5.3: the page helper (`page-bridge.js`) wraps three of Tidal's browser calls inside Tidal's page (passed through unchanged, visible to Tidal's scripts); if Tidal starts showing a captcha or misbehaves, it is the first suspect. Tidal tabs opened before 1.5.3 was installed need one reload for the narrow-page jumps.
- The popup polls the media tab every second while open. That's cheap, but continuous.
- Content scripts run on every http(s) page (existing behaviour; permission scope unchanged).

## Next bounded milestone

Your ears on a film with Movie mode (L-01: MOVIE · AUTO, then a click each way and a Shift-click back); "Islands" again on 1.5.2 (your click report); your listening to the switches and to the pitch shift; then whatever that turns up (per-preset modes, a true-peak ceiling, or tuning of a mode you like are the candidates; none without your OK).
