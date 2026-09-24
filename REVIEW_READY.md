# Review Ready: 2026-09-24

## Identity

| | |
|---|---|
| Project root (source) | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| Repository | `github.com/cornishandy/tidal-miniplayer-extension`, **PRIVATE**, default branch `main` |
| Extraction baseline | tag `v1.1.0-extraction-baseline` → `1b7bedb` |
| Old project (reference only) | `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`, untouched and byte-identical to the baseline |

## Candidate build

| | |
|---|---|
| **Load path (UNPACKED_BUILD_ROOT)** | `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked` |
| Version | 1.1.1 (the live install is 1.1.0) |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` (derived from the path; the harness loaded it under this ID) |
| Source commit | `d0b6d53` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `d1a3f475ed1a5121…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## Installation and state

- **Live install: ORIGINAL UNCHANGED.** It still loads from the old folder. I could not read Chrome's profile (macOS privacy block), so its ID and settings are not independently confirmed.
- **Review install: ISOLATED REVIEW COPY** (not yet loaded; needs your click). It has a different ID and default settings. Your custom presets are not migrated. Recommended in a separate *Extension Review* Chrome profile so the two copies never process the same tab.
- No key generated, nothing uninstalled, no Web Store action.

## Review surfaces

Toolbar popup (DJ BASS / PLAYLISTS / PLAYLIST LAB tabs), Physics drawer, Micro mode, Wide mode, standalone window (🗗, 📌, Alt+M), in-page floating button → Document PiP, Alt+E. Map: [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md).

## Tests

- **Executed**: 24 installed-browser and objective-audio checks, plus 5 unit checks, all PASS on this exact build. The baseline failed 11 of the same 24. Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md).
- **Not run**: a real toolbar-click capture, Document PiP from the floating button, Alt+M/Alt+E in real Chrome, and any listening judgement.
- **Blocked**: anything on real Tidal (transport, metadata, playlists, create). It needs your signed-in session, and I don't contact Tidal.

## Remaining known issues

Design-review items (target-tab rules, 📌 behaviour, Pitch vs Speed, PiP parity, blank band, title truncation, icon-only header). Playlist add/remove is not built. The Tidal API endpoints are unverified. See the plan's *Known risks*.

## Docs

[README.md](README.md) (operating guide) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Minimum action from you

Load the build in a separate Chrome profile (3 clicks; steps in the README under “Load for review”). Everything else is done.

## Status

- **SOURCE SYNC**: reported in chat after the merge was verified (not self-referenced here).
- **EXTENSION**: PARTLY VERIFIED. Loadable, and browser-verified in an isolated test browser. Real-Tidal, real-click and listening checks are pending.
- **LIVE INSTALL**: ORIGINAL UNCHANGED.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
