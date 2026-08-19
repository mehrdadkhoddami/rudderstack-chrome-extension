// popup.js
/*!
 * RudderStack Tracker Chrome Extension
 * Developed by: Mehrdad Khoddami
 * License: MIT
 */

// ═══════════════════════════════════════════════════════════════
// DESIGN PRINCIPLE:
//   - tabCache     : single source of truth — tabId → { items, sentIds, loaded }
//   - currentTabId : which tab is currently shown in the sidepanel
//   - Cache key    : `${tabId}:${msgId}` — composite key prevents cross-tab
//     contamination when two tabs open the same site with identical messageIds.
//   - sentIds      : stores raw msgId per-tab (for sent badge logic)
//   - localStorage : ONLY fetched for the active tab — never for background tabs.
//     This prevents shared-origin localStorage from bleeding events across tabs.
// ═══════════════════════════════════════════════════════════════

// ── Event types the tracker ingests ───────────────────────────────────────────
// Kept in sync with TRACKED_EVENT_TYPES in contentScript.js and the inline copy
// inside fetchAndIngestLocalStorage() below.
const TRACKED_EVENT_TYPES = ['track', 'page', 'screen', 'identify', 'group', 'alias'];
const TRACKED_TYPE_SET = new Set(TRACKED_EVENT_TYPES);

// ── Per-tab in-memory cache ───────────────────────────────────────────────────
const tabCache = new Map();

function getTabCache(tabId) {
  if (!tabCache.has(tabId)) {
    tabCache.set(tabId, {
      items:    new Map(),
      sentIds:  new Set(),
      pinnedIds: new Set(),
      // requestId → [cacheKey] so an HTTP result can be attributed back to the
      // events that were in that request's body.
      reqMap:   new Map(),
      loaded:   false,
    });
  }
  return tabCache.get(tabId);
}

// ── Composite cache key: tabId:msgId ─────────────────────────────────────────
// Ensures events from different tabs are stored separately even if msgIds are
// identical (same site open in multiple tabs).
function cacheKey(tabId, msgId) {
  return `${tabId}:${msgId}`;
}

// ── Active tab pointer ────────────────────────────────────────────────────────
let currentTabId = null;

// ── Window isolation ──────────────────────────────────────────────────────────
// Chrome creates ONE side panel document per browser window, but chrome.tabs
// events and chrome.runtime.sendMessage broadcasts are global. Without this
// guard, the panel in window A reacts to tab activity in window B and shows
// its events. Every tab event and every ingest is scoped to myWindowId.
let myWindowId = null;

// tabId → windowId, so the hot ingest path avoids an async chrome.tabs.get
// for tabs it has already seen.
const tabWindowMap = new Map();

// Runs `fn` only if the tab belongs to this panel's window.
function ifOwnWindow(tabId, fn) {
  if (!tabId || tabId < 0 || myWindowId === null) return;

  const known = tabWindowMap.get(tabId);
  if (known !== undefined) {
    if (known === myWindowId) fn();
    return;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    tabWindowMap.set(tabId, tab.windowId);
    if (tab.windowId === myWindowId) fn();
  });
}

// Caches every tab currently in this window so the first events don't each
// pay for a lookup.
function primeWindowTabs(callback) {
  if (myWindowId === null) { if (callback) callback(); return; }
  chrome.tabs.query({ windowId: myWindowId }, (tabs) => {
    if (!chrome.runtime.lastError && tabs) {
      tabs.forEach(t => tabWindowMap.set(t.id, t.windowId));
    }
    if (callback) callback();
  });
}

// Re-points the panel at whatever tab is active in ITS window. Used when the
// tab it was showing was dragged into (or out of) another window.
function resyncActiveTab() {
  if (myWindowId === null) return;
  chrome.tabs.query({ active: true, windowId: myWindowId }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) return;
    tabWindowMap.set(tab.id, tab.windowId);
    if (tab.id !== currentTabId) switchToTab(tab.id);
  });
}

// sidepanel-init.js uses these getters for live stats
Object.defineProperty(window, 'allItems', {
  get: () => currentTabId ? getTabCache(currentTabId).items : new Map(),
  configurable: true,
});
Object.defineProperty(window, 'sentMessageIds', {
  get: () => currentTabId ? getTabCache(currentTabId).sentIds : new Set(),
  configurable: true,
});

// ── Settings ──────────────────────────────────────────────────────────────────
let _showJsonViewer = true;
let _debugEnabled   = false;

function rsLog(...args) {
  if (_debugEnabled) console.log(...args);
}

function rsWarn(...args) {
  if (_debugEnabled) console.warn(...args);
}

chrome.storage.local.get(['showJsonViewer', 'enableDebug'], (res) => {
  _showJsonViewer = res.showJsonViewer !== false;
  _debugEnabled   = res.enableDebug === true;
});

// ── Storage helpers ───────────────────────────────────────────────────────────
const MAX_ITEMS = 200;

function saveState(tabId) {
  if (!tabId) return;
  try {
    const cache = getTabCache(tabId);
    // Pinned events survive the MAX_ITEMS cap — the user explicitly kept them.
    let entries = [...cache.items.entries()].sort((a, b) => {
      const pa = cache.pinnedIds.has(a[1].msgId || a[0]) ? 1 : 0;
      const pb = cache.pinnedIds.has(b[1].msgId || b[0]) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b[1].timestamp || 0) - (a[1].timestamp || 0);
    });
    if (entries.length > MAX_ITEMS) entries = entries.slice(0, MAX_ITEMS);

    const serialItems  = JSON.stringify(entries);
    const serialSent   = JSON.stringify([...cache.sentIds].slice(-MAX_ITEMS));
    const serialPinned = JSON.stringify([...cache.pinnedIds].slice(-MAX_ITEMS));

    if ((serialItems.length + serialSent.length) * 2 > 4 * 1024 * 1024) {
      rsWarn('[RS Panel] saveState: too large, skipping');
      return;
    }
    chrome.storage.local.set({
      [`allItems_${tabId}`]: serialItems,
      [`sentIds_${tabId}`]:  serialSent,
      [`pinned_${tabId}`]:   serialPinned,
    }, () => {
      if (chrome.runtime.lastError) rsWarn('[RS Panel] saveState:', chrome.runtime.lastError.message);
    });
  } catch(e) { rsWarn('[RS Panel] saveState exception:', e); }
}

function loadState(tabId, callback) {
  if (!tabId) { callback(); return; }
  chrome.storage.local.get(
    [`allItems_${tabId}`, `sentIds_${tabId}`, `pinned_${tabId}`],
    (result) => {
      const cache = getTabCache(tabId);
      try {
        if (result[`allItems_${tabId}`]) {
          const stored = new Map(JSON.parse(result[`allItems_${tabId}`]));
          // Only accept items whose key belongs to this tab (safety guard)
          stored.forEach((v, k) => {
            if (k.startsWith(`${tabId}:`) && !cache.items.has(k)) {
              cache.items.set(k, v);
            }
          });
        }
      } catch(e) { rsWarn('[RS Panel] loadState items error:', e); }
      try {
        if (result[`sentIds_${tabId}`]) {
          const stored = new Set(JSON.parse(result[`sentIds_${tabId}`]));
          stored.forEach(id => cache.sentIds.add(id));
        }
      } catch(e) { rsWarn('[RS Panel] loadState sentIds error:', e); }
      try {
        if (result[`pinned_${tabId}`]) {
          const stored = new Set(JSON.parse(result[`pinned_${tabId}`]));
          stored.forEach(id => cache.pinnedIds.add(id));
        }
      } catch(e) { rsWarn('[RS Panel] loadState pinned error:', e); }
      cache.loaded = true;
      callback();
    }
  );
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const filterInput = document.getElementById('filter-input');
const clearBtn    = document.getElementById('clear-btn');
const itemList    = document.getElementById('localStorage-items');
const chipBar     = document.getElementById('facet-chips');

// ── Active facets ─────────────────────────────────────────────────────────────
let activeType   = 'all';   // 'all' | one of TRACKED_EVENT_TYPES
let failedOnly   = false;   // show only events whose batch failed

const JSON_CLASSES = {
  int: 'json-int', float: 'json-float', boolean: 'json-boolean',
  null: 'json-null', string: 'json-string', object: 'json-object', array: 'json-array',
};

// ── Placeholder easter egg ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('filter-input');
  if (!localStorage.getItem('shownPlaceholderOnce')) {
    input.placeholder = "Developed with ❤️ by Mehrdad Khoddami";
    setTimeout(() => {
      input.style.opacity = '0';
      setTimeout(() => {
        input.placeholder = 'Filter events...';
        input.style.opacity = '1';
        localStorage.setItem('shownPlaceholderOnce', 'true');
      }, 500);
    }, 5000);
  } else {
    input.placeholder = 'Filter events...';
  }
});

// ── Filter ────────────────────────────────────────────────────────────────────
// Search runs against `data-search`, which holds the event name plus the full
// serialized payload — so typing a property value (e.g. an order id) matches too.
function applyFilter() {
  const q = filterInput.value.trim().toLowerCase();
  clearBtn.style.display = q ? 'block' : 'none';

  let visible = 0;
  document.querySelectorAll('#localStorage-items .item').forEach(el => {
    const haystack = el.getAttribute('data-search') || '';
    const type     = el.getAttribute('data-type') || '';
    const failed   = el.getAttribute('data-failed') === '1';

    const matchesText   = !q || haystack.includes(q);
    const matchesType   = activeType === 'all' || type === activeType;
    const matchesStatus = !failedOnly || failed;
    const show = matchesText && matchesType && matchesStatus;

    el.classList.toggle('hidden', !show);
    if (show) visible++;
  });

  // Distinguish "nothing captured yet" from "filter matched nothing"
  const hasItems = itemList.children.length > 0;
  document.body.classList.toggle('no-matches', hasItems && visible === 0);
}

filterInput.addEventListener('input', applyFilter);
clearBtn.addEventListener('click', () => {
  filterInput.value = '';
  clearBtn.style.display = 'none';
  applyFilter();
  filterInput.focus();
});

// ── Facet chips (event type + failed-only) ────────────────────────────────────
function renderChips() {
  if (!chipBar) return;

  const counts = { all: 0 };
  let failedCount = 0;

  if (currentTabId) {
    getTabCache(currentTabId).items.forEach((data) => {
      const t = data.eventType || 'unknown';
      counts[t] = (counts[t] || 0) + 1;
      counts.all++;
      if (data.httpOk === false) failedCount++;
    });
  }

  // Reset a facet that no longer has any matching events
  if (activeType !== 'all' && !counts[activeType]) activeType = 'all';
  if (failedOnly && failedCount === 0) failedOnly = false;

  const frag = document.createDocumentFragment();

  const mkChip = (label, count, isActive, onClick, extraClass) => {
    const chip = document.createElement('button');
    chip.className = 'facet-chip' + (isActive ? ' active' : '') + (extraClass ? ' ' + extraClass : '');
    chip.type = 'button';
    const name = document.createElement('span');
    name.className = 'facet-chip-label';
    name.textContent = label;
    chip.appendChild(name);
    const badge = document.createElement('span');
    badge.className = 'facet-chip-count';
    badge.textContent = count;
    chip.appendChild(badge);
    chip.addEventListener('click', onClick);
    return chip;
  };

  frag.appendChild(mkChip('All', counts.all, activeType === 'all', () => {
    activeType = 'all';
    renderChips();
    applyFilter();
  }));

  // Only surface types that actually occurred, so the bar stays short
  TRACKED_EVENT_TYPES.forEach(t => {
    if (!counts[t]) return;
    frag.appendChild(mkChip(t, counts[t], activeType === t, () => {
      activeType = (activeType === t) ? 'all' : t;
      renderChips();
      applyFilter();
    }));
  });

  if (failedCount > 0) {
    frag.appendChild(mkChip('failed', failedCount, failedOnly, () => {
      failedOnly = !failedOnly;
      renderChips();
      applyFilter();
    }, 'facet-chip-failed'));
  }

  chipBar.replaceChildren(frag);
  chipBar.classList.toggle('hidden', counts.all === 0);
}

// ── Tab helper ────────────────────────────────────────────────────────────────
// Resolves this panel's own window and its active tab in one call — the tab's
// windowId is the source of truth for every later isolation check.
function getCurrentTabId(callback) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) { callback(null); return; }
      myWindowId = tab.windowId;
      tabWindowMap.set(tab.id, tab.windowId);
      callback(tab.id);
    });
  } catch(e) { callback(null); }
}

// ── Clear — only the specified tab ───────────────────────────────────────────
function clearAllItems(tabId) {
  if (!tabId) return;
  //console.log(`[RS DEBUG] clearAllItems | tabId=${tabId}`);

  const cache = getTabCache(tabId);
  cache.items.clear();
  cache.sentIds.clear();
  cache.pinnedIds.clear();
  cache.reqMap.clear();
  cache.loaded = true;

  chrome.storage.local.remove([`allItems_${tabId}`, `sentIds_${tabId}`, `pinned_${tabId}`]);
  try { chrome.tabs.sendMessage(tabId, { type: 'clearAll' }, () => chrome.runtime.lastError); } catch(e) {}

  if (tabId === currentTabId) {
    itemList.innerHTML = '';
    document.body.classList.add('clear-list');
    document.body.classList.remove('no-matches');
    renderChips();
    //console.log(`[RS DEBUG] clearAllItems: DOM cleared for active tab ${tabId}`);
  }

  const btn = document.getElementById('clearButton');
  if (btn) { btn.classList.add('clearing'); setTimeout(() => btn.classList.remove('clearing'), 200); }
}

// ── CORE: ingest batch events for a specific tab ──────────────────────────────
function ingestBatchEvents(batchArray, timestamp, targetTabId, requestId) {
  if (!Array.isArray(batchArray) || !targetTabId || targetTabId < 0) return;

  const cache = getTabCache(targetTabId);
  let newCount = 0;
  const keysInRequest = [];

  let sentChanged = false;
  batchArray.forEach((event) => {
    if (!event?.messageId) return;
    if (!TRACKED_TYPE_SET.has(event.type)) return;

    const msgId = event.messageId;
    const key   = cacheKey(targetTabId, msgId);
    keysInRequest.push(key);

    if (!cache.sentIds.has(msgId)) {
      cache.sentIds.add(msgId);
      sentChanged = true;
    }

    if (!cache.items.has(key)) {
      cache.items.set(key, {
        parsedValue: event,
        value: JSON.stringify(event),
        // identify/group/alias carry no event name — fall back to the type
        originalKey: event.event || event.name || event.type,
        eventType: event.type || 'unknown',
        propertiesKey: event.properties || event.traits || null,
        timestamp: event.originalTimestamp
          ? new Date(event.originalTimestamp).getTime()
          : (timestamp || Date.now()),
        source: 'batch',
        msgId,
      });
      newCount++;
	} else {
      // Item already exists — it was seen in localStorage before the batch arrived.
      // Do NOT change its source to 'batch'; it should only get the SENT badge
      // (via sentIds above), not the BATCH badge.
      // BATCH badge is only for events that arrive via network without ever appearing
      // in localStorage first.
    }
  });

  // Remember which events rode in this request so its HTTP result can be
  // attributed back to them when it arrives.
  if (requestId && keysInRequest.length) {
    cache.reqMap.set(requestId, keysInRequest);
    // Bound the map — results arrive within seconds, stale ids are dead weight
    if (cache.reqMap.size > 200) {
      const oldest = cache.reqMap.keys().next().value;
      cache.reqMap.delete(oldest);
    }
  }

  // Save if new items added OR if sentIds changed (badge persistence across reloads)
  if (newCount > 0 || sentChanged) saveState(targetTabId);

  if (targetTabId === currentTabId) {
    //console.log(`[RS DEBUG] ingestBatch -> renderAll for active tab ${targetTabId}`);
    renderAll();
  }
}

// ── CORE: apply an HTTP result to the events that were in that request ────────
function applyBatchResult(targetTabId, requestId, status, ok, error) {
  if (!targetTabId || targetTabId < 0 || !requestId) return;

  const cache = getTabCache(targetTabId);
  const keys  = cache.reqMap.get(requestId);
  if (!keys || !keys.length) return;

  let changed = false;
  keys.forEach((key) => {
    const item = cache.items.get(key);
    if (!item) return;
    if (item.httpStatus === status && item.httpOk === ok) return;
    item.httpStatus = status;
    item.httpOk     = ok === true;
    item.httpError  = error || null;
    changed = true;
  });

  cache.reqMap.delete(requestId);

  if (!changed) return;
  saveState(targetTabId);
  if (targetTabId === currentTabId) renderAll();
}

// ── CORE: ingest localStorage items — ONLY for the active tab ─────────────────
// localStorage is shared across all tabs of the same origin, so we must NEVER
// call this for a background tab. Doing so would inject the same-origin events
// into an unrelated tab's cache, making every tab look identical.
function ingestLocalStorageItems(itemsObj, targetTabId) {
  if (!itemsObj || typeof itemsObj !== 'object') return;
  if (!targetTabId || targetTabId < 0) return;

  // Hard guard: only ingest localStorage data for the currently active tab.
  // Background-tab localStorage messages are silently dropped.
  if (targetTabId !== currentTabId) {
    rsLog(`[RS Panel] ingestLocalStorage: dropping for background tab ${targetTabId} (current=${currentTabId})`);
    return;
  }

  const cache = getTabCache(targetTabId);
  let changed = false;

  Object.entries(itemsObj).forEach(([msgId, data]) => {
    const key = cacheKey(targetTabId, msgId);

    if (!cache.items.has(key)) {
      cache.items.set(key, {
        parsedValue: data.parsedValue,
        value: data.value,
        originalKey: data.originalKey || msgId,
        eventType: data.eventType || data.parsedValue?.type || 'unknown',
        propertiesKey: data.propertiesKey || null,
        timestamp: data.timestamp || Date.now(),
        source: 'localStorage',
        msgId,
      });
      changed = true;
    }
  });

  if (changed) {
    //console.log(`[RS DEBUG] ingestLocalStorage | tabId=${targetTabId} | total=${cache.items.size}`);
    saveState(targetTabId);
    renderAll();
  }
}

// ── Render — reads exclusively from the active tab's cache ────────────────────
// `force` rebuilds the whole list; used when the sort order changes (pinning).
function renderAll(force) {
  if (!currentTabId) {
    itemList.innerHTML = '';
    document.body.classList.add('clear-list');
    renderChips();
    return;
  }

  const { items, sentIds, pinnedIds } = getTabCache(currentTabId);

  // Pinned events float to the top; the rest stay newest-first.
  const sorted = [...items.entries()].sort((a, b) => {
    const pa = pinnedIds.has(a[1].msgId || a[0]) ? 1 : 0;
    const pb = pinnedIds.has(b[1].msgId || b[0]) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b[1].timestamp || 0) - (a[1].timestamp || 0);
  });

  // A forced rebuild throws away the DOM, so remember which rows the user had
  // expanded and restore them afterwards.
  let expandedKeys = null;
  if (force) {
    expandedKeys = new Set();
    itemList.querySelectorAll('.item[data-key]').forEach(el => {
      if (el.querySelector('.value-container.expanded')) {
        expandedKeys.add(el.getAttribute('data-key'));
      }
    });
    itemList.innerHTML = '';
  }

  // Build a map of currently rendered DOM items
  const domMap = new Map();
  itemList.querySelectorAll('.item[data-key]').forEach(el => {
    domMap.set(el.getAttribute('data-key'), el);
  });

  if (domMap.size === 0) {
    // Fresh render — already in display order
    const frag = document.createDocumentFragment();
    sorted.forEach(([key, data]) => {
      frag.appendChild(buildRow(key, data, sentIds, pinnedIds));
    });
    itemList.appendChild(frag);
  } else {
    // Incremental update:
    // - new item  -> insert above the first unpinned row
    // - existing  -> refresh badges in place
    // - stale     -> remove from DOM
    sorted.forEach(([key, data]) => {
      if (domMap.has(key)) {
        const el = domMap.get(key);
        domMap.delete(key);
        refreshRow(el, data, sentIds, pinnedIds);
      } else {
        const el = buildRow(key, data, sentIds, pinnedIds);
        el.classList.add('new-item');
        // Keep pinned rows at the top by anchoring new arrivals below them
        const anchor = itemList.querySelector('.item:not(.pinned-item)') || null;
        itemList.insertBefore(el, anchor);
        setTimeout(() => {
          el.classList.add('transition-complete');
          setTimeout(() => el.classList.remove('new-item', 'transition-complete'), 300);
        }, 3000);
      }
    });
    // Remove DOM nodes no longer present in cache (tab cleared or switched)
    domMap.forEach(el => el.remove());
  }

  // Restore expansion state after a forced rebuild
  if (expandedKeys && expandedKeys.size) {
    expandedKeys.forEach(k => {
      const el = itemList.querySelector(`.item[data-key="${CSS.escape(k)}"]`);
      if (!el) return;
      el.querySelector('.value-container')?.classList.add('expanded');
      el.querySelector('.toggle-icon')?.classList.remove('collapsed');
    });
  }

  if (itemList.children.length > 0) {
    document.body.classList.remove('clear-list');
  } else {
    document.body.classList.add('clear-list');
  }
  renderChips();
  applyFilter();
}

// Creates a row and stamps the attributes the filter reads.
function buildRow(key, data, sentIds, pinnedIds) {
  const isSent   = sentIds.has(data.msgId || key);
  const isPinned = pinnedIds.has(data.msgId || key);
  const el = createItemElement(key, data, isSent, isPinned);
  el.setAttribute('data-key', key);
  stampFilterAttrs(el, data);
  return el;
}

// Flattens an object into "key value key value …" for substring search.
// Depth- and size-capped so a pathological payload can't stall rendering.
function flattenForSearch(value, out, depth) {
  if (depth > 4 || out.length > 120) return;
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach(v => flattenForSearch(v, out, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      out.push(k);
      flattenForSearch(v, out, depth + 1);
    });
    return;
  }
  out.push(String(value));
}

// Search index — deliberately NOT the whole payload.
//
// Indexing the full serialized event made the filter useless: every event
// carries the same envelope keys (type, event, channel, context, library,
// name, version, integrations, the page URL …), so common words matched
// every row and searching by event name stopped narrowing anything down.
//
// Scope is therefore the event name, its type, the identity fields, and the
// properties/traits subtree — the parts that actually differ between events.
function buildSearchIndex(data) {
  const parts = [data.originalKey || '', data.eventType || ''];

  const ev = data.parsedValue || {};
  ['messageId', 'userId', 'anonymousId'].forEach(f => {
    if (ev[f]) parts.push(String(ev[f]));
  });

  const props = data.propertiesKey || ev.properties || ev.traits;
  if (props && typeof props === 'object') {
    const flat = [];
    try { flattenForSearch(props, flat, 0); } catch (e) { /* keep the name index */ }
    parts.push(flat.join(' '));
  }

  return parts.join(' ').toLowerCase();
}

function stampFilterAttrs(el, data) {
  let index = '';
  try { index = buildSearchIndex(data); }
  catch (e) { index = String(data.originalKey || '').toLowerCase(); }

  el.setAttribute('data-search', index);
  el.setAttribute('data-type', data.eventType || 'unknown');
  el.setAttribute('data-failed', data.httpOk === false ? '1' : '0');
}

// Updates an already-rendered row without rebuilding it.
function refreshRow(el, data, sentIds, pinnedIds) {
  const key      = el.getAttribute('data-key');
  const isSent   = sentIds.has(data.msgId || key);
  const isPinned = pinnedIds.has(data.msgId || key);
  const bc = el.querySelector('.badges-container');

  if (isSent && !el.classList.contains('sent-item')) {
    el.classList.add('sent-item');
    if (bc && !bc.querySelector('.sent-badge')) bc.appendChild(createSentBadge());
  }
  // Upgrade localStorage item to batch when source changed in cache
  if (data.source === 'batch' && !el.classList.contains('batch-item')) {
    el.classList.add('batch-item');
    if (bc && !bc.querySelector('.batch-badge')) bc.appendChild(createBatchBadge());
  }

  el.classList.toggle('pinned-item', isPinned);
  const pinBtn = el.querySelector('.pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('active', isPinned);
    pinBtn.title = isPinned ? 'Unpin event' : 'Pin event';
  }

  // HTTP result badge — added once the response for its batch lands
  if (bc && data.httpStatus !== undefined) {
    const existing = bc.querySelector('.http-badge');
    const fresh = createHttpBadge(data);
    if (existing) existing.replaceWith(fresh);
    else bc.appendChild(fresh);
    el.classList.toggle('failed-item', data.httpOk === false);
  }

  stampFilterAttrs(el, data);
}

// ── Pin toggle ────────────────────────────────────────────────────────────────
function togglePin(msgId) {
  if (!currentTabId || !msgId) return;
  const cache = getTabCache(currentTabId);
  if (cache.pinnedIds.has(msgId)) cache.pinnedIds.delete(msgId);
  else cache.pinnedIds.add(msgId);
  saveState(currentTabId);
  renderAll(true); // sort order changed — full rebuild
}

// ── Switch tab ────────────────────────────────────────────────────────────────
function switchToTab(newTabId) {
  if (!newTabId || newTabId === currentTabId) return;

  const prevTabId = currentTabId;
  //console.log(`[RS DEBUG] switchToTab: BEFORE switch | from=${prevTabId} to=${newTabId}`);


  currentTabId = newTabId;

  // Wipe DOM — no items from the previous tab should remain visible
  itemList.innerHTML = '';
  document.body.classList.add('clear-list');
  //console.log(`[RS DEBUG] switchToTab: DOM cleared, loading tab ${newTabId}`);

  const cache = getTabCache(newTabId);

  const showCached = () => {
    // Abort if the user switched again before this callback ran
    if (currentTabId !== newTabId) {
      //console.log(`[RS DEBUG] switchToTab: abort showCached, currentTab changed to ${currentTabId}`);
      return;
    }

    //console.log(`[RS DEBUG] switchToTab: showCached | tabId=${newTabId} | items=${cache.items.size}`);

    if (cache.items.size > 0) document.body.classList.remove('clear-list');
    renderAll(); // always run so the facet chips reflect the new tab
    // Fetch localStorage only for the newly active tab
    fetchAndIngestLocalStorage(newTabId);
  };

  if (cache.loaded) {
    showCached();
  } else {
    //console.log(`[RS DEBUG] switchToTab: loading from storage for tab ${newTabId}`);
    loadState(newTabId, showCached);
  }
}

// ── Fetch localStorage from a live tab ───────────────────────────────────────
// IMPORTANT: must only be called for the currently active tab (currentTabId).
// Calling it for a background tab that shares the same origin would silently
// copy the shared localStorage into that tab's cache.
function fetchAndIngestLocalStorage(tabId) {
  if (!tabId) return;

  // Do not read localStorage for background tabs
  if (tabId !== currentTabId) {
    rsLog(`[RS Panel] fetchAndIngestLocalStorage: skip background tab ${tabId}`);
    return;
  }

  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (!tab?.url) return;
    if (['chrome://', 'chrome-extension://', 'about:'].some(p => tab.url.startsWith(p))) return;

    // Ask the content script first. It tracks which events THIS document wrote,
    // so events queued by another window on the same origin are excluded.
    // A raw scan of localStorage cannot make that distinction.
    chrome.tabs.sendMessage(tabId, { type: 'getItems' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.items) {
        // No content script in this tab (injected before install, restricted
        // page, …) — fall back to scanning, accepting that a shared-origin
        // queue may bleed in.
        rsLog('[RS Panel] getItems unavailable, falling back to direct scan');
        scanLocalStorageDirect(tabId);
        return;
      }
      if (Object.keys(resp.items).length > 0) {
        ingestLocalStorageItems(resp.items, tabId);
      }
    });
  });
}

// Fallback path: read the tab's localStorage directly via scripting injection.
// Used only when the content script is not answering.
function scanLocalStorageDirect(tabId) {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (!tab?.url) return;
    if (['chrome://', 'chrome-extension://', 'about:'].some(p => tab.url.startsWith(p))) return;

    // Load key patterns from global settings, then inject + execute in page
    chrome.storage.local.get(['patternRudder', 'patternQueue', 'customLsPatterns'], (pats) => {
      const patternRudder = pats.patternRudder !== false;
      const patternQueue  = pats.patternQueue  !== false;
      const customRules   = Array.isArray(pats.customLsPatterns) ? pats.customLsPatterns : [];

      // First inject pattern config as globals, then read localStorage
      chrome.scripting.executeScript({
        target: { tabId },
        func: function setRsPatterns(r, q, rules) {
          window.__rsPatternRudder = r;
          window.__rsPatternQueue  = q;
          window.__rsCustomRules   = rules;
        },
        args: [patternRudder, patternQueue, customRules],
      }, () => {
        if (chrome.runtime.lastError) return;

        chrome.scripting.executeScript({
          target: { tabId },
          args: [TRACKED_EVENT_TYPES],
          func: function safeGetLocalStorage(trackedTypes) {
            try {
              const items = {};
              if (!localStorage) return items;

              const typeSet   = new Set(trackedTypes);
              const useRudder = window.__rsPatternRudder !== false;
              const useQueue  = window.__rsPatternQueue  !== false;
              const rules     = Array.isArray(window.__rsCustomRules) ? window.__rsCustomRules : [];

              function keyMatches(key) {
                if (useRudder && key.startsWith('rudder_') && key.endsWith('.batchQueue')) return true;
                if (useQueue  && key.startsWith('queue.')) return true;
                for (const rule of rules) {
                  if (!rule.prefix) continue;
                  if (key.startsWith(rule.prefix) && (!rule.suffix || key.endsWith(rule.suffix))) return true;
                }
                return false;
              }

              function addEvent(ev) {
                if (!ev || typeof ev !== 'object' || !ev.messageId) return;
                if (!typeSet.has(ev.type)) return;
                items[ev.messageId] = {
                  value:         JSON.stringify(ev),
                  parsedValue:   ev,
                  originalKey:   ev.event || ev.name || ev.type || ev.messageId,
                  eventType:     ev.type || 'unknown',
                  propertiesKey: ev.properties || ev.traits || null,
                  timestamp:     Date.now(),
                  source:        'localStorage',
                  msgId:         ev.messageId,
                };
              }

              function parseValue(raw) {
                try {
                  let parsed = JSON.parse(raw);
                  if (typeof parsed === 'string') parsed = JSON.parse(parsed);

                  // Unwrap a single element: handles SDK v3 wrapper, thin wrapper, direct event
                  // el.event can be a STRING (event name) in direct events — check typeof first
                  function unwrap(el) {
                    if (!el || typeof el !== 'object') return null;
                    if (el.item?.event && typeof el.item.event === 'object') return el.item.event;
                    if (el.event       && typeof el.event       === 'object') return el.event;
                    if (el.messageId) return el;
                    return null;
                  }

                  if (Array.isArray(parsed)) {
                    parsed.forEach(el => addEvent(unwrap(el)));
                  } else if (typeof parsed === 'object' && parsed !== null) {
                    for (const j in parsed) {
                      addEvent(unwrap(parsed[j]));
                    }
                  }
                } catch(e) {}
              }

              for (let i = 0; i < localStorage.length; i++) {
                try {
                  const key = localStorage.key(i);
                  if (!key || !keyMatches(key)) continue;
                  const raw = localStorage.getItem(key);
                  if (!raw) continue;
                  parseValue(raw);
                } catch(e) { continue; }
              }
              return items;
            } catch(e) { return {}; }
          },
        }, (results) => {
          if (chrome.runtime.lastError) return;
          const data = results?.[0]?.result;
          if (data && Object.keys(data).length > 0) {
            ingestLocalStorageItems(data, tabId);
          }
        });
      });
    });
  });
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function parseValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const str = String(value).trim().toLowerCase();
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str === 'null') return null;
  if (!isNaN(str) && str !== '') return str.includes('.') ? parseFloat(str) : parseInt(str, 10);
  return String(value);
}

function detectType(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'unknown';
}

function renderValueSpan(value, addQuotes = true) {
  const parsed = parseValue(value);
  const type = detectType(parsed);
  let display, cssClass = JSON_CLASSES[type];
  switch (type) {
    case 'string':  display = addQuotes ? `"${String(parsed)}"` : String(parsed); break;
    case 'null':    display = 'null'; break;
    case 'boolean':
      display = parsed;
      cssClass = parsed === true ? 'json-boolean-true' : 'json-boolean-false';
      break;
    default: display = parsed;
  }
  return `<span class="${cssClass}">${display}</span>`;
}

function prettyPrintJson(obj, indent = 0) {
  const ind = ' '.repeat(indent * 3);
  const type = detectType(obj);
  if (['int','float','boolean','null','string'].includes(type)) return renderValueSpan(obj);
  if (type === 'array') {
    let h = '[<br>';
    obj.forEach((item, i) => {
      h += ind + '   ' + prettyPrintJson(item, indent + 1) + (i < obj.length - 1 ? ',' : '') + '<br>';
    });
    return h + ind + ']';
  }
  if (type === 'object') {
    let h = '{<br>';
    const entries = Object.entries(obj);
    entries.forEach(([k, v], i) => {
      h += ind + `   <span class="json-key">${k}</span>: ` + prettyPrintJson(v, indent + 1) + (i < entries.length - 1 ? ',' : '') + '<br>';
    });
    return h + ind + '}';
  }
  return '';
}

function createSentBadge() {
  const b = document.createElement('span');
  b.className = 'sent-badge';
  b.textContent = 'SENT';
  return b;
}

function createBatchBadge() {
  const b = document.createElement('span');
  b.className = 'badge batch-badge';
  b.textContent = 'BATCH';
  return b;
}

function createTypeBadge(type) {
  const b = document.createElement('span');
  b.className = 'type-badge type-' + (type || 'unknown');
  b.textContent = type || 'unknown';
  return b;
}

// Shows the HTTP outcome of the batch this event was delivered in.
// status 0 means the request never got a response (network error / blocked).
function createHttpBadge(data) {
  const b = document.createElement('span');
  const ok = data.httpOk === true;
  b.className = 'http-badge ' + (ok ? 'http-ok' : 'http-fail');
  b.textContent = data.httpStatus ? String(data.httpStatus) : 'ERR';
  b.title = ok
    ? `Delivered — HTTP ${data.httpStatus}`
    : `Failed — ${data.httpError || 'HTTP ' + data.httpStatus}`;
  return b;
}

function createPinButton(msgId, isPinned) {
  const btn = document.createElement('button');
  btn.className = 'pin-btn' + (isPinned ? ' active' : '');
  btn.type = 'button';
  btn.title = isPinned ? 'Unpin event' : 'Pin event';
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't toggle the row open
    togglePin(msgId);
  });
  return btn;
}

function createTableFromJson(json) {
  const table = document.createElement('table');
  table.className = 'json-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  ['Key', 'Value'].forEach(t => {
    const th = document.createElement('th');
    th.textContent = t;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  Object.entries(json).sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => {
    const row = document.createElement('tr');
    const kc = document.createElement('td'); kc.textContent = k; row.appendChild(kc);
    const vc = document.createElement('td');
    const type = detectType(v);
    vc.innerHTML = ['int','float','boolean','null','string'].includes(type)
      ? renderValueSpan(v, false)
      : prettyPrintJson(v);
    row.appendChild(vc);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  return table;
}

function createCopyButton(value) {
  const btn = document.createElement('button');
  btn.className = 'copy-button';
  btn.textContent = 'Copy';
  btn.addEventListener('click', () => {
    const text = (typeof value === 'object' && value !== null)
      ? JSON.stringify(value, null, 2)
      : String(value);
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!'; btn.disabled = true;
      showToast('Text copied to clipboard!', 'success');
      setTimeout(() => { btn.textContent = 'Copy'; btn.disabled = false; }, 1000);
    }).catch(() => showToast('Failed to copy', 'error'));
  });
  return btn;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.classList.add('toast', type);
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 100);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 500); }, 1000);
}

function createItemElement(key, data, isSent, isPinned) {
  data = data || {};
  const itemDiv = document.createElement('div');
  itemDiv.className = 'item';
  itemDiv.setAttribute('data-key', key);
  if (isSent) itemDiv.classList.add('sent-item');
  if (data.source === 'batch') itemDiv.classList.add('batch-item');
  if (isPinned) itemDiv.classList.add('pinned-item');
  if (data.httpOk === false) itemDiv.classList.add('failed-item');

  const headerDiv = document.createElement('div');
  headerDiv.className = 'item-header';

  const keyContainer = document.createElement('div');
  keyContainer.className = 'key-container';

  const keyDiv = document.createElement('div');
  keyDiv.className = 'key';
  keyDiv.textContent = key || 'Unknown Key';

  const subtitleDiv = document.createElement('span');
  subtitleDiv.className = 'subtitle';
  subtitleDiv.textContent = data.originalKey || key || 'Unknown';

  const badgesContainer = document.createElement('div');
  badgesContainer.className = 'badges-container';

  if (data.timestamp) {
    const timeDiv = document.createElement('span');
    timeDiv.className = 'timestamp';
    timeDiv.textContent = new Date(data.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    badgesContainer.appendChild(timeDiv);
  }
  badgesContainer.appendChild(createTypeBadge(data.eventType));
  if (isSent) badgesContainer.appendChild(createSentBadge());
  if (data.source === 'batch') badgesContainer.appendChild(createBatchBadge());
  if (data.httpStatus !== undefined) badgesContainer.appendChild(createHttpBadge(data));

  keyContainer.appendChild(subtitleDiv);
  keyContainer.appendChild(keyDiv);
  keyContainer.appendChild(badgesContainer);

  const pinBtn = createPinButton(data.msgId || key, isPinned);

  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'toggle-icon collapsed';
  toggleIcon.innerHTML = '<img src="images/expand_more-128.png" class="view-more" />';

  const valueContainer = document.createElement('div');
  valueContainer.className = 'value-container';

  const propertiesDiv = document.createElement('div');
  propertiesDiv.className = 'properties-value';
  try { if (data.propertiesKey) propertiesDiv.appendChild(createTableFromJson(data.propertiesKey)); } catch(e) {}

  const insideValueContainer = document.createElement('div');
  insideValueContainer.className = 'inside-value-container';
  if (!_showJsonViewer) insideValueContainer.style.display = 'none';

  const valueDiv = document.createElement('pre');
  valueDiv.className = 'value';
  try {
    valueDiv.innerHTML = data.parsedValue
      ? prettyPrintJson(data.parsedValue)
      : (data.value || 'No value available');
  } catch(e) { valueDiv.textContent = data.value || 'Error displaying value'; }

  insideValueContainer.appendChild(createCopyButton(data.parsedValue || {}));
  insideValueContainer.appendChild(valueDiv);
  valueContainer.appendChild(propertiesDiv);
  valueContainer.appendChild(insideValueContainer);
  headerDiv.appendChild(keyContainer);
  headerDiv.appendChild(pinBtn);
  headerDiv.appendChild(toggleIcon);
  itemDiv.appendChild(headerDiv);
  itemDiv.appendChild(valueContainer);

  headerDiv.addEventListener('click', () => {
    toggleIcon.classList.toggle('collapsed');
    valueContainer.classList.toggle('expanded');
  });
  return itemDiv;
}

// ── Settings change listener ──────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.showJsonViewer) {
    _showJsonViewer = changes.showJsonViewer.newValue !== false;
    document.querySelectorAll('.inside-value-container').forEach(el => {
      el.style.display = _showJsonViewer ? '' : 'none';
    });
  }
  if (changes.enableDebug) _debugEnabled = changes.enableDebug.newValue === true;
});

// ── Row copy icon ─────────────────────────────────────────────────────────────
(function attachRowCopySVG(joiner = ': ') {
  function createCopyBtn() {
    const btn = document.createElement('span');
    btn.className = 'copy-icon';
    btn.title = 'Copy row';
    return btn;
  }
  function attachButtons() {
    document.querySelectorAll('table tr').forEach(tr => {
      if (tr.querySelector('.copy-icon')) return;
      const firstCell = tr.querySelector('td, th');
      if (!firstCell) return;
      const btn = createCopyBtn();
      firstCell.prepend(btn);
      btn.addEventListener('click', e => { e.stopPropagation(); copyRow(tr, btn); });
    });
  }
  function copyRow(tr, btn) {
    const cells = Array.from(tr.querySelectorAll('td, th'));
    const texts = cells.map(c => c.innerText.trim());
    const parsed = parseValue(texts[1]);
    texts[1] = detectType(parsed) === 'string' ? `"${parsed}"` : parsed;
    const text = texts.join(joiner);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => { showCopied(btn); showToast('Key-Value copied!', 'success'); })
        .catch(() => fallback(text, btn));
    } else { fallback(text, btn); }
  }
  function fallback(text, btn) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      if (document.execCommand('copy')) { showCopied(btn); showToast('Key-Value copied!', 'success'); }
      ta.remove();
    } catch(e) {}
  }
  function showCopied(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 2000);
  }
  attachButtons();
  new MutationObserver(attachButtons).observe(document.body, { childList: true, subtree: true });
})();

// ── Initialization ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  getCurrentTabId((tabId) => {
    if (!tabId) { rsWarn('[RS Panel] No valid tab ID'); return; }

    currentTabId = tabId;
    //console.log(`[RS DEBUG] Init | currentTabId=${tabId} | windowId=${myWindowId}`);
    document.getElementById('clearButton').addEventListener('click', () => clearAllItems(currentTabId));

    // Cache this window's tabs up front so early events skip the async lookup
    primeWindowTabs();

    // Initial load from persisted storage
    loadState(tabId, () => {
      if (currentTabId === tabId) {
        //console.log(`[RS DEBUG] Initial loadState done | tabId=${tabId} | items=${getTabCache(tabId).items.size}`);
        if (getTabCache(tabId).items.size > 0) document.body.classList.remove('clear-list');
        renderAll();
        fetchAndIngestLocalStorage(tabId);
      }
    });

    // ── Message listener ──────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type !== 'updatePopup' && message.type !== 'batchResult') return true;

      const msgTabId = message.tabId;

      // Drop messages with invalid tabId — never fall back to currentTabId
      if (!msgTabId || msgTabId < 0) {
        rsWarn('[RS Panel] message with invalid tabId, DROPPING', msgTabId);
        if (sendResponse) sendResponse({ received: false });
        return true;
      }

      // Broadcasts reach the panel in EVERY browser window. Only the panel that
      // owns this tab's window may ingest it, otherwise the same events land in
      // two panels and both write the same tab's storage.
      if (message.type === 'batchResult') {
        ifOwnWindow(msgTabId, () => {
          applyBatchResult(msgTabId, message.requestId, message.status, message.ok, message.error);
        });
        if (sendResponse) sendResponse({ received: true });
        return true;
      }

      //console.log(`[RS DEBUG] updatePopup | src=${message.source} | msgTabId=${msgTabId} | currentTabId=${currentTabId} | isActive=${msgTabId === currentTabId}`);

      if (message.source === 'network' && Array.isArray(message.data)) {
        // Network (batch) events are ingested for background tabs too — but only
        // background tabs of THIS window, so the data is ready on tab switch.
        ifOwnWindow(msgTabId, () => {
          ingestBatchEvents(message.data, message.timestamp, msgTabId, message.requestId);
        });
      } else if (message.source === 'localStorage' && message.data) {
        // localStorage events are only accepted for the active tab (guard is inside
        // ingestLocalStorageItems) to prevent same-origin bleed.
        ifOwnWindow(msgTabId, () => {
          ingestLocalStorageItems(message.data, msgTabId);
        });
      }

      if (sendResponse) sendResponse({ received: true });
      return true;
    });

    // ── Tab switch ────────────────────────────────────────────────────────
    // onActivated fires for EVERY window. The event carries its own windowId,
    // so this check needs no lookup — without it, switching tabs in another
    // browser window would drag this panel onto that window's tab.
    chrome.tabs.onActivated.addListener(({ tabId: newTabId, windowId }) => {
      if (windowId !== myWindowId) return;
      tabWindowMap.set(newTabId, windowId);
      if (!newTabId || newTabId === currentTabId) return;
      //console.log(`[RS DEBUG] onActivated | newTabId=${newTabId} | prevTabId=${currentTabId}`);
      switchToTab(newTabId);
    });

    // ── Tab dragged between windows ───────────────────────────────────────
    chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
      tabWindowMap.set(tabId, newWindowId);
      // A tab that just left this window must not stay on screen here
      if (newWindowId !== myWindowId && tabId === currentTabId) resyncActiveTab();
    });

    chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
      tabWindowMap.delete(tabId);
      if (oldWindowId === myWindowId && tabId === currentTabId) resyncActiveTab();
    });

    // ── Tab reload / navigate ─────────────────────────────────────────────
    chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
      if (changeInfo.status !== 'complete') return;
      //console.log(`[RS DEBUG] onUpdated (complete) | tabId=${updatedTabId} | currentTabId=${currentTabId}`);
      // Only re-read localStorage for the currently active tab
      if (updatedTabId === currentTabId) {
        fetchAndIngestLocalStorage(updatedTabId);
      }
    });

    // ── Tab closed — drop this panel's in-memory copy ─────────────────────
    // Persisted storage is cleaned by background.js, which is a single instance
    // and sees every window. Doing it here would mean N panels racing to delete
    // the same keys, and tabs in window-less-panel windows never being cleaned.
    chrome.tabs.onRemoved.addListener((removedTabId) => {
      //.log(`[RS DEBUG] onRemoved | tabId=${removedTabId}`);
      tabWindowMap.delete(removedTabId);
      tabCache.delete(removedTabId);
      if (removedTabId === currentTabId) resyncActiveTab();
    });
  });
});
