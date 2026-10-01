# Design Review Map

The actual surfaces, controls and workflows, with review coverage. Updated as batches are answered. Decisions are recorded in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

Status key: ○ not reviewed · ◐ asked · ● decided · ✔ implemented and verified · ✖ removed

## Surfaces (as of 1.2.0)

| Surface | How you reach it | Regions (top → bottom) | Status |
|---|---|---|---|
| **Toolbar popup** (360 × ~336; Wide 490; +300 with Physics open) | Click the extension icon | Header icon row · player bar (art, title, seek + ticks, ⏮ −25% ▶ +25% ⏭, volume) · status bar (AUDIO EQ switch + badge, Floating Button switch) · presets · sliders | ◐ player bar and header have options out (R-05, R-06) |
| EQ section | Popup | Presets row (badge Saved/Modified, Update, Save As New, ✕, Reset) · Bass · HPF · Mid · High · Auto-Balancing · Master Volume · Pitch/Speed (each: label, −, slider, +, value) | ✔ dead space removed (R-03); content not yet reviewed |
| ~~PLAYLISTS tab~~ | — | — | ✖ R-01 |
| ~~PLAYLIST LAB tab~~ | — | — | ✖ R-01 |
| **Physics side panel** | Header 🔬 | Signal pipeline (animated model) · stage ON/BYPASS buttons · response curve · readout · Guide | ✔ R-02; your visual check pending |
| Micro mode | Header ▫️ | One row: art, title, ⏮ ▶ ⏭, EQ pill, ↗ expand | ◐ fate depends on R-06 |
| Standalone window | Header 🗗 Undock, 📌 On Top, or Alt+M | Same as popup; sizes itself to the content; Dock closes it | ◐ R-06 |
| In-page floating button | “Floating Button” switch (default off) | Draggable “🎧 Mini-Player” pill on every http(s) page | ◐ R-06 |
| Document PiP window | Click the floating button (needs an in-page click) | Reduced popup copy: no skips, nudges, volume; Physics as an overlay drawer | ○ |
| Keyboard shortcuts | Alt+M, Alt+E | Show/hide standalone window · toggle EQ | ○ |
| Themes | Header 🎨 | Cyan, Amber, Synthwave, Matrix, OLED (Physics canvases follow) | ◐ R-06 |
| ~~♥ favourite~~ | — | — | ✖ R-04 |

## Workflows

| ID | Workflow | Status |
|---|---|---|
| J-1 | Open Tidal → turn EQ on → pick preset → adjust → close popup (EQ keeps running) | ○ |
| J-2 | Know which tab is being processed; turn it off; normal audio returns | ◐ (R-05 option A shows the track in the EQ strip) |
| J-3 | Control playback from popup / Micro / window / PiP | ◐ (R-05 decides which controls remain) |
| J-4 | Save, update, delete and reset presets | ◐ (R-07 rule; list fix pending your export) |
| J-5 | A/B a DSP stage in the Physics panel while watching the sliders | ✔ possible now (side panel) |
| ~~J-6~~ | ~~Lab: “in A+ but not Super A+” → create playlist~~ | ✖ |
| J-7 | Errors: wrong tab, Chrome page, tab closed, no Tidal | ○ |

## Batches

1. ~~Purpose and everyday journey~~ → overtaken by your round-1 feedback (2026-10-01); Q1.1–Q1.4 folded into R-05/R-06.
2. **Round 1 (current)**: R-05 player bar options, R-06 header options, R-07 presets. ← **waiting on you**
3. EQ section: main vs advanced controls, Pitch vs Speed, preset buttons, reset/undo, units, bigger type.
4. Status and feedback: badge/icon state, errors, loading and empty states, what persists.
5. PiP window and floating button: keep or drop; parity with the popup.
6. Accessibility and typography: keyboard access to double-click reset, focus rings, contrast, font sizes.
7. Housekeeping: `miniplayer.*` and `tidal-bridge.js` (unused), shortcuts; cut-over plan (presets migration).

## Open questions (round 1, asked 2026-10-01)

- R-05 Player bar: A / B / C (mockups `pa.png`, `pb.png`, `pc.png`). Does the title and ▶ work on real Tidal today?
- R-06 Header: 1 / 2 / 3 (mockups `h1.png`, `h2.png`, `h3.png`).
- R-07 Presets: send the preset list from your everyday copy (one console line, see REVIEW_READY), or name the defaults you want.

## Next review point

Your picks for R-05/R-06 → implement → verify → sync → batch 3 (EQ section), starting from `tests/results/review-v1.2.0/popup-default.png` or your review profile.
