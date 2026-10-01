# Universal Mini-Player & DJ Bass Booster (Chrome extension, MV3)

A Tidal-first mini-player and tab-audio enhancer for Google Chrome on macOS.

- **Audio EQ**: captures one tab's audio and runs it through anti-distortion HPF → bass low-shelf (120 Hz) → mid (1 kHz) → high-shelf (5 kHz) → optional Auto-Balancing compressor → master gain (50–250 %) → limiter → −0.3 dBFS output ceiling. It includes presets (8 factory + your own), a true-bypass *Flat* preset, and per-stage A/B bypass in the Physics panel.
- **Physics side panel**: an animated model of the current settings (signal pipeline and combined frequency response) that opens beside the sliders, so you can A/B a stage while you adjust. It is an illustration driven by the slider values, not a meter of the live audio.
- **Player controls** for Tidal (read from Tidal's bottom player bar) or any tab's audio/video: play/pause, previous/next, seek bar with 25 % ticks, −25 %/+25 % skip, page volume, and Pitch/Speed. (The player bar is under design review; see docs/DESIGN_DECISIONS.md R-05.)
- **Mini-player surfaces**: toolbar popup, Micro mode, Wide mode, an undocked window, an in-page floating button (off by default), and a Document Picture-in-Picture window opened from that button. (Header under review; R-06.)

Removed on 2026-10-01 at the owner's decision: the Playlists and Playlist Lab tabs and the favourite button. The last build that had them is tag `v1.1.1-before-ui-removals`.

Current status, evidence and known gaps: [REVIEW_READY.md](REVIEW_READY.md) and [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md).

## Folders

| Path | What it is |
|---|---|
| repo root | **Source**. It also loads as an unpacked extension, but that isn't the review path. |
| `build/review-unpacked/` | **The build to load in Chrome for review** (gitignored). Contains `BUILD_INFO.json` with source commit and fingerprint. |
| `tools/build.mjs` | Copies only runtime files into a build folder and writes `BUILD_INFO.json`. |
| `tests/` | Test harness (own `package.json`; nothing here ships). |
| `tools/mockshot.mjs` | Renders the design mockups in `docs/mockups/` to PNG. |
| `docs/` | Assessment, plan and acceptance, design decisions, design review map, `mockups/` (design options; open `popup-variants.html` in a browser). |
| `FINAL_HANDOFF.md`, `SESSION_HANDOFF.md` | **Historical** handoffs from the old project. Their paths under `…/T3 Code/t3-nightly-toy/` are historical. |

Old location (reference only, never edited): `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`. Your everyday Chrome install still points there.

## Build

No dependencies are needed to build.

```bash
cd ~/Documents/ChatGPT/tidal-miniplayer-extension
node tools/build.mjs build/review-unpacked     # refresh the review build from the current source
```

Only rebuild `build/review-unpacked` when you intend to refresh the build Chrome is using. After rebuilding, click **Reload** on the extension's card in `chrome://extensions`. A source change never reloads Chrome by itself.

## Load for review (recommended: a separate Chrome profile)

1. In Chrome, open the profile menu, choose **Add**, then **Continue without an account**, and name it *Extension Review*.
2. In that profile's window, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
   `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked`.
3. Check the card shows version **1.2.1** and ID **`gponppchadgoilnlbogcdldbmpdoaeno`**. Pin the icon.

Why a separate profile: an unpacked extension's ID comes from its folder, so the review build is a **different extension** from your live 1.1.0 install. It has its own empty settings, and your custom presets are *not* copied. In the same profile, both copies would inject into every page. Chrome also lets only one of them capture a given tab. For Tidal features in the review profile, sign in to Tidal there.

## Everyday use

- **Turn the EQ on**: go to the tab that is playing, click the extension icon, and switch **AUDIO EQ** on. Chrome only lets the extension capture a tab you opened it on. If it refuses, the message tells you which tab to switch to.
- **Stop**: switch **AUDIO EQ** off, or close the tab. The tab's normal audio returns.
- **Shortcuts** (change them at `chrome://extensions/shortcuts`): **Alt+M** shows or hides the standalone mini-player window. **Alt+E** toggles the EQ.
- **Physics panel**: click 🔬 to open it beside the sliders; click again or ✕ to close. It stays open or closed the next time you open the popup.
- **Always-on-top PiP**: Chrome only opens Document Picture-in-Picture from a click *inside the page*. Turn on **Floating Button** and click it on the Tidal page. The popup's 📌 button and Alt+M open the standalone window instead.
- **Double-click** any value (e.g. `+5.0 dB`) to snap it to neutral; double-click again to restore it. Use the **− / +** buttons to nudge, and **Shift**-click for 5× finer steps.

## Tests (isolated, synthetic, no network)

```bash
cd tests && npm install --ignore-scripts   # one-time: playwright-core only (no install scripts)
npm test                                    # static checks: manifest, commands, permissions, syntax
node ../tools/build.mjs /tmp/tme-build && node browser/run.mjs /tmp/tme-build --label local
```

The browser harness uses Playwright's *Chrome for Testing* with a **fresh temporary profile**. It blocks every hostname except its own localhost fixture server, **mutes audio output**, and plays only generated sine tones and a fake Tidal page. It never touches your Chrome profile or Tidal. Tab capture is authorised with `--allowlisted-extension-id`, which stands in for the toolbar click that automation can't perform. Results go to `tests/results/<label>/` (gitignored).

**Safe manual listening test**: keep system and headphone volume where they already are. Use a quiet YouTube or Tidal track, start from the *Flat (Bypass)* preset, then raise Bass gradually.

## Permissions and privacy

- `tabCapture`, `offscreen`: EQ processing of the tab you choose. Audio stays in Chrome and is never recorded or uploaded.
- `tabs`, `activeTab`, `scripting`, `<all_urls>`: find the media tab, read the track shown on the page, and re-inject controls into tabs opened before an update.
- `storage`: `chrome.storage.local` only (no sync). Keys: `presets`, `currentPreset`, `currentParams`, `showFloatingButton*`, `visualTheme`, `physicsPanelOpen`, `capturedTabId`, `isAudioCapturing`.
- **Network**: none. Since 1.2.0 the extension makes no requests to Tidal or anywhere else, and no longer reads Tidal's session from the page. A unit test (`no network code`) and a browser check (W-NO-REMOTE-REQUESTS) keep it that way.

## Recovery

- Everyday install: unchanged; it still loads from the old folder.
- Extraction baseline: git tag `v1.1.0-extraction-baseline` (`1b7bedb`). A checksummed backup is under `…/t3-nightly-toy/backups/pre-extraction-backup/`.
- Last build with Playlists, Playlist Lab and the favourite button: git tag `v1.1.1-before-ui-removals` (`5355cac`).
- To drop the review copy: remove it from the *Extension Review* profile (or delete that profile). Nothing else is affected.
