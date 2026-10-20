# Design Review Map

The actual surfaces, controls and workflows, with review coverage. Updated as batches are answered. Decisions are recorded in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

Status key: ○ not reviewed · ◐ asked · ● decided · ✔ implemented and verified · ✖ removed

## Surfaces (as of 1.5.6)

| Surface | How you reach it | Regions (top → bottom) | Status |
|---|---|---|---|
| **The screen** (440 × 592) | Click the extension icon (or the Stay-open window) | Art slice (left) · full cover (top right) · title, artist, time · ♥ ⏮ −15 s ▶ +30 s ⏭ · AUDIO EQ switch + badge · MOVIE button · presets · physics (live spectrum + response) · ten rows in signal order (PITCH, HPF, LOW, MID, HI, AUTO, MATCH, VOL, LIM, CEIL) with band switches, mode menus and live bars · footer (Stay open, theme dots, Mini bar) | ✔ built per rounds 1–4; **confirmed by you 2026-10-03**; rows reordered and four dynamics rows in 1.5.0 (D-03): **your look pending**; MOVIE button in 1.5.5 (L-01) + 16 px Movie status line & Pitch lock in 1.5.6 (L-02): **your look and a film pending** |
| Band switches | Tag at the left of each row | Popup and side panel: PITCH · HPF · LOW · MID · HI · AUTO · MATCH · VOL text tags (LIM and CEIL are labels: always on). The side panel's icon buttons of round 6 were replaced by the same words on your request (R-21 revised, 1.5.1) | ✔ R-15, R-21 revised; MATCH added 1.5.0 |
| Dynamics switches and bars | The AUTO, MATCH, LIM and CEIL rows | Leveler menu (Full band · Slow release · Bass only) · MATCH tag · Limiter menu (Fast · Look-ahead) · Ceiling menu (Clean · Warm); a live bar (full at 12 dB; the figure keeps counting above it, 1.5.8) and figure on each of the four rows; defaults = the 1.4.0 sound | ✔ D-01, D-02 (objective checks W-DYN-*); **your listening pending** |
| EQ ranges | The LOW, MID and HI rows (popup, side panel, window; Movie Sound follows) | Bass 0 to +56 dB, Mid and High −24 to +24 dB, 0.5 dB steps (1.5.9; were +28 and ±12); same filters and defaults; Movie Sound 1.1.2 accepts the same ends | ✔ E-03, W-EQ-RANGE-UI, W-AUDIO-EXTREME, W-DYN-BASELINE unchanged; Movie Sound follow-chrome boundary test; **your listening pending** |
| Live band cuts | The LOW, MID and HI rows (popup, side panel, window) | Red tick at slider value minus measured cut, clamped to its range; red `cut N dB` under the name, with the specified explanation on hover; normal captions return when hidden, with no added row height | R-29 (1.5.10); unit `eq-cuts` and silent W-EQ-CUT cover response math, audible points, smoothing, hiding, layout and five-theme contrast |
| Skip-button feedback | +30, −15 and Next in the popup and side panel | Confirm movement; explain held, start, refused, missing-helper, unreachable and failed-Next states in the existing hint; nothing on success and no added height | R-30 (1.5.12); unit `seek-feedback` includes Sol’s B1/B2/S1 regressions (playing short seek, same-title Next, repeated hint timer); silent W-JUMP-FEEDBACK adds playing short seeks and same-title/artist Next on both surfaces; 1.5.12 covers whole-second refused jumps, site-neutral hints, missing-tab/reload advice, Previous holds and immediate jumps after same-title Next on both surfaces; earlier W-JUMP route checks unchanged |
| Preset stepping | Buttons beside the preset dropdown (popup and side panel) | Previous / Next follow the dropdown order, wrap both ends and share its confirmed apply path; disabled during preset operations, with no added height | R-31 (1.5.12); unit `preset-switches` and silent W-PRESET-STEP cover order, wrap, unknown-name Previous/Next endpoints, locks, storage / engine / UI, saved switches and popup / panel layout |
| Preset switches | The preset header (popup, side panel, window) | A preset saved or updated from 1.5.8 stores Leveler, MATCH, Limiter and Ceiling; picking it or Reset brings them back. The label says "EQ + switches". Older presets and the factory ones leave the switches alone (label "EQ only") until Update | ✔ R-28, unit `preset-switches`, W-PRESET-SWITCHES; **your listening pending** |
| Physics | On the screen | **Live spectrum** (in vs out, real audio) · response curve (settings) · readout | ✔ R-12 → R-18 ("make it real") |
| **Side panel** (Stay open) | Footer switch, then the toolbar icon; or Alt+M | Same screen docked beside the page; no art slice; under 400 px the player stacks (56 px cover top right, two-line title, full-width transport), from 400 px up the normal layout; two-line slider rows with the same word tags as the popup; follows the drag live; Chrome's floor is 360 px | ✔ R-20 confirmed by you 2026-10-03; R-23 stacked layout accepted by you ("ok"), **cover moved top right on your note: your look pending** |
| Standalone window | Fallback only (Chrome without a side panel) | Same screen in a window | ✔ R-06 (fallback) |
| Mini bar | *Mini bar* in the side panel (or the window) | Always-on-top bar: art, title, ♥, −15 s, play, +30 s, EQ pill, ✕ | ✔ R-10; **confirmed by you 2026-10-03** |
| Keyboard shortcuts | Alt+M, Alt+E | Open the panel · toggle EQ (on the playing tab) | ○ static only; **your check asked 2026-10-03** |
| Keyboard access | Tab / arrows / Space / Enter | Focus ring on every control, names for sliders and the EQ switch, on/off states for band buttons and theme dots | ✔ A-01 (1.3.4), W-KEYBOARD |
| Themes | Footer dots | Cyan, Amber, Synthwave, Matrix, OLED (drawings follow) | ✔ |
| ~~Header icon row, Micro, Wide, On Top, Undock, Physics side panel, floating button, in-page PiP, Playlists, Lab~~ | — | — | ✖ R-01, R-06, R-13 |

## Workflows

| ID | Workflow | Status |
|---|---|---|
| J-1 | Open Tidal → turn EQ on → pick preset → adjust → close popup (EQ keeps running) | ✔ your all-clear 2026-10-03 (1.3.3) |
| J-2 | Know which tab is being processed; turn it off; normal audio returns | ✔ badge shows the tab title (W-CAPTURE-START/STOP) |
| J-3 | Control playback from the screen or the mini bar | ✔ fixture; real Tidal confirmed by you 2026-10-03 (heart, jumps, time) |
| J-4 | Save, update, delete and reset presets | ✔ W-PRESET-RESET-SAFE; R-07: the stray old entries stay behind in the cut-over (the new copy starts with the factory list); presets you saved yourself are re-saved by you. R-28: Save and Update also store the four switches; a preset without them, and every factory preset, leaves the switches alone (W-PRESET-SWITCHES) |
| J-5 | A/B one band without losing its value | ✔ R-15 (objective audio check) |
| J-6 | Keep the screen open while browsing; float the mini bar over other apps | ✔ W-STAY-OPEN, W-MINIBAR; confirmed by you 2026-10-03 |
| J-7 | Errors: wrong tab, Chrome page, tab closed, no Tidal, heart not found | ◐ messages inventoried (A-02 in DESIGN_DECISIONS); not reviewed with you |
| J-8 | Reload or update the extension while Tidal is open → the screen still works without a page refresh | ✔ H-02 (1.3.4), W-REINJECT-ORPHAN |
| J-9 | Shift the key of a track (Pitch) without changing its speed | ✔ W-PITCH (objective, 1.4.0); **your listening pending** (P-01) |
| J-10 | Hear when the leveler, limiter or ceiling is working (the bars), and switch to an alternative stage without losing the original sound | ✔ W-DYN-* (objective, 1.5.0), W-DYN-METERS-UI; **your listening pending** (D-01) |
| J-12 | Movie Sound follows this EQ live: the Movie Sound page (127.0.0.1:8791) gets the saved preset, sliders and dynamics as they change (1.5.7, M-01) | ✔ unit `movie-sound-link`, browser `movie-sound-link.mjs`; **your film with Movie Sound pending** |
| J-11 | Movie mode: a video on the captured tab shortens the buffer by itself (MOVIE · AUTO) and locks Pitch off (~140 ms granular window) while preserving saved preset pitch; a 16 px status line explains the buffer/Pitch state and alerts on locked Pitch interactions without shifting layout; a click forces Movie mode on or off; Shift-click returns to automatic | ✔ W-MOVIE-MODE, W-MOVIE-PITCH-LOCK, W-MOVIE-CONTRAST (1.5.5–1.5.6); **your ears on a film pending** (L-01, L-02) |

## Batches

1. ~~Purpose and everyday journey~~ → folded into rounds 1–3.
2. ~~Round 1~~, ~~Round 2~~, ~~Round 3 built (1.3.0)~~, ~~rounds 4–6 (1.3.1–1.3.3)~~ → **your all-clear 2026-10-03**.
3. Open items: **the switches on real music (D-01)** · **Pitch as a key shift (P-01, built; your listening)** · the new rows (D-03) and the diagram (D-04) · Alt+M / Alt+E. Closed: the EQ's target tab (C-01, keep), transport row (C2 kept), year source (R-08, no year), preset list (R-07, overtaken by the cut-over), heavy-preset listening (S-04: both heard; answered by the 1.5.0 switches), side panel, jumps, art.
4. Status and feedback: messages inventoried (A-02); loading/empty states and what persists still to review with you.
5. Accessibility and typography: keyboard access and focus rings **done** (A-01, 1.3.4); contrast measured (table under A-01); typography not reviewed.
6. Cut-over: **done 2026-10-03 (R-24)**. `build/review-unpacked` is the everyday extension; the 1.1.0 folder is archived as a zip beside its old place and removed.

## Next review point

Reload to 1.5.0, watch the four bars on a loud track, then try the switches one at a time (LISTENING_CHECK.md, "How to compare"). Then: Pitch on a track, the new row order and the "Leveler" label, the diagram, Alt+M / Alt+E, and the cover top right in the narrow panel.

## Open items, parked 2026-10-10 while the click report is investigated

Kept at your request ("keep all the open items available"). Each has its question batch. J-01, E-01, L-01 and L-02 are built; the rest below are not.

| Item | Raised | What is waiting | Mockup |
|---|---|---|---|
| Signal facts readout (rates, channels, delay, levels, Tidal's badge) | 2026-10-04 | Where to show it (recommended: two lines in the popup's live strip, the full table on a click on PHYSICS, a permanent card in the side panel); what the two lines carry; Tidal's badge yes/no; LUFS yes/no | `docs/mockups/r12-signal-a2.png`, `r12-signal-b3.png`, `r12-signal-c2.png` |
| Defaults for the mode menus and MATCH | 2026-10-04 | Keep them engine-wide for now (recommended) or put them in presets; a one-click reset of the four modes plus a hint that they are engine-wide (recommended); Master Volume at 100 % in every factory preset: leave (recommended) or propose per-preset values (R-07, before/after first) | none |
| MATCH bar with zero in the middle | 2026-10-04 | Build it (recommended); scale 12 dB each side (recommended) or 6; whether the bars read too much like sliders | `docs/mockups/r13-match-bipolar-2.png` |
| Listening and layout questions from 1.5.0 | 2026-10-04 | The switches on real music; Pitch on a track; Pitch row at the top or the bottom; the "Leveler" label; whether the diagram makes the point; Alt+M / Alt+E; the 56 px cover in the narrow panel | `docs/diagrams/leveler-explained-2026-10-04.png` |
| Mini bar from the toolbar (M-01) | 2026-10-11 | Whether the second click, in the side panel, floats the bar; then one click anywhere in the panel (recommended) or a helper window | — |
| The side panel's empty bottom (R-26) and the artist gauge (R-27) | 2026-10-11 | A (cover on top), B (album and artist cards at the bottom) or C (both); the gauge's lanes; the data source (R-08 reopened: MusicBrainz as an opt-in, recommended) | `docs/mockups/r14-a-cover-top.png`, `r14-b-album-artist.png`, `r14-c-both.png`, `r14-today.png` |
| Low-delay switch & Pitch lock for video (L-01 in 1.5.5, L-02 in 1.5.6) | 2026-10-11 | Your check: play a video with the EQ on and Pitch at 0. The MOVIE button should read MOVIE · AUTO and the sound should sit closer to the picture. Click it to force the large buffer (MOVIE · OFF) or the short one (MOVIE · ON). Shift-click returns to automatic. Music with no video should stay on the large buffer (MOVIE) | — |
| Jumps on a narrow Tidal page; +30 s near the end goes to the next track (J-01, J-02, built in 1.5.3) | 2026-10-11 | Your check on real Tidal: +30 with the panel wide, and +30 in the last 30 s | — |
| EQ after a restart or a tab reload: one icon click turns it on (E-01, built in 1.5.4) | 2026-10-11 | Your check: after a Chrome restart, turn AUDIO EQ on in the panel; if refused, click OK, then the icon once; the switch should flip to on within a second and the panel stay open | — |
