// content.js - Reads Tidal's bottom player bar (or any tab's media element) and runs the
// transport commands the popup sends. No UI is injected into the page.

(function() {
  if (window.__TIDAL_MINIPLAYER_INJECTED__) return;
  window.__TIDAL_MINIPLAYER_INJECTED__ = true;

  const isTidal = window.location.hostname.includes('tidal.com');
  let currentTrackInfo = null;

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
    const artEl = footer.querySelector('img[data-test="current-media-imagery"], .media-imagery img, figure[data-test="imagery"] img, img');
    const playBtn = getPlayPauseButton();

    let title = titleEl ? titleEl.textContent.trim() : 'No Track Playing';
    let artist = artistEl ? artistEl.textContent.trim() : 'Tidal';
    let artwork = artEl ? (artEl.src || artEl.getAttribute('srcset')?.split(' ')[0] || '') : '';
    let isPlaying = playBtn ? (playBtn.getAttribute('data-test') === 'pause' || (playBtn.getAttribute('aria-label') || '').toLowerCase().includes('pause')) : false;

    if (navigator.mediaSession && navigator.mediaSession.metadata) {
      const meta = navigator.mediaSession.metadata;
      if (meta.title && (title === 'No Track Playing' || !title)) title = meta.title;
      if (meta.artist && (artist === 'Tidal' || !artist)) artist = meta.artist;
      if (!artwork && meta.artwork && meta.artwork.length > 0) artwork = meta.artwork[meta.artwork.length - 1].src;
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

  function seekAudio(targetSecs) {
    const media = document.querySelector('audio, video');
    if (media && !isNaN(targetSecs)) {
      const max = isFinite(media.duration) && media.duration > 0 ? media.duration : Infinity;
      media.currentTime = Math.max(0, Math.min(max, targetSecs));
    }
  }

  function setPlaybackSpeed(spd) {
    document.querySelectorAll('audio, video').forEach(m => { m.playbackRate = spd; });
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
    }
  });
})();
