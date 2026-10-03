// content.js - Reads Tidal's bottom player bar (or any tab's media element) and runs the
// transport commands the popup sends. No UI is injected into the page.

(function() {
  if (window.__TIDAL_MINIPLAYER_INJECTED__) return;
  window.__TIDAL_MINIPLAYER_INJECTED__ = true;

  const isTidal = window.location.hostname.includes('tidal.com');
  let currentTrackInfo = null;

  // The speed control went away in 1.4.0 (pitch is shifted in the DSP graph now). A Tidal tab left at
  // another rate by an older copy of this script goes back to normal speed.
  if (isTidal) document.querySelectorAll('audio, video').forEach((m) => { if (m.playbackRate !== 1) m.playbackRate = 1; });

  // 1. Track info
  function getTrackInfo() {
    if (!isTidal) {
      const media = document.querySelector('audio, video');
      return {
        title: document.title || 'Web Audio',
        artist: window.location.hostname,
        artwork: '',
        isPlaying: media ? !media.paused : true,
        currentTime: media ? media.currentTime : 0,
        duration: media ? media.duration : 0,
        favoriteFound: false,
        isFavorite: false
      };
    }

    // Strictly scoped to the bottom footer / transport controls
    const footer = getFooterPlayerElement() || document;
    const titleEl = footer.querySelector('[data-test="footer-track-title"], [data-test="track-title"], .track-title, a[href^="/album/"][class*="title"]') || document.querySelector('[data-test="footer-track-title"]');
    const artistEl = footer.querySelector('[data-test="track-artist"], .artist-link, a[href^="/artist/"]') || document.querySelector('#footerPlayer .artist-link');
    const playBtn = getPlayPauseButton();

    let title = titleEl ? titleEl.textContent.trim() : 'No Track Playing';
    let artist = artistEl ? artistEl.textContent.trim() : 'Tidal';
    let artwork = bestArtwork(footer);
    let isPlaying = playBtn ? (playBtn.getAttribute('data-test') === 'pause' || (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause')) : false;

    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      const meta = navigator.mediaSession.metadata;
      if (meta.title && (title === 'No Track Playing' || !title)) title = meta.title;
      if (meta.artist && (artist === 'Tidal' || !artist)) artist = meta.artist;
    }
    if (navigator.mediaSession && navigator.mediaSession.playbackState) {
      if (navigator.mediaSession.playbackState === 'playing') isPlaying = true;
      else if (navigator.mediaSession.playbackState === 'paused' && !playBtn) isPlaying = false;
    }

    let currentTime = 0;
    let duration = 0;

    // The media element gives accurate time; the footer's time labels are the fallback.
    const media = document.querySelector('audio, video');
    if (media && !isNaN(media.duration) && media.duration > 0) {
      currentTime = media.currentTime || 0;
      duration = media.duration || 0;
    }
    const allTimes = footer.querySelectorAll('time, [data-test="current-time"], [data-test="duration"], .current-time, .duration');
    if (allTimes.length >= 2) {
      const curVal = parseTimeToSeconds(allTimes[0].textContent.trim());
      const durVal = parseTimeToSeconds(allTimes[allTimes.length - 1].textContent.trim());
      if (durVal > 0 && (!duration || duration <= 0)) duration = durVal;
      if (curVal >= 0 && (!media || Math.abs(currentTime - curVal) > 2)) currentTime = curVal;
    } else if (allTimes.length === 1 && (!duration || duration <= 0)) {
      duration = parseTimeToSeconds(allTimes[0].textContent.trim());
    }

    const favBtn = getFavoriteButton();
    currentTrackInfo = {
      title, artist, artwork, isPlaying, currentTime, duration,
      favoriteFound: !!favBtn,
      isFavorite: isTrackFavorited(favBtn)
    };
    return currentTrackInfo;
  }

  // The largest cover available: the biggest mediaSession artwork, else the biggest srcset candidate,
  // else the player bar's image. Tidal's image URLs carry the size, so the thumbnail is upgraded to 1280.
  function upgradeTidalImage(url) {
    return url.replace(/\/(\d{2,4})x(\d{2,4})(\.[a-z]+)(\?.*)?$/i, (m, w, h, ext, q) => `/1280x1280${ext}${q || ''}`);
  }

  function bestArtwork(footer) {
    const ms = navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.artwork;
    if (ms && ms.length) {
      let best = null, bestPx = -1;
      for (const a of ms) {
        const m = /(\d+)x(\d+)/.exec(a.sizes || '');
        const px = m ? parseInt(m[1], 10) : 0;
        if (a.src && px > bestPx) { best = a; bestPx = px; }
      }
      if (best) return upgradeTidalImage(best.src);
    }
    const img = footer && footer.querySelector('img[data-test="current-media-imagery"], .media-imagery img, figure[data-test="imagery"] img, img');
    if (!img) return '';
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      let best = '', bw = -1;
      for (const cand of srcset.split(',')) {
        const [u, d] = cand.trim().split(/\s+/);
        const w = parseFloat(d) || 0;
        if (u && w > bw) { best = u; bw = w; }
      }
      if (best) return upgradeTidalImage(best);
    }
    return upgradeTidalImage(img.currentSrc || img.src || '');
  }

  function parseTimeToSeconds(tStr) {
    if (!tStr) return 0;
    const parts = tStr.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  // 2. Scoped transport queries
  function getFooterPlayerElement() {
    return document.querySelector('#footerPlayer, [data-test="footer-player"], footer');
  }

  function getPlaybackControlsElement() {
    return document.querySelector('[data-test="playback-controls"], #footerPlayer [data-test="playback-controls"], footer [data-test="playback-controls"]');
  }

  function getPlayPauseButton() {
    const sel = 'button[data-test="play"], button[data-test="pause"], button[aria-label="Play"], button[aria-label="Pause"], button[data-type="button__play"]';
    const controls = getPlaybackControlsElement();
    if (controls) {
      const btn = controls.querySelector(sel);
      if (btn) return btn;
    }
    const footer = getFooterPlayerElement();
    if (footer) {
      const btn = footer.querySelector(sel);
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

  // Tidal's "My Collection" heart in the footer. Only the footer is searched, never playlist cards.
  function getFavoriteButton() {
    const footer = getFooterPlayerElement();
    if (!footer) return null;
    return footer.querySelector(
      'button[data-test*="favorite" i], button[data-test*="favourite" i], button[data-test="heart"], ' +
      'button[aria-label*="collection" i], button[aria-label*="favorite" i], button[aria-label*="favourite" i], button[aria-label*="like" i]'
    );
  }

  function isTrackFavorited(favBtn) {
    if (!favBtn) return false;
    if (favBtn.getAttribute('aria-checked') === 'true' || favBtn.getAttribute('aria-pressed') === 'true') return true;
    if (favBtn.classList.contains('active')) return true;
    const label = (favBtn.getAttribute('aria-label') || favBtn.getAttribute('title') || '').toLowerCase();
    if (label.includes('remove from') || label.includes('unfavorite') || label.includes('unlike')) return true;
    const svg = favBtn.querySelector('svg');
    if (svg) {
      const fill = svg.getAttribute('fill') || window.getComputedStyle(svg).fill;
      if (fill && fill !== 'none' && fill !== 'transparent' && !fill.includes('rgba(0, 0, 0, 0)')) return true;
      const path = svg.querySelector('path');
      if (path) {
        const pFill = path.getAttribute('fill');
        if (pFill && pFill !== 'none' && pFill !== 'transparent') return true;
      }
    }
    return false;
  }

  // 3. Commands
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

  // Clicks Tidal's own heart. Reports honestly when it cannot be found.
  function toggleFavorite() {
    const favBtn = getFavoriteButton();
    if (!favBtn) return Promise.resolve({ found: false, isFavorite: false });
    favBtn.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        const again = getFavoriteButton();
        resolve({ found: true, isFavorite: isTrackFavorited(again || favBtn) });
      }, 250);
    });
  }

  // Seek: a reachable media element first; otherwise drive the page's own seek bar in the footer
  // (Tidal keeps its player element out of reach). Reports which route worked, or false.
  function seekAudio(targetSecs) {
    if (isNaN(targetSecs)) return { seeked: false };
    const media = document.querySelector('audio, video');
    if (media && isFinite(media.duration) && media.duration > 0) {
      media.currentTime = Math.max(0, Math.min(media.duration, targetSecs));
      return { seeked: 'media' };
    }
    const footer = getFooterPlayerElement();
    const duration = (currentTrackInfo || getTrackInfo()).duration;
    if (!footer || !(duration > 0)) return { seeked: false };
    const frac = Math.max(0, Math.min(1, targetSecs / duration));

    // A native range input (set the value the way a user would, so React-style handlers fire)
    const range = footer.querySelector('input[type="range"]');
    if (range) {
      const min = parseFloat(range.min || '0'), max = parseFloat(range.max || '100');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, String(min + frac * (max - min)));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return { seeked: 'range' };
    }

    // A custom slider: click it at the right spot
    const bar = footer.querySelector('[data-test*="progress" i], [role="slider"], [class*="progress" i], [class*="seek" i]');
    if (bar) {
      const r = bar.getBoundingClientRect();
      if (r.width > 0) {
        const x = r.left + frac * r.width, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        const el = hit && bar.contains(hit) ? hit : bar;
        const init = (down) => ({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
        el.dispatchEvent(new PointerEvent('pointerdown', init(true)));
        el.dispatchEvent(new MouseEvent('mousedown', init(true)));
        el.dispatchEvent(new PointerEvent('pointerup', init(false)));
        el.dispatchEvent(new MouseEvent('mouseup', init(false)));
        el.dispatchEvent(new MouseEvent('click', init(false)));
        return { seeked: 'bar' };
      }
    }
    return { seeked: false };
  }

  function setMediaVolume(vol) {
    const clamped = Math.max(0, Math.min(1, vol));
    document.querySelectorAll('audio, video').forEach(m => { m.volume = clamped; });
  }

  // 4. Message dispatcher
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
      case 'TOGGLE_FAVORITE':
        toggleFavorite().then(sendResponse);
        return true;
      case 'SEEK_AUDIO': {
        const r = seekAudio(message.time);
        sendResponse({ success: r.seeked !== false, ...r });
        return true;
      }
      case 'SET_VOLUME':
        setMediaVolume(message.volume);
        sendResponse({ success: true, volume: message.volume });
        return true;
    }
  });
})();
