# Review Ready: 2026-10-03 (round 7: your all-clear on 1.3.3; 1.3.4 fixes re-injection and adds keyboard access)

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
| Version | **1.3.4** (the live install is 1.1.0) |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` (unchanged: same folder) |
| Runtime source commit | `075e241` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `ff8d9b1d9ea6cc6d…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## Your report on 1.3.3 (2026-10-03)

"Everything working perfect now": the side panel holds while you click around Tidal, the cover is sharp, the jumps and the time work on real Tidal, the mini bar floats on your desktop, the heart works. Recorded as verified by you in [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) and [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md).

## What changed in 1.3.4

- **Fix: tabs opened before a Reload or an update stayed on "Connecting…"** (transport dead) until you refreshed the page. The worker was trying to put the page script back by injecting a file that was deleted in 1.3.0, so the attempt failed quietly. Fixed; a new check reproduces it on 1.3.3 and passes on 1.3.4.
- **Keyboard access.** Tab moves through every control with a visible ring (sliders ring the thumb, switches ring the track); arrows move a slider; Space or Enter presses a button or a band switch. Screen readers get names for the six sliders and the EQ switch, and on/off states for the band buttons and theme dots. Nothing changes for mouse use.

## Earlier rounds (1.3.0 to 1.3.3)

One legible 440 px screen, no header; cover-art slice and full cover; title, artist, time; ♥ · prev · −15 s · play · +30 s · next; EQ switch with the tab's name; presets; the **real** live spectrum and the response curve; sliders with per-band on/off; footer with **Stay open** (Chrome's side panel), theme dots and **Mini bar**. Details and your decisions: [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md). Presets and their data untouched (R-07).

## Installation and state

- **Live install: ORIGINAL UNCHANGED.** It still loads from the old folder (1.1.0).
- **Review install: ISOLATED REVIEW COPY.** Same folder and ID; click **Reload** on its card. Stored settings carry over.
- No key generated, nothing uninstalled, no Web Store action.

## Tests

- **Executed**: 35 installed-browser and objective-audio checks, plus 11 unit checks, all PASS on this exact build. Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md). Results: `tests/results/review-v1.3.4/`. The two new checks fail on the 1.3.3 runtime (`tests/results/repro-1.3.3-orphan/`), which is how the defects were confirmed.
- **Reported working by you** (1.3.3, 2026-10-03): side panel, cover art, jumps, time, mini bar, heart on real Tidal.
- **Not run**: Alt+M / Alt+E on your Mac; the extreme-boost listening check.

## What I need from you

1. Click **Reload** on the review card; confirm **1.3.4**. Leave your Tidal tab exactly as it is (no refresh) and open the screen: it should show the track straight away. That is the fix.
2. **Year of original release: pick a source** (open since round 1). (a) Tidal's album edition year via your session: re-adds a Tidal request with your token, and shows remaster years, not the original. (b) MusicBrainz first-release year: an opt-in switch; while on, the title and artist of what you play go to musicbrainz.org, and it needs one new host permission. (c) No year. Recommendation: (c) for now; (b) if you want it badly enough to accept the sharing.
3. **Presets: the list from your everyday copy.** Everyday profile → right-click the icon → **Inspect popup** → **Console** → paste the line below → it lands on your clipboard → paste it here. Those keys hold only preset names and EQ values.
   `chrome.storage.local.get(['presets','currentPreset','currentParams'], d => copy(JSON.stringify(d, null, 1)))`
   Checked today: the factory presets in your everyday copy (1.1.0) and in 1.3.4 are identical, name for name and value for value, so moving over will not change any default preset. Only the stray old entries need your list.
4. Optional, while you are there: **Alt+M** (opens the panel) and **Alt+E** on the Tidal tab (toggles the EQ); and a heavy preset at your usual volume: any crackle or pumping?
5. Next, once 3 is done: the **cut-over** (make 1.3.x your everyday extension and retire the old folder). Your call when.

## Remaining known issues

Year not shown (no source yet). Heart depends on Tidal's markup. Pitch/Speed applies only while the EQ is on (unchanged; closed unless you object). Old default presets showing under "My Custom Presets" in your everyday copy (R-07; fix needs your list). Alt+E can only attach to a tab you have opened the extension on (Chrome's rule).

## Docs

[README.md](README.md) (operating guide) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: VERIFIED by you on 1.3.3 (real Tidal, side panel, mini bar). 1.3.4 is harness-verified on the exact review folder (35/35); your Reload is pending.
- **LIVE INSTALL**: ORIGINAL UNCHANGED.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
