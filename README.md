# Universal Mini-Player & DJ Bass Booster (Chrome extension, MV3)

A Tidal-first tab-audio EQ for Google Chrome on macOS. One screen, no menus.

- **Audio EQ**: captures one tab's audio and runs it through pitch (key shift) → anti-distortion HPF → bass low-shelf (120 Hz, 0 to +56 dB) → mid (1 kHz, ±24 dB) → high-shelf (5 kHz, ±24 dB; the three ranges doubled again in 1.5.9) → optional Auto-Balancing leveler → optional loudness match → master gain (50–250 %) → limiter → −0.3 dBFS output ceiling. Presets (8 factory + your own) and a true-bypass *Flat* preset.
- **Switchable stages with live bars** (1.5.0): the Leveler row offers *Full band* (the original), *Slow release* and *Bass only*; the MATCH tag keeps the music as loud as the untouched tab; the Limiter row offers *Fast* (the original) and *Look-ahead*; the Ceiling row offers *Clean* (the original) and *Warm*. Each of those four rows shows how much it is turning the music down right now (the bar is full at 12 dB; the figure keeps counting). The defaults are the sound of 1.4.0, and a harness check (W-DYN-BASELINE) proves it. Saving or updating a preset stores these modes with it; a preset from before that, and every factory preset, leaves them as they are until you press Update.
- **Per-band switches**: the tag at the left of each row (PITCH, HPF, LOW, MID, HI, AUTO, MATCH, VOL) switches that stage off while keeping its value, so you can hear a track with and without one band. The rows run top to bottom in the order the audio passes through them; LIM and CEIL are always on.
- **Live band cuts** (1.5.10): LOW, MID and HI show a red `cut N dB` caption and slider tick when the measured audio falls short of the requested boost; a band's cut never reads below the limiter's reduction plus the full-band Leveler's, minus MATCH gain. Readings need sound in that band and hide while idle, bypassed or pitch-shifted.
- **Physics on screen**: a live spectrum of the audio while the EQ is on (grey = what the tab sends, colour = what you hear) and, below it, the combined frequency response of your settings. The spectrum is still and flat when the EQ is off.
- **Player**: cover art (a centre slice down the left edge and the full cover at the top right), title, artist and time read from Tidal's bottom player bar (or any tab's media element); heart (Tidal's *My Collection*), previous, back 15 s, play/pause, forward 30 s, next. The jumps use the page's media element when it is reachable, otherwise the page's own seek bar; on Tidal, when a narrow page hides the seek bar, they go through Tidal's own page (the seek handler Tidal gives the Mac's media controls, else its player element). A forward jump that would pass the end goes to the next track (1.5.3).
- **Skip feedback** (1.5.11): jumps and Next confirm playback moved; the existing hint explains a delay, held repeat or failure, clears on success, and does not change the screen height.
- **Preset stepping** (1.5.11): the Previous preset and Next preset buttons beside the dropdown follow its order and wrap at either end, applying saved switches just like a dropdown pick.
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
| `tools/diagramshot.mjs` | Renders a diagram page in `docs/diagrams/` to PNG. |
| `tools/panelshot.mjs` | Screenshots the real side-panel page of a build, optionally with a mockup fragment injected (`--inject docs/mockups/round14-panel.html --variant b --full`). Silent and isolated like the harness; use a scratch build. |
| `tests/` | Test harness (own `package.json`; nothing here ships). |
| `docs/` | Assessment, plan and acceptance, design decisions, design review map, the listening guide, `diagrams/`, `mockups/`. |
| `FINAL_HANDOFF.md`, `SESSION_HANDOFF.md` | **Historical** handoffs from the old project. Their paths under `…/T3 Code/t3-nightly-toy/` are historical. |

Runtime files: `manifest.json`, `background.js` (service worker: capture, presets, Stay-open window), `content.js` (reads Tidal's player bar, runs transport commands), `page-bridge.js` (on Tidal only, inside Tidal's own page: lets the jumps work when the seek bar is hidden), `offscreen.html/.js` (Web Audio DSP), `pitch-shifter.worklet.js` (the key shift), `dynamics.worklet.js` (the bass-only leveler, the loudness match and the look-ahead limiter), `popup.html/.css/.js` (the screen, the window and the mini bar), `physics-view.js` (drawings), `themes.css`, `icons/`.

The old 1.1.0 copy was retired on 2026-10-03 (decision R-24): archived as `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension-1.1.0-retired-2026-10-03.zip` (and as the tag `v1.1.0-extraction-baseline`), the folder removed. Nothing in Chrome points there any more.

## Build

No dependencies are needed to build.

```bash
cd ~/Documents/ChatGPT/tidal-miniplayer-extension
node tools/build.mjs build/review-unpacked     # refresh the review build from the current source
```

Only rebuild `build/review-unpacked` when you intend to refresh the build Chrome is using. After rebuilding, click **Reload** on the extension's card in `chrome://extensions`. A source change never reloads Chrome by itself.

## Load it

`build/review-unpacked` is the review build and, since the cut-over of 2026-10-03 (decision R-24), the everyday extension too. Its path is permanent: an unpacked extension's ID, and with it its saved presets and settings, come from the folder path. Never move or rename it. Every promotion lands there; you click **Reload** on its card in `chrome://extensions`.

- The card shows ID **`gponppchadgoilnlbogcdldbmpdoaeno`** and the current version (see REVIEW_READY).
- If it ever has to be loaded again: `chrome://extensions`, **Developer mode** on, **Load unpacked**, choose `~/Documents/ChatGPT/tidal-miniplayer-extension/build/review-unpacked`; pin it (puzzle piece, then the pin); check **Alt+M** and **Alt+E** at `chrome://extensions/shortcuts`.
- **Review in a separate profile** (optional): profile menu, **Add**, **Continue without an account**, name it *Extension Review*, and load the same folder there. Same ID, separate settings; sign in to Tidal there for Tidal features.

## Everyday use

- **Turn the EQ on**: go to the tab that is playing, click the extension icon, and switch **AUDIO EQ** on. Chrome only lets the extension capture a tab you opened it on. If it refuses, the message tells you which tab to switch to. The badge shows the tab being processed.
- **Stop**: switch **AUDIO EQ** off, or close the tab. The tab's normal audio returns.
- **Band switches**: click PITCH / HPF / LOW / MID / HI / AUTO / VOL (the same words in the popup and the side panel) to take that stage out while keeping its slider value; click again to bring it back. Switched-off rows are dimmed. The state is saved with presets.
- **Switches and bars** (the AUTO, MATCH, LIM and CEIL rows): the menu beside Leveler, Limiter and Ceiling picks the stage's design; the first entry is the original. MATCH switches the loudness match on. The bar on each of those rows is how much that stage is turning the music down at this moment (the bar is full at 12 dB and the figure keeps counting; amber from 3 dB, red from 8 dB; "idle" while the EQ is off). Saving or updating a preset stores them with it. Older presets and the factory ones leave them as they are until you press Update. What each one does and how to compare them: [docs/LISTENING_CHECK.md](docs/LISTENING_CHECK.md).
- **Values**: drag, use − / + (Shift-click for 5× finer steps), or double-click a value to snap it to neutral and double-click again to restore it.
- **Pitch**: moves the key up or down by up to 12 semitones at the same speed (what DJ software calls a key shift). Clean within a few semitones; further out, long notes warble a little and drums can double. It adds about a sixth of a second of delay while in use, which matters only for video; at 0 st it is out of the chain entirely and does no work. Switching it on plays about 0.15 s unshifted first, while the shifter fills up. It applies while the EQ is on.
- **Delay and dropouts** (1.5.2): the EQ hands audio to your output device in 2048-sample blocks (21 ms at 96 kHz), so a moment when the Mac is busy does not become a click. Chrome reports about 35 to 60 ms of delay for the chain (about 10 ms before 1.5.2), plus a little for taking the sound from the tab, which it doesn't report. That matters only for lip sync on video and stays under the roughly 0.1 s at which most people notice sound lagging the picture.
- **Movie mode** (1.5.5–1.5.6): while a video is showing on the captured tab, the EQ uses a shorter buffer so the sound sits closer to the picture and automatically locks **PITCH** off (`0 st`) so saved preset pitch shifts do not add granular delay (restoring your saved semitones when Movie mode turns off). Music with no video keeps the large buffer from 1.5.2. The **MOVIE** button in the status bar reads MOVIE · AUTO when the short buffer turned on by itself. Click it to force the short buffer on or the large one off (MOVIE · ON or MOVIE · OFF). Shift-click returns to automatic. A 16 px status line directly under the AUDIO EQ bar explains the active buffer and Pitch state. The choice lasts until you stop the EQ.
- **Movie Sound** (1.5.7): if you use [Movie Sound](https://github.com/cornishandy/movie-sound) for films in Safari, it follows this EQ live. Pick a preset or move a slider and the film's sound changes with it. The link is one small script, `movie-sound-link.js`, that runs only on Movie Sound's own page (`http://127.0.0.1:8791`) and only reads your EQ settings. Movie Sound ignores the AUDIO EQ switch, and keeps Pitch off for films.
- **Presets**: *+ Save* saves the current values and switches as a new preset; *Update* saves them into the selected custom preset; *↺ Reset* restores the selected preset's saved values, and its switches if it has them (factory values for a default); ✕ deletes a custom preset. Your custom presets are never deleted by Reset.
- **Stay open**: switch it on and the screen moves into Chrome's side panel on the right of the window, where it stays while you click anything on the page; from then on the toolbar icon opens that panel and never closes it (1.5.4; close it with the panel's own X). The popup itself is closed by Chrome whenever you click elsewhere; nothing can change that. Drag the panel's edge to resize it: narrower than 400 px the player stacks (cover top right at 56 px, title up to two lines, full-width transport); wider, it is the normal layout. Chrome itself stops the panel at 360 px. The panel shows no art slice. Switch it off in the panel to go back to the popup. **Alt+M** opens the panel. **Alt+E** toggles the EQ (press it on the playing tab: Chrome only lets the EQ attach to a tab you have opened the extension on). Change shortcuts at `chrome://extensions/shortcuts`.
- **EQ after a restart** (1.5.4): Chrome asks for one click on the extension's toolbar icon on a tab before the EQ may attach to it, again after Chrome restarts or the tab reloads. In the side panel, if switching AUDIO EQ on is refused for that reason, click the icon once: the EQ then turns on by itself.
- **Mini bar**: in the side panel, click **Mini bar**. It floats above every app and stays as long as the panel is open. From the toolbar popup, *Mini bar* first opens the panel for you.
- **Heart**: adds the track to, or removes it from, your Tidal collection by clicking Tidal's own heart in the player bar. If Tidal's heart can't be found on the page, the heart is dimmed and says so.
- **Theme**: the five dots at the bottom.
- **Keyboard**: Tab moves between the controls (a ring shows where you are), arrows move a slider, Space or Enter presses a button or a band switch.
- **After a Reload or an update**: Tidal tabs that were already open keep working; the page script is put back automatically, no page refresh needed.

## Tests (isolated, synthetic, no network)

```bash
cd tests && npm install --ignore-scripts   # one-time: playwright-core only (no install scripts)
npm test                                    # unit: the static checks, the 1.5.2 click proofs, and movie mode (38)
node ../tools/build.mjs /tmp/tme-build && node browser/run.mjs /tmp/tme-build --label local
node browser/glitch-check.mjs /tmp/tme-build --seconds 60 --loop-seconds 90   # dropouts and gaps (diagnostic)
```

The test browser has no audio output at all (`--disable-audio-output`), so nothing is heard while tests run.

The browser harness uses Playwright's *Chrome for Testing* with a **fresh temporary profile**. It blocks every hostname except its own localhost fixture server, **mutes audio output**, and plays only generated sine tones and a fake Tidal page. It never touches your Chrome profile or Tidal. Tab capture is authorised with `--allowlisted-extension-id`, which stands in for the toolbar click that automation can't perform. The audio graph runs at the rate of the Mac's default output device (recorded with each run); the level readings are taken at exact frequencies, so they do not depend on it. Results go to `tests/results/<label>/` (gitignored). The 1.5.7 review run is `tests/results/review-v1.5.7/results.json`: 62/62 on `build/review-unpacked` (commit `69d157bb871bae62bf0b96a58a4e63e58aaaeba6`, fingerprint `2fc9ed67bf1b8577c4d94a11694d7fd010cd28ffd86b84ff6fc800038dd2907b`, `sourceDirty: false`), silent and host-isolated, plus unit 46/46. The Movie Sound link has its own real-Chrome check, `node browser/movie-sound-link.mjs`, which uses a scratch build on a free port (4/4). Chrome caps a toolbar popup at 600 px tall; the harness fails if the screen grows past that.

**Safe manual listening test**: keep system and headphone volume where they already are. Use a quiet YouTube or Tidal track, start from the *Flat (Bypass)* preset, then raise Bass gradually.

## Permissions and privacy

- `tabCapture`, `offscreen`: EQ processing of the tab you choose. Audio stays in Chrome and is never recorded or uploaded.
- `tabs`, `activeTab`, `scripting`, `<all_urls>`: find the media tab, read the track shown on the page, and re-inject the page script into tabs opened before an update.
- `sidePanel`: show the screen in Chrome's side panel (Stay open). UI only; grants no access to pages, audio or devices.
- `storage`: `chrome.storage.local` (no sync) for `presets`, `currentPreset`, `currentParams`, `dynamics`, `visualTheme`, `stayOpen`, `capturedTabId`, `isAudioCapturing`. Movie mode is `movieState` in `chrome.storage.session`: whether the short buffer is on, and whether you forced it. It lasts for that capture and is cleared when the EQ stops.
- **Movie Sound link** (1.5.7): `movie-sound-link.js` runs only on `http://127.0.0.1:8791/*`, a page on this Mac. When that page asks, it posts `presets`, `currentPreset`, `currentParams` and `dynamics` to that page's own window. Nothing else, and nothing leaves the Mac.
- **Network**: the extension makes no requests of its own and reads no Tidal session or token. The one piece of network activity is the cover image, which the screen loads from Tidal's image server while a track is shown (the full-size version of the image Tidal's page shows). A unit test (`no network code`) and a browser check (W-NO-REMOTE-REQUESTS) guard the rest.

## Recovery

- Everyday install: unchanged; it still loads from the old folder.
- Extraction baseline: git tag `v1.1.0-extraction-baseline` (`1b7bedb`). A checksummed backup is under `…/t3-nightly-toy/backups/pre-extraction-backup/`.
- Last build with Playlists, Playlist Lab and the favourite button: tag `v1.1.1-before-ui-removals` (`5355cac`).
- Last build with the header icons, Physics side panel, Micro/Wide modes and the floating button: tag `v1.2.1-before-main-screen` (`6fcb492`).
- To drop the review copy: remove it from the *Extension Review* profile (or delete that profile). Nothing else is affected.
