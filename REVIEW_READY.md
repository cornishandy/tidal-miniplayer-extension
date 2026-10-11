# Review Ready: 2026-10-11 (1.5.3: the jumps on a narrow Tidal page and at the end of a track)

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
| Version | **1.5.3** |
| Expected extension ID | `gponppchadgoilnlbogcdldbmpdoaeno` |
| Runtime source commit | `__COMMIT__` (see `BUILD_INFO.json` in the load path) |
| Build fingerprint | `__FP__…` (SHA-256 over all shipped files; full value in `BUILD_INFO.json`) |
| Rebuild | `node tools/build.mjs build/review-unpacked`, then **Reload** in `chrome://extensions` |

Later commits on `main` change docs only. The runtime files at `main`'s tip are identical to this build.

## What changed in 1.5.3 (your reports of 2026-10-11 about the +30 s button)

**Nothing about the sound changed.** Only the transport: content.js, the new page helper, the jump in popup.js and the worker's re-injection.

- **+30 s and −15 s work when Tidal hides its timeline** (J-01). With the side panel dragged wide, Tidal's page gets narrow and drops its seek bar, which the jumps used to drive. A small helper inside Tidal's own page (`page-bridge.js`, on Tidal only) now remembers the seek handler Tidal gives the Mac's media controls, and Tidal's player; when the seek bar is missing, the jump goes through those. The time also keeps showing. The helper passes everything through unchanged, reads no login, storage or cookies, and sends nothing anywhere.
- **+30 s in the last 30 seconds goes to the next track** (J-02), as if the track had played out. If there is no Next (end of the queue), the track plays to its end.
- **One reload of the Tidal tab** is needed if that tab was already open when you clicked Reload on the extension; new Tidal tabs have the helper from the start. If a jump fails on Tidal, the screen says so.

## What changed in 1.5.2 (your report: "lots of clicking sounds", Glass, "Islands", iFi DAC at 96 kHz)

**The sound is untouched**: on the default settings every sample is the same as in 1.5.1 (unit proofs against the 1.5.1 code; W-DYN-BASELINE at 96 kHz). You said yes to installing it on 2026-10-10.

- **No more dropouts when the Mac is briefly busy.** At 96 kHz Chrome had been giving the EQ 2.7 ms per audio hand-over; whenever the audio thread was held up for more than about 4 ms, your DAC got a moment of silence: a click. The EQ now hands over 21 ms at a time. Measured with deliberate stalls about 11 times a second: 1.5.1 dropped out on almost every stall from 6 ms (12 to 23 a second), 1.5.2 not once up to 24 ms ([docs/evidence/stall-series-2026-10-10.md](docs/evidence/stall-series-2026-10-10.md)). Cost: up to about 50 ms more delay (corrected 2026-10-11 from "about 30 ms"), noticeable only as lip sync on video.
- **The pitch stage rests when Pitch is at 0.** It used to keep working ten times a second even when unused, which made the stalls likelier. Switching Pitch on now plays about 0.15 s unshifted first. A jump across the whole range at once can still click for a moment (it did since 1.4.0); the fix for that changes how Pitch glides, so it waits for your OK (K-04).
- **A freeze after six hours is gone.** A counter in the look-ahead limiter's code overflowed after 6.2 hours of continuous playback at 96 kHz and stopped all sound.
- **Tests are silent.** The test browser now has no audio output at all; before, you could hear its test tones on your DAC (sorry).

Ruled out on the evidence: the EQ settings and the 1.5.0 switches, the page script, and your DAC's clock (it runs about 11 ppm fast; 10 minutes without a gap).

## What changed in 1.5.1

- **Side panel tags are words again** (your request: "change the slider labels (now images) in the side panel back to match the extension (words)"). The panel shows the same PITCH, HPF, LOW, MID, HI, AUTO, MATCH, VOL, LIM, CEIL tags as the popup, struck through when off. The icon buttons are gone (R-21 revised).
- Harness only, nothing in the extension: the level readings are now taken at exact frequencies, so they no longer depend on which output device your Mac has selected (the iFi DAC at 96 kHz had shifted the 60 Hz reading by 0.8 dB). The rate is recorded with each run.

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

## Your decisions (recorded in [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md), "Click report" and "Review round 14")

- **Fix the jumps to your preference** (2026-10-11): built as 1.5.3 (J-01, J-02).
- **Install 1.5.2: yes** (K-01, 2026-10-10).
- Waiting for your answers (round 14): the mini bar's second click (M-01), the side panel's empty bottom A / B / C (R-26), the artist gauge (R-27), where album and artist facts come from (R-08 reopened); and the low-delay switch only if lips look late (L-01).
- Your other open items are parked, with their questions and mockups, in [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) ("Open items, parked 2026-10-10").

## Installation and state

- **Everyday install**: `build/review-unpacked`, loaded by you on 2026-10-03; click **Reload** for 1.5.3. Nothing in your Chrome profile was touched by me. Your presets and settings are kept (the folder and the ID are unchanged).
- No key generated, no Web Store action.

## Tests

- **Executed (1.5.3)**: 53 installed-browser and objective-audio checks, plus 18 unit checks, all PASS on this exact build (`tests/results/review-v1.5.3/`), with the test browser silent and the fake Tidal page served as tidal.com from this Mac only. New: W-JUMP-NARROW, W-JUMP-NARROW-ELEMENT, W-JUMP-END, W-JUMP-END-QUEUE-END, W-JUMP-END-NO-NEXT, W-BRIDGE-PAUSE-TIME, W-BRIDGE-SCOPE, W-NO-REMOTE-REQUESTS-LATE. A test-isolation slip of 1.5.2 in the dropout diagnostic was found and fixed (H-05).
- **Executed (1.5.2)**: 45 installed-browser and objective-audio checks, plus 16 unit checks, all PASS (`tests/results/review-v1.5.2/`). New: W-CLICK-PATH (21 ms buffer, pitch stage at rest), W-PITCH-RECOVER (after a −12 to +12 jump Pitch comes back by itself), unit proofs that the limiter and the shifted sound are bit-identical to 1.5.1 and that the 6-hour freeze cannot happen.
- **Diagnostics** (not in the regular run): the stall series and two 10-minute runs without a loop (0 gaps, 0 dropouts on both versions).
- **Not run (your ears)**: the track you reported, and the open listening items below.

## What I need from you

1. **Reload**: open `chrome://extensions`, find the card "Universal Mini-Player & DJ Bass Booster", click its round arrow (Reload), and check it says **1.5.3**. Then reload your Tidal tab once.
2. **Try the jumps**: drag the side panel wide until Tidal's timeline disappears, then click +30; pause and check that the time shown is the song's; and click +30 with less than 30 s left. Tell me "works" or what happened, and tell me if a jump ever asks you to reload a tab you had just opened.
3. **Play "Islands" again** with AUDIO EQ on, the iDSD back at 96 kHz if you changed it. Tell me "clean", or roughly how often the clicks come and whether they are steady or random.
4. When you have time: the round-14 questions and the parked open items (signal readout, mode defaults, the MATCH bar, the 1.5.0 listening and layout questions).

## Remaining known issues

Up to about 50 ms more delay since 1.5.2, about 35 to 60 ms in all by Chrome's figures (lip sync on video; corrected 2026-10-11 from "about 30 ms"). A jump across the whole Pitch range at once can click for a moment (K-04, waits for your OK). No year shown (your decision, R-08). Heart depends on Tidal's markup. The 1.5.3 page helper is visible to Tidal's scripts: if Tidal starts showing a captcha, it is the first suspect. Pitch adds about 0.14 s of delay only while a shift is set. Look-ahead adds 5 ms of delay only while selected. MATCH follows the music over a few seconds.

## Docs

[README.md](README.md) (operating guide) · [LICENSE](LICENSE) · [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md) · [docs/diagrams/](docs/diagrams/) · [docs/ASSESSMENT_2026-09-24.md](docs/ASSESSMENT_2026-09-24.md) · [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md) · [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) · [docs/DESIGN_REVIEW_MAP.md](docs/DESIGN_REVIEW_MAP.md) · [docs/mockups/](docs/mockups/) · historical: [FINAL_HANDOFF.md](FINAL_HANDOFF.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md)

## Status

- **SOURCE SYNC**: reported in chat after the merge is verified (not self-referenced here).
- **EXTENSION**: VERIFIED by you on 1.3.3 (real Tidal, side panel, mini bar). 1.5.3 is harness-verified on the exact review folder (53/53, silent, fake Tidal page served from this Mac only); your Reload, the jumps on real Tidal and your listening to "Islands" on 1.5.2's fix are pending.
- **EVERYDAY INSTALL**: this build's folder, loaded by you; Reload pending.
- **STORE/DEPLOYMENT**: NOT PUBLISHED.
