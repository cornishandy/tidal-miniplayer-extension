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

### Review round 2 (2026-10-01, after you loaded 1.2.0): your picks and new requests

Mockups for this round: [mockups/round2.html](mockups/round2.html) (`r2-*.png`). They use a proposed "legible" size, not the shipped CSS.

| # | Surface | Your decision / request | Outcome | Status |
|---|---|---|---|---|
| R-05 (decided) | Player bar | Option **C** chosen; add **back 15 s / forward 30 s** buttons | Mocked as **C2** (transport on its own row: ♥ · prev · −15 s · play · +30 s · next; recommended) and **C1** (inline on the title line, no prev/next). Transport glyphs drawn as line icons, no emoji. | Awaiting C1 / C2 |
| R-04 (reversed) | Favourite | Bring the ♥ back **if it can be made to work on Tidal** | Needs Tidal's heart-button HTML from your page (footer) to target it reliably. Will say "couldn't find Tidal's heart" rather than pretend. | Awaiting your HTML snippet |
| R-06 (decided) | Header | **Remove all the top icons.** Keep only: an option to stop the popup auto-closing, and the theme choice | Chrome always closes a toolbar popup when it loses focus; nothing can prevent that. The only form that stays is a window. Design: **no header**; a footer row with a **Stay open** switch (on = the toolbar icon opens a window that stays until you close it; off = normal popup), **theme dots**, and **Mini bar**. Size, Physics, Micro, On Top, Undock and Theme buttons go. | Mocked. Awaiting OK |
| R-09 | Size | **Legibly sized; remove the expand (Wide) option** | One size: 440 px wide, 12.5 px text, 16 px title, 6 px tracks with 14 px thumbs. | Mocked. Awaiting OK |
| R-10 | Micro / on top | **The mini bar must stay on top of the desktop, even over other apps** | Only Chrome's Document Picture-in-Picture floats over other apps, and Chrome lets it open only from a click inside a page that stays alive. With the floating button gone (R-13) that is the **Stay-open window**: click *Mini bar* there, and the bar lives as long as that window exists (minimised is fine). It cannot open from the toolbar popup (the popup closes, and that closes the bar). | Mocked (`r2-micro.png`). Awaiting OK on that rule |
| R-11 | Icons | **Replace the emoji icons; show alternatives** | i1 none (text only; the base of every mockup), i2 thin line icons (grey, accent when active), i3 small tags (LOW / HPF / MID / HI / AUTO / VOL / SPD). | Awaiting i1 / i2 / i3 |
| R-12 | Physics | **Integrate the physics into the main screen, one screen** | p1 response curve only · **p2 curve + stage A/B pills (recommended)** · p3 animated wave + curve. Replaces the side panel (R-02) once chosen. | Awaiting p1 / p2 / p3 |
| R-13 (decided) | Floating button | **Remove it** | The in-page pill and its switch go with the header slice. Consequence recorded in R-10. | Decided |
| R-14 (fixed) | Sliders | **Changing a value shifts the layout** (the Modified badge and Update button appear) | Confirmed on 1.2.0 by the new check W-NO-LAYOUT-SHIFT (controls jumped 15 px). Fixed in 1.2.1 (`44599e5`): fixed-height preset row, no wrapping, fixed-width badge, shorter labels. | Fixed; W-NO-LAYOUT-SHIFT PASS |
| R-08 (strip) | Player bar | Cover-art strip on the left | Accepted by implication (you chose C with the strip shown). Year source still open. | Awaiting year source |

### Review round 3 (2026-10-01): your picks, and what 1.3.0 built

| # | Surface | Your pick / request | Built in 1.3.0 (`dccf108`) | Verified |
|---|---|---|---|---|
| R-12 (decided) | Physics | **P3**: animated signal wave + response curve on the main screen | Both drawings sit between the presets and the sliders, redraw with every change and reflect the band switches. The side panel (R-02) is gone. Heights were trimmed so the whole screen fits Chrome's 600 px popup cap. | W-PHYSICS-INLINE PASS; your look pending |
| R-11 → R-15 (decided) | Icons / band switches | **I3 tags, as on/off switches per slider**: switch a band off without resetting it to zero | LOW / HPF / MID / HI / AUTO / VOL / SPD are buttons. Off = the stage leaves the chain, the slider keeps its value, the row dims, the state is saved with presets. AUTO is the Auto-Balancing switch. SPD off = playback speed 1.00x. The audio engine gained per-band bypass; old saved whole-EQ flags still work. No emoji anywhere (unit test). | W-BAND-SWITCH-SYNC PASS; **W-AUDIO-BAND-SWITCH PASS** (LOW off with bass +10 dB: 60 Hz back to flat, measured) |
| R-05 (built) | Player | C with 15 s / 30 s jumps | **C2** built (transport on its own row: ♥ · prev · −15 s · play · +30 s · next). C1 remains available if you prefer it. | W-JUMP PASS (+29.7 s / −13.7 s on a 60 s tone while playing); W-TRANSPORT-SCOPE PASS |
| R-04 (reversed, built) | Heart | Bring it back if it can work | Targets Tidal's own heart in the footer (collection / favourite / like labels and data-test names). When it can't be found, the heart is dimmed and the click explains instead of pretending. | W-HEART PASS on the fixture; **real Tidal pending: send the heart's HTML if it stays dimmed** |
| R-06 (built) | Header | Remove the top icons; keep stay-open and theme | No header. Footer: **Stay open** switch, five theme dots, **Mini bar**. Alt+M shows/hides the window. | W-SURFACES-REMOVED, W-THEME-DOTS, W-STAY-OPEN PASS |
| R-09 (built) | Size | Legible; no Wide option | One size: 440 px wide, 12.5 px text, 16 px title, 14 px thumbs. 585 px tall (Chrome caps popups at 600). | W-NO-DEAD-SPACE PASS |
| R-10 (built) | Mini bar on top | Must float over other apps | Document Picture-in-Picture bar: art, title, ♥, −15 s, play, +30 s, EQ pill, ✕. Opens from the Stay-open window (Chrome's rule); from the popup, *Mini bar* opens that window first and highlights the button. Lives as long as the window exists. | **W-MINIBAR PASS** (opened by a real click in the harness); your check on the desktop pending |
| R-13 (built) | Floating button | Remove | Gone, with its switch and the in-page Picture-in-Picture code. | W-SURFACES-REMOVED PASS |
| R-08 (built) | Art strip | Cover art strip on the left | 56 px strip: square cover at the top, the same art blurred down the side. The image is the one Tidal's page shows, loaded from Tidal's image server. **Year still needs a source decision.** | your look pending |
| R-03 (kept) | Layout | No dead space | The screen height follows the content; the sliders pack from the top. | W-NO-DEAD-SPACE PASS |
| H-01 (assistant housekeeping, reversible) | Files | — | Dead files removed from the repo and the build: `tidal-bridge.js` (unused token reader), `miniplayer.html/.js` (broken, unused), `router-visualizer.js` (replaced by `physics-view.js`). No `web_accessible_resources` any more. Last build with them: tag `v1.2.1-before-main-screen`. | unit test: dead files stay out |

Still open after round 3: C1 vs C2 (C2 built), the year's data source (R-08), the heart on real Tidal (R-04), and the preset list from your everyday copy (R-07).

### Review round 4 (2026-10-01, after you loaded 1.3.0): corrections and "make it real"

| # | Surface | Your words | Built in 1.3.1 (`ca30d42`) | Verified |
|---|---|---|---|---|
| R-16 | Cover art | "Side image not what I wanted: a centre slice of the full image on the left, and the full image in the top part" | The left strip shows the cover scaled to the strip's height, centre slice (no blur). The full cover sits at the top right of the player section (76 px). | screenshot `tests/results/review-v1.3.1/popup-default.png`; your look pending |
| R-17 | Jumps | "Jump back/forward buttons don't do anything; next/previous and heart work" | On Tidal the player element is out of reach, so the jumps now drive the page's own seek bar in the footer (range input; else a click on the progress bar). If neither exists the screen says so instead of doing nothing. The fixture now mirrors Tidal (media in a shadow root, time labels, seek bar). | W-JUMP PASS through the seek bar; **real Tidal pending** (tell me if the time shows next to the artist) |
| R-18 (decided) | Physics strip | Asked why it moved with no audio and what the dots were; answer: an animation of the sliders, dots decorative. **"Make it real."** | The strip is now the real spectrum of the audio while the EQ is on: grey = what the tab sends, colour = what you hear. Flat and still when the EQ is off. Dots and the animated wave are gone. The response curve stays as the picture of the settings. | **W-LIVE-SPECTRUM PASS** (objective: input shows the tone's 60 Hz / 1 kHz / 8 kHz peaks; output shows the +10 dB bass lift at 60 Hz and 0.2 dB at 1 kHz); W-PHYSICS-INLINE requires stillness when off |
| R-19 | Stay open | "Stay open button doesn't work" | Not reproduced: a real-click test (W-STAY-OPEN) flips the icon into window mode, opens the window, and switching off in the window restores the popup. Waiting for your description of what happens on your Mac. | pending your answer |

### Review round 5 (2026-10-01, after 1.3.1): blurry art, Stay open

| # | Surface | Your words | Built in 1.3.2 (`18bc5d1`) | Verified |
|---|---|---|---|---|
| R-16 (fixed) | Cover art | "Side image should be hi-def, not an enlarged blurry image" | The page script was taking Tidal's 80 px thumbnail. It now takes the largest artwork offered (mediaSession sizes, srcset, or the player-bar image) and asks Tidal for the 1280 px size, stepping down to 640 / 320 when a size is missing. | W-ART-HIRES PASS (1280 requested, 640 fallback); your look pending |
| R-19 (resolved) → **R-20 (decided)** | Stay open | "Still doesn't survive any click in the website" | Cause: the window was a separate window, so the first click in the page brought Chrome's main window over it. **Stay open now docks the screen into Chrome's side panel**, beside the page, where it stays while you click anything; the toolbar icon opens it while Stay open is on. Requires the `sidePanel` permission (UI-only; no access to pages, audio or devices), added as an explicit decision. The window remains only as a fallback for Chrome without a side panel. The Mini bar opens from the panel. Panel layout: two-line slider rows with full-width sliders, scrolls, redraws on resize. | W-STAY-OPEN PASS (real click, hand-over to the panel, icon behaviour), W-SIDE-PANEL-OPEN PASS, W-PANEL-LAYOUT PASS (360 / 480 px); **your check on your Mac pending** |

### Review round 6 (2026-10-01): side-panel band buttons

| # | Surface | Your words | Built in 1.3.3 (`f018f0c`) | Verified |
|---|---|---|---|---|
| R-21 (decided) | Side panel rows | "Two rows: I don't like the text labels on the clickable slider buttons; icons/image buttons for the side panel only." Mockups A–D (`mockups/round3.html`); **you chose A.** | In the side panel each band's on/off is a 28 px icon button (woofer, HPF curve, mic, sparkle, scales, speaker, gauge): accent when on, grey with a slash when off, row dims. The popup keeps the LOW/HPF/… text tags. | W-PANEL-LAYOUT PASS (icon shown, text hidden, click toggles off with slash and dimmed row); your look pending |

### Review round 7 (2026-10-03): your all-clear on 1.3.3; housekeeping in 1.3.4

| # | Surface | Your words / finding | Outcome | Verified |
|---|---|---|---|---|
| V-01 (your verification) | Everything from rounds 4–6 | "Everything working perfect now" (on 1.3.3) | R-16 cover art, R-17 jumps and time, R-20 side panel, R-21 icon buttons, R-10 mini bar on the desktop and R-04 heart are **confirmed on your Mac and real Tidal**. The matrix rows that waited on you are marked PASS with the date. | your report |
| H-02 (assistant fix, bug) | Tabs open before a Reload or update | Found while listing open items: after a Reload on the card (or an update), Tidal tabs that were already open showed "Connecting…" with dead transport until the page was refreshed. **Cause**: the worker re-injects the page script when the old copy stops answering, but its file list still named `router-visualizer.js`, deleted in H-01, so the injection threw and was swallowed. | `PAGE_SCRIPT_FILES = ['content.js']`, injected immediately; the worker counts re-injections per tab. | **W-REINJECT-ORPHAN**: FAIL on the 1.3.3 runtime ("Connecting…", 0 re-injections), PASS on 1.3.4 (1 re-injection, track shown). Unit test: injected files must exist. |
| A-01 (assistant, accessibility; no visual change for mouse use) | Keyboard and screen readers (review batch 5) | Keyboard focus was invisible on the sliders, the select and both switches; the six sliders and the EQ switch had no accessible name; band buttons and theme dots exposed no state. | A `:focus-visible` ring on every control (thumb ring on sliders, track ring on switches, 2 px accent outline elsewhere); `aria-label` on the sliders and the EQ switch; `aria-pressed` on band buttons and theme dots; `role="img"` with a description on the two drawings; the hint is a live `status` region. | **W-KEYBOARD** (pixel-measured ring, arrows move and save a slider, Space/Enter press buttons and band switches, no unnamed control): FAIL on 1.3.3, PASS on 1.3.4. Two unit tests (names and states; no `outline: none` without a focus-visible rule). |
| A-02 (inventory for J-7) | Error and empty states | Not reviewed with you; listed here so you can skim. | **EQ on fails**: "Chrome only lets the EQ attach to a tab after you open this extension on that tab. Switch to "<tab>", click the extension icon there, then turn Audio EQ on." · "<tab> is already being captured, possibly by another copy of this extension or another audio extension. Turn that one off first." · "Chrome system pages cannot be captured. Switch to a music or video tab." · "No active media tab found. Open Tidal or any music/video tab." (shown as an alert). **Jumps**: "The track length isn't known on this page, so the jump can't be placed." · "Couldn't move the playback position on this page (no media element or seek bar found). Prev, next and play still work." **Heart**: dimmed, "Tidal's heart button was not found in the player bar, so nothing was changed." **Mini bar**: "This Chrome cannot float a window (Document Picture-in-Picture is unavailable)." **No track**: the title stays "Connecting…" / "Media tab". | messages exist (static); wording is yours to change |
| C-01 (closed with your all-clear) | C1 vs C2 · EQ target-tab rules · Pitch/Speed wording | Open since round 2–3 | **C2 stands** (transport on its own row). **Target tab for the EQ** (unchanged): the audible Tidal tab, else any audible tab, else any Tidal tab, else a YouTube/Spotify/SoundCloud/Apple Music/Netflix tab, else the active tab; the screen names the tab it is processing. **Pitch / Speed** keeps its name and applies only while the EQ is on. Say the word if you want any of the three changed. | — |

**Contrast, measured (WCAG ratio against the theme background; 4.5:1 is the small-text target, 3:1 for UI parts).** Main text 16.9–19.1 in every theme. Muted labels: Cyan 6.7 · Amber 6.6 · Synthwave 7.9 · Matrix 5.3 · OLED 4.5 (on the surface colour 4.1, the one borderline case). Accent on background: Cyan 12.1 · Amber 8.8 · Synthwave 5.0 · Matrix 14.7 · OLED 7.9. A switched-off band tag's text 3.7–4.2 (a deliberately dimmed state; it is a UI part, and the value next to it stays readable). No change made; the OLED muted colour can be lifted on request.

Still open after round 7: the year's data source (R-08), the preset list from your everyday copy (R-07), Alt+M / Alt+E on your Mac, the extreme-boost listening check (S-04), and the cut-over (review batch 6).

### Repository (2026-10-03)

| # | Surface | Your words | Outcome | Verified |
|---|---|---|---|---|
| R-22 (decided) | GitHub repository | "make the github public also" | Visibility switched from private to **public** with `gh repo edit --visibility public`. Pre-flight scan of the full history first: no tokens, keys, credentials or Tidal session data anywhere; tests use synthetic fixtures only; the review build and test results are not in the repo. What a visitor can see: the source and docs, the commit author identity on your commits (name and e-mail, as on any public repository), and the local folder paths with your account name in five documents (README, REVIEW_READY and the historical hand-offs). No LICENSE file yet, so the default "all rights reserved" applies. CLAUDE.md updated: the visibility is not to be changed again without your OK. | `gh repo view`: visibility PUBLIC |
