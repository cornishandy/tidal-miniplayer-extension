# Review Ready: 2026-10-03 (round 10: Pitch is a key shift; cut-over done; 1.4.0)

## Identity

| | |
|---|---|
| Project root (source) | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| Repository | `github.com/cornishandy/tidal-miniplayer-extension`, **PUBLIC** since 2026-10-03 (your request, R-22), MIT licence (R-25), default branch `main` |
| Tags | `v1.1.0-extraction-baseline` (1b7bedb) · `v1.1.1-before-ui-removals` (5355cac) · `v1.2.1-before-main-screen` (6fcb492) |
| Old project | **Retired 2026-10-03 (R-24)**: archived as `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension-1.1.0-retired-2026-10-03.zip` (18 files, archive tested), folder removed |

## The build (your everyday extension)

| | |
|---|---|
| **Load path (UNPACKED_BUILD_ROOT)** | `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked` (permanent: the extension's ID and its saved settings come from this path; never moved or renamed) |
| Version | **1.4.0** |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` |
| Runtime source commit | `4b4975a` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `efa8fe4eed23ff39…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## What changed in 1.4.0

- **Pitch is a key shift** (your instruction: "the functionality should just change the pitch, and rename to Pitch"). The slider, now called **Pitch**, moves the pitch by −12 to +12 semitones while the speed stays exactly as it was. The old "Pitch / Speed" changed the page's playback rate, so pitch and tempo moved together like a turntable; that is gone. The shift is done inside the DSP graph (whole segments of the waveform overlapped at their best-matching point, then read out at the new rate: the method DJ software of the SoundTouch family uses), and at 0 st it is out of the chain entirely. Steps of 0.1 st (− / + move 0.5, Shift 0.1); the **PITCH** tag switches it out; the value reads "+2.0 st".
- **What to expect**: clean within a few semitones. Further out, long steady notes warble a little and drum hits can double; that is the nature of the method, and the reason the range stops at an octave. While a shift is set there is about 0.14 s of delay, which matters only for video lip-sync, not for music.
- **Presets**: in all eight factory presets the dead field "Pitch / Speed 1.00×" (neutral) became "Pitch 0 st" (neutral). Nothing audible changes in any preset. Presets saved before 1.4.0 load at 0 st. No stored data was rewritten (R-07).

## Your decisions today (recorded in [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md), rounds 9 and 10)

- **Cut-over: done** (R-24). You removed the 1.1.0 card; the old folder was zipped, checked and removed. `build/review-unpacked` is your everyday extension.
- **Transport row: keep** (C-01 closed). **Year: none** (R-08). **Licence, description, paths** (R-25) done.
- **Pitch** (P-01): built as above. **Listening check** (S-04): explained in [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md).

## Installation and state

- **Everyday install**: `build/review-unpacked`, loaded by you on 2026-10-03; click **Reload** for 1.4.0. Nothing in your Chrome profile was touched by me.
- No key generated, no Web Store action. The old 1.1.0 copy exists only as the zip above and as the tag `v1.1.0-extraction-baseline`.

## Tests

- **Executed**: 36 installed-browser and objective-audio checks, plus 12 unit checks, all PASS on this exact build (`tests/results/review-v1.4.0/`). New: W-PITCH (objective: +12 st moves the 1 kHz tone to 2 kHz and −12 st to 500 Hz at the same level; the page keeps playing at normal speed; 0 st and the PITCH tag route around the shifter). Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md).
- **Reported working by you** (1.3.3, 2026-10-03): side panel, cover art, jumps, time, mini bar, heart on real Tidal.
- **Not run (your ears)**: the pitch shift on real music; the heavy-preset listening check; Alt+M / Alt+E on your Mac.

## What I need from you

1. **Reload**, confirm **1.4.0**, and **try Pitch on a track**: EQ on, move Pitch to +2, then −2, then +7. The key should move while the tempo stays put. Tell me: does it sound right within a few semitones; how far out does the warble or doubling bother you; are the steps and the range right.
2. **Which tab the EQ grabs: keep or change?** The EQ can process one tab at a time, so when you switch it on it has to pick one. Today's order: the Tidal tab that is making sound; if none, any tab making sound; then any Tidal tab even if paused; then a YouTube, Spotify, SoundCloud, Apple Music or Netflix tab; and only then the tab you happen to be on. The screen names the tab it picked next to the switch. Example: Tidal plays in one tab while you read in another with the panel open; you flip the switch, and it attaches to Tidal, not to the page you are reading. The alternative: always and only the tab you are looking at. Simpler to predict, but in that example it would refuse and send you to the Tidal tab first. One limit either way: Chrome only lets the extension capture a tab you have clicked the extension on at some point in that tab, and the message tells you which tab to go to when that is missing. Recommendation: keep.
3. **The listening check** (what, why and the alternatives: [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md)). Heaviest preset, a bass-heavy track at your normal volume, then a track with a clear voice and hi-hats. Flip AUTO off and on during a loud passage; flip AUDIO EQ off and on. Report "clean", or the preset, the track, roughly when, and which row of the table it sounded like.
4. **Alt+M** should open the panel; **Alt+E** on the Tidal tab should switch the EQ.
5. **The narrow panel**: the cover now sits top right at 56 px (1.3.6). Say if you want it bigger or elsewhere.

## Remaining known issues

No year shown (your decision, R-08). Heart depends on Tidal's markup. Pitch applies while the EQ is on and adds about 0.14 s of delay only while a shift is set. Alt+E can only attach to a tab you have opened the extension on (Chrome's rule). Chrome's side panel cannot go below 360 px.

## Docs

[README.md](README.md) (operating guide) · [LICENSE](LICENSE) · [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: VERIFIED by you on 1.3.3 (real Tidal, side panel, mini bar). 1.4.0 is harness-verified on the exact review folder (36/36); your Reload and your listening to Pitch are pending.
- **EVERYDAY INSTALL**: this build's folder, loaded by you; Reload pending.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
