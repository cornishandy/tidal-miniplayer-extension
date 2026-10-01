# Design Review Map

The actual surfaces, controls and workflows, with review coverage. Updated as batches are answered. Decisions are recorded in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

Status key: ○ not reviewed · ◐ asked · ● decided · ✔ implemented and verified · ✖ removed

## Surfaces (as of 1.3.0, `dccf108`)

| Surface | How you reach it | Regions (top → bottom) | Status |
|---|---|---|---|
| **The screen** (440 × 585) | Click the extension icon (or the Stay-open window) | Art strip (left) · title, artist, time · ♥ ⏮ −15 s ▶ +30 s ⏭ · AUDIO EQ switch + badge · presets · physics (wave + response) · sliders with band switches · footer (Stay open, theme dots, Mini bar) | ✔ built per rounds 1–3; **your look pending** |
| Band switches | Tag at the left of each row | LOW · HPF · MID · HI · AUTO · VOL · SPD | ✔ R-15 |
| Physics | On the screen | Animated signal model · response curve · readout | ✔ R-12 (P3) |
| Stay-open window | Footer switch, or Alt+M | Same screen in a window Chrome does not auto-close; sizes itself to the content | ✔ R-06 |
| Mini bar | *Mini bar* in the Stay-open window | Always-on-top bar: art, title, ♥, −15 s, play, +30 s, EQ pill, ✕ | ✔ R-10; **your desktop check pending** |
| Keyboard shortcuts | Alt+M, Alt+E | Show/hide the window · toggle EQ | ○ (static only) |
| Themes | Footer dots | Cyan, Amber, Synthwave, Matrix, OLED (drawings follow) | ✔ |
| ~~Header icon row, Micro, Wide, On Top, Undock, Physics side panel, floating button, in-page PiP, Playlists, Lab~~ | — | — | ✖ R-01, R-06, R-13 |

## Workflows

| ID | Workflow | Status |
|---|---|---|
| J-1 | Open Tidal → turn EQ on → pick preset → adjust → close popup (EQ keeps running) | ◐ you confirmed title/▶ on real Tidal (1.2.0); EQ-on on real Tidal not yet reported |
| J-2 | Know which tab is being processed; turn it off; normal audio returns | ✔ badge shows the tab title (W-CAPTURE-START/STOP) |
| J-3 | Control playback from the screen or the mini bar | ✔ fixture; real Tidal pending |
| J-4 | Save, update, delete and reset presets | ✔ W-PRESET-RESET-SAFE; R-07 list fix pending your export |
| J-5 | A/B one band without losing its value | ✔ R-15 (objective audio check) |
| J-6 | Keep the screen open while browsing; float the mini bar over other apps | ✔ W-STAY-OPEN, W-MINIBAR; your desktop check pending |
| J-7 | Errors: wrong tab, Chrome page, tab closed, no Tidal, heart not found | ◐ messages exist; not reviewed with you |

## Batches

1. ~~Purpose and everyday journey~~ → folded into rounds 1–3.
2. ~~Round 1~~, ~~Round 2~~, **Round 3 built** (1.3.0). ← **waiting on your look at the real thing**
3. Open items: C1 vs C2 · year source · heart on real Tidal · preset list (R-07) · EQ target-tab rules · Pitch vs Speed wording.
4. Status and feedback: errors, loading and empty states, what persists.
5. Accessibility and typography: keyboard access, focus rings, contrast.
6. Cut-over plan: presets migration from your everyday copy; retiring the old install (needs your explicit decision).

## Next review point

Load 1.3.0, use it on real Tidal for a while, then tell me what to change. Then the open items above.
