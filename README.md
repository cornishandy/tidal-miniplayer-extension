# Tidal Mini-Player & DJ Audio Booster (Chrome Extension)

A Chrome extension for **Tidal Web Player** (`listen.tidal.com`) and any music tab in Google Chrome, featuring:
1. **macOS Always-On-Top Floating Mini-Player**: Uses Chrome's native **Document Picture-in-Picture API** (`documentPictureInPicture`). Floats over all macOS applications with live artwork, scrub bar, and transport controls.
2. **DJ-Grade Audio Engine**:
   - **Punchy Bass Boost** (Low-shelf @ 100Hz + Sub-peak @ 65Hz) with warm analog-style soft limiting.
   - **HPF (High-Pass Filter / Anti-Distortion)**: Just like the DJ extension you use, nudge this slider to the right (e.g. 50–80Hz) to cut out sub-audible rumble and immediately eliminate speaker distortion/buzzing when the bass is cranked!
   - **Vocals (Mid) & Sparkle (High)**: Dedicated knobs to bring out vocal presence and crisp high frequencies.
   - **Auto-Balancing (Smart Leveler)**: One-click dynamic range compression that automatically levels out loud vs quiet tracks so you never have to adjust volume between songs or tweak complex compressor ratios/attacks.
   - **Volume Booster**: Up to 400% gain with zero digital harshness.
   - **Pitch / Speed Slider**: DJ-style tempo adjustment.
3. **Saved States & Presets**:
   - Built-in presets: *Punchy Bass & Clarity*, *Deep Bass Head*, *Clean DJ (Anti-Distortion)*, *Vocal Focus*, *Flat (Bypass)*.
   - **+ Save State**: Save your own custom configurations by name with a single click.
4. **Smart Playlist Manager**:
   - Lists your Tidal playlists.
   - **Pre-checkmarks** any playlist that already contains the currently playing song to prevent duplicate additions.
   - Check or uncheck a playlist to instantly add or remove the track.

---

## 🚀 How to Install in Chrome on macOS

1. Open Google Chrome.
2. In the URL bar, go to: `chrome://extensions`
3. Toggle on **Developer mode** in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select this folder:
   `~/Documents/ChatGPT/T3 Code/t3-nightly-toy/tidal-miniplayer-extension`
6. Pin the extension to your Chrome toolbar for quick access!

---

## 🎧 How to Use

### 1. Launching the Mini-Player
* **Option A (From Tidal)**: Open [listen.tidal.com](https://listen.tidal.com). You will see a floating **"🎛️ Mini-Player"** button in the bottom-right corner. Click it to launch the native macOS always-on-top floating window!
* **Option B (From Chrome Toolbar)**: Click the extension icon in Chrome's toolbar, then click **"🎛️ Pop Out Mini-Player"**.

### 2. DJ Audio & Bass Boost
* **Bass Boost**: Increase to add deep, warm sub-bass punch.
* **HPF (Anti-Distortion Filter)**: If you crank the bass and hear rattle, buzz, or distortion from your headphones/speakers, **nudge the HPF slider to the right**. This filters out extreme subsonic frequencies and tightens up the kick!
* **Auto-Balancing**: Toggle this switch to automatically equalize volume levels between different tracks.
* **Save State**: Click **"+ Save State"** in the popup to name and store your favorite settings.

### 3. Playlist Management
* Inside the Mini-Player, switch to the **"📂 MY PLAYLISTS"** tab.
* Any playlist that already contains the song will have a checkmark and an **"Already Added"** badge.
* Click any checkbox to add or remove the song instantly.
