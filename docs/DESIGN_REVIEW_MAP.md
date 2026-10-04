# Design Review Map

The actual surfaces, controls and workflows, with review coverage. Updated as batches are answered. Decisions are recorded in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

Status key: ○ not reviewed · ◐ asked · ● decided · ✔ implemented and verified · ✖ removed

## Surfaces (as of 1.5.1)

| Surface | How you reach it | Regions (top → bottom) | Status |
|---|---|---|---|
| **The screen** (440 × 592) | Click the extension icon (or the Stay-open window) | Art slice (left) · full cover (top right) · title, artist, time · ♥ ⏮ −15 s ▶ +30 s ⏭ · AUDIO EQ switch + badge · presets · physics (live spectrum + response) · ten rows in signal order (PITCH, HPF, LOW, MID, HI, AUTO, MATCH, VOL, LIM, CEIL) with band switches, mode menus and live bars · footer (Stay open, theme dots, Mini bar) | ✔ built per rounds 1–4; **confirmed by you 2026-10-03**; rows reordered and four dynamics rows in 1.5.0 (D-03): **your look pending** |
| Band switches | Tag at the left of each row | Popup and side panel: PITCH · HPF · LOW · MID · HI · AUTO · MATCH · VOL text tags (LIM and CEIL are labels: always on). The side panel's icon buttons of round 6 were replaced by the same words on your request (R-21 revised, 1.5.1) | ✔ R-15, R-21 revised; MATCH added 1.5.0 |
| Dynamics switches and bars | The AUTO, MATCH, LIM and CEIL rows | Leveler menu (Full band · Slow release · Bass only) · MATCH tag · Limiter menu (Fast · Look-ahead) · Ceiling menu (Clean · Warm); a live 0 to 12 dB bar and figure on each of the four rows; defaults = the 1.4.0 sound | ✔ D-01, D-02 (objective checks W-DYN-*); **your listening pending** |
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
| J-4 | Save, update, delete and reset presets | ✔ W-PRESET-RESET-SAFE; R-07: the stray old entries stay behind in the cut-over (the new copy starts with the factory list); presets you saved yourself are re-saved by you |
| J-5 | A/B one band without losing its value | ✔ R-15 (objective audio check) |
| J-6 | Keep the screen open while browsing; float the mini bar over other apps | ✔ W-STAY-OPEN, W-MINIBAR; confirmed by you 2026-10-03 |
| J-7 | Errors: wrong tab, Chrome page, tab closed, no Tidal, heart not found | ◐ messages inventoried (A-02 in DESIGN_DECISIONS); not reviewed with you |
| J-8 | Reload or update the extension while Tidal is open → the screen still works without a page refresh | ✔ H-02 (1.3.4), W-REINJECT-ORPHAN |
| J-9 | Shift the key of a track (Pitch) without changing its speed | ✔ W-PITCH (objective, 1.4.0); **your listening pending** (P-01) |
| J-10 | Hear when the leveler, limiter or ceiling is working (the bars), and switch to an alternative stage without losing the original sound | ✔ W-DYN-* (objective, 1.5.0), W-DYN-METERS-UI; **your listening pending** (D-01) |

## Batches

1. ~~Purpose and everyday journey~~ → folded into rounds 1–3.
2. ~~Round 1~~, ~~Round 2~~, ~~Round 3 built (1.3.0)~~, ~~rounds 4–6 (1.3.1–1.3.3)~~ → **your all-clear 2026-10-03**.
3. Open items: **the switches on real music (D-01)** · **Pitch as a key shift (P-01, built; your listening)** · the new rows (D-03) and the diagram (D-04) · Alt+M / Alt+E. Closed: the EQ's target tab (C-01, keep), transport row (C2 kept), year source (R-08, no year), preset list (R-07, overtaken by the cut-over), heavy-preset listening (S-04: both heard; answered by the 1.5.0 switches), side panel, jumps, art.
4. Status and feedback: messages inventoried (A-02); loading/empty states and what persists still to review with you.
5. Accessibility and typography: keyboard access and focus rings **done** (A-01, 1.3.4); contrast measured (table under A-01); typography not reviewed.
6. Cut-over: **done 2026-10-03 (R-24)**. `build/review-unpacked` is the everyday extension; the 1.1.0 folder is archived as a zip beside its old place and removed.

## Next review point

Reload to 1.5.0, watch the four bars on a loud track, then try the switches one at a time (LISTENING_CHECK.md, "How to compare"). Then: Pitch on a track, the new row order and the "Leveler" label, the diagram, Alt+M / Alt+E, and the cover top right in the narrow panel.
