// page-bridge.js - Runs inside Tidal's own page (world MAIN, document_start), on Tidal only.
// Tidal keeps its player element out of reach of content.js and hides its seek bar when the page is narrow, so the
// jumps had nothing to drive. This remembers what Tidal hands the browser for the system's media controls (its
// media-session handlers and position) and the media element that last started playing. Every call is passed
// through unchanged. content.js asks through DOM events; only strings cross between the two worlds.
(() => {
  if (!location.hostname.includes('tidal.com') || window.__tmePageBridge) return;
  Object.defineProperty(window, '__tmePageBridge', { value: true });

  const handlers = Object.create(null); // action -> Tidal's handler (seekto, nexttrack, ...)
  let position = null;                  // the last position state Tidal reported
  const played = [];                    // the media elements that last called play(), newest last (at most 4)
  const session = navigator.mediaSession;

  try {
    if (session && typeof session.setActionHandler === 'function') {
      const setActionHandler = session.setActionHandler;
      session.setActionHandler = function (action, handler) {
        const result = setActionHandler.call(this, action, handler);
        handlers[action] = typeof handler === 'function' ? handler : null;
        return result;
      };
    }
    if (session && typeof session.setPositionState === 'function') {
      const setPositionState = session.setPositionState;
      session.setPositionState = function (state) {
        const result = setPositionState.call(this, state);
        position = state && state.duration > 0 && isFinite(state.duration)
          ? { duration: state.duration, position: state.position || 0, rate: state.playbackRate || 1, at: performance.now() }
          : null;
        return result;
      };
    }
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const i = played.indexOf(this);
      if (i >= 0) played.splice(i, 1);
      played.push(this);
      if (played.length > 4) played.shift();
      return play.apply(this, arguments);
    };
  } catch (_) { /* leave the page exactly as it was */ }

  // The element that is playing now, else the one that played last; only one with a known length.
  function media() {
    const known = played.filter((m) => isFinite(m.duration) && m.duration > 0).reverse(); // newest first
    return known.find((m) => !m.paused) || known[0] || null;
  }

  function state() {
    const m = media();
    if (m) return { currentTime: m.currentTime, duration: m.duration, paused: m.paused, from: 'element' };
    if (position) {
      const moving = session.playbackState !== 'paused';
      const t = position.position + (moving ? (performance.now() - position.at) / 1000 * position.rate : 0);
      return { currentTime: Math.max(0, Math.min(position.duration, t)), duration: position.duration, from: 'session' };
    }
    return null;
  }

  // Tidal's own seek handler first (what the Mac's Now Playing scrubber uses), else the element itself.
  function seek(time) {
    if (handlers.seekto) {
      try { handlers.seekto({ action: 'seekto', seekTime: time, fastSeek: false }); return 'session'; } catch (_) { /* next route */ }
    }
    const m = media();
    if (m) { m.currentTime = Math.max(0, Math.min(m.duration, time)); return 'element'; }
    return false;
  }

  function next() {
    if (!handlers.nexttrack) return false;
    try { handlers.nexttrack({ action: 'nexttrack' }); return 'session'; } catch (_) { return false; }
  }

  document.addEventListener('tme-bridge-request', (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch (_) { return; }
    let reply = null;
    try {
      if (req.op === 'state') reply = state();
      else if (req.op === 'seek' && typeof req.time === 'number' && isFinite(req.time)) reply = { seeked: seek(req.time) };
      else if (req.op === 'next') reply = { next: next() };
    } catch (_) { reply = null; }
    document.dispatchEvent(new CustomEvent('tme-bridge-reply', { detail: JSON.stringify({ id: req.id, reply }) }));
  });
})();
