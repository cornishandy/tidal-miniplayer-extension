// tidal-bridge.js - Injected into MAIN world to capture auth and communicate with Tidal API
(function() {
  let tidalAuth = {
    token: null,
    userId: null,
    countryCode: 'US'
  };

  let currentPlayingTrackId = null;

  function inspectObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    try {
      // Access tokens
      const possibleToken = obj.token || obj.accessToken || obj.access_token || obj.oAuthToken;
      if (possibleToken && typeof possibleToken === 'string' && possibleToken.length > 20) {
        tidalAuth.token = possibleToken;
      }

      // User ID
      const possibleUser = obj.userId || obj.user?.id || obj.sub || obj.profile?.sub || (obj.id && typeof obj.id === 'number' ? obj.id : null);
      if (possibleUser && (typeof possibleUser === 'string' || typeof possibleUser === 'number')) {
        tidalAuth.userId = String(possibleUser);
      }

      // Country Code
      if (obj.countryCode || obj.user?.countryCode) {
        tidalAuth.countryCode = obj.countryCode || obj.user.countryCode;
      }

      // Track ID in Redux playback state
      const possibleTrackId = obj.currentTrack?.id || obj.media?.id || obj.currentMedia?.id || obj.playback?.currentTrack?.id;
      if (possibleTrackId) {
        currentPlayingTrackId = String(possibleTrackId);
      }

      // Deep inspection of nested properties
      if (obj.auth) inspectObject(obj.auth);
      if (obj.session) inspectObject(obj.session);
      if (obj.credentials) inspectObject(obj.credentials);
      if (obj.user) inspectObject(obj.user);
      if (obj.profile) inspectObject(obj.profile);
      if (obj.currentUser) inspectObject(obj.currentUser);
      if (obj.playback) inspectObject(obj.playback);
    } catch (e) {}
  }

  function detectSession() {
    try {
      // 1. Scan localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            if (raw.startsWith('{') || raw.startsWith('[')) {
              inspectObject(JSON.parse(raw));
            } else if (raw.length > 20 && (key.includes('token') || key.includes('auth'))) {
              tidalAuth.token = raw;
            }
          }
        } catch (e) {}
      }

      // 2. Scan sessionStorage
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        try {
          const raw = sessionStorage.getItem(key);
          if (raw) {
            if (raw.startsWith('{') || raw.startsWith('[')) {
              inspectObject(JSON.parse(raw));
            } else if (raw.length > 20 && (key.includes('token') || key.includes('auth'))) {
              tidalAuth.token = raw;
            }
          }
        } catch (e) {}
      }

      // 3. Scan window globals
      if (window.__REDUX_STATE__) inspectObject(window.__REDUX_STATE__);
      if (window.__PRELOADED_STATE__) inspectObject(window.__PRELOADED_STATE__);
      if (window.wimp) inspectObject(window.wimp);
    } catch (e) {}
  }

  // Intercept fetch to automatically catch Authorization Bearer token, userId, and playing track
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const [resource, config] = args;
      const url = typeof resource === 'string' ? resource : resource?.url || '';

      if (url.includes('tidal.com')) {
        let headers = config?.headers;
        let authHeader = null;
        if (headers) {
          if (typeof headers.get === 'function') {
            authHeader = headers.get('Authorization') || headers.get('authorization');
          } else if (typeof headers === 'object') {
            authHeader = headers['Authorization'] || headers['authorization'];
          }
        }
        if (authHeader && authHeader.startsWith('Bearer ')) {
          tidalAuth.token = authHeader.replace('Bearer ', '').trim();
        }

        const userMatch = url.match(/\/users\/([0-9a-zA-Z_-]+)/);
        if (userMatch && userMatch[1] && userMatch[1] !== 'undefined') {
          tidalAuth.userId = userMatch[1];
        }

        // Intercept playback stream requests to capture current track ID
        const trackMatch = url.match(/\/tracks\/([0-9]+)/);
        if (trackMatch && trackMatch[1]) {
          currentPlayingTrackId = trackMatch[1];
          window.postMessage({ type: 'TIDAL_TRACK_DETECTED', trackId: currentPlayingTrackId }, '*');
        }

        if (tidalAuth.token) {
          window.postMessage({ type: 'TIDAL_AUTH_UPDATED', auth: tidalAuth }, '*');
        }
      }
    } catch (e) {}
    return originalFetch.apply(this, args);
  };

  detectSession();
  if (tidalAuth.token) {
    window.postMessage({ type: 'TIDAL_AUTH_UPDATED', auth: tidalAuth }, '*');
  }

  // Handle messages from content script
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'TIDAL_EXT_CONTENT') return;

    const { action, payload, requestId } = event.data;

    const respond = (data, error = null) => {
      window.postMessage({
        source: 'TIDAL_EXT_BRIDGE',
        requestId,
        data,
        error
      }, '*');
    };

    if (action === 'GET_AUTH') {
      detectSession();
      respond({ auth: tidalAuth, currentPlayingTrackId });
    } else if (action === 'FETCH_USER_PLAYLISTS') {
      try {
        if (!tidalAuth.token || !tidalAuth.userId) {
          detectSession();
        }

        // If we have token but missing userId, resolve it via /sessions
        if (tidalAuth.token && !tidalAuth.userId) {
          try {
            const sRes = await fetch('https://api.tidal.com/v1/sessions', {
              headers: {
                'Authorization': `Bearer ${tidalAuth.token}`,
                'x-tidal-token': tidalAuth.token
              }
            });
            if (sRes.ok) {
              const sData = await sRes.json();
              if (sData.userId) tidalAuth.userId = String(sData.userId);
            }
          } catch (e) {}
        }

        if (!tidalAuth.token || !tidalAuth.userId) {
          return respond([], null);
        }

        const res = await fetch(`https://api.tidal.com/v1/users/${tidalAuth.userId}/playlists?limit=50`, {
          headers: {
            'Authorization': `Bearer ${tidalAuth.token}`,
            'x-tidal-token': tidalAuth.token
          }
        });
        if (!res.ok) {
          return respond([], null);
        }
        const json = await res.json();
        respond(json.items || []);
      } catch (err) {
        respond([], null);
      }
    } else if (action === 'FETCH_PLAYLIST_TRACKS') {
      try {
        const { playlistUuid } = payload;
        if (!tidalAuth.token) {
          return respond([], null);
        }
        const res = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}/items?limit=100`, {
          headers: {
            'Authorization': `Bearer ${tidalAuth.token}`,
            'x-tidal-token': tidalAuth.token
          }
        });
        if (!res.ok) return respond([], null);
        const json = await res.json();
        respond(json.items || []);
      } catch (err) {
        respond([], null);
      }
    } else if (action === 'ADD_TRACK_TO_PLAYLIST') {
      try {
        const { playlistUuid, trackId } = payload;
        if (!trackId) {
          return respond(null, 'No track ID found');
        }

        // Fetch playlist ETag
        let etag = '*';
        try {
          const plRes = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}`, {
            headers: {
              'Authorization': `Bearer ${tidalAuth.token}`,
              'x-tidal-token': tidalAuth.token
            }
          });
          if (plRes.ok) {
            etag = plRes.headers.get('ETag') || '*';
          }
        } catch (e) {}

        const params = new URLSearchParams();
        params.append('trackIds', String(trackId));
        params.append('onDup', 'SKIP');

        let res = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}/items`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${tidalAuth.token}`,
            'x-tidal-token': tidalAuth.token,
            'If-None-Match': etag,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        if (!res.ok) {
          // Retry with wildcard ETag
          res = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}/items`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${tidalAuth.token}`,
              'x-tidal-token': tidalAuth.token,
              'If-None-Match': '*',
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
          });
        }

        if (res.ok) {
          respond({ success: true });
        } else {
          const errTxt = await res.text();
          respond(null, errTxt || 'Could not add track to playlist');
        }
      } catch (err) {
        respond(null, err.message);
      }
    } else if (action === 'REMOVE_TRACK_FROM_PLAYLIST') {
      try {
        const { playlistUuid, trackIndex, trackId } = payload;
        let etag = '*';
        try {
          const plRes = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}`, {
            headers: {
              'Authorization': `Bearer ${tidalAuth.token}`,
              'x-tidal-token': tidalAuth.token
            }
          });
          if (plRes.ok) {
            etag = plRes.headers.get('ETag') || '*';
          }
        } catch (e) {}

        let res = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}/items/${trackIndex}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${tidalAuth.token}`,
            'x-tidal-token': tidalAuth.token,
            'If-None-Match': etag
          }
        });

        if (!res.ok) {
          res = await fetch(`https://api.tidal.com/v1/playlists/${playlistUuid}/items/${trackIndex}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${tidalAuth.token}`,
              'x-tidal-token': tidalAuth.token,
              'If-None-Match': '*'
            }
          });
        }

        if (res.ok) {
          respond({ success: true });
        } else {
          respond(null, 'Could not remove track');
        }
      } catch (err) {
        respond(null, err.message);
      }
    }
  });
})();
