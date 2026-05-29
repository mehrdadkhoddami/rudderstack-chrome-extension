// background.js (Manifest V3 service worker)

const connections = new Map(); // tabId → port
const DEFAULT_BATCH_PATTERN = '/beacon/v1/batch';
let cachedBatchPattern = DEFAULT_BATCH_PATTERN;
let _debugEnabled = false;

function rsLog(...args)  { if (_debugEnabled) console.log(...args); }
function rsWarn(...args) { if (_debugEnabled) console.warn(...args); }

// ── Keep service worker alive ─────────────────────────────────────────────────
function keepAlive() {
  if (connections.size > 0) {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch(e) {}
    setTimeout(keepAlive, 20000);
  }
}

function cleanOrphanedStorage() {
  chrome.tabs.query({}, (openTabs) => {
    const openTabIds = new Set(openTabs.map(t => String(t.id)));
    chrome.storage.local.get(null, (allStorage) => {
      const keysToRemove = Object.keys(allStorage).filter(key => {
        const m = key.match(/^(?:allItems|sentIds)_(\d+)$/);
        return m && !openTabIds.has(m[1]);
      });
      if (keysToRemove.length > 0) {
        chrome.storage.local.remove(keysToRemove);
        rsLog('[RS BG] Cleaned orphaned storage keys:', keysToRemove);
      }
    });
  });
}

// ── Load settings ─────────────────────────────────────────────────────────────
chrome.storage.local.get(['batchUrlPattern', 'enableDebug'], (result) => {
  cachedBatchPattern = result.batchUrlPattern || DEFAULT_BATCH_PATTERN;
  _debugEnabled = result.enableDebug === true;
  rsLog('[RS BG] Loaded pattern:', cachedBatchPattern);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.batchUrlPattern) {
    cachedBatchPattern = changes.batchUrlPattern.newValue || DEFAULT_BATCH_PATTERN;
    rsLog('[RS BG] Pattern updated:', cachedBatchPattern);
    connections.forEach((port) => {
      try { port.postMessage({ type: 'patternUpdate', pattern: cachedBatchPattern }); } catch(e) {}
    });
  }
  if (changes.enableDebug) _debugEnabled = changes.enableDebug.newValue === true;
});

// ── Broadcast: tabId حتماً باید معتبر باشه ───────────────────────────────────
// اگه tabId نامعتبره → drop. هرگز به تب اشتباه assign نکن.
function broadcastBatch(batch, sourceTabId, timestamp, via) {
  if (!sourceTabId || sourceTabId < 0) {
    rsLog(`[RS BG] broadcastBatch: invalid tabId=${sourceTabId}, DROP (via ${via})`);
    return;
  }
  rsLog(`[RS BG] broadcastBatch ${batch.length} events | tabId=${sourceTabId} | via=${via}`);

  chrome.runtime.sendMessage({
    type: 'updatePopup',
    data: batch,
    tabId: sourceTabId,
    timestamp: timestamp || Date.now(),
    source: 'network',
  }).catch(() => {});
}

// ── webRequest fallback ───────────────────────────────────────────────────────
// فقط وقتی interceptor.js نتونه capture کنه (مثلاً HTTPS compression)
// برای جلوگیری از duplicate: اگه content script connected هست برای این تب،
// به interceptor.js اعتماد می‌کنیم و webRequest رو skip می‌کنیم
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    if (!details.url.includes(cachedBatchPattern)) return;
    if (!details.tabId || details.tabId < 0) return;

    // اگه content script برای این تب connected هست، interceptor.js handle می‌کنه
    // webRequest رو skip کن تا duplicate نشه
    if (connections.has(details.tabId)) {
      rsLog(`[RS BG] webRequest: tab ${details.tabId} has content script, skipping (interceptor handles)`);
      return;
    }

    rsLog('[RS BG] webRequest fallback for tabId:', details.tabId);

    try {
      if (!details.requestBody?.raw?.length) return;
      const chunks = details.requestBody.raw
        .filter(c => c.bytes?.byteLength > 0)
        .map(c => new TextDecoder('utf-8').decode(c.bytes));
      if (!chunks.length) return;

      const parsed = JSON.parse(chunks.join(''));
      if (!Array.isArray(parsed?.batch) || !parsed.batch.length) return;

      broadcastBatch(parsed.batch, details.tabId, Date.now(), 'webRequest-fallback');
    } catch(e) {
      rsWarn('[RS BG] webRequest parse error:', e.message);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// ── Content script connections ────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rudderstack-monitor') return;

  const tabId = port.sender?.tab?.id;
  if (!tabId) { rsWarn('[RS BG] onConnect: no tabId in sender'); return; }

  connections.set(tabId, port);
  rsLog('[RS BG] Connected, tabId:', tabId);
  if (connections.size === 1) keepAlive();

  port.onMessage.addListener((message) => {
    if (message.type === 'storageChanged') {
      // localStorage events — tabId مشخص هست از port
      chrome.runtime.sendMessage({
        type: 'updatePopup',
        data: message.data,
        tabId: tabId,
        source: 'localStorage',
      }).catch(() => {});

    } else if (message.type === 'batchCaptured') {
      if (!Array.isArray(message.data) || !message.data.length) return;
      rsLog(`[RS BG] batchCaptured tabId=${tabId}: ${message.data.length} events`);
      // tabId از port میاد — همیشه معتبره
      broadcastBatch(message.data, tabId, message.timestamp, 'interceptor.js');
    }
  });

  port.onDisconnect.addListener(() => {
    connections.delete(tabId);
    rsLog('[RS BG] Disconnected, tabId:', tabId);
  });
});

// ── Install / click ───────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(cleanOrphanedStorage);

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
  chrome.storage.local.get(['batchUrlPattern'], (result) => {
    if (!result.batchUrlPattern) chrome.storage.local.set({ batchUrlPattern: DEFAULT_BATCH_PATTERN });
  });
  cleanOrphanedStorage();
});

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); }
  catch(e) { console.error('[RS BG] Error opening side panel:', e); }
});
