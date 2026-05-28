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

// ── State ─────────────────────────────────────────────────────────────────────
let allItems = new Map();
let sentMessageIds = new Set();
let currentTabId = null;

// expose globally for sidepanel-init.js stats updater
window.allItems = allItems;
window.sentMessageIds = sentMessageIds;

// ── Settings cache ────────────────────────────────────────────────────────────
let _showJsonViewer = true;
let _debugEnabled   = false;

function rsLog(...args) {
  if (_debugEnabled) console.log(...args);
}
function rsWarn(...args) {
  if (_debugEnabled) console.warn(...args);
}

// Load settings once at startup
chrome.storage.local.get(['showJsonViewer', 'enableDebug'], (res) => {
  _showJsonViewer = res.showJsonViewer !== false;
  _debugEnabled   = res.enableDebug === true;
});

// ── Storage quota-safe save ───────────────────────────────────────────────────
// Keep only the most recent MAX_ITEMS events to avoid quota errors
const MAX_ITEMS = 200;

function saveState(tabId) {
  try {
    // Trim to MAX_ITEMS newest
    let entries = [...allItems.entries()].sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
    if (entries.length > MAX_ITEMS) entries = entries.slice(0, MAX_ITEMS);

    const trimmedItems = JSON.stringify(entries);
    const trimmedSent  = JSON.stringify([...sentMessageIds].slice(-MAX_ITEMS));

    // Estimate size (2 bytes per char approx)
    const estimatedBytes = (trimmedItems.length + trimmedSent.length) * 2;
    // chrome.storage.local limit is 10MB; stay under 4MB per tab to be safe
    if (estimatedBytes > 4 * 1024 * 1024) {
      rsWarn('[RS Panel] saveState: data too large, skipping save');
      return;
    }

    chrome.storage.local.set({
      [`allItems_${tabId}`]: trimmedItems,
      [`sentIds_${tabId}`]:  trimmedSent,
    }, () => {
      if (chrome.runtime.lastError) {
        rsWarn('[RS Panel] saveState error:', chrome.runtime.lastError.message);
      }
    });
  } catch(e) {
    rsWarn('[RS Panel] saveState exception:', e);
  }
}

function loadState(tabId, callback) {
  chrome.storage.local.get([`allItems_${tabId}`, `sentIds_${tabId}`], (result) => {
    if (result[`allItems_${tabId}`]) {
      try { allItems = new Map(JSON.parse(result[`allItems_${tabId}`])); window.allItems = allItems; } catch(e) {}
    }
    if (result[`sentIds_${tabId}`]) {
      try { sentMessageIds = new Set(JSON.parse(result[`sentIds_${tabId}`])); window.sentMessageIds = sentMessageIds; } catch(e) {}
    }
    callback();
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const filterInput = document.getElementById("filter-input");
const clearBtn    = document.getElementById("clear-btn");
const itemList    = document.getElementById("localStorage-items");

const JSON_CLASSES = {
  int: 'json-int', float: 'json-float', boolean: 'json-boolean',
  null: 'json-null', string: 'json-string', object: 'json-object', array: 'json-array'
};

// ── Placeholder easter egg ────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("filter-input");
  const originalPlaceholder = "Filter events...";
  const tempText = "Developed with ❤️ by Mehrdad Khoddami";
  if (!localStorage.getItem("shownPlaceholderOnce")) {
    input.placeholder = tempText;
    setTimeout(() => {
      input.style.opacity = "0";
      setTimeout(() => {
        input.placeholder = originalPlaceholder;
        input.style.opacity = "1";
        localStorage.setItem("shownPlaceholderOnce", "true");
      }, 500);
    }, 5000);
  } else {
    input.placeholder = originalPlaceholder;
  }
});

// ── Filter ────────────────────────────────────────────────────────────────────
function applyFilter() {
  const filterValue = filterInput.value.toLowerCase();
  const items = document.querySelectorAll("#localStorage-items .item");
  clearBtn.style.display = filterValue ? "block" : "none";
  items.forEach(item => {
    const subtitleEl = item.querySelector(".key-container .subtitle");
    const keyEl      = item.querySelector(".key-container .key");
    if (!subtitleEl || !keyEl) return;
    const matches = subtitleEl.textContent.toLowerCase().includes(filterValue) ||
                    keyEl.textContent.toLowerCase().includes(filterValue);
    item.classList.toggle("hidden", !matches);
  });
}
filterInput.addEventListener("input", applyFilter);
clearBtn.addEventListener("click", () => {
  filterInput.value = "";
  clearBtn.style.display = "none";
  applyFilter();
});
new MutationObserver(() => applyFilter()).observe(itemList, { childList: true, subtree: true });

// ── Tab helper ────────────────────────────────────────────────────────────────
function getCurrentTabId(callback) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      callback((tabs && tabs[0] && tabs[0].id) ? tabs[0].id : null);
    });
  } catch (e) { callback(null); }
}

// ── Clear ─────────────────────────────────────────────────────────────────────
function clearAllItems(tabId) {
  allItems.clear();
  sentMessageIds.clear();
  document.getElementById('localStorage-items').innerHTML = '';
  document.body.classList.add('clear-list');

  chrome.storage.local.remove([`allItems_${tabId}`, `sentIds_${tabId}`]);

  try {
    chrome.tabs.sendMessage(tabId, { type: 'clearAll' }, () => { chrome.runtime.lastError; });
  } catch (e) {}

  const btn = document.getElementById('clearButton');
  btn.classList.add('clearing');
  setTimeout(() => btn.classList.remove('clearing'), 200);
}

// ── Ingest batch events ───────────────────────────────────────────────────────
function ingestBatchEvents(batchArray, timestamp) {
  if (!Array.isArray(batchArray)) {
    rsWarn('[RS Panel] ingestBatchEvents called with non-array:', batchArray);
    return;
  }

  rsLog(`[RS Panel] ingestBatchEvents: processing ${batchArray.length} events`);
  let newCount = 0, alreadySeenCount = 0, skippedCount = 0;

  batchArray.forEach((event, i) => {
    if (!event || !event.messageId) { skippedCount++; return; }
    if (event.type !== 'track' && event.type !== 'page') { skippedCount++; return; }

    const msgId = event.messageId;
    sentMessageIds.add(msgId);

    if (!allItems.has(msgId)) {
      allItems.set(msgId, {
        parsedValue: event,
        value: JSON.stringify(event),
        originalKey: event.event || event.name || event.type,
        propertiesKey: event.properties || null,
        timestamp: event.originalTimestamp ? new Date(event.originalTimestamp).getTime() : (timestamp || Date.now()),
        source: 'batch',
      });
      newCount++;
    } else {
      alreadySeenCount++;
    }
  });

  rsLog(`[RS Panel] Done: new=${newCount}, markedSent=${alreadySeenCount}, skipped=${skippedCount} | total=${allItems.size}`);

  renderAll();
  saveState(currentTabId);
}

// ── Ingest localStorage events ────────────────────────────────────────────────
function ingestLocalStorageItems(itemsObj) {
  if (!itemsObj || typeof itemsObj !== 'object') return;
  let changed = false;

  Object.entries(itemsObj).forEach(([msgId, data]) => {
    if (!allItems.has(msgId)) {
      allItems.set(msgId, {
        parsedValue: data.parsedValue,
        value: data.value,
        originalKey: data.originalKey || msgId,
        propertiesKey: data.propertiesKey || null,
        timestamp: data.timestamp || Date.now(),
        source: 'localStorage',
      });
      changed = true;
    }
  });

  if (changed) {
    renderAll();
    saveState(currentTabId);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderAll() {
  const container = document.getElementById('localStorage-items');
  const sorted = [...allItems.entries()]
    .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));

  const existingEls = new Map();
  container.querySelectorAll('.item[data-key]').forEach(el => {
    existingEls.set(el.getAttribute('data-key'), el);
  });

  sorted.forEach(([msgId, data]) => {
    const isSent = sentMessageIds.has(msgId);
    let el = existingEls.get(msgId);

    if (!el) {
      el = createItemElement(msgId, data, isSent);
      el.setAttribute('data-key', msgId);
      el.classList.add('new-item');
      container.insertBefore(el, container.firstChild);
      setTimeout(() => {
        el.classList.add('transition-complete');
        setTimeout(() => el.classList.remove('new-item', 'transition-complete'), 300);
      }, 3000);
    } else {
      existingEls.delete(msgId);
      // Update sent badge — always inside badges-container
      if (isSent && !el.classList.contains('sent-item')) {
		  el.classList.add('sent-item');
		  const badgesContainer = el.querySelector('.badges-container');
		  if (badgesContainer && !badgesContainer.querySelector('.sent-badge')) {
			badgesContainer.appendChild(createSentBadge());
		  }
		}
    }
  });

  existingEls.forEach(el => el.remove());

  if (container.children.length > 0) {
    document.body.classList.remove('clear-list');
  }
  applyFilter();
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
    case 'string': display = addQuotes ? `"${String(parsed)}"` : String(parsed); break;
    case 'null': display = 'null'; break;
    case 'boolean':
      display = parsed;
      cssClass = parsed === true ? 'json-boolean-true' : 'json-boolean-false';
      break;
    default: display = parsed;
  }
  return `<span class="${cssClass}">${display}</span>`;
}

function prettyPrintJson(obj, indent = 0) {
  const keyClass = 'json-key';
  const indentStr = ' '.repeat(indent * 3);
  let html = '';
  const type = detectType(obj);
  if (['int','float','boolean','null','string'].includes(type)) {
    html += renderValueSpan(obj);
  } else if (type === 'array') {
    html += '[<br>';
    obj.forEach((item, i) => {
      html += indentStr + '   ' + prettyPrintJson(item, indent + 1);
      if (i < obj.length - 1) html += ',';
      html += '<br>';
    });
    html += indentStr + ']';
  } else if (type === 'object') {
    html += '{<br>';
    const entries = Object.entries(obj);
    entries.forEach(([k, v], i) => {
      html += indentStr + '   <span class="' + keyClass + '">' + k + '</span>: ' + prettyPrintJson(v, indent + 1);
      if (i < entries.length - 1) html += ',';
      html += '<br>';
    });
    html += indentStr + '}';
  }
  return html;
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
  const headerRow = document.createElement('tr');
  ['Key','Value'].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  Object.entries(json).sort((a,b) => a[0].localeCompare(b[0])).forEach(([k,v]) => {
    const row = document.createElement('tr');
    const keyCell = document.createElement('td');
    keyCell.textContent = k;
    row.appendChild(keyCell);
    const valueCell = document.createElement('td');
    const type = detectType(v);
    valueCell.innerHTML = ['int','float','boolean','null','string'].includes(type) ?
      renderValueSpan(v, false) : prettyPrintJson(v);
    row.appendChild(valueCell);
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
    const text = (typeof value === 'object' && value !== null) ? JSON.stringify(value, null, 2) : String(value);
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.disabled = true;
      showToast('Text copied to clipboard!', 'success');
      setTimeout(() => { btn.textContent = 'Copy'; btn.disabled = false; }, 1000);
    }).catch(err => { rsLog('Failed to copy:', err); showToast('Failed to copy', 'error'); });
  });
  return btn;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.classList.add('toast', type);
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 100);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 500);
  }, 1000);
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

  // ── badges-container: ALL badges go here ──────────────────────────────────
  const badgesContainer = document.createElement('div');
  badgesContainer.className = 'badges-container';

  // 1. Timestamp
  if (data.timestamp) {
    const timeDiv = document.createElement('span');
    timeDiv.className = 'timestamp';
    timeDiv.textContent = new Date(data.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    badgesContainer.appendChild(timeDiv);
  }

  // 2. SENT badge (first, if sent)
  if (isSent) badgesContainer.appendChild(createSentBadge());

  // 3. BATCH badge
  if (data.source === 'batch') badgesContainer.appendChild(createBatchBadge());

  keyContainer.appendChild(subtitleDiv);
  keyContainer.appendChild(keyDiv);
  keyContainer.appendChild(badgesContainer);

  // ── Toggle chevron ────────────────────────────────────────────────────────
  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'toggle-icon collapsed';
  toggleIcon.innerHTML = '<img src="expand_more-128.png" class="view-more" />';

  // ── Value container ───────────────────────────────────────────────────────
  const valueContainer = document.createElement('div');
  valueContainer.className = 'value-container';

  // Properties table
  const propertiesDiv = document.createElement('div');
  propertiesDiv.className = 'properties-value';
  try {
    if (data.propertiesKey) propertiesDiv.appendChild(createTableFromJson(data.propertiesKey));
  } catch(e) {}

  // JSON viewer (inside-value-container) — controlled by showJsonViewer setting
  const insideValueContainer = document.createElement('div');
  insideValueContainer.className = 'inside-value-container';

  // Apply current setting; also update whenever setting changes
  if (!_showJsonViewer) insideValueContainer.style.display = 'none';

  const valueDiv = document.createElement('pre');
  valueDiv.className = 'value';
  try {
    valueDiv.innerHTML = data.parsedValue ? prettyPrintJson(data.parsedValue) : (data.value || 'No value available');
  } catch(e) {
    valueDiv.textContent = data.value || 'Error displaying value';
  }

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

// ── Re-apply showJsonViewer when setting changes ──────────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.showJsonViewer) {
    _showJsonViewer = changes.showJsonViewer.newValue !== false;
    document.querySelectorAll('.inside-value-container').forEach(el => {
      el.style.display = _showJsonViewer ? '' : 'none';
    });
  }
  if (changes.enableDebug) {
    _debugEnabled = changes.enableDebug.newValue === true;
  }
});

// ── Row copy SVG ──────────────────────────────────────────────────────────────
(function attachRowCopySVG(joiner = ': ') {
  function createCopyBtn() {
    const btn = document.createElement('span');
    btn.className = 'copy-icon';
    btn.title = 'Copy row';
    return btn;
  }
  function attachButtons() {
    document.querySelectorAll('table tr').forEach(tr => {
      if (!tr.querySelector('.copy-icon')) {
        const firstCell = tr.querySelector('td, th');
        if (firstCell) {
          const btn = createCopyBtn();
          firstCell.prepend(btn);
          btn.addEventListener('click', e => { e.stopPropagation(); copyRow(tr, btn); });
        }
      }
    });
  }
  function copyRow(tr, btn) {
    const cells = Array.from(tr.querySelectorAll('td, th'));
    const texts = cells.map(c => c.innerText.trim());
    const parsed = parseValue(texts[1]);
    const type = detectType(parsed);
    texts[1] = (type === 'string') ? `"${parsed}"` : parsed;
    const finalText = texts.join(joiner);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(finalText).then(() => {
        showCopiedEffect(btn); showToast('Key-Value copied!', 'success');
      }).catch(() => fallbackCopy(finalText, btn));
    } else { fallbackCopy(finalText, btn); }
  }
  function fallbackCopy(text, btn) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      if (document.execCommand('copy')) { showCopiedEffect(btn); showToast('Key-Value copied!', 'success'); }
      document.body.removeChild(ta);
    } catch(ex) {}
  }
  function showCopiedEffect(btn) {
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
    if (!tabId) { rsWarn('[RS Panel] No valid tab ID found'); return; }
    currentTabId = tabId;

    document.getElementById('clearButton').addEventListener('click', () => clearAllItems(tabId));

    loadState(tabId, () => {
      if (allItems.size > 0) renderAll();

      chrome.scripting.executeScript({
        target: { tabId },
        func: function safeGetLocalStorage() {
          try {
            const items = {};
            if (!localStorage) return items;
            for (let i = 0; i < localStorage.length; i++) {
              try {
                const key = localStorage.key(i);
                if (!key || !key.startsWith('rudder_') || !key.endsWith('.batchQueue')) continue;
                const value = localStorage.getItem(key);
                if (!value) continue;
                try {
                  const parsedL1 = JSON.parse(value);
                  const parsedJson = JSON.parse(parsedL1);
                  for (let j in parsedJson) {
                    if (!parsedJson[j].item || !parsedJson[j].item.event) continue;
                    const currentItem = parsedJson[j].item.event;
                    if (currentItem.type === 'track' || currentItem.type === 'page') {
                      const k = currentItem.messageId;
                      if (!k) continue;
                      items[k] = {
                        value: JSON.stringify(currentItem),
                        parsedValue: currentItem,
                        originalKey: currentItem.event || currentItem.name || k,
                        propertiesKey: currentItem.properties || null,
                        timestamp: Date.now(),
                        source: 'localStorage'
                      };
                    }
                  }
                } catch(e) {}
              } catch(e) { continue; }
            }
            return items;
          } catch(e) { return {}; }
        }
      }, (results) => {
        if (results && results[0] && results[0].result) {
          ingestLocalStorageItems(results[0].result);
        }
      });
    });

    // ── Message listener ───────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type !== 'updatePopup') { return true; }

      const msgTabId = message.tabId;
      const tabMatches = msgTabId === undefined || msgTabId === null ||
                         msgTabId === -1 || msgTabId === tabId;

      rsLog('[RS Panel] updatePopup | source:', message.source,
            '| msgTabId:', msgTabId, '| ourTabId:', tabId, '| match:', tabMatches);

      if (tabMatches) {
        if (message.source === 'network' && Array.isArray(message.data)) {
          ingestBatchEvents(message.data, message.timestamp);
        } else if (message.source === 'localStorage' && message.data) {
          ingestLocalStorageItems(message.data);
        }
        if (sendResponse) sendResponse({ received: true });
      }
      return true;
    });
  });
});
