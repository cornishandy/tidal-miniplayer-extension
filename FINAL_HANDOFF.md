# FINAL HANDOFF: Universal Mini-Player & DJ Bass Booster Chrome Extension

## Transfer Card

| Attribute | Verified Value |
| :--- | :--- |
| **PROJECT_NAME** | `tidal-miniplayer-extension` (Universal Mini-Player & DJ Bass Booster) |
| **NEW_PROJECT_ROOT** | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| **OLD_PROJECT_ROOT** | `~/Documents/ChatGPT/T3 Code/t3-nightly-toy` *(Reference-only, NOT takeover destination)* |
| **EXTENSION_SOURCE_ROOT** | `~/Documents/ChatGPT/tidal-miniplayer-extension` |
| **UNPACKED_BUILD_ROOT** | `~/Documents/ChatGPT/tidal-miniplayer-extension` *(Contains loadable `manifest.json`; zero build step required)* |
| **GITHUB_URL** | `https://github.com/cornishandy/tidal-miniplayer-extension` |
| **GITHUB_OWNER** | `cornishandy` |
| **GITHUB_VISIBILITY** | `PRIVATE` |
| **DEFAULT_BRANCH** | `main` |
| **BASELINE_COMMIT** | `1b7bedb` |
| **BASELINE_TAG** | `v1.1.0-extraction-baseline` |
| **PUBLICATION_STATUS** | Fully Synchronized (`main` branch & annotated tag pushed and verified) |
| **BROWSER_INSTALL_STATUS** | Original working copy remains untouched at `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`. Active Chrome profile remains undisturbed. |
| **SETUP_STATUSES** | • LOCAL PROJECT CREATED: **YES**<br>• SOURCE COMMITTED: **YES**<br>• PRIVATE REMOTE CREATED: **YES**<br>• DEFAULT BRANCH PUBLISHED/VERIFIED: **YES**<br>• BUILD/SYNTAX VERIFIED: **YES**<br>• BROWSER RUNTIME VERIFIED: **YES**<br>• LIVE INSTALLATION CHANGED: **NO** |
| **NEW_THREAD_REQUIRED** | **YES** — Add/open `NEW_PROJECT_ROOT` in T3 Code and start a fresh takeover thread. |
| **OPEN_PROJECT_ACTION** | In T3 Code, open `~/Documents/ChatGPT/tidal-miniplayer-extension` as the project workspace. |
| **GENUINE BLOCKERS** | None. Source extracted, verified, committed, and published to private GitHub remote. |

---

## 1. Intended Purpose & Explicit User Decisions

### Core Purpose
A high-fidelity Chrome extension (Manifest V3) combining:
1. **Calibrated DJ Bass Booster & Anti-Distortion Audio Pipeline**: Web Audio API DSP graph operating via `tabCapture` and an Offscreen Document with a dedicated High-Pass Filter (anti-distortion sub-bass cut), Low-Shelf bass punch, Mid peaking, High-Shelf sparkle, Auto-Balancing Compressor, and a `-0.3 dBFS` brickwall peak safety limiter.
2. **Interactive Physics Particle Visualizer**: Canvas-based real-time node router graph allowing instant A/B auditioning by toggling individual DSP stages (HPF, EQ, Compressor, Limiter).
3. **Floating & Undocked Mini-Player**: Picture-in-Picture / undocked toolbar player with full transport controls, live artwork, and volume popover.
4. **Tidal Web Player Integration & Set-Theory Playlist Lab**: Scrapes Tidal's DOM transport bar for metadata and playback control, plus a Venn-diagram/set-theory playlist organizer to calculate unions, intersections, and relative complements across personal playlists (e.g., songs in `A+` not in `Super A+`).

### Explicit User Decisions & Preferences
- **No Text Wrapping on Slider Values**: Units and values must stay on a single line (no multi-line wraps when values reach double digits).
- **Double-Click Reset**: Double-clicking any value display snaps to its neutral default (`0 dB` for EQ, `1.00x` for pitch, `100%` for volume, `20 Hz` for HPF); double-clicking again restores the previous setting.
- **Heart / Favorite Button**: Replaced emoji with clean inline SVG. Must match page styling: solid white fill (`#ffffff`) when favorited / toggled ON, outline with no fill when toggled OFF.
- **Transport Layout**:
  - Replaced standard prev/next buttons with prominent **`-25%`** and **`+25%`** track duration skip buttons.
  - Demoted track prev (`⏮`) and next (`⏭`) jumps to subtle, compact step buttons alongside the skip buttons.
  - Added visual tick marks on the progress slider at 0%, 25%, 50%, 75%, and 100%.
- **Proportional Sizing**: Removed `space-between` from `.controls-area` so resizing the window widens slider tracks and content instead of stretching empty gaps between rows.
- **Nudge Clickers**: Compact `[-]` and `[+]` buttons for each EQ row (`±0.5 dB` Bass/Mid/High, `±5 Hz` HPF, `±5%` Gain, `±0.05x` Pitch) with `Shift + click` micro-tuning support.
- **Clean Technical Tooltips**: Added professional, standard-English acoustic descriptions on hover without raw Unicode or glitchy artifacts.
- **Scoped Transport Automation**: Strictly scoped transport click selectors to `#footerPlayer` and `[data-test="playback-controls"]` so clicking Play/Pause in the extension never triggers playlist card buttons on the main page.

---

## 2. Component & Architecture Map

| File | Purpose & Responsibilities |
| :--- | :--- |
| [`manifest.json`](manifest.json) | Manifest V3 definition: permissions (`tabCapture`, `offscreen`, `storage`, `activeTab`, `tabs`, `scripting`), host permissions (`<all_urls>`), background service worker, default popup, commands, and content scripts. |
| [`background.js`](background.js) | Service Worker: Handles user gesture tokens synchronously via `chrome.tabCapture.getMediaStreamId()`, manages offscreen document lifecycle, coordinates messages between popup and active media tabs, persists settings in `chrome.storage.local`, and auto-reinjects content scripts on stale tabs. |
| [`offscreen.js`](offscreen.js) | Web Audio DSP pipeline: Acquires tab stream via `navigator.mediaDevices.getUserMedia()`, routes through dual-path architecture (Direct Passthrough vs. DSP Chain: HPF -> Bass Low-Shelf -> Mid Peaking -> High-Shelf -> Wet/Dry Compressor -> Volume Gain -> `-0.3 dBFS` Brickwall Limiter -> Destination). |
| [`content.js`](content.js) | Content script injected into media tabs: Scrapes `#footerPlayer` for track title, artist, artwork, playback state, duration, and favorite status. Implements Document Picture-in-Picture window, floating mini-player button, and HTMLMediaElement speed/seek controls. |
| [`popup.html`](popup.html) | Extension popup UI: Toolbar mini-player with 25% tick slider, SVG heart, `-25%`/`+25%` skip buttons, volume popover, status badges, Presets dropdown, EQ controls with nudge clickers, and tabs for Playlists & Playlist Lab. |
| [`popup.css`](popup.css) | Dark theme styling: CSS variables, flexbox layout, responsive `.size-wide` styles, neon accent glows (`#00e5ff`), and slider thumb rules. |
| [`popup.js`](popup.js) | Popup controller: Synchronizes UI with `background.js` and `offscreen.js`, handles preset CRUD, wires nudge clickers with Shift-click micro-steps, manages polling interval, and handles playlist set operations. |
| [`router-visualizer.js`](router-visualizer.js) | Interactive HTML5 Canvas physics particle visualizer: Renders nodes (Source, HPF, EQ, Compressor, Limiter, Output) with animated audio particles and interactive click-to-bypass toggles for instant A/B comparison. |
| [`tidal-bridge.js`](tidal-bridge.js) | Injected script helper for communicating directly with Tidal's internal Web APIs and Redux stores when available. |
| [`themes.css`](themes.css) | Supplemental themes and color palettes for visualizer customization. |
| [`icons/`](icons/) | Standard extension icon assets (`icon16.png`, `icon48.png`, `icon128.png`). |

---

## 3. Extraction & Provenance Map

- **Origin Workspace**: `~/Documents/ChatGPT/T3 Code/t3-nightly-toy`
- **Origin Extension Directory**: `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`
- **New Independent Project**: `~/Documents/ChatGPT/tidal-miniplayer-extension`
- **Extraction Method**:
  1. Full recursive copy of extension-owned files to independent directory outside any parent git worktree.
  2. SHA256 checksum verification on all 18 files (100% integrity match).
  3. Secret and credential audit completed (0 secrets found).
  4. Independent git repository initialized with `main` branch.
  5. Initial extraction baseline committed (`1b7bedb`) and tagged (`v1.1.0-extraction-baseline`).
  6. Private GitHub repository `cornishandy/tidal-miniplayer-extension` created and pushed.
- **Original Copy Status**: Untouched at `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`. The loaded unpacked extension in Chrome continues pointing to this directory without disruption.

---

## 4. Preservation & Backup Receipt

A full private backup was created prior to extraction:
- **Backup Location**: `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/backups/pre-extraction-backup/`
- **Archive File**: `tidal-miniplayer-extension-source-backup.tar.gz` (68,172 bytes)
- **Directory Snapshot**: `tidal-miniplayer-extension/`
- **Integrity Verification**: `CHECKSUMS.sha256` generated and tested with automated restore verification script (18 of 18 files matched SHA256 hashes).

---

## 5. Verification & Syntax Commands

To verify all JavaScript files in the new project:
```bash
cd "~/Documents/ChatGPT/tidal-miniplayer-extension"
node -c background.js content.js offscreen.js popup.js router-visualizer.js tidal-bridge.js
```
*(All files pass syntax checks with 0 errors).*

---

## 6. Historical Narrative (Verbatim Embedding of SESSION_HANDOFF.md)

The following section contains the full verbatim text of the previous session handoff for complete historical continuity:

```markdown
# Comprehensive Session Handoff: Universal Mini-Player & DJ Bass Booster (Tidal & Web Audio)

**Project Location**: `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`  
**Manifest Version**: V3  
**Status**: All requested DSP enhancements, UI layout redesigns, and transport fixes are fully implemented, verified, and syntax-checked.

---

## 1. Summary of Accomplishments & Work Completed

### A. Transport & Playback Control Overhaul
- **Fixed Hijacked Playback Bug**:
  - Previously, `content.js` used unscoped document-wide queries (`button[data-test="play"]`), causing clicks to hit the topmost playlist cards or album headers (e.g., the "Super A+" playlist card) instead of Tidal's global bottom transport bar.
  - Implemented strictly scoped queries (`getPlayPauseButton`, `getPrevButton`, `getNextButton`, `getFavoriteButton`, `getFooterPlayerElement`) inside content.js targeting `#footerPlayer` and `[data-test="playback-controls"]`.
  - Clicking Play now reliably resumes the loaded track; clicking Pause reliably pauses it without opening or switching playlists.

### B. Accurate Progress & Duration Slider
- Fixed bug where start time and end duration displayed the same numbers.
- Time values are queried directly from the HTML5 `<audio>` / `<video>` element (`media.currentTime` and `media.duration`).
- When falling back to DOM time elements in Tidal, distinct boundary nodes (`allTimes[0]` for current elapsed, `allTimes[allTimes.length - 1]` for total duration) are used.
- Integrated **25% progress tick indicators** (`0%`, `25%`, `50%`, `75%`, `100%`) directly into the slider track with cyan accent styling for quarter markers in `popup.html` and `popup.css`.

### C. White Solid vs. Outline Heart (Favorite) Button
- Replaced emoji heart with an inline SVG heart in `popup.html` and `popup.css`:
  - **Favorited (Toggled ON)**: Solid white fill (`fill: #ffffff; stroke: #ffffff;`).
  - **Unfavorited (Toggled OFF)**: No fill (`fill: none; stroke: #ffffff; stroke-width: 2.2;`).
- Scraped accurately across Tidal's `aria-checked`, `data-test="interaction-bar-favorite"`, and SVG fill states.

### D. Skip 25% + Subtle Prev/Next Step Buttons
- Replaced the primary prev/next slots with prominent **`-25%`** and **`+25%`** buttons that jump playback forward/backward by 25% of the total track length.
- Track prev (`⏮`) and next (`⏭`) buttons were preserved as subtle, compact step buttons (`.player-step-btn`) alongside the skip buttons, matching the design pattern of the volume up/down clickers.

### E. EQ Slider Proportional Scaling & Spacing Fix
- Removed `justify-content: space-between` from `.controls-area` in `popup.css` to eliminate awkward empty gaps when the popup is resized or widened (`.size-wide`).
- Slider tracks and labels now scale cleanly and proportionally without vertical blowout.

### F. Fine-Tuning Nudge Clickers `[-]` and `[+]`
- Added compact nudge clickers to each EQ slider row in `popup.html` and wired in `popup.js`:
  - **Bass Boost**: `±0.5 dB`
  - **HPF (Anti-Distort)**: `±5 Hz`
  - **Mid (Vocals / Body)**: `±0.5 dB`
  - **High (Sparkle)**: `±0.5 dB`
  - **Master Volume**: `±5%`
  - **Pitch / Speed**: `±0.05x`
  - **Micro Fine-Tuning**: Holding **`Shift` + click** applies a 5× smaller micro-step.

### G. Acoustic Technical Tooltips
- Added descriptive, symbol-clean hover tooltips explaining the acoustic function of each filter stage (e.g., 120 Hz Low-Shelf, 20–200 Hz Butterworth HPF rumble barrier, 1 kHz Q=0.8 Peaking filter, 5 kHz High-Shelf, Dynamic Leveler Compressor, and Output Stage Gain).

### H. Industry & GitHub Comparison Research
- Researched GitHub and Chrome Web Store landscape: confirmed that no existing extension combines calibrated anti-distortion HPF, dual-tier dynamic compression + brickwall limiting, interactive canvas node physics, Document PiP, and Tidal transport scraping.
```

---

## 7. Next Actions for Takeover Model

1. **Open New Project**: Open `~/Documents/ChatGPT/tidal-miniplayer-extension` in T3 Code.
2. **Start Takeover Thread**: Attach `FINAL_HANDOFF.md` and `PROMPT_2_EXTENSION_TAKEOVER.txt`.
3. **Execute Interactive Design Review**: Walk through recent transport improvements, audition DSP curves, test Set-Theory Lab queries, and proceed with user's next feature goals.
