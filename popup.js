// popup.js
(function(){
  if (window.__perfHelpersInjected) return;
  window.__perfHelpersInjected = true;
  window._throttle = function(fn, wait){ var last=0; return function(){ var now=Date.now(); if(now-last>wait){ last=now; fn.apply(this, arguments);} }; };
  window._debounce = function(fn, wait){ var t; return function(){ var ctx=this, args=arguments; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,args); }, wait); }; };
})();

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

// ── Per-tab in-memory cache ───────────────────────────────────────────────────
const tabCache = new Map();

function getTabCache(tabId) {
  if (!tabCache.has(tabId)) {
    tabCache.set(tabId, { items: new Map(), sentIds: new Set(), loaded: false });
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
    let entries = [...cache.items.entries()]
      .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
    if (entries.length > MAX_ITEMS) entries = entries.slice(0, MAX_ITEMS);

    const serialItems = JSON.stringify(entries);
    const serialSent  = JSON.stringify([...cache.sentIds].slice(-MAX_ITEMS));

    if ((serialItems.length + serialSent.length) * 2 > 4 * 1024 * 1024) {
      rsWarn('[RS Panel] saveState: too large, skipping');
      return;
    }
    chrome.storage.local.set({
      [`allItems_${tabId}`]: serialItems,
      [`sentIds_${tabId}`]:  serialSent,
    }, () => {
      if (chrome.runtime.lastError) rsWarn('[RS Panel] saveState:', chrome.runtime.lastError.message);
    });
  } catch(e) { rsWarn('[RS Panel] saveState exception:', e); }
}

function loadState(tabId, callback) {
  if (!tabId) { callback(); return; }
  chrome.storage.local.get([`allItems_${tabId}`, `sentIds_${tabId}`], (result) => {
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
    cache.loaded = true;
    callback();
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const filterInput = document.getElementById('filter-input');
const clearBtn    = document.getElementById('clear-btn');
const itemList    = document.getElementById('localStorage-items');

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
function applyFilter() {
  const q = filterInput.value.toLowerCase();
  clearBtn.style.display = q ? 'block' : 'none';
  document.querySelectorAll('#localStorage-items .item').forEach(el => {
    const s = el.querySelector('.subtitle')?.textContent.toLowerCase() || '';
    const k = el.querySelector('.key')?.textContent.toLowerCase() || '';
    el.classList.toggle('hidden', !(s.includes(q) || k.includes(q)));
  });
}
filterInput.addEventListener('input', applyFilter);
clearBtn.addEventListener('click', () => {
  filterInput.value = '';
  clearBtn.style.display = 'none';
  applyFilter();
});
new MutationObserver(() => applyFilter()).observe(itemList, { childList: true, subtree: true });

// ── Tab helper ────────────────────────────────────────────────────────────────
function getCurrentTabId(callback) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      callback((tabs && tabs[0]?.id) ? tabs[0].id : null);
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
  cache.loaded = true;

  chrome.storage.local.remove([`allItems_${tabId}`, `sentIds_${tabId}`]);
  try { chrome.tabs.sendMessage(tabId, { type: 'clearAll' }, () => chrome.runtime.lastError); } catch(e) {}

  if (tabId === currentTabId) {
    itemList.innerHTML = '';
    document.body.classList.add('clear-list');
    //console.log(`[RS DEBUG] clearAllItems: DOM cleared for active tab ${tabId}`);
  }

  const btn = document.getElementById('clearButton');
  if (btn) { btn.classList.add('clearing'); setTimeout(() => btn.classList.remove('clearing'), 200); }
}

// ── CORE: ingest batch events for a specific tab ──────────────────────────────
function ingestBatchEvents(batchArray, timestamp, targetTabId) {
  if (!Array.isArray(batchArray) || !targetTabId || targetTabId < 0) return;

  const cache = getTabCache(targetTabId);
  let newCount = 0;

  batchArray.forEach((event) => {
    if (!event?.messageId) return;
    if (event.type !== 'track' && event.type !== 'page') return;

    const msgId = event.messageId;
    const key   = cacheKey(targetTabId, msgId);

    cache.sentIds.add(msgId);

    if (!cache.items.has(key)) {
      cache.items.set(key, {
        parsedValue: event,
        value: JSON.stringify(event),
        originalKey: event.event || event.name || event.type,
        propertiesKey: event.properties || null,
        timestamp: event.originalTimestamp
          ? new Date(event.originalTimestamp).getTime()
          : (timestamp || Date.now()),
        source: 'batch',
        msgId,
      });
      newCount++;
    }
  });

  //console.log(`[RS DEBUG] ingestBatch | tabId=${targetTabId} | +${newCount} new | total=${cache.items.size} | isActive=${targetTabId === currentTabId}`);
  if (newCount > 0) saveState(targetTabId);

  if (targetTabId === currentTabId) {
    //console.log(`[RS DEBUG] ingestBatch -> renderAll for active tab ${targetTabId}`);
    renderAll();
  }
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
function renderAll() {
  if (!currentTabId) {
    itemList.innerHTML = '';
    document.body.classList.add('clear-list');
    return;
  }

  const { items, sentIds } = getTabCache(currentTabId);

  const sorted = [...items.entries()]
    .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

  //console.log(`[RS DEBUG] renderAll | currentTabId=${currentTabId} | items=${sorted.length} | DOM had=${itemList.children.length}`);

  // Build a map of currently rendered DOM items
  const domMap = new Map();
  itemList.querySelectorAll('.item[data-key]').forEach(el => {
    domMap.set(el.getAttribute('data-key'), el);
  });

  if (domMap.size === 0) {
    // Fresh render — sorted descending so newest is first in fragment
    const frag = document.createDocumentFragment();
    sorted.forEach(([key, data]) => {
      const isSent = sentIds.has(data.msgId || key);
      const el = createItemElement(key, data, isSent);
      el.setAttribute('data-key', key);
      frag.appendChild(el);
    });
    itemList.appendChild(frag);
    //console.log(`[RS DEBUG] renderAll: fresh render, appended ${sorted.length} items`);
  } else {
    // Incremental update:
    // - new item  -> insertBefore firstChild (top)
    // - existing  -> update sent badge only
    // - stale     -> remove from DOM
    sorted.forEach(([key, data]) => {
      const isSent = sentIds.has(data.msgId || key);
      if (domMap.has(key)) {
        const el = domMap.get(key);
        domMap.delete(key);
        if (isSent && !el.classList.contains('sent-item')) {
          el.classList.add('sent-item');
          const bc = el.querySelector('.badges-container');
          if (bc && !bc.querySelector('.sent-badge')) bc.appendChild(createSentBadge());
        }
      } else {
        const el = createItemElement(key, data, isSent);
        el.setAttribute('data-key', key);
        el.classList.add('new-item');
        itemList.insertBefore(el, itemList.firstChild);
        setTimeout(() => {
          el.classList.add('transition-complete');
          setTimeout(() => el.classList.remove('new-item', 'transition-complete'), 300);
        }, 3000);
      }
    });
    // Remove DOM nodes no longer present in cache (tab cleared or switched)
    domMap.forEach(el => el.remove());
  }

  if (itemList.children.length > 0) {
    document.body.classList.remove('clear-list');
  } else {
    document.body.classList.add('clear-list');
  }
  applyFilter();
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

    if (cache.items.size > 0) {
      document.body.classList.remove('clear-list');
      renderAll();
    }
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

    chrome.scripting.executeScript({
      target: { tabId },
      func: function safeGetLocalStorage() {
        try {
          const items = {};
          if (!localStorage) return items;
          for (let i = 0; i < localStorage.length; i++) {
            try {
              const key = localStorage.key(i);
              if (!key?.startsWith('rudder_') || !key.endsWith('.batchQueue')) continue;
              const value = localStorage.getItem(key);
              if (!value) continue;
              try {
                const parsed = JSON.parse(JSON.parse(value));
                for (const j in parsed) {
                  const ev = parsed[j]?.item?.event;
                  if (!ev || (ev.type !== 'track' && ev.type !== 'page') || !ev.messageId) continue;
                  items[ev.messageId] = {
                    value: JSON.stringify(ev),
                    parsedValue: ev,
                    originalKey: ev.event || ev.name || ev.messageId,
                    propertiesKey: ev.properties || null,
                    timestamp: Date.now(),
                    source: 'localStorage',
                  };
                }
              } catch(e) {}
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

function createItemElement(key, data, isSent) {
  data = data || {};
  const itemDiv = document.createElement('div');
  itemDiv.className = 'item';
  itemDiv.setAttribute('data-key', key);
  if (isSent) itemDiv.classList.add('sent-item');
  if (data.source === 'batch') itemDiv.classList.add('batch-item');

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
  if (isSent) badgesContainer.appendChild(createSentBadge());
  if (data.source === 'batch') badgesContainer.appendChild(createBatchBadge());

  keyContainer.appendChild(subtitleDiv);
  keyContainer.appendChild(keyDiv);
  keyContainer.appendChild(badgesContainer);

  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'toggle-icon collapsed';
  toggleIcon.innerHTML = '<img src="expand_more-128.png" class="view-more" />';

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
    //console.log(`[RS DEBUG] Init | currentTabId=${tabId}`);
    document.getElementById('clearButton').addEventListener('click', () => clearAllItems(currentTabId));

    // Initial load from persisted storage
    loadState(tabId, () => {
      if (currentTabId === tabId) {
        //console.log(`[RS DEBUG] Initial loadState done | tabId=${tabId} | items=${getTabCache(tabId).items.size}`);
        if (getTabCache(tabId).items.size > 0) {
          document.body.classList.remove('clear-list');
          renderAll();
        }
        fetchAndIngestLocalStorage(tabId);
      }
    });

    // ── Message listener ──────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type !== 'updatePopup') { return true; }

      const msgTabId = message.tabId;

      // Drop messages with invalid tabId — never fall back to currentTabId
      if (!msgTabId || msgTabId < 0) {
        rsWarn('[RS Panel] updatePopup: invalid tabId, DROPPING', msgTabId);
        if (sendResponse) sendResponse({ received: false });
        return true;
      }

      //console.log(`[RS DEBUG] updatePopup | src=${message.source} | msgTabId=${msgTabId} | currentTabId=${currentTabId} | isActive=${msgTabId === currentTabId}`);

      if (message.source === 'network' && Array.isArray(message.data)) {
        // Network (batch) events are always ingested regardless of which tab is active —
        // they carry a verified tabId from background.js and must not be dropped.
        ingestBatchEvents(message.data, message.timestamp, msgTabId);
      } else if (message.source === 'localStorage' && message.data) {
        // localStorage events are only accepted for the active tab (guard is inside
        // ingestLocalStorageItems) to prevent same-origin bleed.
        ingestLocalStorageItems(message.data, msgTabId);
      }

      if (sendResponse) sendResponse({ received: true });
      return true;
    });

    // ── Tab switch ────────────────────────────────────────────────────────
    chrome.tabs.onActivated.addListener(({ tabId: newTabId }) => {
      if (!newTabId || newTabId === currentTabId) return;
      //console.log(`[RS DEBUG] onActivated | newTabId=${newTabId} | prevTabId=${currentTabId}`);
      switchToTab(newTabId);
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

    // ── Tab closed — wipe memory and persisted storage ────────────────────
    chrome.tabs.onRemoved.addListener((removedTabId) => {
      //.log(`[RS DEBUG] onRemoved | tabId=${removedTabId}`);
      tabCache.delete(removedTabId);
      chrome.storage.local.remove([`allItems_${removedTabId}`, `sentIds_${removedTabId}`]);
    });
  });
});
