# Review Ready: 2026-10-03 (round 9: cover top right in the stacked panel; your answers; the cut-over; 1.3.6)

## Identity

| | |
|---|---|
| Project root (source) | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| Repository | `github.com/cornishandy/tidal-miniplayer-extension`, **PUBLIC** since 2026-10-03 (your request, R-22), MIT licence (R-25), default branch `main` |
| Tags | `v1.1.0-extraction-baseline` (1b7bedb) · `v1.1.1-before-ui-removals` (5355cac) · `v1.2.1-before-main-screen` (6fcb492) |
| Old project (reference only) | `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`, untouched; archived after your cut-over, on your word |

## The build (review and, from the cut-over, everyday)

| | |
|---|---|
| **Load path (UNPACKED_BUILD_ROOT)** | `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked` (permanent: the extension's ID and its saved settings come from this path; never moved or renamed) |
| Version | **1.3.6** (the everyday install is 1.1.0 until you do the cut-over steps below) |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` (same folder, same ID, in any profile) |
| Runtime source commit | `ea7832f` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `8f66bcfa918726a9…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## What changed in 1.3.6

- **Stacked panel: the cover is top right again**, at 56 px (your note on the 1.3.5 screenshot: "you could probably still fit in the cover art in the upper right, just make it smaller"). Title (up to two lines) and artist sit to its left; the transport runs across the full width below. Nothing else changed.

## Your decisions today (recorded in [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md), round 9)

- **Year of original release: none** (R-08, your pick (c)). No Tidal request, no third-party lookup, no new permission. Can be reopened later.
- **Cut-over: go ahead** (R-24). `build/review-unpacked` becomes your everyday extension; steps below.
- **Public page** (R-25): MIT `LICENSE` (holder `cornishandy`, your GitHub name; say if you want your real name instead), repository description set, your account name taken out of README and this file. The historical hand-offs keep their paths (not rewritten, by rule).

## Earlier in 1.3.x

1.3.5: the side panel adapts to its width (stacked under 400 px, normal from 400 px; no art slice in the panel; Chrome's own floor is 360 px). 1.3.4: tabs opened before a Reload or update work without a page refresh; keyboard access with visible focus rings and accessible names. 1.3.0 to 1.3.3: the one legible 440 px screen, confirmed by you on real Tidal on 2026-10-03. Details: [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md). Presets and their data untouched (R-07).

## Installation and state

- **Everyday install: still the ORIGINAL (1.1.0) from the old folder** until you do the steps below. Nothing in your Chrome profile was touched by me.
- **Review install**: same folder and ID as before; click **Reload** for 1.3.6.
- No key generated, nothing uninstalled, no Web Store action. The old folder stays until you confirm the 1.1.0 card is removed.

## Tests

- **Executed**: 35 installed-browser and objective-audio checks, plus 11 unit checks, all PASS on this exact build (`tests/results/review-v1.3.6/`, with panel screenshots at 300, 360, 400 and 480 px). Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md).
- **Reported working by you** (1.3.3, 2026-10-03): side panel, cover art, jumps, time, mini bar, heart on real Tidal. Stacked panel: "ok" on the 1.3.5 screenshot, cover now moved on your note.
- **Not run**: Alt+M / Alt+E on your Mac; the listening check (S-04, below).

## What I need from you

1. **The cut-over, once, in your everyday Chrome profile.**
   1. Only if you ever pressed *+ Save* in the old copy to keep a preset of your own: open the old popup, pick that preset and note its six values, so you can save it again afterwards (or export the list, step 5). If you never did, skip this: the new copy starts with the factory presets, which are identical to the old copy's defaults value for value, and the stray old entries under "My Custom Presets" do not come along.
   2. Open `chrome://extensions`. On the card **Universal Mini-Player & DJ Bass Booster** that shows version **1.1.0**, click **Remove**. (Chrome deletes that copy's settings with it. The folder on disk stays until you tell me.)
   3. On the same page turn **Developer mode** on (top right), click **Load unpacked**, and choose `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked`. The new card shows version **1.3.6** and ID `gponppchadgoilnlbogcdldbmpdoaeno`. (If this profile already has the review card, click **Reload** on it instead.)
   4. Pin it: click the puzzle piece in the toolbar, then the pin next to its name.
   5. Open `chrome://extensions/shortcuts` and check **Alt+M** and **Alt+E** are filled in next to it. If a box is blank, click the pencil and press the keys.
   6. Refresh your Tidal tab once (the old copy's page script went away with it). From then on, Reloads need no refresh.
   7. Tell me "old one removed". I will then zip the old folder beside itself and take it out of the way. Until then it stays, as a fallback.
2. **Look at the panel**: Stay open on, drag the panel to its narrowest. The cover should sit top right at 56 px, title and artist to its left. Say if you want it bigger or elsewhere.
3. **Three things I closed on your all-clear, re-asked so you can change them.** Each has a recommended default; a one-word answer per line is enough.
   - **Transport row.** Now: the six buttons (heart, previous, −15 s, play, +30 s, next) on their own row under the title (C2). Alternative (C1): heart and the two jumps inline on the title line, no previous/next, saving one row. Keep C2?
   - **Which tab the EQ attaches to when you switch it on.** Now: the Tidal tab that is playing; if none, any tab that is playing; then any Tidal tab; then a YouTube, Spotify, SoundCloud, Apple Music or Netflix tab; else the tab you are on. Alternative: only ever the tab you opened the screen from (simpler, refuses more often). Keep the current order? (Either way, Chrome only lets the EQ attach to a tab you have opened the extension on.)
   - **The slider named "Pitch / Speed".** It changes speed and pitch together, like a turntable, and only while the EQ is on. Alternatives: "Speed", "Tempo", "Turntable". Keep "Pitch / Speed"?
4. **Listening check (S-04), with your ears; the harness cannot do it.** Pick your heaviest preset (or push Bass Boost to +14 dB and Master Volume up), play a bass-heavy track at the volume you normally use, and listen for two things: crackle or buzz on the loud hits (distortion), and the whole track dipping for a moment after each big hit and swelling back (pumping, from the leveler). Answer "clean", or tell me the preset, the track and roughly when it happened. While you are there: **Alt+M** should open the panel, **Alt+E** on the Tidal tab should toggle the EQ.
5. **Only if step 1.1 applies and you would rather export than retype**: in your everyday Chrome window, right-click the extension's icon in the toolbar (the one you pinned; if it is hidden, click the puzzle piece first), choose **Inspect popup**. A separate window of developer tools opens. Along its top, click **Console**. Click in the empty area at the bottom of that pane (next to the `>` sign), paste the line below, press Return. The list is now on your clipboard; paste it here. It holds only preset names and EQ values. Do this **before** step 1.2, while the old copy is still installed.
   `chrome.storage.local.get(['presets','currentPreset','currentParams'], d => copy(JSON.stringify(d, null, 1)))`

## Remaining known issues

No year shown (your decision, R-08). Heart depends on Tidal's markup. Pitch/Speed applies only while the EQ is on (re-asked above). Alt+E can only attach to a tab you have opened the extension on (Chrome's rule). Chrome's side panel cannot go below 360 px.

## Docs

[README.md](README.md) (operating guide, cut-over steps) · [LICENSE](LICENSE) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: VERIFIED by you on 1.3.3 (real Tidal, side panel, mini bar). 1.3.6 is harness-verified on the exact review folder (35/35); your Reload and your look at the cover are pending.
- **EVERYDAY INSTALL**: ORIGINAL (1.1.0) UNCHANGED until you do the cut-over steps; nothing touched by me.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
