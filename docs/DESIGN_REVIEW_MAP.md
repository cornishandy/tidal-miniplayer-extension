# Design Review Map

The actual surfaces, controls and workflows, with review coverage. Updated as batches are answered. Decisions are recorded in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

Status key: ○ not reviewed · ◐ asked · ● decided · ✔ implemented and verified · ✖ removed

## Surfaces (as of 1.3.4, `075e241`)

| Surface | How you reach it | Regions (top → bottom) | Status |
|---|---|---|---|
| **The screen** (440 × 585) | Click the extension icon (or the Stay-open window) | Art slice (left) · full cover (top right) · title, artist, time · ♥ ⏮ −15 s ▶ +30 s ⏭ · AUDIO EQ switch + badge · presets · physics (live spectrum + response) · sliders with band switches · footer (Stay open, theme dots, Mini bar) | ✔ built per rounds 1–4; **confirmed by you 2026-10-03** |
| Band switches | Tag at the left of each row | Popup: LOW · HPF · MID · HI · AUTO · VOL · SPD text tags. Side panel: icon buttons (R-21, option A) | ✔ R-15, R-21 |
| Physics | On the screen | **Live spectrum** (in vs out, real audio) · response curve (settings) · readout | ✔ R-12 → R-18 ("make it real") |
| **Side panel** (Stay open) | Footer switch, then the toolbar icon; or Alt+M | Same screen docked beside the page in Chrome's side panel; two-line slider rows; stays while you click anything | ✔ R-20; **confirmed by you 2026-10-03** |
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
| J-4 | Save, update, delete and reset presets | ✔ W-PRESET-RESET-SAFE; R-07 list fix pending your export |
| J-5 | A/B one band without losing its value | ✔ R-15 (objective audio check) |
| J-6 | Keep the screen open while browsing; float the mini bar over other apps | ✔ W-STAY-OPEN, W-MINIBAR; confirmed by you 2026-10-03 |
| J-7 | Errors: wrong tab, Chrome page, tab closed, no Tidal, heart not found | ◐ messages inventoried (A-02 in DESIGN_DECISIONS); not reviewed with you |
| J-8 | Reload or update the extension while Tidal is open → the screen still works without a page refresh | ✔ H-02 (1.3.4), W-REINJECT-ORPHAN |

## Batches

1. ~~Purpose and everyday journey~~ → folded into rounds 1–3.
2. ~~Round 1~~, ~~Round 2~~, ~~Round 3 built (1.3.0)~~, ~~rounds 4–6 (1.3.1–1.3.3)~~ → **your all-clear 2026-10-03**.
3. Open items: **year source (R-08)** · **preset list (R-07)** · Alt+M / Alt+E · extreme-boost listening. Closed with your all-clear: side panel, jumps, art, C1 vs C2 (C2 stands), EQ target-tab rules and Pitch/Speed wording (recorded in DESIGN_DECISIONS round 7; say if you want either changed).
4. Status and feedback: messages inventoried (A-02); loading/empty states and what persists still to review with you.
5. Accessibility and typography: keyboard access and focus rings **done** (A-01, 1.3.4); contrast measured (table under A-01); typography not reviewed.
6. Cut-over plan: presets migration from your everyday copy; retiring the old install (needs your explicit decision). **Next after R-07.**

## Next review point

Reload to 1.3.4 and check that your open Tidal tab works without a refresh. Then: the year source, the preset list, and the cut-over.
