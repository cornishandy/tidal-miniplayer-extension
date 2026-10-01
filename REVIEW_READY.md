# Review Ready: 2026-10-01 (round 3: the new main screen)

## Identity

| | |
|---|---|
| Project root (source) | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| Repository | `github.com/cornishandy/tidal-miniplayer-extension`, **PRIVATE**, default branch `main` |
| Tags | `v1.1.0-extraction-baseline` (1b7bedb) · `v1.1.1-before-ui-removals` (5355cac) · `v1.2.1-before-main-screen` (6fcb492) |
| Old project (reference only) | `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`, untouched |

## Candidate build

| | |
|---|---|
| **Load path (UNPACKED_BUILD_ROOT)** | `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked` |
| Version | **1.3.0** (the live install is 1.1.0) |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` (unchanged: same folder) |
| Runtime source commit | `dccf108` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `dfac61d0babdd57c…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## What 1.3.0 is

Your rounds 1–3 built: one legible screen (440 px), no header; cover-art strip; title, artist, time; ♥ · prev · −15 s · play · +30 s · next; the EQ switch with the tab's name; presets; the physics (wave + response) on the screen; sliders with **band switches** (LOW/HPF/MID/HI/AUTO/VOL/SPD, off keeps the value); footer with **Stay open**, theme dots and **Mini bar** (always on top). Floating button, Micro/Wide, On Top, Undock and the side panel are gone. Dead files removed. Presets and their data untouched (R-07).

## Installation and state

- **Live install: ORIGINAL UNCHANGED.** It still loads from the old folder (1.1.0).
- **Review install: ISOLATED REVIEW COPY.** Same folder and ID; click **Reload** on its card. Stored settings carry over (the floating-button and side-panel settings are cleared; they no longer exist).
- No key generated, nothing uninstalled, no Web Store action.

## Tests

- **Executed**: 29 installed-browser and objective-audio checks, plus 8 unit checks, all PASS on this exact build. Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md). Results: `tests/results/review-v1.3.0/`.
- **Not run**: your look at the screen, the mini bar on your desktop, a real toolbar-click capture, Alt+M/Alt+E, the extreme-boost listening check.
- **Blocked**: anything on real Tidal (heart, jumps, cover art). It needs your signed-in session, and I don't contact Tidal.

## What I need from you

1. Click **Reload** on the review card; confirm **1.3.0**. Use it on real Tidal: EQ on, band switches, the heart, the jumps, the cover art.
2. Switch **Stay open** on (the window opens), then click **Mini bar** there and tell me if it floats over other apps.
3. If the heart stays dimmed on real Tidal: right-click the heart in Tidal's bottom bar → **Inspect** → right-click the highlighted line → **Copy** → **Copy outerHTML** → paste it here.
4. **Year of original release: pick a source.** (a) Tidal's album edition year via your session (re-adds a Tidal request); (b) MusicBrainz first-release year (sends title + artist to musicbrainz.org); (c) no year.
5. For the presets: the list from your everyday copy. Everyday profile → right-click the icon → **Inspect popup** → **Console** → paste: `chrome.storage.local.get(['presets','currentPreset'], d => console.log(JSON.stringify(d, null, 1)))` → copy what it prints.

## Remaining known issues

Year not shown (no source yet). Heart depends on Tidal's markup. Pitch/Speed only applies while the EQ is on (unchanged behaviour). Old default presets showing under “My Custom Presets” in your everyday copy (R-07; fix needs your list).

## Docs

[README.md](README.md) (operating guide) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: PARTLY VERIFIED. Loadable, and browser-verified in an isolated test browser (29/29). Your visual, desktop and real-Tidal checks are pending.
- **LIVE INSTALL**: ORIGINAL UNCHANGED.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
