// contentScript.js
(function(){
  if (window.__perfHelpersInjected) return;
  window.__perfHelpersInjected = true;
  window._throttle = function(fn, wait){ var last=0; return function(){ var now=Date.now(); if(now-last>wait){ last=now; fn.apply(this, arguments);} }; };
  window._debounce = function(fn, wait){ var t; return function(){ var ctx=this, args=arguments; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,args); }, wait); }; };
})();

(() => {
    let isExtensionActive = true;
    let port = null;
    let monitoringInterval = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    let interceptorInjected = false;

    // ── Inject interceptor.js ────────────────────────────────────────────────
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
            script.onload = () => {
                script.remove();
                console.log('[RS Content] interceptor.js injected, pattern:', pattern);
            };
            script.onerror = (e) => {
                console.error('[RS Content] Failed to inject interceptor.js:', e);
            };
            (document.head || document.documentElement).prepend(script);
        } catch (e) {
            console.error('[RS Content] Error injecting interceptor:', e);
        }
    }

    // ── Listen for captured batches from page context ────────────────────────
    window.addEventListener('__rs_batch_captured', (e) => {
        try {
            const { batch, timestamp, sourceType } = e.detail;
            if (!Array.isArray(batch) || !batch.length) return;
            console.log(`[RS Content] __rs_batch_captured: ${batch.length} events via ${sourceType}`);
            if (port) {
                try {
                    port.postMessage({ type: 'batchCaptured', data: batch, timestamp });
                } catch (err) {
                    console.warn('[RS Content] Failed to post batchCaptured to port:', err);
                    handleConnectionError();
                }
            } else {
                console.warn('[RS Content] No port available to forward batch');
            }
        } catch (err) {
            console.error('[RS Content] Error handling __rs_batch_captured:', err);
        }
    });

    // ── localStorage monitoring ──────────────────────────────────────────────
    function safeGetLocalStorage() {
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
                        for (var j in parsedJson) {
                            if (!parsedJson[j].item || !parsedJson[j].item.event) continue;
                            const currentItem = parsedJson[j].item.event;
                            if (currentItem.type === 'track' || currentItem.type === 'page') {
                                const currentKey = currentItem.messageId;
                                if (!currentKey) continue;
                                items[currentKey] = {
                                    value: JSON.stringify(currentItem),
                                    parsedValue: currentItem,
                                    originalKey: currentItem.event || currentItem.name || currentKey,
                                    propertiesKey: currentItem.properties || null,
                                    timestamp: Date.now(),
                                    source: 'localStorage'
                                };
                            }
                        }
                    } catch (parseError) {}
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
        } catch (e) { console.error('[RS Content] Error in checkAndNotifyChanges:', e); }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'clearAll') sendResponse({ success: true });
        return true;
    });

    function setupMonitoring(pattern) {
        try {
            if (!isExtensionActive || !chrome.runtime) { cleanup(); return; }
            if (monitoringInterval) clearInterval(monitoringInterval);

            injectInterceptor(pattern);

            const storageScript = document.createElement('script');
            storageScript.src = chrome.runtime.getURL('storage-monitor.js');
            storageScript.onload = () => { storageScript.remove(); checkAndNotifyChanges(); };
            (document.head || document.documentElement).appendChild(storageScript);

            window.addEventListener('storage', (e) => {
                if (e.key && e.key.startsWith('rudder')) checkAndNotifyChanges();
            });
            window.addEventListener('rudderstack_storage_changed', checkAndNotifyChanges);

            monitoringInterval = setInterval(checkAndNotifyChanges, 1000);
        } catch (e) {
            console.error('[RS Content] Error in setupMonitoring:', e);
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
                    console.log('[RS Content] Pattern updated from background:', message.pattern);
                    // interceptor قبلاً inject شده، فقط event می‌زنیم
                    injectInterceptor(message.pattern);
                }
            });

            port.onDisconnect.addListener(() => {
                try { if (chrome.runtime.lastError) cleanup(); } catch(e) {}
            });

            chrome.storage.local.get(['batchUrlPattern'], (result) => {
                const pattern = result.batchUrlPattern || '/beacon/v1/batch';
                setupMonitoring(pattern);
            });

        } catch (e) {
            console.log('[RS Content] Error in setupConnection:', e);
            cleanup();
        }
    }

    try {
        if (chrome.runtime) setupConnection();
    } catch (e) {
        console.log('[RS Content] Error during initialization:', e);
    }

    window.addEventListener('beforeunload', () => {
        try { cleanup(); } catch(e) {}
    });
})();
