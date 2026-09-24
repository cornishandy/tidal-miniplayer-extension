// background.js - Service Worker for Tab Audio Capture, Routing, and Mini-Player

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let capturedTabId = null;
let standaloneWindowId = null;

// Built-in presets
const FACTORY_PRESETS = {
  "Punchy Bass & Clarity": {
    bass: 5.0,
    hpf: 30,
    mid: 1.5,
    high: 2.0,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: true
  },
  "Clean DJ (Anti-Distortion)": {
    bass: 4.5,
    hpf: 35,
    mid: 1.0,
    high: 2.5,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: true
  },
  "Deep Sub-Bass (Dub/Trap)": {
    bass: 8.0,
    hpf: 25,
    mid: 0.0,
    high: 1.0,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: true
  },
  "Club / Festival Bangers": {
    bass: 7.0,
    hpf: 32,
    mid: 2.0,
    high: 3.5,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: true
  },
  "Audiophile Clean (Flat Bass)": {
    bass: 2.0,
    hpf: 20,
    mid: 0.5,
    high: 1.5,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: false
  },
  "Late Night Movies & Dialogue": {
    bass: 3.5,
    hpf: 45,
    mid: 3.0,
    high: 1.0,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: true
  },
  "Acoustic & Live": {
    bass: 3.0,
    hpf: 40,
    mid: 2.0,
    high: 3.0,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: false
  },
  "Flat (Bypass)": {
    bass: 0.0,
    hpf: 20,
    mid: 0.0,
    high: 0.0,
    gain: 1.0,
    pitch: 1.0,
    autoBalance: false,
    bypass: true
  }
};

const FACTORY_PRESET_NAMES = [
  ...Object.keys(FACTORY_PRESETS),
  "Clean DJ (Anti-Distortion)"
];
const DEFAULT_PRESETS = { ...FACTORY_PRESETS };

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['presets', 'currentParams', 'currentPreset', 'showFloatingButton_userExplicit']);
  if (!data.presets) {
    await chrome.storage.local.set({ presets: DEFAULT_PRESETS });
  } else {
    const merged = { ...DEFAULT_PRESETS, ...data.presets };
    await chrome.storage.local.set({ presets: merged });
  }
  if (!data.currentParams) {
    await chrome.storage.local.set({
      currentParams: DEFAULT_PRESETS["Punchy Bass & Clarity"]
    });
  }
  if (!data.currentPreset) {
    await chrome.storage.local.set({ currentPreset: "Punchy Bass & Clarity" });
  }
  if (!data.showFloatingButton_userExplicit) {
    await chrome.storage.local.set({
      showFloatingButton: false,
      showFloatingButton_userExplicit: false
    });
  }
});

async function isOffscreenOpen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await isOffscreenOpen()) return;

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Process tab audio with Web Audio API for EQ and bass boost'
    });
  } catch (err) {
    if (!err.message?.includes('single offscreen document')) {
      throw err;
    }
  }

  // Ping offscreen document until its listener is ready
  for (let i = 0; i < 15; i++) {
    const ready = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_AUDIO_STATUS' }, (res) => {
        if (chrome.runtime.lastError || !res) resolve(false);
        else resolve(true);
      });
    });
    if (ready) break;
    await new Promise(r => setTimeout(r, 40));
  }
}

function broadcastAudioState(isCapturing, tabId = null) {
  chrome.runtime.sendMessage({
    type: 'AUDIO_STATE_CHANGED',
    isCapturing,
    tabId
  }).catch(() => {});

  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      type: 'AUDIO_STATE_CHANGED',
      isCapturing
    }).catch(() => {});
  }
}

// Check live audio capture status directly from the running offscreen document
async function getActualCaptureStatus() {
  const offscreenOpen = await isOffscreenOpen();
  if (!offscreenOpen) {
    if (capturedTabId) {
      capturedTabId = null;
      await chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });
    }
    return { isCapturing: false, tabId: null };
  }

  if (!capturedTabId) {
    const data = await chrome.storage.local.get(['capturedTabId', 'isAudioCapturing']);
    if (data.capturedTabId) {
      capturedTabId = data.capturedTabId;
    }
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'GET_AUDIO_STATUS'
    }, (res) => {
      if (chrome.runtime.lastError || !res) {
        resolve({ isCapturing: false, tabId: null });
      } else {
        const isCapturing = !!res.isCapturing;
        if (!isCapturing && capturedTabId) {
          capturedTabId = null;
          chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });
        }
        resolve({ isCapturing, tabId: capturedTabId });
      }
    });
  });
}

async function startAudioCapture(tabId) {
  // CRITICAL: Call getMediaStreamId immediately so the user gesture token from the message is fresh!
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  await ensureOffscreenDocument();

  if (capturedTabId && capturedTabId !== tabId) {
    await stopAudioCapture();
  }

  const stored = await chrome.storage.local.get(['currentParams', 'currentPreset', 'presets']);
  const presets = { ...DEFAULT_PRESETS, ...(stored.presets || {}) };
  const currentPreset = stored.currentPreset || "Punchy Bass & Clarity";
  const params = stored.currentParams || presets[currentPreset] || DEFAULT_PRESETS["Punchy Bass & Clarity"];

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_AUDIO_CAPTURE',
      streamId,
      params
    }, async (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        capturedTabId = tabId;
        await chrome.storage.local.set({ capturedTabId: tabId, isAudioCapturing: true });
        broadcastAudioState(true, tabId);
        resolve(response);
      }
    });
  });
}

async function stopAudioCapture() {
  const oldTabId = capturedTabId;
  capturedTabId = null;
  await chrome.storage.local.set({ capturedTabId: null, isAudioCapturing: false });

  if (!(await isOffscreenOpen())) {
    broadcastAudioState(false, oldTabId);
    return { success: true };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'STOP_AUDIO_CAPTURE'
    }, () => {
      if (chrome.runtime.lastError) {}
      broadcastAudioState(false, oldTabId);
      resolve({ success: true });
    });
  });
}

// Target tab finder specifically for player commands & track info
async function findMediaTabForPlayer() {
  const allTabs = await chrome.tabs.query({});
  if (!allTabs || allTabs.length === 0) return null;

  // 1. Any Tidal tab: first active/audible, then any open Tidal tab
  const activeTidal = allTabs.find(t => t.active && t.url && t.url.includes('tidal.com'));
  if (activeTidal) return activeTidal;

  const audibleTidal = allTabs.find(t => t.audible && t.url && t.url.includes('tidal.com'));
  if (audibleTidal) return audibleTidal;

  const anyTidal = allTabs.find(t => t.url && t.url.includes('tidal.com'));
  if (anyTidal) return anyTidal;

  // 2. Currently captured tab (if active capture)
  if (capturedTabId) {
    const captured = allTabs.find(t => t.id === capturedTabId);
    if (captured) return captured;
  }

  // 3. Any currently audible tab across any window
  const audible = allTabs.find(t => t.audible);
  if (audible) return audible;

  // 4. Any media streaming service tab
  const media = allTabs.find(t => t.url && (
    t.url.includes('youtube.com') ||
    t.url.includes('spotify.com') ||
    t.url.includes('soundcloud.com') ||
    t.url.includes('music.apple.com') ||
    t.url.includes('netflix.com')
  ));
  if (media) return media;

  // 5. Active web tab in current focused window
  const activeWeb = allTabs.find(t => t.active && t.url && !t.url.startsWith('chrome'));
  return activeWeb || null;
}

// Target tab finder specifically for Audio EQ Capture
async function findAudioCaptureTab(preferredTabId = null) {
  const allTabs = await chrome.tabs.query({});
  if (!allTabs || allTabs.length === 0) return null;

  // If a valid tab was explicitly passed from popup or content script
  if (preferredTabId) {
    const pref = allTabs.find(t => t.id === preferredTabId);
    if (pref && pref.url && !pref.url.startsWith('chrome')) {
      return pref;
    }
  }

  // 1. Audible Tidal tab
  const audibleTidal = allTabs.find(t => t.audible && t.url && t.url.includes('tidal.com'));
  if (audibleTidal) return audibleTidal;

  // 2. Any currently audible tab across all windows
  const audible = allTabs.find(t => t.audible);
  if (audible) return audible;

  // 3. Any open Tidal tab (even if paused right now)
  const anyTidal = allTabs.find(t => t.url && t.url.includes('tidal.com'));
  if (anyTidal) return anyTidal;

  // 4. Other media streaming tabs (YouTube, Spotify, etc.)
  const media = allTabs.find(t => t.url && (
    t.url.includes('youtube.com') ||
    t.url.includes('spotify.com') ||
    t.url.includes('soundcloud.com') ||
    t.url.includes('music.apple.com') ||
    t.url.includes('netflix.com')
  ));
  if (media) return media;

  // 5. Active tab in normal window
  const activeTab = allTabs.find(t => t.active && t.url && !t.url.startsWith('chrome'));
  return activeTab || null;
}

// Clean up when tabs close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === capturedTabId) {
    await stopAudioCapture();
  }
});

// Standalone popup window tracking
chrome.windows.onRemoved.addListener((winId) => {
  if (winId === standaloneWindowId) {
    standaloneWindowId = null;
  }
});

// Keyboard shortcut handlers
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-pip-miniplayer') {
    const targetTab = await findMediaTabForPlayer();
    if (targetTab?.id) {
      chrome.tabs.sendMessage(targetTab.id, { type: 'TOGGLE_MINIPLAYER' });
    }
  } else if (command === 'toggle-eq') {
    const status = await getActualCaptureStatus();
    if (status.isCapturing) {
      await stopAudioCapture();
    } else {
      const targetTab = await findAudioCaptureTab();
      if (targetTab?.id) {
        await startAudioCapture(targetTab.id);
      }
    }
  }
});

// Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'START_CAPTURE_FOR_TAB': {
          const targetTab = await findAudioCaptureTab(message.tabId || sender.tab?.id);
          if (!targetTab?.id) {
            sendResponse({ success: false, error: 'No active media tab found. Open Tidal or any music/video tab.' });
            return;
          }
          try {
            const result = await startAudioCapture(targetTab.id);
            sendResponse({ success: true, result, capturedTabId });
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case 'STOP_CAPTURE': {
          const result = await stopAudioCapture();
          sendResponse({ success: true, result });
          break;
        }

        case 'UPDATE_AUDIO_PARAMS': {
          await chrome.storage.local.set({ currentParams: message.params });
          if (message.presetName) {
            await chrome.storage.local.set({ currentPreset: message.presetName });
          }
          if (await isOffscreenOpen()) {
            chrome.runtime.sendMessage({
              target: 'offscreen',
              type: 'UPDATE_AUDIO_PARAMS',
              params: message.params
            }, (res) => {
              if (chrome.runtime.lastError) {}
              sendResponse(res || { success: true });
            });
          } else {
            sendResponse({ success: true, saved: true });
          }
          break;
        }

        case 'SET_ACTIVE_PRESET': {
          const { presetName, params } = message;
          await chrome.storage.local.set({
            currentPreset: presetName,
            currentParams: params
          });
          if (await isOffscreenOpen()) {
            chrome.runtime.sendMessage({
              target: 'offscreen',
              type: 'UPDATE_AUDIO_PARAMS',
              params
            });
          }
          sendResponse({ success: true });
          break;
        }

        case 'GET_STATE': {
          const stored = await chrome.storage.local.get(['presets', 'currentParams', 'currentPreset', 'showFloatingButton', 'showFloatingButton_userExplicit']);
          const presets = { ...DEFAULT_PRESETS, ...(stored.presets || {}) };
          const currentPreset = stored.currentPreset || "Punchy Bass & Clarity";
          const showFloating = stored.showFloatingButton_userExplicit === true && stored.showFloatingButton === true;
          const status = await getActualCaptureStatus();

          sendResponse({
            capturedTabId: status.tabId,
            isCapturing: status.isCapturing,
            presets,
            factoryPresets: FACTORY_PRESET_NAMES,
            currentPreset,
            currentParams: stored.currentParams || presets[currentPreset] || DEFAULT_PRESETS["Punchy Bass & Clarity"],
            showFloatingButton: showFloating
          });
          break;
        }

        case 'TOGGLE_MINIPLAYER':
        case 'OPEN_MINIPLAYER': {
          const targetTab = await findMediaTabForPlayer();
          if (targetTab?.id) {
            chrome.tabs.sendMessage(targetTab.id, { type: 'TOGGLE_MINIPLAYER' }, (res) => {
              if (chrome.runtime.lastError || !res?.success) {
                chrome.windows.create({
                  url: chrome.runtime.getURL('miniplayer.html'),
                  type: 'popup',
                  width: 360,
                  height: 540
                });
              }
            });
          } else {
            chrome.windows.create({
              url: chrome.runtime.getURL('miniplayer.html'),
              type: 'popup',
              width: 360,
              height: 540
            });
          }
          sendResponse({ success: true });
          break;
        }

        case 'CREATE_FALLBACK_WINDOW': {
          chrome.windows.create({
            url: message.url || chrome.runtime.getURL('miniplayer.html'),
            type: 'popup',
            width: 360,
            height: 540
          });
          sendResponse({ success: true });
          break;
        }

        case 'TOGGLE_FLOATING_BUTTON': {
          await chrome.storage.local.set({
            showFloatingButton: !!message.show,
            showFloatingButton_userExplicit: true
          });
          const allTabs = await chrome.tabs.query({});
          allTabs.forEach(tab => {
            if (tab.id && !tab.url?.startsWith('chrome://')) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_FLOATING_BUTTON',
                show: !!message.show
              }).catch(() => {});
            }
          });
          sendResponse({ success: true });
          break;
        }

        case 'SAVE_PRESET': {
          const { name, params } = message;
          const data = await chrome.storage.local.get('presets');
          const p = { ...DEFAULT_PRESETS, ...(data.presets || {}) };
          p[name] = params;
          await chrome.storage.local.set({ presets: p, currentPreset: name, currentParams: params });
          sendResponse({ success: true, presets: p, savedName: name });
          break;
        }

        case 'UPDATE_PRESET': {
          const { name, params } = message;
          const data = await chrome.storage.local.get('presets');
          const p = { ...DEFAULT_PRESETS, ...(data.presets || {}) };
          p[name] = params;
          await chrome.storage.local.set({ presets: p, currentPreset: name, currentParams: params });
          sendResponse({ success: true, presets: p });
          break;
        }

        case 'DELETE_PRESET': {
          const { name } = message;
          const data = await chrome.storage.local.get('presets');
          const p = { ...DEFAULT_PRESETS, ...(data.presets || {}) };
          delete p[name];
          await chrome.storage.local.set({ presets: p });
          sendResponse({ success: true, presets: p });
          break;
        }

        case 'RESET_DEFAULT_PRESETS': {
          const presetToReset = message.currentPreset;
          const data = await chrome.storage.local.get('presets');
          const p = { ...(data.presets || {}) };

          if (presetToReset && FACTORY_PRESETS[presetToReset]) {
            p[presetToReset] = { ...FACTORY_PRESETS[presetToReset] };
            await chrome.storage.local.set({
              presets: p,
              currentPreset: presetToReset,
              currentParams: p[presetToReset]
            });
            sendResponse({
              success: true,
              presets: p,
              selectedName: presetToReset,
              currentParams: p[presetToReset]
            });
          } else {
            await chrome.storage.local.set({
              presets: DEFAULT_PRESETS,
              currentPreset: "Punchy Bass & Clarity",
              currentParams: DEFAULT_PRESETS["Punchy Bass & Clarity"]
            });
            sendResponse({
              success: true,
              presets: DEFAULT_PRESETS,
              selectedName: "Punchy Bass & Clarity",
              currentParams: DEFAULT_PRESETS["Punchy Bass & Clarity"]
            });
          }
          break;
        }

        case 'FORWARD_PLAYER_COMMAND': {
          const targetTab = await findMediaTabForPlayer();
          if (!targetTab?.id) {
            sendResponse({ success: false, error: 'No media tab found' });
            return;
          }
          chrome.tabs.sendMessage(targetTab.id, message.command, async (response) => {
            if (chrome.runtime.lastError) {
              const errMsg = chrome.runtime.lastError.message || '';
              if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection')) {
                try {
                  await chrome.scripting.executeScript({
                    target: { tabId: targetTab.id },
                    files: ['router-visualizer.js', 'content.js']
                  });
                  chrome.tabs.sendMessage(targetTab.id, message.command, (retryRes) => {
                    if (chrome.runtime.lastError) {
                      sendResponse({ success: false, error: chrome.runtime.lastError.message });
                    } else {
                      sendResponse(retryRes);
                    }
                  });
                  return;
                } catch (injectErr) {
                  sendResponse({ success: false, error: errMsg });
                  return;
                }
              }
              sendResponse({ success: false, error: errMsg });
            } else {
              sendResponse(response);
            }
          });
          break;
        }

        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});
