// movie-sound-link.js: hands this extension's saved EQ to the Movie Sound page, so films in Safari play through
// the same preset (https://github.com/cornishandy/movie-sound). Everything for Movie Sound lives in this one file;
// deleting it and its manifest entry removes the link.
//
// The manifest runs it only on http://127.0.0.1:8791/ (the Movie Sound page), top frame only. It reads the four
// EQ keys from chrome.storage.local and posts them to that page's own window. It never writes storage, never
// touches capture or audio, and sends nothing anywhere else. The AUDIO EQ switch (isAudioCapturing) isn't read:
// Movie Sound deliberately doesn't follow it.
(() => {
  'use strict';
  const ORIGIN = 'http://127.0.0.1:8791';
  if (location.origin !== ORIGIN || window.top !== window) return;

  const KEYS = ['presets', 'currentPreset', 'currentParams', 'dynamics'];
  const MIN_GAP_MS = 100; // at most ten posts a second while a slider is dragged; the last value always follows
  let asked = false; // nothing is posted until the page asks
  let gone = false; // the extension was reloaded, updated or removed: this copy can't read storage any more
  let reading = false;
  let again = false;
  let timer = null;
  let lastPost = 0;
  let watch = null;

  const post = (message) => window.postMessage({ source: 'tidal-eq-link', version: 1, ...message }, ORIGIN);

  function lost() {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    clearInterval(watch);
    post({ type: 'chrome-eq-link-lost' });
  }

  function read() {
    if (gone) return;
    if (reading) { again = true; return; }
    reading = true;
    again = false;
    let pending;
    try {
      pending = chrome.storage.local.get(KEYS);
    } catch (err) {
      reading = false;
      lost();
      return;
    }
    pending.then((saved) => {
      reading = false;
      if (gone) return;
      lastPost = Date.now();
      post({
        type: 'chrome-eq-settings',
        presets: saved.presets ?? null,
        currentPreset: saved.currentPreset ?? null,
        currentParams: saved.currentParams ?? null,
        dynamics: saved.dynamics ?? null
      });
      if (again) schedule();
    }, () => {
      reading = false;
      lost();
    });
  }

  // A trailing throttle, not a debounce: a long drag still sends updates, and the final value is never dropped.
  function schedule() {
    if (gone || timer) return;
    timer = setTimeout(() => {
      timer = null;
      read();
    }, Math.max(0, MIN_GAP_MS - (Date.now() - lastPost)));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== 'movie-sound' || data.type !== 'request-chrome-eq' || data.version !== 1) return;
    asked = true;
    schedule();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !asked) return;
      if (KEYS.some((key) => key in changes)) schedule();
    });
  } catch (err) {
    lost();
  }

  // After an extension reload this copy is orphaned: storage events stop and chrome.runtime.id disappears.
  // Notice that, so the page stops claiming to follow.
  if (!gone) watch = setInterval(() => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) lost();
    } catch (err) {
      lost();
    }
  }, 3000);

  // The page may have asked before this script was listening.
  if (!gone) post({ type: 'chrome-eq-link-ready' });
})();
