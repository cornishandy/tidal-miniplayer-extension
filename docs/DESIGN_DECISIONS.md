# Design Decisions

Your decisions, with implementation and verification status. Suggestions from the assistant are marked as such. Sensitive feedback is summarised, not quoted.

## Inherited decisions (settled before the 2026-09-24 takeover; source: FINAL_HANDOFF.md §1)

| # | Surface | Decision | Implemented | Verified |
|---|---|---|---|---|
| D-01 | EQ rows | Values and units never wrap onto two lines | Yes (CSS) | static; visual check at 360 px pending |
| D-02 | EQ values | Double-click snaps to neutral (0 dB, 1.00x, 100 %, 20 Hz); double-click again restores | Yes (popup, PiP) | static |
| D-03 | Favorite | Clean inline SVG heart: solid white when favorited, outline when not | **Superseded by R-04** (favorite removed) | — |
| D-04 | Transport | Prominent −25 % / +25 % skip; subtle ⏮ ⏭ step buttons; ticks at 0/25/50/75/100 % | Popup: yes. **Under review (R-05)** | W-SKIP-25 PASS |
| D-05 | Layout | Resizing widens tracks and content, not gaps (`space-between` removed) | Yes | static |
| D-06 | EQ rows | − / + nudges (±0.5 dB, ±5 Hz, ±5 %, ±0.05x); Shift-click = 5× finer | Popup: yes. PiP: no | static |
| D-07 | Tooltips | Plain technical English, no glyph artifacts | Yes | static |
| D-08 | Transport | Commands scoped to Tidal's footer / playback-controls only | Yes | W-TRANSPORT-SCOPE PASS |

## Takeover stabilization (2026-09-24): assistant decisions within your authorization, no product-direction change

| # | Decision | Rationale | Status |
|---|---|---|---|
| S-01 | “Reset” on a custom preset reverts to its saved values instead of wiping all custom presets | Data-loss bug | Implemented `9b01e83`; W-PRESET-RESET-SAFE PASS |
| S-02 | Lab and Playlists never invent tracks/BPM/Key or report fake success; demo data is labelled | Honesty | Implemented; later removed with the surfaces (R-01) |
| S-03 | Standalone window = existing undocked popup (the broken `miniplayer.html` is unused) | Fallback crashed | Implemented; W-FALLBACK-WINDOW PASS |
| S-04 | Final −0.3 dBFS output ceiling after the limiter | Makes the stated safety limit true | Implemented; W-AUDIO-LIMITER PASS; **you reported liking the sound (2026-10-01)**, extreme-boost listening check still open |

## Decisions from the design review

### Review round 1 (2026-10-01): “minimalise; emphasise the important parts”

Your direction, summarised: you love the sound; the UI should be minimal and legible, with the EQ as the point of it. Chat batch 1 questions (Q1.1–Q1.4) were overtaken by this feedback and are folded into R-05/R-06 below.

| # | Surface | Your decision / question | Outcome | Rationale | Affects | Status |
|---|---|---|---|---|---|---|
| R-01 | Popup tabs | Remove **Playlists** and **Playlist Lab** | **Chosen: removed** (UI, page-script commands and the Tidal API code). Last build with them: tag `v1.1.1-before-ui-removals`. | Unused; cluttered the popup. Side effect: the extension now makes **no network requests at all**. | PLAYLISTS tab, PLAYLIST LAB tab, `content.js` Tidal session reader | Implemented in 1.2.0; W-SURFACES-REMOVED, U-NO-NETWORK, U-RETIRED PASS |
| R-02 | Physics | Physics visual slides out **beside** the player, not over it; both visible at once | **Chosen: side panel** (300 px, docks to the right; the popup widens to 660 px; Chrome's limit is 800). Open/closed state is remembered. Canvas colours follow the popup theme (the drawer's own theme pills are gone). Per-stage ℹ️ buttons folded into one Guide. Subtitle now says it is a model of the settings, not a live meter. | Your request; honesty about what the animation is. | Physics drawer → side panel; standalone window resizes to fit | Implemented in 1.2.0; W-PHYSICS-SIDE PASS; **your visual check pending** |
| R-03 | EQ layout | Remove the empty space above and below the sliders | **Chosen**: the popup is now only as tall as its content (336 px instead of 540 px); rows pack from the top. The standalone window sizes itself to the content too. | Dead space came from a fixed 540 px height sized for the Lab tab. | Popup, standalone window | Implemented; W-NO-DEAD-SPACE PASS (0 px slack, 5 px above, 8 px below) |
| R-04 | Player bar | Remove the ♥ favourite button (“it doesn't work”) | **Chosen: removed** from popup, Micro and PiP. Supersedes D-03. | Not reliable on Tidal; one fewer control. | Player bar, Micro, PiP, `content.js` favourite scraping | Implemented; W-TRANSPORT-SCOPE now proves the page's favourite is never clicked |
| R-05 | Player bar | “Song section is useless; re-imagine it: minimal, important parts stand out, legible” | **Open: options A/B/C** in [mockups/](mockups/) (`pa.png`, `pb.png`, `pc.png`). Assistant recommends **A** (one strip: big EQ switch + big title/artist + play/pause, hairline progress; drops seek bar, −25 %/+25 %, volume). | A makes the EQ switch the dominant control and shows what is being processed (covers Q1.3). | Player bar, status bar, Micro | Awaiting your pick. **You confirmed (2026-10-01, 1.2.0 on real Tidal): title/artist correct and play/pause works.** |
| R-08 | Player bar | Add a **vertical cover-art strip on the left** to every option, and show the **year of original release** | **Mockups updated** (all six): 56 px strip below the header, square cover at the top, the same art blurred as a spine down the side; popup widens to 416 px so the sliders keep their length. Year shown after the artist. | Your request. | Player bar, popup width, metadata source | Strip: ready to build on your pick. **Year: needs a data-source decision** (see REVIEW_READY): Tidal's player bar carries no year; the choices are Tidal's own album data (edition year, needs a request with your Tidal session), MusicBrainz first-release year (sends title+artist to musicbrainz.org), or no year. |
| R-06 | Header | “Top icons confusing and cluttered; too many attach/detach/minimise” | **Open: options 1/2/3** in [mockups/](mockups/) (`h1.png`, `h2.png`, `h3.png`). Assistant recommends **1** (words: Physics · Window · ⋯ menu for Theme / Floating button / Compact bar). 📌 On Top removed in every option: it only ever opened the same window as 🗗 (Document PiP cannot be opened from the popup). | Fewer, named actions; one detached form (the window), the always-on-top PiP kept as an option behind the floating button. | Header, Micro, Wide, Undock, On Top, Theme | Awaiting your pick |
| R-07 | Presets | “Presets changed; some old defaults moved into My Custom Presets; tell me before any preset change” | **Rule adopted (CLAUDE.md)**: no factory preset is added, renamed, re-tuned, reordered or removed, and no stored presets are migrated, without your explicit OK, shown as a before/after list. **Cause (assistant finding)**: an earlier version shipped *Deep Bass Head* and *Vocal Focus* as defaults (old README); later versions replaced them. Your copy kept the old ones, and the popup files anything not in the current factory list under “My Custom Presets”. If a default was re-tuned, your copy also kept its older values. | Presets are yours. | Factory list, `onInstalled` merge, cut-over migration | Rule in force. Fix needs your actual list (see REVIEW_READY “What I need from you”). No preset data was changed in 1.2.0. |

Also removed with R-01/R-04, assistant decision, reversible: the dead PLAYLISTS tab in the PiP window, and the Tidal session reader (`getTidalSession`), which read tokens from Tidal's localStorage. Nothing reads Tidal credentials any more.
