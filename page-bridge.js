// page-bridge.js - Runs inside Tidal's own page (world MAIN, document_start), on Tidal only.
// Tidal keeps its player element out of reach of content.js and hides its seek bar when the page is narrow, so the
// jumps had nothing to drive. This remembers what Tidal hands the browser for the system's media controls (its
// media-session handlers and position) and the media element that last started playing. Every call is passed
// through unchanged. content.js asks through DOM events; only strings cross between the two worlds.
(() => {
  const host = location.hostname;
  if (!(host === 'tidal.com' || host.endsWith('.tidal.com')) || window.__tmePageBridge) return;
  Object.defineProperty(window, '__tmePageBridge', { value: true });

  const handlers = Object.create(null); // action -> Tidal's handler (seekto, nexttrack, ...)
  let position = null;                  // the last position state Tidal reported, moved on at each play/pause
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
        const result = setPositionState.call(this, state); // throws exactly as before on a bad state
        try { position = toPosition(state); } catch (_) { position = null; }
        return result;
      };
    }
    // A pause or resume moves the reported position on to that moment, so paused time is not counted.
    const playbackState = typeof MediaSession !== 'undefined' && Object.getOwnPropertyDescriptor(MediaSession.prototype, 'playbackState');
    if (session && playbackState && playbackState.get && playbackState.set) {
      Object.defineProperty(session, 'playbackState', {
        configurable: true,
        enumerable: true,
        get() { return playbackState.get.call(this); },
        set(value) {
          const before = playbackState.get.call(this);
          playbackState.set.call(this, value);
          try {
            if (position && playbackState.get.call(this) !== before) position = { ...position, position: positionAt(before), at: performance.now() };
          } catch (_) { /* keep the last report */ }
        }
      });
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

  function toPosition(state) {
    if (!state) return null;
    const duration = Number(state.duration), at = Number(state.position), rate = Number(state.playbackRate);
    if (!(duration > 0) || !isFinite(duration)) return null;
    return { duration, position: isFinite(at) && at >= 0 ? at : 0, rate: isFinite(rate) && rate > 0 ? rate : 1, at: performance.now() };
  }

  // Where the reported position has got to now, if playback was in `state` since the report.
  function positionAt(state) {
    const moving = state !== 'paused';
    const t = position.position + (moving ? (performance.now() - position.at) / 1000 * position.rate : 0);
    return Math.max(0, Math.min(position.duration, t));
  }

  // The element that is playing now, else the one that played last; only one with a known length.
  function media() {
    const known = played.filter((m) => isFinite(m.duration) && m.duration > 0).reverse(); // newest first
    return known.find((m) => !m.paused) || known[0] || null;
  }

  function state() {
    const m = media();
    if (m) return { currentTime: m.currentTime, duration: m.duration, paused: m.paused, from: 'element' };
    if (position) return { currentTime: positionAt(session.playbackState), duration: position.duration, from: 'session' };
    return null;
  }

  // route 'session': Tidal's own seek handler (what the Mac's Now Playing scrubber uses); 'element': the element itself.
  // content.js tries them in that order and checks each one took.
  function seek(time, route) {
    if (route === 'session') {
      if (!handlers.seekto) return false;
      try { handlers.seekto({ action: 'seekto', seekTime: time, fastSeek: false }); return 'session'; } catch (_) { return false; }
    }
    const m = route === 'element' ? media() : null;
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
      else if (req.op === 'seek' && typeof req.time === 'number' && isFinite(req.time)) reply = { seeked: seek(req.time, req.route) };
      else if (req.op === 'next') reply = { next: next() };
    } catch (_) { reply = null; }
    document.dispatchEvent(new CustomEvent('tme-bridge-reply', { detail: JSON.stringify({ id: req.id, reply }) }));
  });
})();
