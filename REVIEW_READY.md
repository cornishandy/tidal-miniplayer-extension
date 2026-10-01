# Review Ready: 2026-10-01 (round 2)

## Identity

| | |
|---|---|
| Project root (source) | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| Repository | `github.com/cornishandy/tidal-miniplayer-extension`, **PRIVATE**, default branch `main` |
| Extraction baseline | tag `v1.1.0-extraction-baseline` → `1b7bedb` |
| Last build with Playlists / Lab / favourite | tag `v1.1.1-before-ui-removals` → `5355cac` |
| Old project (reference only) | `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`, untouched |

## Candidate build

| | |
|---|---|
| **Load path (UNPACKED_BUILD_ROOT)** | `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked` |
| Version | **1.2.1** (the live install is 1.1.0; previous review builds 1.1.1, 1.2.0) |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` (unchanged: same folder) |
| Runtime source commit | `44599e5` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `c6ff582bdd7396f4…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## What changed in 1.2.1

- The preset row no longer reflows when a value changes, so the sliders and + / − buttons stay put under the pointer (your report; R-14). Button labels are shorter: *Update*, *+ Save*, *↺ Reset*.

## What changed in 1.2.0 (your round-1 decisions)

- Playlists and Playlist Lab tabs: **gone**. The extension now makes **no network requests** and no longer reads Tidal's session.
- ♥ favourite: **gone** (popup, Micro, PiP).
- Physics: a **side panel** beside the sliders (popup widens to 660 px); open/closed state is remembered; colours follow the theme.
- Empty space above/below the sliders: **gone**; the popup is 336 px tall instead of 540 px. The standalone window sizes itself to its content.
- Nothing was changed in your presets or their data (rule R-07).

## Installation and state

- **Live install: ORIGINAL UNCHANGED.** It still loads from the old folder (1.1.0).
- **Review install: ISOLATED REVIEW COPY.** Same folder and ID as before; click **Reload** on its card in the *Extension Review* profile. Its stored settings (presets, theme) carry over from 1.1.1 because the ID is unchanged.
- No key generated, nothing uninstalled, no Web Store action.

## Review surfaces

Toolbar popup (player bar · AUDIO EQ · presets · sliders), Physics side panel (🔬), Micro mode, Wide mode, standalone window (🗗, 📌, Alt+M), in-page floating button → Document PiP, Alt+E. Map: [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md). Design options for the player bar and header: [docs/mockups/](docs/mockups/).

## Tests

- **Executed**: 25 installed-browser and objective-audio checks, plus 7 unit checks, all PASS on this exact build. Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md). Results: `tests/results/review-v1.2.1/`.
- **Not run**: your visual check of the side panel in real Chrome, a real toolbar-click capture, Document PiP from the floating button, Alt+M/Alt+E, and the extreme-boost listening check.
- **Blocked**: anything on real Tidal (transport, metadata). It needs your signed-in session, and I don't contact Tidal.

## What I need from you

1. Click **Reload** on the review card; confirm **1.2.1**; check that nudging a value no longer moves the sliders.
2. Round-2 picks (`docs/mockups/round2.html`, `r2-*.png`): player **C1 or C2** · physics **p1 / p2 / p3** · icons **i1 / i2 / i3** · OK on the **Stay open** window and the **Mini bar** rule (it opens from that window and lives as long as the window does).
3. **The heart.** On the Tidal page, right-click the heart in the bottom player bar → **Inspect** → in the panel, right-click the highlighted line → **Copy** → **Copy outerHTML** → paste it here. That lets me target Tidal's own button instead of guessing.
4. **Year of original release: pick a source.** Tidal's player bar has no year, so one of: (a) Tidal's own album data: the year of the album edition you're playing (remasters show the remaster year), fetched from Tidal using your signed-in session (this re-adds a Tidal request, which 1.2.0 removed); (b) **MusicBrainz** first-release year: the real original year, but the extension would send each track's title and artist to musicbrainz.org (free, no account, no key); (c) no year. Assistant's recommendation: (b) if you're comfortable with that lookup, otherwise (a).
5. For the presets: the list from your everyday copy. In the everyday Chrome profile, right-click the extension icon → **Inspect popup** → **Console** tab → paste the line below → copy what it prints into our chat. It only reads; it changes nothing.
   `chrome.storage.local.get(['presets','currentPreset'], d => console.log(JSON.stringify(d, null, 1)))`

## Remaining known issues

Design-review items (player bar, header, EQ target-tab rules, Pitch vs Speed, PiP parity, PiP keep/drop, `miniplayer.*` and `tidal-bridge.js`). Old default presets showing under “My Custom Presets” in your everyday copy (R-07; fix needs your list).

## Docs

[README.md](README.md) (operating guide) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: PARTLY VERIFIED. Loadable, and browser-verified in an isolated test browser. Your visual check, real-Tidal and real-click checks are pending.
- **LIVE INSTALL**: ORIGINAL UNCHANGED.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
