// content.js - Content script: reads the Tidal player bar, transport commands, floating button and Document PiP window

(function() {
  if (window.__TIDAL_MINIPLAYER_INJECTED__) return;
  window.__TIDAL_MINIPLAYER_INJECTED__ = true;

  let isTidal = window.location.hostname.includes('tidal.com');
  let pipWindow = null;
  let floatingBtn = null;
  let isMicroMode = false;
  let isEqActive = false;
  let routerVisualizer = null;
  let currentTrackInfo = null;

  let pipPresets = {};
  let pipFactoryPresets = [];
  let pipCurrentPreset = "Punchy Bass & Clarity";
  let activePresetBaseline = null;

  // 1. Tidal DOM Scrapers & Media Controls
  function getTrackInfo() {
    if (!isTidal) {
      const media = document.querySelector('audio, video');
      return {
        title: document.title || 'Web Audio',
        artist: window.location.hostname,
        artwork: '',
        isPlaying: media ? !media.paused : true,
        currentTime: media ? media.currentTime : 0,
        duration: media ? media.duration : 0
      };
    }

    // Strictly scoped to the bottom footer / transport controls!
    const footer = getFooterPlayerElement() || document;
    const titleEl = footer.querySelector('[data-test="footer-track-title"], [data-test="track-title"], .track-title, a[href^="/album/"][class*="title"]') || document.querySelector('[data-test="footer-track-title"]');
    const artistEl = footer.querySelector('[data-test="track-artist"], .artist-link, a[href^="/artist/"]') || document.querySelector('#footerPlayer .artist-link');
    const artEl = footer.querySelector('img[data-test="current-media-imagery"], .media-imagery img, figure[data-test="imagery"] img, img');
    const playBtn = getPlayPauseButton();

    let title = titleEl ? titleEl.textContent.trim() : 'No Track Playing';
    let artist = artistEl ? artistEl.textContent.trim() : 'Tidal';
    let artwork = artEl ? (artEl.src || artEl.getAttribute('srcset')?.split(' ')[0] || '') : '';
    let isPlaying = playBtn ? (playBtn.getAttribute('data-test') === 'pause' || (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause')) : false;

    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      const meta = navigator.mediaSession.metadata;
      if (meta.title && (title === 'No Track Playing' || !title)) {
        title = meta.title;
      }
      if (meta.artist && (artist === 'Tidal' || !artist)) {
        artist = meta.artist;
      }
      if (!artwork && meta.artwork && meta.artwork.length > 0) {
        artwork = meta.artwork[meta.artwork.length - 1].src;
      }
    }
    if (navigator.mediaSession && navigator.mediaSession.playbackState) {
      if (navigator.mediaSession.playbackState === 'playing') {
        isPlaying = true;
      } else if (navigator.mediaSession.playbackState === 'paused' && !playBtn) {
        isPlaying = false;
      }
    }

    let currentTime = 0;
    let duration = 0;

    // 1. Audio element provides accurate time
    const media = document.querySelector('audio, video');
    if (media && !isNaN(media.duration) && media.duration > 0) {
      currentTime = media.currentTime || 0;
      duration = media.duration || 0;
    }

    // 2. Fallback to DOM time elements if needed
    const allTimes = footer.querySelectorAll('time, [data-test="current-time"], [data-test="duration"], .current-time, .duration');
    if (allTimes.length >= 2) {
      const curVal = parseTimeToSeconds(allTimes[0].textContent.trim());
      const durVal = parseTimeToSeconds(allTimes[allTimes.length - 1].textContent.trim());
      if (durVal > 0 && (!duration || duration <= 0)) {
        duration = durVal;
      }
      if (curVal >= 0 && (!media || Math.abs(currentTime - curVal) > 2)) {
        currentTime = curVal;
      }
    } else if (allTimes.length === 1 && (!duration || duration <= 0)) {
      duration = parseTimeToSeconds(allTimes[0].textContent.trim());
    }

    currentTrackInfo = { title, artist, artwork, isPlaying, currentTime, duration };
    return currentTrackInfo;
  }

  function parseTimeToSeconds(tStr) {
    if (!tStr) return 0;
    const parts = tStr.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  // Scoped transport queries
  function getFooterPlayerElement() {
    return document.querySelector('#footerPlayer, [data-test="footer-player"], footer');
  }

  function getPlaybackControlsElement() {
    return document.querySelector('[data-test="playback-controls"], #footerPlayer [data-test="playback-controls"], footer [data-test="playback-controls"]');
  }

  function getPlayPauseButton() {
    const controls = getPlaybackControlsElement();
    if (controls) {
      const btn = controls.querySelector('button[data-test="play"], button[data-test="pause"], button[aria-label="Play"], button[aria-label="Pause"], button[data-type="button__play"]');
      if (btn) return btn;
    }
    const footer = getFooterPlayerElement();
    if (footer) {
      const btn = footer.querySelector('button[data-test="play"], button[data-test="pause"], button[aria-label="Play"], button[aria-label="Pause"], button[data-type="button__play"]');
      if (btn) return btn;
    }
    return document.querySelector('#footerPlayer button, [data-test="footer-player"] button');
  }

  function getPrevButton() {
    const controls = getPlaybackControlsElement() || getFooterPlayerElement() || document;
    return controls.querySelector('button[data-test="previous"], button[aria-label="Previous"], button[aria-label="Previous track"]');
  }

  function getNextButton() {
    const controls = getPlaybackControlsElement() || getFooterPlayerElement() || document;
    return controls.querySelector('button[data-test="next"], button[aria-label="Next"], button[aria-label="Next track"]');
  }

  function togglePlayPause() {
    const playBtn = getPlayPauseButton();
    if (playBtn) {
      playBtn.click();
    } else {
      const media = document.querySelector('audio, video');
      if (media) {
        if (media.paused) media.play();
        else media.pause();
      }
    }
    setTimeout(getTrackInfo, 100);
  }

  function prevTrack() {
    const btn = getPrevButton();
    if (btn) btn.click();
    setTimeout(getTrackInfo, 250);
  }

  function nextTrack() {
    const btn = getNextButton();
    if (btn) btn.click();
    setTimeout(getTrackInfo, 250);
  }

  function seekAudio(targetSecs) {
    const media = document.querySelector('audio, video');
    if (media && !isNaN(targetSecs)) {
      media.currentTime = targetSecs;
    }
  }

  function setPlaybackSpeed(spd) {
    const media = document.querySelectorAll('audio, video');
    media.forEach(m => { m.playbackRate = spd; });
  }

  function setMediaVolume(vol) {
    const media = document.querySelectorAll('audio, video');
    const clamped = Math.max(0, Math.min(1, vol));
    media.forEach(m => { m.volume = clamped; });
  }

  // 2. Floating Button on Webpage
  function injectFloatingButton() {
    if (floatingBtn || document.getElementById('tidal-pip-floating-btn')) return;

    floatingBtn = document.createElement('div');
    floatingBtn.id = 'tidal-pip-floating-btn';
    floatingBtn.innerHTML = `
      <div class="t-pip-icon">🎧</div>
      <div class="t-pip-text">Mini-Player</div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #tidal-pip-floating-btn {
        position: fixed;
        bottom: 80px;
        right: 20px;
        z-index: 9999999;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        background: #121216;
        color: #00e5ff;
        border: 1px solid rgba(0, 229, 255, 0.4);
        border-radius: 20px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.6), 0 0 10px rgba(0,229,255,0.2);
        cursor: pointer;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        font-weight: 700;
        transition: transform 0.15s, box-shadow 0.15s;
        user-select: none;
      }
      #tidal-pip-floating-btn:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 20px rgba(0,0,0,0.8), 0 0 16px rgba(0,229,255,0.4);
      }
      .t-pip-icon { font-size: 14px; }
      .t-pip-text { letter-spacing: 0.5px; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(floatingBtn);

    // Draggable & Click
    let isDragging = false;
    let startX, startY, origX, origY;

    floatingBtn.onmousedown = (e) => {
      isDragging = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = floatingBtn.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;

      const onMouseMove = (ev) => {
        if (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4) {
          isDragging = true;
          floatingBtn.style.right = 'auto';
          floatingBtn.style.bottom = 'auto';
          floatingBtn.style.left = `${origX + (ev.clientX - startX)}px`;
          floatingBtn.style.top = `${origY + (ev.clientY - startY)}px`;
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    floatingBtn.onclick = () => {
      if (!isDragging) {
        toggleDocumentPiP();
      }
    };
  }

  function removeFloatingButton() {
    if (floatingBtn) {
      floatingBtn.remove();
      floatingBtn = null;
    }
  }

  // 3. Native Document Picture-in-Picture Mini-Player
  async function toggleDocumentPiP() {
    if (pipWindow) {
      pipWindow.close();
      pipWindow = null;
      return;
    }

    if (!('documentPictureInPicture' in window)) {
      chrome.runtime.sendMessage({ type: 'CREATE_FALLBACK_WINDOW' });
      return;
    }

    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 360,
        height: 540
      });

      setupPiPWindow(pipWindow);
    } catch (err) {
      console.warn('Document PiP request error, falling back:', err);
      chrome.runtime.sendMessage({ type: 'CREATE_FALLBACK_WINDOW' });
    }
  }

  function setupPiPWindow(win) {
    const doc = win.document;
    doc.title = 'Tidal DJ Bass & Mini-Player';

    const linkTheme = doc.createElement('link');
    linkTheme.rel = 'stylesheet';
    linkTheme.href = chrome.runtime.getURL('themes.css');
    doc.head.appendChild(linkTheme);

    const linkPopupCss = doc.createElement('link');
    linkPopupCss.rel = 'stylesheet';
    linkPopupCss.href = chrome.runtime.getURL('popup.css');
    doc.head.appendChild(linkPopupCss);

    doc.body.innerHTML = `
      <div class="popup-container">
       <div class="popup-main">
        <!-- Header -->
        <header class="header">
          <div class="logo">
            <span class="logo-icon">🎧</span>
            <span class="logo-text">TIDAL DJ</span>
          </div>
          <div class="header-actions">
            <button id="btn-size-toggle" class="btn-icon" title="Toggle Compact / Wide Window">↔️</button>
            <button id="btn-open-router" class="btn-icon" title="Audio Signal Path & Physics">🔬</button>
            <button id="btn-micro-toggle" class="btn-icon" title="Switch to Micro Player Mode">▫️</button>
            <button id="btn-theme-toggle" class="btn-icon" title="Cycle Visual Themes">🎨</button>
            <button id="btn-close-pip" class="btn-icon" title="Close Always-on-Top Window" style="color: #ff5252;">✕</button>
          </div>
        </header>

        <!-- MICRO-PLAYER VIEW (Visible in Micro Mode) -->
        <div class="micro-container" id="micro-container">
          <img class="micro-art" id="micro-art" src="" alt="Art">
          <div class="micro-info">
            <div class="micro-title" id="micro-title">Connecting...</div>
            <div class="micro-artist" id="micro-artist">Media Tab</div>
          </div>
          <div class="micro-actions">
            <button class="micro-btn" id="micro-btn-prev" title="Previous Track">⏮</button>
            <button class="micro-btn micro-btn-play" id="micro-btn-play" title="Play / Pause">▶</button>
            <button class="micro-btn" id="micro-btn-next" title="Next Track">⏭</button>
            <button class="micro-eq-pill inactive" id="micro-eq-pill" title="Toggle EQ">○ EQ</button>
            <button class="micro-btn" id="btn-exit-micro" title="Expand to Full Player" style="font-size: 13px; color: var(--accent, #00e5ff); margin-left: 2px;">↗</button>
          </div>
        </div>

        <!-- Compact Toolbar Player Bar -->
        <div class="toolbar-player">
          <div class="player-art-wrap">
            <img id="player-art" class="player-art" src="" alt="Art">
          </div>
          <div class="player-info-wrap">
            <div class="player-title" id="player-title">Connecting...</div>
            <div class="player-artist" id="player-artist">Media Tab</div>
            <div class="player-progress-row">
              <span id="player-time-cur" class="player-time">0:00</span>
              <input type="range" id="player-progress" class="player-slider" min="0" max="100" value="0">
              <span id="player-time-dur" class="player-time">0:00</span>
            </div>
          </div>
          <div class="player-controls">
            <button id="player-btn-prev" class="player-ctrl-btn" title="Previous Track">⏮</button>
            <button id="player-btn-play" class="player-ctrl-btn player-play" title="Play / Pause">▶</button>
            <button id="player-btn-next" class="player-ctrl-btn" title="Next Track">⏭</button>
          </div>
        </div>

        <!-- Master EQ Power Switch Bar -->
        <div class="status-bar">
          <div class="eq-power-group">
            <span class="power-title">AUDIO EQ:</span>
            <label class="switch power-switch" title="Turn EQ On/Off">
              <input type="checkbox" id="toggle-eq-power">
              <span class="slider-round"></span>
            </label>
            <span id="eq-power-status-badge" class="power-badge off">○ OFF</span>
          </div>
        </div>

        <!-- EQ Controls -->
        <div class="eq-pane">
          <section class="section preset-section">
            <div class="section-title-row">
              <div style="display: flex; align-items: center; gap: 6px;">
                <label for="preset-select" class="section-title">PRESETS</label>
                <span id="preset-status-badge" class="preset-badge-saved">● Saved</span>
              </div>
            </div>
            <select id="preset-select" class="preset-dropdown"></select>
          </section>

          <main class="controls-area">
            <div class="eq-row">
              <div class="eq-label">🔊 Bass Boost</div>
              <input type="range" id="slider-bass" class="eq-slider" min="0" max="14" step="0.5" value="5.0">
              <span class="eq-val" id="val-bass">+5.0 dB</span>
            </div>
            <div class="eq-row">
              <div class="eq-label">🛡️ HPF (Cut)</div>
              <input type="range" id="slider-hpf" class="eq-slider" min="20" max="200" step="5" value="30">
              <span class="eq-val" id="val-hpf">30 Hz</span>
            </div>
            <div class="eq-row">
              <div class="eq-label">🎤 Mid (Vocals)</div>
              <input type="range" id="slider-mid" class="eq-slider" min="-6" max="6" step="0.5" value="1.5">
              <span class="eq-val" id="val-mid">+1.5 dB</span>
            </div>
            <div class="eq-row">
              <div class="eq-label">✨ High (Sparkle)</div>
              <input type="range" id="slider-high" class="eq-slider" min="-6" max="6" step="0.5" value="2.0">
              <span class="eq-val" id="val-high">+2.0 dB</span>
            </div>
            <div class="toggle-row">
              <div class="eq-label">⚖️ Auto-Balancing</div>
              <label class="switch">
                <input type="checkbox" id="toggle-autobalance" checked>
                <span class="slider-round"></span>
              </label>
            </div>
            <div class="eq-row">
              <div class="eq-label">🚀 Master Volume</div>
              <input type="range" id="slider-gain" class="eq-slider" min="0.5" max="2.5" step="0.05" value="1.0">
              <span class="eq-val" id="val-gain">100%</span>
            </div>
            <div class="eq-row">
              <div class="eq-label">🎛️ Pitch / Speed</div>
              <input type="range" id="slider-pitch" class="eq-slider" min="0.75" max="1.3" step="0.05" value="1.0">
              <span class="eq-val" id="val-pitch">1.00x</span>
            </div>
          </main>
        </div>
       </div>
      </div>
    `;

    // Load router-visualizer into PiP window
    const scriptVisualizer = doc.createElement('script');
    scriptVisualizer.src = chrome.runtime.getURL('router-visualizer.js');
    scriptVisualizer.onload = () => {
      routerVisualizer = new win.AudioRouterVisualizer({
        container: doc.querySelector('.popup-container'),
        doc: doc
      });
      doc.getElementById('btn-open-router').onclick = () => routerVisualizer.toggle();
    };
    doc.head.appendChild(scriptVisualizer);

    setupPiPControls(win);

    win.addEventListener('pagehide', () => {
      pipWindow = null;
    });
  }

  function setupPiPControls(win) {
    const doc = win.document;
    const btnClosePip = doc.getElementById('btn-close-pip');
    const btnMicroToggle = doc.getElementById('btn-micro-toggle');
    const btnExitMicro = doc.getElementById('btn-exit-micro');
    const btnSizeToggle = doc.getElementById('btn-size-toggle');

    const toggleEqPower = doc.getElementById('toggle-eq-power');
    const eqPowerStatusBadge = doc.getElementById('eq-power-status-badge');
    const microEqPill = doc.getElementById('micro-eq-pill');

    const playerArt = doc.getElementById('player-art');
    const playerTitle = doc.getElementById('player-title');
    const playerArtist = doc.getElementById('player-artist');
    const playerProgress = doc.getElementById('player-progress');
    const playerTimeCur = doc.getElementById('player-time-cur');
    const playerTimeDur = doc.getElementById('player-time-dur');
    const playerBtnPrev = doc.getElementById('player-btn-prev');
    const playerBtnPlay = doc.getElementById('player-btn-play');
    const playerBtnNext = doc.getElementById('player-btn-next');

    const microArt = doc.getElementById('micro-art');
    const microTitle = doc.getElementById('micro-title');
    const microArtist = doc.getElementById('micro-artist');
    const microBtnPrev = doc.getElementById('micro-btn-prev');
    const microBtnPlay = doc.getElementById('micro-btn-play');
    const microBtnNext = doc.getElementById('micro-btn-next');

    if (btnClosePip) btnClosePip.onclick = () => win.close();

    function setMicro(active) {
      isMicroMode = active;
      if (isMicroMode) {
        doc.body.classList.add('micro-mode');
        try { win.resizeTo(360, 95); } catch (e) {}
      } else {
        doc.body.classList.remove('micro-mode');
        try { win.resizeTo(360, 540); } catch (e) {}
      }
    }

    if (btnMicroToggle) btnMicroToggle.onclick = () => setMicro(!isMicroMode);
    if (btnExitMicro) btnExitMicro.onclick = () => setMicro(false);

    if (btnSizeToggle) {
      btnSizeToggle.onclick = () => {
        const isWide = doc.body.classList.toggle('size-wide');
        try { win.resizeTo(isWide ? 490 : 360, 540); } catch (e) {}
      };
      btnSizeToggle.ondblclick = () => {
        doc.body.classList.remove('size-wide');
        try { win.resizeTo(360, 540); } catch (e) {}
      };
    }

    const doPlay = () => { togglePlayPause(); syncTrack(); };
    const doPrev = () => { prevTrack(); syncTrack(); };
    const doNext = () => { nextTrack(); syncTrack(); };

    playerBtnPlay.onclick = doPlay;
    if (microBtnPlay) microBtnPlay.onclick = doPlay;
    playerBtnPrev.onclick = doPrev;
    if (microBtnPrev) microBtnPrev.onclick = doPrev;
    playerBtnNext.onclick = doNext;
    if (microBtnNext) microBtnNext.onclick = doNext;

    function syncTrack() {
      const info = getTrackInfo();
      playerTitle.textContent = info.title;
      playerArtist.textContent = info.artist;
      if (microTitle) microTitle.textContent = info.title;
      if (microArtist) microArtist.textContent = info.artist;

      if (info.artwork) {
        playerArt.src = info.artwork;
        playerArt.style.display = 'block';
        if (microArt) { microArt.src = info.artwork; microArt.style.display = 'block'; }
      } else {
        playerArt.style.display = 'none';
        if (microArt) microArt.style.display = 'none';
      }

      const playSym = info.isPlaying ? '⏸' : '▶';
      playerBtnPlay.textContent = playSym;
      if (microBtnPlay) microBtnPlay.textContent = playSym;

      if (info.duration > 0) {
        playerProgress.value = (info.currentTime / info.duration) * 100;
        playerTimeCur.textContent = formatSecs(info.currentTime);
        playerTimeDur.textContent = formatSecs(info.duration);
      }
    }

    function formatSecs(s) {
      if (isNaN(s) || s === Infinity) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec < 10 ? '0' : ''}${sec}`;
    }

    syncTrack();
    const pollId = setInterval(syncTrack, 1000);
    win.addEventListener('unload', () => clearInterval(pollId));

    function updateEqBadge(active) {
      isEqActive = !!active;
      if (toggleEqPower) toggleEqPower.checked = isEqActive;
      if (eqPowerStatusBadge) {
        if (isEqActive) {
          eqPowerStatusBadge.className = 'power-badge on';
          eqPowerStatusBadge.textContent = '● ON';
        } else {
          eqPowerStatusBadge.className = 'power-badge off';
          eqPowerStatusBadge.textContent = '○ OFF';
        }
      }
      if (microEqPill) {
        if (isEqActive) {
          microEqPill.className = 'micro-eq-pill active';
          microEqPill.textContent = '● EQ';
        } else {
          microEqPill.className = 'micro-eq-pill inactive';
          microEqPill.textContent = '○ EQ';
        }
      }
      if (routerVisualizer) routerVisualizer.updateState(getPiPParams(doc), isEqActive);
    }

    function toggleEq() {
      if (isEqActive) {
        chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, () => {
          updateEqBadge(false);
          setPlaybackSpeed(1.0);
        });
      } else {
        chrome.runtime.sendMessage({ type: 'START_CAPTURE_FOR_TAB' }, (res) => {
          if (res?.success) updateEqBadge(true);
        });
      }
    }

    if (toggleEqPower) toggleEqPower.onchange = toggleEq;
    if (microEqPill) microEqPill.onclick = toggleEq;

    setupPiPEQSliders(win, updateEqBadge);
  }

  function setupPiPEQSliders(win, updateEqBadge) {
    const doc = win.document;
    const presetSelect = doc.getElementById('preset-select');
    const presetStatusBadge = doc.getElementById('preset-status-badge');

    const sliderBass = doc.getElementById('slider-bass');
    const sliderHpf = doc.getElementById('slider-hpf');
    const sliderMid = doc.getElementById('slider-mid');
    const sliderHigh = doc.getElementById('slider-high');
    const sliderGain = doc.getElementById('slider-gain');
    const sliderPitch = doc.getElementById('slider-pitch');
    const toggleAutoBalance = doc.getElementById('toggle-autobalance');

    const valBass = doc.getElementById('val-bass');
    const valHpf = doc.getElementById('val-hpf');
    const valMid = doc.getElementById('val-mid');
    const valHigh = doc.getElementById('val-high');
    const valGain = doc.getElementById('val-gain');
    const valPitch = doc.getElementById('val-pitch');

    function checkPresetMod() {
      if (!activePresetBaseline || !presetStatusBadge) return;
      const cur = getPiPParams(doc);
      const b = activePresetBaseline;
      const isMod =
        Math.abs(cur.bass - b.bass) > 0.01 ||
        Math.abs(cur.hpf - b.hpf) > 0.5 ||
        Math.abs(cur.mid - b.mid) > 0.01 ||
        Math.abs(cur.high - b.high) > 0.01 ||
        Math.abs(cur.gain - b.gain) > 0.01 ||
        Math.abs(cur.pitch - (b.pitch || 1.0)) > 0.01 ||
        cur.autoBalance !== b.autoBalance;

      if (isMod) {
        presetStatusBadge.className = 'preset-badge-modified';
        presetStatusBadge.textContent = '● Modified';
      } else {
        presetStatusBadge.className = 'preset-badge-saved';
        presetStatusBadge.textContent = '● Saved';
      }
    }

    function populate(selName) {
      presetSelect.innerHTML = '';
      const grpFactory = doc.createElement('optgroup');
      grpFactory.label = 'Default Presets';
      const grpCustom = doc.createElement('optgroup');
      grpCustom.label = 'My Custom Presets';

      Object.keys(pipPresets).forEach(n => {
        const opt = doc.createElement('option');
        opt.value = n;
        opt.textContent = n;
        if (pipFactoryPresets.includes(n)) grpFactory.appendChild(opt);
        else grpCustom.appendChild(opt);
      });

      presetSelect.appendChild(grpFactory);
      if (grpCustom.children.length > 0) presetSelect.appendChild(grpCustom);

      if (selName && pipPresets[selName]) {
        presetSelect.value = selName;
        pipCurrentPreset = selName;
      }
      checkPresetMod();
    }

    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (!res) return;
      updateEqBadge(!!res.isCapturing);
      pipPresets = res.presets || {};
      pipFactoryPresets = res.factoryPresets || [];
      pipCurrentPreset = res.currentPreset || "Punchy Bass & Clarity";
      populate(pipCurrentPreset);

      if (res.currentParams) applyPiPParams(doc, res.currentParams);
      activePresetBaseline = pipPresets[pipCurrentPreset] ? { ...pipPresets[pipCurrentPreset] } : null;
      checkPresetMod();

      if (routerVisualizer) routerVisualizer.updateState(res.currentParams, !!res.isCapturing);
    });

    presetSelect.onchange = () => {
      pipCurrentPreset = presetSelect.value;
      const sel = pipPresets[pipCurrentPreset];
      if (sel) {
        activePresetBaseline = { ...sel };
        applyPiPParams(doc, sel);
        sendPiPUpdate(doc);
      }
    };

    function setupToggle(valEl, sliderEl, neutralVal, fmtFn) {
      let prev = parseFloat(sliderEl.value);
      valEl.title = 'Double-click to reset / restore default';
      valEl.ondblclick = (e) => {
        e.preventDefault();
        const cur = parseFloat(sliderEl.value);
        if (Math.abs(cur - neutralVal) < 0.001) {
          const target = (prev !== undefined && Math.abs(prev - neutralVal) >= 0.001) ? prev : parseFloat(sliderEl.defaultValue || neutralVal);
          sliderEl.value = target;
        } else {
          prev = cur;
          sliderEl.value = neutralVal;
        }
        fmtFn(sliderEl.value);
        sendPiPUpdate(doc);
      };
    }

    setupToggle(valBass, sliderBass, 0, (v) => { valBass.textContent = `+${parseFloat(v).toFixed(1)} dB`; });
    setupToggle(valHpf, sliderHpf, 20, (v) => { valHpf.textContent = `${Math.round(v)} Hz`; });
    setupToggle(valMid, sliderMid, 0, (v) => { const n = parseFloat(v); valMid.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`; });
    setupToggle(valHigh, sliderHigh, 0, (v) => { const n = parseFloat(v); valHigh.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`; });
    setupToggle(valGain, sliderGain, 1.0, (v) => { valGain.textContent = `${Math.round(parseFloat(v) * 100)}%`; });
    setupToggle(valPitch, sliderPitch, 1.0, (v) => {
      valPitch.textContent = `${parseFloat(v).toFixed(2)}x`;
      setPlaybackSpeed(parseFloat(v));
    });

    sliderBass.oninput = (e) => { valBass.textContent = `+${parseFloat(e.target.value).toFixed(1)} dB`; sendPiPUpdate(doc); };
    sliderHpf.oninput = (e) => { valHpf.textContent = `${Math.round(e.target.value)} Hz`; sendPiPUpdate(doc); };
    sliderMid.oninput = (e) => { const n = parseFloat(e.target.value); valMid.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`; sendPiPUpdate(doc); };
    sliderHigh.oninput = (e) => { const n = parseFloat(e.target.value); valHigh.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`; sendPiPUpdate(doc); };
    sliderGain.oninput = (e) => { valGain.textContent = `${Math.round(e.target.value * 100)}%`; sendPiPUpdate(doc); };
    sliderPitch.oninput = (e) => {
      const v = parseFloat(e.target.value);
      valPitch.textContent = `${v.toFixed(2)}x`;
      setPlaybackSpeed(v);
      sendPiPUpdate(doc);
    };
    toggleAutoBalance.onchange = () => sendPiPUpdate(doc);
  }

  function getPiPParams(doc) {
    const presetSelect = doc.getElementById('preset-select');
    const sel = pipPresets[presetSelect?.value];
    return {
      bass: parseFloat(doc.getElementById('slider-bass')?.value || 5),
      hpf: parseFloat(doc.getElementById('slider-hpf')?.value || 30),
      mid: parseFloat(doc.getElementById('slider-mid')?.value || 1.5),
      high: parseFloat(doc.getElementById('slider-high')?.value || 2.0),
      gain: parseFloat(doc.getElementById('slider-gain')?.value || 1.0),
      pitch: parseFloat(doc.getElementById('slider-pitch')?.value || 1.0),
      autoBalance: doc.getElementById('toggle-autobalance')?.checked ?? true,
      bypass: sel?.bypass === true,
      // Keep the Physics drawer's A/B stage bypass with every update so it is not silently dropped.
      ...(routerVisualizer?.currentParams?.stageBypass ? { stageBypass: { ...routerVisualizer.currentParams.stageBypass } } : {})
    };
  }

  function applyPiPParams(doc, p) {
    if (typeof p.bass === 'number') {
      doc.getElementById('slider-bass').value = p.bass;
      doc.getElementById('val-bass').textContent = `+${parseFloat(p.bass).toFixed(1)} dB`;
    }
    if (typeof p.hpf === 'number') {
      doc.getElementById('slider-hpf').value = p.hpf;
      doc.getElementById('val-hpf').textContent = `${Math.round(p.hpf)} Hz`;
    }
    if (typeof p.mid === 'number') {
      doc.getElementById('slider-mid').value = p.mid;
      doc.getElementById('val-mid').textContent = `${p.mid >= 0 ? '+' : ''}${parseFloat(p.mid).toFixed(1)} dB`;
    }
    if (typeof p.high === 'number') {
      doc.getElementById('slider-high').value = p.high;
      doc.getElementById('val-high').textContent = `${p.high >= 0 ? '+' : ''}${parseFloat(p.high).toFixed(1)} dB`;
    }
    if (typeof p.gain === 'number') {
      doc.getElementById('slider-gain').value = p.gain;
      doc.getElementById('val-gain').textContent = `${Math.round(p.gain * 100)}%`;
    }
    if (typeof p.pitch === 'number') {
      doc.getElementById('slider-pitch').value = p.pitch;
      doc.getElementById('val-pitch').textContent = `${parseFloat(p.pitch).toFixed(2)}x`;
    }
    if (typeof p.autoBalance === 'boolean') {
      doc.getElementById('toggle-autobalance').checked = p.autoBalance;
    }
  }

  function sendPiPUpdate(doc) {
    const params = getPiPParams(doc);
    chrome.runtime.sendMessage({
      type: 'UPDATE_AUDIO_PARAMS',
      params,
      presetName: pipCurrentPreset
    });
    if (routerVisualizer) routerVisualizer.updateState(params, isEqActive);
  }

  // 4. Message Dispatcher
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'GET_TRACK_INFO':
        sendResponse(getTrackInfo());
        return true;
      case 'TOGGLE_PLAY_PAUSE':
        togglePlayPause();
        sendResponse(getTrackInfo());
        return true;
      case 'PREV_TRACK':
        prevTrack();
        sendResponse(getTrackInfo());
        return true;
      case 'NEXT_TRACK':
        nextTrack();
        sendResponse(getTrackInfo());
        return true;
      case 'SEEK_AUDIO':
        seekAudio(message.time);
        sendResponse({ success: true });
        return true;
      case 'SET_SPEED':
        setPlaybackSpeed(message.speed);
        sendResponse({ success: true });
        return true;
      case 'RESET_SPEED':
        setPlaybackSpeed(1.0);
        sendResponse({ success: true });
        return true;
      case 'SET_VOLUME':
        setMediaVolume(message.volume);
        sendResponse({ success: true, volume: message.volume });
        return true;
      case 'TOGGLE_MINIPLAYER':
      case 'TOGGLE_PIP_MINIPLAYER':
        toggleDocumentPiP();
        sendResponse({ success: true });
        return true;
      case 'TOGGLE_FLOATING_BUTTON':
        if (message.show) injectFloatingButton();
        else removeFloatingButton();
        sendResponse({ success: true });
        return true;
    }
  });

  // Check initial floating button preference
  chrome.storage.local.get('showFloatingButton', (data) => {
    if (data.showFloatingButton !== false) {
      injectFloatingButton();
    }
  });
})();
