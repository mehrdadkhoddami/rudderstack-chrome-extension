// contentScript.js
(() => {
  let isExtensionActive = true;
  let port = null;
  let monitoringInterval = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  let interceptorInjected = false;

  // ── Debug logging ──────────────────────────────────────────────────────────
  let _debugEnabled = false;
  function rsLog(...args)  { if (_debugEnabled) console.log(...args); }
  function rsWarn(...args) { if (_debugEnabled) console.warn(...args); }

  chrome.storage.local.get(['enableDebug'], (res) => {
    _debugEnabled = res.enableDebug === true;
    pushDebugToPage();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enableDebug) {
      _debugEnabled = changes.enableDebug.newValue === true;
      pushDebugToPage();
    }
  });

  // interceptor.js runs in page context and cannot read chrome.storage, so the
  // debug flag has to be pushed across the boundary.
  function pushDebugToPage() {
    try {
      window.dispatchEvent(new CustomEvent('__rs_update_debug', { detail: { debug: _debugEnabled } }));
    } catch (e) { /* noop */ }
  }

  // ── Event types the tracker ingests ────────────────────────────────────────
  // Matches the RudderStack spec API surface. Kept in sync with the same list
  // in popup.js.
  const TRACKED_EVENT_TYPES = new Set(['track', 'page', 'screen', 'identify', 'group', 'alias']);

  // ── localStorage key pattern cache (global settings) ──────────────────────
  let _lsPatterns = {
    patternRudder: true,
    patternQueue:  true,
    customRules:   [],
  };

  function loadLsPatterns(cb) {
    chrome.storage.local.get(['patternRudder', 'patternQueue', 'customLsPatterns'], (res) => {
      _lsPatterns = {
        patternRudder: res.patternRudder !== false,
        patternQueue:  res.patternQueue  !== false,
        customRules:   Array.isArray(res.customLsPatterns) ? res.customLsPatterns : [],
      };
      if (cb) cb();
    });
  }

  loadLsPatterns();

  chrome.storage.onChanged.addListener((changes) => {
    let lsPatternChanged = false;
    if (changes.patternRudder)    { _lsPatterns.patternRudder = changes.patternRudder.newValue !== false;  lsPatternChanged = true; }
    if (changes.patternQueue)     { _lsPatterns.patternQueue  = changes.patternQueue.newValue  !== false;  lsPatternChanged = true; }
    if (changes.customLsPatterns) { _lsPatterns.customRules   = Array.isArray(changes.customLsPatterns.newValue) ? changes.customLsPatterns.newValue : []; lsPatternChanged = true; }
    // Push updated patterns into page context so storage-monitor.js stays in sync
    if (lsPatternChanged) pushLsPatternsToPage();
  });

  // ── Key matching ───────────────────────────────────────────────────────────
  function keyMatchesPatterns(key) {
    if (_lsPatterns.patternRudder && key.startsWith('rudder_') && key.endsWith('.batchQueue')) return true;
    if (_lsPatterns.patternQueue  && key.startsWith('queue.')) return true;
    for (const rule of _lsPatterns.customRules) {
      if (!rule.prefix) continue;
      if (key.startsWith(rule.prefix)) {
        if (!rule.suffix || key.endsWith(rule.suffix)) return true;
      }
    }
    return false;
  }

  // ── Unwrap a single localStorage array/object element into a raw event ───────
  // Handles three shapes without false-positives on el.event being a string:
  //   { item: { event: {...} } }        SDK v3 batchQueue wrapper
  //   { event: {...} }                  thin object wrapper
  //   { messageId, type, event: "name"} direct event (event field is a string)
  function unwrapStorageElement(el) {
    if (!el || typeof el !== 'object') return null;
    if (el.item?.event && typeof el.item.event === 'object') return el.item.event;
    if (el.event       && typeof el.event       === 'object') return el.event;
    if (el.messageId) return el; // direct event object
    return null;
  }

  // ── Parse a single localStorage value into event items ────────────────────
  function parseStorageValue(rawValue, outItems) {
    try {
      let parsed = JSON.parse(rawValue);

      // Structure 1: double-encoded string (standard RudderStack SDK)
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }

      // Structure 2: array — each element may be:
      //   a) direct event object  { messageId, type, event: "name", ... }  ← queue.* / partner.*
      //   b) SDK v3 wrapper       { item: { event: {...} }, attemptNumber } ← rudder_beacon_*
      //   c) thin event wrapper   { event: { messageId, ... } }
      // NOTE: in case (a) el.event is a STRING (the event name), not an object —
      //       so we must check typeof before using el.event as the event object.
      if (Array.isArray(parsed)) {
        parsed.forEach(el => addEventToItems(unwrapStorageElement(el), outItems));
        return;
      }

      // Structure 3: numeric-indexed object { 0: { item: { event: {...} } }, ... }
      if (typeof parsed === 'object' && parsed !== null) {
        for (const j in parsed) {
          addEventToItems(unwrapStorageElement(parsed[j]), outItems);
        }
      }
    } catch (e) {}
  }

  function addEventToItems(ev, outItems) {
    if (!ev || typeof ev !== 'object' || !ev.messageId) return;
    if (!TRACKED_EVENT_TYPES.has(ev.type)) return;
    outItems[ev.messageId] = {
      value:        JSON.stringify(ev),
      parsedValue:  ev,
      // identify/group/alias have no `event` name — fall back to the type.
      originalKey:  ev.event || ev.name || ev.type || ev.messageId,
      eventType:    ev.type || 'unknown',
      propertiesKey: ev.properties || ev.traits || null,
      timestamp:    Date.now(),
      source:       'localStorage',
      msgId:        ev.messageId,
    };
  }

  // ── Pending message queue (captured before port is ready) ──────────────────
  const pendingMessages = [];

  function postOrQueue(message) {
    if (port) {
      try {
        port.postMessage(message);
        return;
      } catch (e) {
        rsWarn('[RS Content] postMessage failed, queuing:', e);
        pendingMessages.push(message);
        handleConnectionError();
        return;
      }
    }
    pendingMessages.push(message);
  }

  function flushPendingMessages() {
    if (!port || pendingMessages.length === 0) return;
    rsLog(`[RS Content] Flushing ${pendingMessages.length} pending message(s)`);
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      try {
        port.postMessage(message);
      } catch(e) {
        rsWarn('[RS Content] Failed to flush pending message:', e);
        pendingMessages.unshift(message);
        handleConnectionError();
        break;
      }
    }
  }

  // ── Inject interceptor.js ──────────────────────────────────────────────────
  function injectInterceptor(pattern) {
    if (interceptorInjected) {
      window.dispatchEvent(new CustomEvent('__rs_update_pattern', { detail: { pattern } }));
      return;
    }
    interceptorInjected = true;

    try {
      const scriptUrl = chrome.runtime.getURL('interceptor.js');
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.dataset.pattern = pattern || '/beacon/v1/batch';
      script.dataset.debug   = _debugEnabled ? 'true' : 'false';
      script.onload = () => {
        script.remove();
        pushDebugToPage();
        rsLog('[RS Content] interceptor.js injected, pattern:', pattern);
      };
      script.onerror = (e) => {
        rsWarn('[RS Content] Failed to inject interceptor.js:', e);
      };
      (document.head || document.documentElement).prepend(script);
    } catch (e) {
      rsWarn('[RS Content] Error injecting interceptor:', e);
    }
  }

  // ── Listen for captured batches from page context ──────────────────────────
  window.addEventListener('__rs_batch_captured', (e) => {
    try {
      const { batch, timestamp, sourceType, requestId } = e.detail;
      if (!Array.isArray(batch) || !batch.length) return;
      rsLog(`[RS Content] __rs_batch_captured: ${batch.length} events via ${sourceType}`);
      postOrQueue({ type: 'batchCaptured', data: batch, timestamp, requestId });
    } catch (err) {
      rsWarn('[RS Content] Error handling __rs_batch_captured:', err);
    }
  });

  // ── Listen for HTTP results of previously captured batches ─────────────────
  window.addEventListener('__rs_batch_result', (e) => {
    try {
      const { requestId, status, ok, error } = e.detail;
      if (!requestId) return;
      rsLog(`[RS Content] __rs_batch_result: ${requestId} status=${status} ok=${ok}`);
      postOrQueue({ type: 'batchResult', requestId, status, ok, error });
    } catch (err) {
      rsWarn('[RS Content] Error handling __rs_batch_result:', err);
    }
  });

  // ── localStorage monitoring ────────────────────────────────────────────────
  function safeGetLocalStorage() {
    try {
      const items = {};
      if (!localStorage) return items;
      for (let i = 0; i < localStorage.length; i++) {
        try {
          const key = localStorage.key(i);
          if (!key || !keyMatchesPatterns(key)) continue;
          const value = localStorage.getItem(key);
          if (!value) continue;
          parseStorageValue(value, items);
        } catch (itemError) { continue; }
      }
      return items;
    } catch (e) { return {}; }
  }

  function checkAndNotifyChanges() {
    try {
      if (!isExtensionActive || !chrome.runtime) { cleanup(); return; }
      const items = safeGetLocalStorage();
      if (port && Object.keys(items).length > 0) {
        try {
          port.postMessage({ type: 'storageChanged', data: items });
        } catch (e) { handleConnectionError(); }
      }
    } catch (e) { rsWarn('[RS Content] Error in checkAndNotifyChanges:', e); }
  }

  // Push the initial debug flag as soon as the page context is available, in
  // case interceptor.js was injected before the storage read resolved.
  pushDebugToPage();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'clearAll') sendResponse({ success: true });
    return true;
  });

  // ── Push current ls patterns into page context (for storage-monitor.js) ──────
  // storage-monitor.js runs in page context and has no chrome.storage access,
  // so contentScript pushes the patterns via a CustomEvent whenever they change.
  function pushLsPatternsToPage() {
    try {
      window.dispatchEvent(new CustomEvent('__rs_update_ls_patterns', {
        detail: {
          patternRudder: _lsPatterns.patternRudder,
          patternQueue:  _lsPatterns.patternQueue,
          customRules:   _lsPatterns.customRules,
        }
      }));
    } catch (e) {
      rsWarn('[RS Content] Failed to push ls patterns to page:', e);
    }
  }

  function setupMonitoring(pattern) {
    try {
      if (!isExtensionActive || !chrome.runtime) { cleanup(); return; }
      if (monitoringInterval) clearInterval(monitoringInterval);

      injectInterceptor(pattern);

      const storageScript = document.createElement('script');
      storageScript.src = chrome.runtime.getURL('storage-monitor.js');
      storageScript.onload = () => {
        storageScript.remove();
        // Push current patterns immediately after storage-monitor.js is ready
        pushLsPatternsToPage();
        checkAndNotifyChanges();
      };
      (document.head || document.documentElement).appendChild(storageScript);

      window.addEventListener('storage', (e) => {
        if (e.key && keyMatchesPatterns(e.key)) checkAndNotifyChanges();
      });
      window.addEventListener('rudderstack_storage_changed', checkAndNotifyChanges);

      monitoringInterval = setInterval(checkAndNotifyChanges, 1000);
    } catch (e) {
      rsWarn('[RS Content] Error in setupMonitoring:', e);
      cleanup();
    }
  }

  function handleConnectionError() {
    cleanup();
    if (chrome.runtime && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(setupConnection, 1000 * Math.pow(2, reconnectAttempts));
    }
  }

  function cleanup() {
    if (monitoringInterval) { clearInterval(monitoringInterval); monitoringInterval = null; }
    if (port) { try { port.disconnect(); } catch(e) {} port = null; }
    isExtensionActive = false;
  }

  function setupConnection() {
    try {
      if (!chrome.runtime) { cleanup(); return; }
      if (port) { try { port.disconnect(); } catch(e) {} port = null; }
      isExtensionActive = true;

      port = chrome.runtime.connect({ name: 'rudderstack-monitor' });

      port.onMessage.addListener((message) => {
        if (message.type === 'patternUpdate' && message.pattern) {
          rsLog('[RS Content] Pattern updated from background:', message.pattern);
          injectInterceptor(message.pattern);
        }
      });

      port.onDisconnect.addListener(() => {
        try { if (chrome.runtime.lastError) cleanup(); } catch(e) {}
      });

      chrome.storage.local.get(['batchUrlPattern'], (result) => {
        const pattern = result.batchUrlPattern || '/beacon/v1/batch';
        setupMonitoring(pattern);
        flushPendingMessages();
      });

    } catch (e) {
      rsLog('[RS Content] Error in setupConnection:', e);
      cleanup();
    }
  }

  try {
    if (chrome.runtime) setupConnection();
  } catch (e) {
    rsLog('[RS Content] Error during initialization:', e);
  }

  window.addEventListener('beforeunload', () => {
    try { cleanup(); } catch(e) {}
  });
})();
