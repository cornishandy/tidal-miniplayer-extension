# Design Review Map

The actual surfaces, controls and workflows, with review coverage. Updated as batches are answered. Decisions are recorded in [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md).

Status key: ○ not reviewed · ◐ asked · ● decided · ✔ implemented and verified

## Surfaces

| Surface | How you reach it | Regions (top → bottom) | Status |
|---|---|---|---|
| **Toolbar popup** (360×540; Wide 490) | Click the extension icon | Header icon row · player bar (art, title, seek + ticks, ♥ ⏮ −25% ▶ +25% ⏭, volume) · status bar (AUDIO EQ switch + badge, Floating Button switch) · tabs (DJ BASS / PLAYLISTS / PLAYLIST LAB) | ○ |
| DJ BASS tab | Popup, first tab | Presets row (badge Saved/Modified, Update, Save As New, ✕, Reset) · Bass · HPF · Mid · High · Auto-Balancing · Master Volume · Pitch/Speed (each: label, −, slider, +, value) | ○ |
| PLAYLISTS tab | Popup | Notice · list of playlists with checkbox (add/remove **not built**, says so) | ○ |
| PLAYLIST LAB tab | Popup | Notice · A/B/C pickers · operation pills · counts · sortable table · new name + Create | ○ |
| Physics drawer | Header 🔬 | Animated signal path (illustrative, not a live meter) · stage ON/BYPASS buttons · response curve · guide | ○ |
| Micro mode | Header ▫️ | One row: art, title, ♥ ⏮ ▶ ⏭, EQ pill, ↗ expand | ○ |
| Standalone window | Header 🗗 Undock, 📌 On Top, or Alt+M | Same as popup; resizable; Dock closes it | ○ |
| In-page floating button | “Floating Button” switch (default off) | Draggable “🎧 Mini-Player” pill on every http(s) page | ○ |
| Document PiP window | Click the floating button (needs an in-page click) | Reduced popup copy: no skips, nudges, volume or Lab; emoji heart | ○ |
| Keyboard shortcuts | Alt+M, Alt+E | Show/hide standalone window · toggle EQ | ○ |
| Themes | Header 🎨 | Cyan, Amber, Synthwave, Matrix, OLED | ○ |

## Workflows

| ID | Workflow | Status |
|---|---|---|
| J-1 | Open Tidal → turn EQ on → pick preset → adjust → close popup (EQ keeps running) | ○ |
| J-2 | Know which tab is being processed; turn it off; normal audio returns | ○ |
| J-3 | Control playback from popup / Micro / window / PiP | ○ |
| J-4 | Save, update, delete and reset presets | ○ |
| J-5 | A/B a DSP stage in the Physics drawer | ○ |
| J-6 | Lab: “in A+ but not Super A+” → create playlist | ○ |
| J-7 | Errors: wrong tab, Chrome page, tab closed, no Tidal | ○ |

## Batches (small, in order)

1. **Purpose and everyday journey**: main use, which tab EQ attaches to, how you know it's on. ← **current**
2. Popup player bar: title truncation, volume, transport density, what 📌 should do.
3. DJ BASS tab: blank band, main vs advanced controls, Pitch vs Speed, preset buttons, reset/undo, units.
4. Status and feedback: badge/icon state, errors, loading and empty states, what persists.
5. Header icon row and secondary surfaces: labels vs icons, Micro, Wide, Undock, themes, Physics drawer purpose.
6. PiP window and floating button: parity with the popup (heart, skips), when the button appears.
7. Playlists and Lab: build real add/remove? Lab layout at 360 px; create confirmation.
8. Accessibility and typography: keyboard access to double-click reset, focus rings, contrast, font sizes.
9. Housekeeping: `miniplayer.*` and `tidal-bridge.js` (unused), shortcuts.

## Open questions (batch 1, asked 2026-09-24)

- Q1.1 Main everyday use and priority order.
- Q1.2 Which tab EQ should attach to, given Chrome only allows the tab you opened the extension on.
- Q1.3 Showing the processed tab's name in the status bar.
- Q1.4 A toolbar-icon badge while EQ is on.

## Next review point

Batch 1 answers → implement the agreed slice → then Batch 2 (popup player bar), starting from the screenshot `tests/results/review-v1.1.1/popup-default.png` or your own review profile.
