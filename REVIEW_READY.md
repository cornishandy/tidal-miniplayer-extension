# Review Ready: 2026-10-04 (round 11: the alternatives as switches, live meters, rows in chain order; 1.5.0)

## Identity

| | |
|---|---|
| Project root (source) | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| Repository | `github.com/cornishandy/tidal-miniplayer-extension`, **PUBLIC** since 2026-10-03 (your request, R-22), MIT licence (R-25), default branch `main` |
| Tags | `v1.1.0-extraction-baseline` (1b7bedb) · `v1.1.1-before-ui-removals` (5355cac) · `v1.2.1-before-main-screen` (6fcb492) |
| Old project | Retired 2026-10-03 (R-24): archived as `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension-1.1.0-retired-2026-10-03.zip`, folder removed |

## The build (your everyday extension)

| | |
|---|---|
| **Load path (UNPACKED_BUILD_ROOT)** | `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked` (permanent: the extension's ID and its saved settings come from this path; never moved or renamed) |
| Version | **1.5.0** |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` |
| Runtime source commit | `553e23b` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `8a8b8962edc509b0…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## What changed in 1.5.0

**The sound you had is untouched.** Every new menu starts on its first entry and MATCH starts off; in that state the signal path is the 1.4.0 path, and the harness proves it: six settings measured on 1.4.0 (flat, bass +10, the worst case, and three AUTO-on settings) come out the same on 1.5.0 to within 0.3 dB (W-DYN-BASELINE). Your rule of 2026-10-04 ("don't change anything about the audio processing without asking me first") is now written into the repo's working rules; this check is how it is enforced.

**The alternatives, as switches** (your "Oh hell yeah, build these so I can switch between them in the app"):

| Row | Control | Entries (first = the original) | In one line |
|---|---|---|---|
| Leveler (AUTO) | menu | **Full band** · Slow release · Bass only | the whole mix levelled · the same, letting go three times more slowly · only what is below 150 Hz levelled, voice and hi-hats untouched |
| Loudness match (MATCH) | tag | **off** · on | on: the music is kept as loud as the untouched tab, so more bass is a change of tone, not of volume; it also removes the lift AUTO adds (about +3 dB on a quiet signal, measured), which makes AUTO on and off a fair comparison |
| Limiter (LIM) | menu | **Fast** · Look-ahead | reacts in 1 ms, the fastest peaks slip past to the ceiling · sees peaks 5 ms early, turns down smoothly before them, nothing left for the ceiling; 5 ms of delay while selected |
| Ceiling (CEIL) | menu | **Clean** · Warm | does nothing below −0.6 dB · rounds the loudest peaks from about −10 dB up, like tape; a deliberate gentle distortion |

The modes are engine settings, not preset values: they stay as you set them whichever preset you choose, so a mode can be compared across presets. No preset was changed (R-07).

**Live bars** (your "add a level or something else to indicate when this sort of thing gets activated"): each of those four rows shows how much that stage is turning the music down right now, 0 to 12 dB, with the figure beside it (theme colour under 3 dB, amber from 3 dB, red from 8 dB; "idle" while the EQ is off).

**Rows in signal order** (your "include the layout in this order, and add any missing pieces"): PITCH, HPF, LOW, MID, HI, AUTO, MATCH, VOL, LIM, CEIL, top to bottom, the way the audio passes through them. Pitch is first because it is first in the chain. The Auto-Balancing row reads "Leveler" because its menu needed the room (the AUTO tag keeps the name). LIM and CEIL have no switch: they are always on. The popup is 592 px tall with ten rows (Chrome's cap is 600).

**The diagram** (your "explain visually with diagram"): [docs/diagrams/leveler-explained-2026-10-04.png](docs/diagrams/leveler-explained-2026-10-04.png), also embedded in [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md).

## Your decisions today (recorded in [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md), round 11)

- **Which tab the EQ grabs: keep** (C-01 closed).
- **Audio processing frozen without your OK** (A-03, rule).
- **Listening result**: both heard, "more bass" and "squashed" (S-04); the switches are the answer.
- **Alternatives built as switches** (D-01), **live bars** (D-02), **rows in chain order** (D-03), **diagram** (D-04), **the "things to try" note kept** (N-01).

## Installation and state

- **Everyday install**: `build/review-unpacked`, loaded by you on 2026-10-03; click **Reload** for 1.5.0. Nothing in your Chrome profile was touched by me. Your presets and settings are kept (the folder and the ID are unchanged).
- No key generated, no Web Store action.

## Tests

- **Executed**: 43 installed-browser and objective-audio checks, plus 13 unit checks, all PASS on this exact build (`tests/results/review-v1.5.0/`). New: W-DYN-BASELINE (the 1.4.0 sound reproduced), W-DYN-LEVELER-BASS (60 Hz down 3.5 dB, 1 kHz and 8 kHz unchanged), W-DYN-LEVELER-SLOW, W-DYN-MATCH (within 0.3 dB of the untouched loudness where it was 5.2 dB louder), W-DYN-LIMITER-LOOKAHEAD (peak 0.930, ceiling idle, distortion products 25 to 40 dB lower than Fast), W-DYN-CEILING-WARM (never above −0.3 dB, transparent at a quiet level, +13 dB of colour at the worst case), W-DYN-METERS-UI (the bars follow the engine; the menus and the MATCH tag persist). Matrix and evidence: [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md).
- **Reported working by you** (1.3.3, 2026-10-03): side panel, cover art, jumps, time, mini bar, heart on real Tidal.
- **Not run (your ears and eyes)**: the switches on real music; the pitch shift on real music; the new rows and the diagram; Alt+M / Alt+E on your Mac.

## What I need from you

1. **Reload**, confirm **1.5.0**, EQ on, and look at the four bars while a loud track plays. The AUTO bar sitting amber or red during the loud parts is the leveler working hard; that is the "squashed" case made visible.
2. **Try the switches, one at a time** (how to compare, in full: [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md)). Leveler → Bass only: the voice and hi-hats should stop dipping with the kick. Leveler → Slow release: less breathing between kicks. MATCH on: leave it on while comparing anything else, so loudness stops fooling you. At a high Master setting: Limiter → Look-ahead, then Ceiling → Warm. Report which switch, which preset, which track, roughly when, and what it sounded like.
3. **The layout**: Pitch moved to the top (chain order) and the Auto-Balancing row now reads "Leveler". Say if you want Pitch back at the bottom or the old label back.
4. **The diagram**: does it make the full-band / bass-only / loudness point clear?
5. Still open from before: **Pitch** on a track (+2, −2, +7); **Alt+M** opens the panel and **Alt+E** on the Tidal tab switches the EQ; the **56 px cover** in the narrow panel.

Things to try without code, kept at your request: AUTO off with Master at or under 100 % for punch; HPF from 30 up to 40 Hz on heavy presets; Master down as Bass goes up (about 70 % per +6 dB; with MATCH on this happens by itself).

## Remaining known issues

No year shown (your decision, R-08). Heart depends on Tidal's markup. Pitch applies while the EQ is on and adds about 0.14 s of delay only while a shift is set. Look-ahead adds 5 ms of delay only while selected. MATCH follows the music over a few seconds, so a quiet-to-loud section change can be heard as a slow level settle. Alt+E can only attach to a tab you have opened the extension on (Chrome's rule). Chrome's side panel cannot go below 360 px.

## Docs

[README.md](README.md) (operating guide) · [LICENSE](LICENSE) · [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md) · [docs/diagrams/](docs/diagrams/) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: VERIFIED by you on 1.3.3 (real Tidal, side panel, mini bar). 1.5.0 is harness-verified on the exact review folder (43/43); your Reload and your listening to the switches are pending.
- **EVERYDAY INSTALL**: this build's folder, loaded by you; Reload pending.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
