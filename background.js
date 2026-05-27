// background.js (Manifest V3 service worker compatible)

const connections = new Map();
const DEFAULT_BATCH_PATTERN = '/beacon/v1/batch';
let cachedBatchPattern = DEFAULT_BATCH_PATTERN;

// ── Keep service worker alive ─────────────────────────────────────────────────
function keepAlive() {
  if (connections.size > 0) {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {}
    setTimeout(keepAlive, 20000);
  }
}

chrome.storage.local.get(['batchUrlPattern'], (result) => {
  cachedBatchPattern = result.batchUrlPattern || DEFAULT_BATCH_PATTERN;
  console.log('[RS BG] Loaded batch pattern:', cachedBatchPattern);
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.batchUrlPattern) {
    cachedBatchPattern = changes.batchUrlPattern.newValue || DEFAULT_BATCH_PATTERN;
    console.log('[RS BG] Batch pattern updated:', cachedBatchPattern);
  }
});

// ── Broadcast batch events to sidepanel ───────────────────────────────────────
function broadcastBatch(batch, sourceTabId, timestamp, via) {
    console.log(`[RS BG] Broadcasting ${batch.length} events to sidepanel (via ${via}, tabId=${sourceTabId})`);
    batch.forEach((ev, i) => {
        console.log(`[RS BG]   [${i}] type=${ev.type} | event="${ev.event || ev.name || '-'}" | msgId=${ev.messageId}`);
    });

    const payload = {
        type: 'updatePopup',
        data: batch,
        tabId: sourceTabId,
        timestamp: timestamp || Date.now(),
        source: 'network',
    };

    // Send once with the real tabId
    chrome.runtime.sendMessage(payload).catch(() => {});

    // If tabId is -1 (sendBeacon) — also send for every connected tab
    // so the open sidepanel always picks it up
    if (sourceTabId === -1 || sourceTabId === undefined || sourceTabId === null) {
        connections.forEach((port, connTabId) => {
            if (connTabId !== sourceTabId) {
                chrome.runtime.sendMessage({ ...payload, tabId: connTabId }).catch(() => {});
            }
        });
    }
}

// ── webRequest: catches fetch/XHR but NOT text/plain sendBeacon ───────────────
// This is a SECONDARY path — interceptor.js in page context is primary.
// We keep it as a fallback for non-CSP sites where requestBody.raw is populated.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    if (!details.url.includes(cachedBatchPattern)) return;

    console.log('[RS BG] webRequest matched:', details.url, '| tabId:', details.tabId);

    try {
        if (!details.requestBody || !details.requestBody.raw || !details.requestBody.raw.length) {
            // Expected for text/plain — interceptor.js handles this case
            console.log('[RS BG] requestBody.raw empty (text/plain) — interceptor.js will handle');
            return;
        }
        const chunks = details.requestBody.raw
            .filter(c => c.bytes && c.bytes.byteLength > 0)
            .map(c => new TextDecoder('utf-8').decode(c.bytes));
        if (!chunks.length) return;

        const parsed = JSON.parse(chunks.join(''));
        if (!parsed || !Array.isArray(parsed.batch) || !parsed.batch.length) return;

        console.log('[RS BG] webRequest fallback captured', parsed.batch.length, 'events');
        broadcastBatch(parsed.batch, details.tabId, Date.now(), 'webRequest');
    } catch (e) {
        console.warn('[RS BG] webRequest parse error:', e.message);
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// ── Handle connections from content scripts ───────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rudderstack-monitor') return;

  const tabId = port.sender.tab.id;
  connections.set(tabId, port);
  console.log('[RS BG] Content script connected, tabId:', tabId);

  if (connections.size === 1) keepAlive();

  port.onMessage.addListener((message) => {
    if (message.type === 'storageChanged') {
        // localStorage queue events
        chrome.runtime.sendMessage({
            type: 'updatePopup',
            data: message.data,
            tabId: tabId,
            source: 'localStorage',
        }).catch(() => {});

    } else if (message.type === 'batchCaptured') {
        // Network batch events captured by interceptor.js in page context
        if (!Array.isArray(message.data) || !message.data.length) return;
        console.log(`[RS BG] batchCaptured from content script (tabId=${tabId}): ${message.data.length} events`);
        broadcastBatch(message.data, tabId, message.timestamp, 'interceptor.js');
    }
  });

  port.onDisconnect.addListener(() => {
    connections.delete(tabId);
    console.log('[RS BG] Content script disconnected, tabId:', tabId);
  });
});

// ── Install / click handlers ──────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
  chrome.storage.local.get(['batchUrlPattern'], (result) => {
    if (!result.batchUrlPattern) {
      chrome.storage.local.set({ batchUrlPattern: DEFAULT_BATCH_PATTERN });
    }
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); }
  catch (e) { console.error('[RS BG] Error opening side panel:', e); }
});
