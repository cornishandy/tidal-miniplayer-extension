# Universal Mini-Player & DJ Bass Booster (Chrome extension, MV3)

A Tidal-first tab-audio EQ for Google Chrome on macOS. One screen, no menus.

- **Audio EQ**: captures one tab's audio and runs it through anti-distortion HPF → bass low-shelf (120 Hz) → mid (1 kHz) → high-shelf (5 kHz) → optional Auto-Balancing compressor → master gain (50–250 %) → limiter → −0.3 dBFS output ceiling. Presets (8 factory + your own) and a true-bypass *Flat* preset.
- **Per-band switches**: the tag at the left of each row (LOW, HPF, MID, HI, AUTO, VOL, SPD) switches that stage off while keeping its value, so you can hear a track with and without one band.
- **Physics on screen**: a live spectrum of the audio while the EQ is on (grey = what the tab sends, colour = what you hear) and, below it, the combined frequency response of your settings. The spectrum is still and flat when the EQ is off.
- **Player**: cover art (a centre slice down the left edge and the full cover at the top right), title, artist and time read from Tidal's bottom player bar (or any tab's media element); heart (Tidal's *My Collection*), previous, back 15 s, play/pause, forward 30 s, next. The jumps use the page's media element when it is reachable, otherwise the page's own seek bar.
- **Stay open**: a switch that docks the screen into Chrome's side panel beside the page, where it stays while you click anything; the toolbar icon then opens the panel. (A separate window is used only where Chrome has no side panel.)
- **Mini bar**: a small always-on-top bar (Chrome's Document Picture-in-Picture) with art, title, heart, jumps, play/pause and the EQ switch. Chrome only lets it open from a click inside a page that stays alive, so it opens from the side panel (or the fallback window) and lives as long as that stays open.

Removed at the owner's decision (2026-10-01): Playlists and Playlist Lab (last build: tag `v1.1.1-before-ui-removals`), the header icon row with Size/Wide, Micro, On Top, Undock and theme-cycle buttons, the Physics side panel, and the in-page floating button (last build with them: tag `v1.2.1-before-main-screen`).

Current status, evidence and known gaps: [REVIEW_READY.md](REVIEW_READY.md) and [docs/PLAN_AND_ACCEPTANCE.md](docs/PLAN_AND_ACCEPTANCE.md).

## Folders

| Path | What it is |
|---|---|
| repo root | **Source**. It also loads as an unpacked extension, but that isn't the review path. |
| `build/review-unpacked/` | **The build to load in Chrome for review** (gitignored). Contains `BUILD_INFO.json` with source commit and fingerprint. |
| `tools/build.mjs` | Copies only runtime files into a build folder and writes `BUILD_INFO.json`. |
| `tools/mockshot.mjs` | Renders the design mockups in `docs/mockups/` to PNG. |
| `tests/` | Test harness (own `package.json`; nothing here ships). |
| `docs/` | Assessment, plan and acceptance, design decisions, design review map, `mockups/`. |
| `FINAL_HANDOFF.md`, `SESSION_HANDOFF.md` | **Historical** handoffs from the old project. Their paths under `…/T3 Code/t3-nightly-toy/` are historical. |

Runtime files: `manifest.json`, `background.js` (service worker: capture, presets, Stay-open window), `content.js` (reads Tidal's player bar, runs transport commands), `offscreen.html/.js` (Web Audio DSP), `popup.html/.css/.js` (the screen, the window and the mini bar), `physics-view.js` (drawings), `themes.css`, `icons/`.

Old location (reference only, never edited): `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`. Until the cut-over below is done, your everyday Chrome install (1.1.0) still points there; afterwards the folder is archived, on your word.

## Build

No dependencies are needed to build.

```bash
cd ~/Documents/ChatGPT/tidal-miniplayer-extension
node tools/build.mjs build/review-unpacked     # refresh the review build from the current source
```

Only rebuild `build/review-unpacked` when you intend to refresh the build Chrome is using. After rebuilding, click **Reload** on the extension's card in `chrome://extensions`. A source change never reloads Chrome by itself.

## Load it

`build/review-unpacked` is the review build and, since the cut-over (decision R-24, 2026-10-03), the everyday extension too. Its path is permanent: an unpacked extension's ID, and with it its saved presets and settings, come from the folder path. Never move or rename it. Every promotion lands there; you click **Reload**.

**Cut-over, once, in your everyday profile** (replaces the 1.1.0 install from the old folder):

1. If you ever saved a preset of your own with *+ Save* in the old copy, note its six values first (or export the list: see REVIEW_READY). The factory presets are identical in both copies and need nothing; the stray old entries under "My Custom Presets" do not come along.
2. `chrome://extensions`: on the card *Universal Mini-Player & DJ Bass Booster* that shows version **1.1.0**, click **Remove**. Chrome deletes that copy's settings with it; the folder on disk stays until you say so.
3. Same page: **Developer mode** on (top right), **Load unpacked**, choose `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked`. The new card shows version **1.3.6** and ID **`gponppchadgoilnlbogcdldbmpdoaeno`**. If this profile already has the review card, click **Reload** on it instead.
4. Pin the icon: the puzzle piece in the toolbar, then the pin next to the name.
5. `chrome://extensions/shortcuts`: check **Alt+M** and **Alt+E** are filled in next to it; if a box is blank, click the pencil and press the keys.
6. Refresh your Tidal tab once (the old copy's page script went with it). From then on, Reloads need no refresh.

**Review in a separate profile** (optional, as before): profile menu, **Add**, **Continue without an account**, name it *Extension Review*, and load the same folder there. Same ID, separate settings; sign in to Tidal there for Tidal features.

## Everyday use

- **Turn the EQ on**: go to the tab that is playing, click the extension icon, and switch **AUDIO EQ** on. Chrome only lets the extension capture a tab you opened it on. If it refuses, the message tells you which tab to switch to. The badge shows the tab being processed.
- **Stop**: switch **AUDIO EQ** off, or close the tab. The tab's normal audio returns.
- **Band switches**: click LOW / HPF / MID / HI / AUTO / VOL / SPD (icon buttons in the side panel) to take that stage out while keeping its slider value; click again to bring it back. Switched-off rows are dimmed. The state is saved with presets.
- **Values**: drag, use − / + (Shift-click for 5× finer steps), or double-click a value to snap it to neutral and double-click again to restore it.
- **Presets**: *+ Save* saves the current values as a new preset; *Update* saves into the selected custom preset; *↺ Reset* restores the selected preset's saved values (factory values for a default); ✕ deletes a custom preset. Your custom presets are never deleted by Reset.
- **Stay open**: switch it on and the screen moves into Chrome's side panel on the right of the window, where it stays while you click anything on the page; from then on the toolbar icon opens that panel (the popup itself is closed by Chrome whenever you click elsewhere; nothing can change that). Drag the panel's edge to resize it: narrower than 400 px the player stacks (cover top right at 56 px, title up to two lines, full-width transport); wider, it is the normal layout. Chrome itself stops the panel at 360 px. The panel shows no art slice. Switch it off in the panel to go back to the popup. **Alt+M** opens the panel. **Alt+E** toggles the EQ (press it on the playing tab: Chrome only lets the EQ attach to a tab you have opened the extension on). Change shortcuts at `chrome://extensions/shortcuts`.
- **Mini bar**: in the side panel, click **Mini bar**. It floats above every app and stays as long as the panel is open. From the toolbar popup, *Mini bar* first opens the panel for you.
- **Heart**: adds the track to, or removes it from, your Tidal collection by clicking Tidal's own heart in the player bar. If Tidal's heart can't be found on the page, the heart is dimmed and says so.
- **Theme**: the five dots at the bottom.
- **Keyboard**: Tab moves between the controls (a ring shows where you are), arrows move a slider, Space or Enter presses a button or a band switch.
- **After a Reload or an update**: Tidal tabs that were already open keep working; the page script is put back automatically, no page refresh needed.

## Tests (isolated, synthetic, no network)

```bash
cd tests && npm install --ignore-scripts   # one-time: playwright-core only (no install scripts)
npm test                                    # static checks: manifest, commands, permissions, syntax, no network code, retired surfaces, no emoji, injected files, names, focus rings
node ../tools/build.mjs /tmp/tme-build && node browser/run.mjs /tmp/tme-build --label local
```

The browser harness uses Playwright's *Chrome for Testing* with a **fresh temporary profile**. It blocks every hostname except its own localhost fixture server, **mutes audio output**, and plays only generated sine tones and a fake Tidal page. It never touches your Chrome profile or Tidal. Tab capture is authorised with `--allowlisted-extension-id`, which stands in for the toolbar click that automation can't perform. Results go to `tests/results/<label>/` (gitignored). Chrome caps a toolbar popup at 600 px tall; the harness fails if the screen grows past that.

**Safe manual listening test**: keep system and headphone volume where they already are. Use a quiet YouTube or Tidal track, start from the *Flat (Bypass)* preset, then raise Bass gradually.

## Permissions and privacy

- `tabCapture`, `offscreen`: EQ processing of the tab you choose. Audio stays in Chrome and is never recorded or uploaded.
- `tabs`, `activeTab`, `scripting`, `<all_urls>`: find the media tab, read the track shown on the page, and re-inject the page script into tabs opened before an update.
- `sidePanel`: show the screen in Chrome's side panel (Stay open). UI only; grants no access to pages, audio or devices.
- `storage`: `chrome.storage.local` only (no sync). Keys: `presets`, `currentPreset`, `currentParams`, `visualTheme`, `stayOpen`, `capturedTabId`, `isAudioCapturing`.
- **Network**: the extension makes no requests of its own and reads no Tidal session or token. The one piece of network activity is the cover image, which the screen loads from Tidal's image server while a track is shown (the full-size version of the image Tidal's page shows). A unit test (`no network code`) and a browser check (W-NO-REMOTE-REQUESTS) guard the rest.

## Recovery

- Everyday install: unchanged; it still loads from the old folder.
- Extraction baseline: git tag `v1.1.0-extraction-baseline` (`1b7bedb`). A checksummed backup is under `…/t3-nightly-toy/backups/pre-extraction-backup/`.
- Last build with Playlists, Playlist Lab and the favourite button: tag `v1.1.1-before-ui-removals` (`5355cac`).
- Last build with the header icons, Physics side panel, Micro/Wide modes and the floating button: tag `v1.2.1-before-main-screen` (`6fcb492`).
- To drop the review copy: remove it from the *Extension Review* profile (or delete that profile). Nothing else is affected.
