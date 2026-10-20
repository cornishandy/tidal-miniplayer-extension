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
        mediaSrc: media ? media.currentSrc || media.src || '' : '',
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
    // A narrow Tidal page drops its time labels: ask the page itself (page-bridge.js).
    if (!(duration > 0) || allTimes.length < 2) {
      const s = bridge('state');
      if (s && s.duration > 0) { duration = s.duration; currentTime = s.currentTime; }
    }

    const favBtn = getFavoriteButton();
    currentTrackInfo = {
      title, artist, artwork, isPlaying, currentTime, duration,
      trackUrl: titleEl ? titleEl.href || titleEl.closest('a[href]')?.href || '' : '',
      mediaSrc: media ? media.currentSrc || media.src || '' : '',
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

  // `orEnd` (a forward jump that reaches the end): if no Next takes, play the track out to its end.
  // A disabled Next is the end of the queue: then Tidal's next-track handler is not tried either.
  async function nextTrack(orEnd = false) {
    const btn = getNextButton();
    const disabled = !!btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true');
    const course = startCourse();
    const advanced = (now) => now.title !== course.title || now.artist !== course.artist
      || (course.trackUrl && now.trackUrl && now.trackUrl !== course.trackUrl)
      || (course.mediaSrc && now.mediaSrc && now.mediaSrc !== course.mediaSrc)
      || now.currentTime < Math.min(3, course.from); // an observed restart, even near the start
    let route = false;
    if (btn && !disabled) { btn.click(); route = 'button'; }
    else if (!btn && isTidal) route = (bridge('next') || {}).next || false; // a narrow page without the button
    // Never follow a clicked Next button with another attempt: a slow Next could otherwise skip twice.
    // Keep the existing no-button session -> track-end fallback, but only after a confirmed timeout.
    if (route) {
      const outcome = await watch(advanced, course, 15);
      if (outcome === 'done') return { status: 'confirmed', next: route };
      if (outcome !== 'timeout') return { status: 'cancelled', next: false };
      if (route === 'button' || !orEnd) return { status: 'exhausted', next: false, reason: 'next' };
    }
    if (orEnd && course.seq === transportSeq) {
      const info = getTrackInfo();
      // Playing: land just before the end and let it play out. Paused: the very end, so the track ends now.
      if (info.duration > 0) {
        const result = await seekAudio(info.isPlaying ? info.duration - 0.25 : info.duration, course);
        return { ...result, next: result.status === 'confirmed' ? 'end' : false };
      }
    }
    return { status: 'exhausted', next: false, reason: 'next' };
  }

  // Tidal moves playback a moment after it is asked, if at all. `watch` checks every 200 ms (6 times: 1.2 s),
  // whether `done` has happened. It stops early, leaving everything as it is, when a newer command came in,
  // the track changed, or the time left its old course without reaching the goal (someone else moved it,
  // for instance in Tidal itself). Only 'timeout' means the request demonstrably did nothing.
  function startCourse() {
    const now = getTrackInfo();
    return { from: now.currentTime || 0, playing: !!now.isPlaying, title: now.title, artist: now.artist,
      trackUrl: now.trackUrl, mediaSrc: now.mediaSrc, seq: transportSeq, t0: performance.now() };
  }

  async function watch(done, course, steps = 6, read = getTrackInfo) {
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (course.seq !== transportSeq) return 'stale';
      const now = read();
      if (done(now)) return 'done';
      if (now.title !== course.title) return 'stale';
      const expected = course.from + (course.playing ? (performance.now() - course.t0) / 1000 : 0);
      if (Math.abs(now.currentTime - expected) > 3) return 'moved';
    }
    return 'timeout';
  }

  // Tidal's page-world helper (page-bridge.js) answers synchronously while the request event is dispatched.
  // Only strings cross between the worlds; only the reply carrying this request's id counts. null when the
  // helper is not there (other sites, or a Tidal tab opened before 1.5.3).
  let bridgeSeq = 0;
  let transportSeq = 0; // counts the commands that move playback, so a pending seek check never acts on a newer one
  function bridge(op, args = {}) {
    const id = `${Date.now()}-${++bridgeSeq}`;
    let reply = null;
    const onReply = (e) => {
      try { const m = JSON.parse(e.detail); if (m && m.id === id) reply = m.reply; } catch (_) { /* not ours */ }
    };
    document.addEventListener('tme-bridge-reply', onReply);
    try {
      document.dispatchEvent(new CustomEvent('tme-bridge-request', { detail: JSON.stringify({ id, op, ...args }) }));
    } finally {
      document.removeEventListener('tme-bridge-reply', onReply);
    }
    return reply;
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

  // Seek: a reachable media element first; otherwise, on Tidal, one route after another until one takes:
  // the page's own seek bar in the footer (verified on real Tidal), then through page-bridge.js Tidal's own
  // seek handler, then its player element. A route is left for the next only when `watch` shows it did
  // nothing; anything else (done, a newer command, another change) ends the attempt. The target is
  // absolute, so a later route never jumps twice. Only a confirmed route reports a seek; cancellation
  // leaves the user's newer action alone, while exhaustion explains which capability was missing.
  async function seekAudio(targetSecs, course = null) {
    if (!Number.isFinite(targetSecs)) return { status: 'exhausted', seeked: false, reason: 'seek' };
    course = course || startCourse();
    const media = document.querySelector('audio, video');
    const reachable = media && isFinite(media.duration) && media.duration > 0;
    const duration = reachable ? media.duration : getTrackInfo().duration;
    if (duration > 0) targetSecs = Math.max(0, Math.min(duration, targetSecs));
    const distance = Math.abs(targetSecs - course.from);
    let drivenAt = course.t0;
    const reached = (now) => {
      const expected = course.from + (course.playing ? (performance.now() - course.t0) / 1000 : 0);
      // A successful seek can resume playing before the first sample; allow only time since this route.
      const played = course.playing ? (performance.now() - drivenAt) / 1000 : 0;
      const tolerance = Math.min(3, Math.max(0.05, distance / 2));
      return now.title === course.title && now.currentTime > targetSecs - tolerance
        && now.currentTime < targetSecs + played + tolerance
        && (course.from - targetSecs < 1 || now.currentTime < course.from)
        && Math.abs(now.currentTime - expected) >= Math.min(0.5, distance / 2);
    };
    let helper = false;
    for (const route of ['media', 'bar', ...(isTidal ? ['session', 'element'] : [])]) {
      drivenAt = performance.now();
      let took = false;
      if (route === 'media') {
        if (!reachable) continue;
        try { media.currentTime = targetSecs; took = 'media'; } catch (_) { /* try the existing fallback routes */ }
      } else if (route === 'bar') took = seekWithBar(targetSecs);
      else {
        const reply = bridge('seek', { time: targetSecs, route });
        if (!reply) break; // no helper in this tab
        helper = helper || 'empty';
        took = reply.seeked;
      }
      if (!took) continue;
      if (route === 'session' || route === 'element') helper = 'used';
      // Read the reachable element itself: footer labels can lag its seek.
      const read = route === 'media' ? () => ({ ...getTrackInfo(), currentTime: media.currentTime }) : getTrackInfo;
      const outcome = await watch(reached, course, 6, read);
      if (outcome === 'done') return { status: 'confirmed', seeked: took, bridge: helper };
      if (outcome !== 'timeout') return { status: 'cancelled', seeked: false, bridge: helper };
    }
    return { status: 'exhausted', seeked: false, bridge: helper,
      reason: isTidal && !reachable && helper !== 'used' ? 'helper' : 'seek' };
  }

  function seekWithBar(targetSecs) {
    const footer = getFooterPlayerElement();
    const duration = (currentTrackInfo || getTrackInfo()).duration;
    if (!footer || !(duration > 0)) return false;
    const frac = Math.max(0, Math.min(1, targetSecs / duration));

    // A native range input (set the value the way a user would, so React-style handlers fire)
    const range = footer.querySelector('input[type="range"]');
    if (range) {
      const min = parseFloat(range.min || '0'), max = parseFloat(range.max || '100');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(range, String(min + frac * (max - min)));
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      return 'range';
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
        return 'bar';
      }
    }
    return false;
  }

  function setMediaVolume(vol) {
    const clamped = Math.max(0, Math.min(1, vol));
    document.querySelectorAll('audio, video').forEach(m => { m.volume = clamped; });
  }

  // Movie mode (1.5.5): is this tab showing a real picture? Audio-only pages, including a <video> whose
  // stream has no frames, stay on the large device buffer. document.hidden is ignored so a background tab
  // that is actually showing video still counts.
  const observedShadowRoots = new WeakSet();
  let videoMutationObserver = null;

  function watchVideoRoot(root) {
    if (!videoMutationObserver || !root) return;
    try {
      videoMutationObserver.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'src']
      });
    } catch (_) {}
  }

  function watchShadowRoot(root) {
    if (!root || observedShadowRoots.has(root)) return;
    observedShadowRoots.add(root);
    watchVideoRoot(root);
  }

  function collectVideos(root = document, out = []) {
    if (!root || !root.querySelectorAll) return out;
    root.querySelectorAll('video').forEach((v) => out.push(v));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        watchShadowRoot(el.shadowRoot);
        collectVideos(el.shadowRoot, out);
      }
    });
    return out;
  }

  function hasSourceCandidate(v) {
    return !!(v.currentSrc || v.src || v.srcObject || (v.querySelector && v.querySelector('source[src]')));
  }

  function isElementVisiblyRendered(v) {
    if (!v || !v.isConnected) return false;
    let cur = v;
    while (cur && cur.nodeType === 1) {
      const cs = window.getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') <= 0.05) {
        return false;
      }
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    const r = v.getBoundingClientRect();
    return r.width >= 120 && r.height >= 68;
  }

  function hiddenInside(v, root) {
    let cur = v;
    while (cur && cur.nodeType === 1) {
      const cs = window.getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') <= 0.05) return true;
      if (cur === root) break;
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    return false;
  }

  function detectVideoState() {
    let sawLoadingVideo = false;
    const noteLoading = (v) => {
      if (v && v.readyState === 0 && hasSourceCandidate(v)) sawLoadingVideo = true;
    };

    const pip = document.pictureInPictureElement;
    if (pip && pip.tagName === 'VIDEO') {
      if (pip.videoWidth > 0 && pip.videoHeight > 0) return { state: 'video', videoWidth: pip.videoWidth, videoHeight: pip.videoHeight };
      noteLoading(pip);
    }

    const fs = document.fullscreenElement;
    if (fs) {
      const fsVideos = fs.tagName === 'VIDEO' ? [fs] : collectVideos(fs);
      for (const v of fsVideos) {
        if (hiddenInside(v, fs)) continue;
        if (v.videoWidth > 0 && v.videoHeight > 0) return { state: 'video', videoWidth: v.videoWidth, videoHeight: v.videoHeight };
        noteLoading(v);
      }
    }

    const audioPlaying = () => {
      const list = document.querySelectorAll ? document.querySelectorAll('audio') : [];
      for (const a of list) if (!a.paused && !a.ended) return true;
      return false;
    };

    for (const v of collectVideos(document)) {
      if (!isElementVisiblyRendered(v)) continue;
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        const r = v.getBoundingClientRect();
        const decorative = v.muted && v.loop && !v.controls && v.duration > 0 && v.duration <= 20;
        if (decorative && !(r.width >= 320 && r.height >= 180 && !audioPlaying())) continue;
        return { state: 'video', videoWidth: v.videoWidth, videoHeight: v.videoHeight };
      }
      noteLoading(v);
    }

    if (sawLoadingVideo) return { state: 'unknown', videoWidth: 0, videoHeight: 0 };
    return { state: 'audio', videoWidth: 0, videoHeight: 0 };
  }

  let lastPushedVideoState = null;
  let videoHintTimer = null;
  function scheduleVideoHintCheck() {
    clearTimeout(videoHintTimer);
    videoHintTimer = setTimeout(() => {
      videoHintTimer = null;
      let det;
      try { det = detectVideoState(); } catch (_) { return; }
      if (!det || det.state === lastPushedVideoState) return;
      lastPushedVideoState = det.state;
      try {
        const p = chrome.runtime.sendMessage({ type: 'VIDEO_STATE_HINT', state: det.state, videoWidth: det.videoWidth, videoHeight: det.videoHeight });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }, 250);
  }

  function mutationTouchesVideo(records) {
    for (const rec of records || []) {
      const nodes = [];
      if (rec.target) nodes.push(rec.target);
      rec.addedNodes && rec.addedNodes.forEach((n) => nodes.push(n));
      rec.removedNodes && rec.removedNodes.forEach((n) => nodes.push(n));
      for (const n of nodes) {
        if (!n || n.nodeType !== 1) continue;
        if (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video'))) return true;
      }
    }
    return false;
  }

  for (const type of ['loadedmetadata', 'loadeddata', 'play', 'emptied', 'resize', 'enterpictureinpicture', 'leavepictureinpicture', 'fullscreenchange']) {
    document.addEventListener(type, scheduleVideoHintCheck, { capture: true, passive: true });
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    videoMutationObserver = new MutationObserver((records) => {
      let hasVideo = false;
      try { hasVideo = collectVideos().length > 0; } catch (_) {}
      // Ancestor attribute changes never name the <video>. An open shadow root is a separate tree.
      // Either one still has to schedule a check when a video is on the page or we have already reported one.
      if (mutationTouchesVideo(records) || lastPushedVideoState !== null || hasVideo) scheduleVideoHintCheck();
    });
    watchVideoRoot(document.documentElement);
    try { collectVideos(); } catch (_) {}
  }

  // 4. Message dispatcher
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (['TOGGLE_PLAY_PAUSE', 'PREV_TRACK', 'NEXT_TRACK', 'SEEK_AUDIO'].includes(message.type)) transportSeq++;
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
        nextTrack(!!message.orEnd).then((r) => sendResponse({ ...getTrackInfo(), success: r.status === 'confirmed', ...r }))
          .catch(() => sendResponse({ success: false, status: 'exhausted', next: false, reason: 'next' }));
        return true;
      case 'TOGGLE_FAVORITE':
        toggleFavorite().then(sendResponse);
        return true;
      case 'SEEK_AUDIO':
        seekAudio(message.time).then((r) => sendResponse({ ...getTrackInfo(), success: r.status === 'confirmed', ...r }))
          .catch(() => sendResponse({ success: false, status: 'exhausted', seeked: false, reason: 'seek' }));
        return true;
      case 'SET_VOLUME':
        setMediaVolume(message.volume);
        sendResponse({ success: true, volume: message.volume });
        return true;
      case 'GET_VIDEO_STATE':
        sendResponse(detectVideoState());
        return true;
    }
  });
})();
