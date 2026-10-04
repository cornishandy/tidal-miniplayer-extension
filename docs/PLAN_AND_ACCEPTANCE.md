# Plan and Acceptance Evidence

Living document. Dated history of *why* is in [ASSESSMENT_2026-09-24.md](ASSESSMENT_2026-09-24.md). Decisions are in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

## Evidence levels

`static` code or manifest inspection · `unit` Node tests (`tests/unit`) · `installed-browser` the unpacked build in Chrome for Testing 1208 with a temp profile, network blocked, muted (`tests/browser/run.mjs`) · `objective-audio` AnalyserNode FFT and peak measured inside the offscreen DSP graph on synthetic tones · `user-listening` your ears on real music · `real-tidal` your signed-in Tidal · `user-visual` you looking at the review build.

A mocked or automated check does **not** prove how real music sounds or that real Tidal works. Those rows stay NOT RUN or BLOCKED until you try them.

## Acceptance matrix

Current review build: **v1.5.0**, runtime commit `553e23b`, fingerprint `8a8b8962edc509b0…`, 2026-10-04 (1.4.0 was `4b4975a`, 1.3.6 `ea7832f`, 1.3.5 `41ab5ca`, 1.3.4 `075e241`, 1.3.3 `f018f0c`, 1.3.2 `18bc5d1`, 1.3.1 `ca30d42`, 1.3.0 `dccf108`; earlier results stand where a check is unchanged). Earlier columns are kept where the check still exists; checks for removed surfaces are marked RETIRED.

| ID | Workflow / requirement | Level | 1.2.1 | **1.3.x / 1.4.0 / 1.5.0 (latest 1.5.0)** |
|---|---|---|---|---|
| W-LOAD | Unpacked build loads; worker starts | installed-browser | PASS | PASS |
| W-POPUP-RENDER | Screen renders; 8 factory presets load | installed-browser | PASS | PASS |
| W-SURFACES-REMOVED | Header icons, tabs, floating button, side panel gone; page script ignores their commands | installed-browser | PASS (tabs) | PASS |
| W-NO-DEAD-SPACE | Rows pack from the top; 440 px wide; under Chrome's 600 px cap | installed-browser | PASS | PASS (592 px with ten rows, 1.5.0; 585 px in 1.4.0) |
| W-TRACK-INFO | Title/artist read from Tidal footer only | installed-browser (fake Tidal DOM) | PASS | PASS |
| W-ART-HIRES | Cover requested at 1280 px; steps down to 640 when missing | installed-browser | — | PASS |
| W-TRANSPORT-SCOPE | Play/Prev/Next hit footer, never playlist cards | installed-browser (decoy) | PASS | PASS |
| W-HEART | Heart clicks the footer heart and shows its state | installed-browser | — | PASS |
| W-JUMP | +30 s / −15 s jumps through the footer seek bar (media element out of reach, as on Tidal) | installed-browser | — (was W-SKIP-25) | PASS (+29.2 / −14.0 while playing) |
| W-THEME-DOTS | Theme dots switch and remember the theme | installed-browser | — (was W-THEME-KEEPS-LAYOUT) | PASS |
| W-PRESET-RESET-SAFE | Reset on custom preset keeps all custom presets | installed-browser | PASS | PASS |
| W-NO-LAYOUT-SHIFT | Changing a value does not move the controls | installed-browser | PASS | PASS |
| W-BAND-SWITCH-SYNC | Band tag switches the stage off, keeps the value, persists | installed-browser | — | PASS |
| W-PHYSICS-INLINE | Live strip and curve on the main screen; still while the EQ is off | installed-browser | — (was W-PHYSICS-SIDE) | PASS |
| W-LIVE-SPECTRUM | The live strip is real: input shows the tone peaks; output shows the +10 dB bass lift at 60 Hz only | objective-audio | — | PASS (+10.0 dB at 60 Hz, +0.2 at 1 kHz) |
| W-CAPTURE-START | EQ attaches; offscreen graph runs | installed-browser* | PASS | PASS |
| W-AUDIO-TRANSPARENT | Flat settings keep input level (peak 0.15) | objective-audio | PASS | PASS |
| W-AUDIO-BASS | Bass +10 dB → +9.3 dB at 60 Hz, 1 kHz unchanged | objective-audio | PASS | PASS |
| W-AUDIO-BAND-SWITCH | LOW off: bass +10 dB has no effect (60 Hz back to flat) | objective-audio | — | PASS |
| W-AUDIO-HPF | HPF 200 Hz → −21 dB at 60 Hz | objective-audio | PASS | PASS |
| W-AUDIO-LIMITER | Worst case never exceeds −0.3 dBFS | objective-audio | PASS (0.965) | PASS (0.965) |
| W-PITCH | Pitch is a key shift (P-01): +12 st moves the 1 kHz tone to 2 kHz and −12 st to 500 Hz at the final output at the same level; the page's playback rate stays 1; 0 st and the PITCH tag route around the shifter; the tag text fits | objective-audio | — | PASS (1.4.0: 2 kHz −39.9 dB vs 1 kHz −39.9 flat; 1 kHz −131.7 when shifted) |
| W-DYN-BASELINE | The default modes reproduce the sound of 1.4.0: six settings (flat, bass +10, worst case, AUTO on flat, AUTO on bass +14 at 150 %, AUTO on bass +8 / HPF 25 / high +1) within 0.3 dB at 60 Hz, 1 kHz and 8 kHz and 0.004 in peak; the constants were measured on 1.4.0 with this harness (A-03) | objective-audio | — | **PASS (1.5.0: no difference)** |
| W-DYN-LEVELER-BASS | Leveler → Bass only: with bass +14 dB, 60 Hz down 2 dB or more while 1 kHz and 8 kHz stay within 0.5 dB of AUTO off; Full band moves 1 kHz too; routing and meter agree | objective-audio | — | PASS (60 Hz −3.5 dB, 1 kHz and 8 kHz 0.0 dB; Full band +2.2 dB at 1 kHz; meter 3.6 dB) |
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
| W-PANEL-LAYOUT | Panel adapts live: stacked player at 300 and 360 px (no art slice, 56 px cover top right, full-width transport, wrapping title), normal layout at 400 and 480 px with the 76 px cover top right; cover right of the title and flush with the player's edge in both; no overflow; sliders ≥ 130/150/150/250 px; icon band buttons toggle; no errors; screenshots | installed-browser | — | PASS (1.3.6) |
| W-FALLBACK-WINDOW / W-FALLBACK-SINGLE | Stay-open window works; only one instance | installed-browser | PASS | PASS |
| W-KEYBOARD | Tab reaches the sliders, buttons and switches with a visible ring (measured in pixels); arrows move a slider and save it; Space/Enter press buttons and band switches; every control has a name | installed-browser | — | **PASS** (1.3.4; FAIL on 1.3.3: no rings, six unnamed sliders) |
| W-REINJECT-ORPHAN | A tab whose page script is not listening (orphaned by an update or a Reload) gets it re-injected by the worker; the screen shows its track | installed-browser | — | **PASS** (1.3.4; FAIL on 1.3.3: "Connecting…", no re-injection) |
| W-MINIBAR | Mini bar opens as Document PiP from the Stay-open page by a real click | installed-browser | — | PASS |
| W-NO-REMOTE-REQUESTS | No requests beyond the local fixture server | installed-browser | PASS | PASS (real Tidal: cover image only) |
| W-NO-PAGE-ERRORS | No uncaught errors during run | installed-browser | PASS | PASS |
| ~~W-PHYSICS-SIDE, W-SKIP-25, W-THEME-KEEPS-LAYOUT, W-PLAYLIST-*, W-LAB-*~~ | Removed surfaces | — | — | RETIRED |
| U-* (13) | Manifest, commands, permissions unchanged, syntax, fallback URL, no network code, retired surfaces and dead files stay out, no emoji, injected files exist, names and states present (menus and meters too), focus never hidden, pitch worklet ships and no speed path remains, dynamics worklet ships with the 1.4.0 stage values and defaults frozen and the rows in chain order | unit | 7/7 | **13/13** |
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
- The popup polls the media tab every second while open. That's cheap, but continuous.
- Content scripts run on every http(s) page (existing behaviour; permission scope unchanged).

## Next bounded milestone

Your listening to the switches and to the pitch shift; then whatever that turns up (per-preset modes, a true-peak ceiling, or tuning of a mode you like are the candidates; none without your OK).
