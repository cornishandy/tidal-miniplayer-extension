# Design Decisions

Your decisions, with implementation and verification status. Suggestions from the assistant are marked as such. Sensitive feedback is summarised, not quoted.

## Inherited decisions (settled before the 2026-09-24 takeover; source: FINAL_HANDOFF.md §1)

| # | Surface | Decision | Implemented | Verified |
|---|---|---|---|---|
| D-01 | EQ rows | Values and units never wrap onto two lines | Yes (CSS) | static; visual check at 360 px pending |
| D-02 | EQ values | Double-click snaps to neutral (0 dB, 1.00x, 100 %, 20 Hz); double-click again restores | Yes (popup, PiP) | static |
| D-03 | Favorite | Clean inline SVG heart: solid white when favorited, outline when not | Popup: yes. **PiP window still uses emoji** | installed-browser (popup) |
| D-04 | Transport | Prominent −25 % / +25 % skip; subtle ⏮ ⏭ step buttons; ticks at 0/25/50/75/100 % | Popup: yes. PiP window has no skips or ticks | W-SKIP-25 PASS |
| D-05 | Layout | Resizing widens tracks and content, not gaps (`space-between` removed) | Yes | static |
| D-06 | EQ rows | − / + nudges (±0.5 dB, ±5 Hz, ±5 %, ±0.05x); Shift-click = 5× finer | Popup: yes. PiP: no | static |
| D-07 | Tooltips | Plain technical English, no glyph artifacts | Yes | static |
| D-08 | Transport | Commands scoped to Tidal's footer / playback-controls only | Yes | W-TRANSPORT-SCOPE PASS |

## Takeover stabilization (2026-09-24): assistant decisions within your authorization, no product-direction change

| # | Decision | Rationale | Status |
|---|---|---|---|
| S-01 | “Reset” on a custom preset reverts to its saved values instead of wiping all custom presets | Data-loss bug | Implemented `9b01e83`; W-PRESET-RESET-SAFE PASS |
| S-02 | Lab and Playlists never invent tracks/BPM/Key or report fake success; demo data is labelled | Honesty | Implemented; W-LAB-HONESTY PASS |
| S-03 | Standalone window = existing undocked popup (the broken `miniplayer.html` is unused) | Fallback crashed | Implemented; W-FALLBACK-WINDOW PASS |
| S-04 | Final −0.3 dBFS output ceiling after the limiter | Makes the stated safety limit true | Implemented; W-AUDIO-LIMITER PASS; **listening check pending** |

## Decisions from the design review

*(None yet. Each entry: date · surface · question · your answer · chosen / rejected / deferred · rationale · affected functionality · implementation and verification status · commit/build · superseded decision.)*
