// contentScript.js
(() => {
    let lastProcessedState = {};
    let isExtensionActive = true;
    let port = null;
    let monitoringInterval = null;

    // Safe localStorage access
    function safeGetLocalStorage() {
        try {
            const items = {};
            if (!localStorage) return items;

            for (let i = 0; i < localStorage.length; i++) {
                try {
                    const key = localStorage.key(i);
                    if (!key || !key.startsWith('rudder_batch')) continue;

                    const value = localStorage.getItem(key);
                    if (!value) continue;

                    try {
                        const parsedL1 = JSON.parse(value);
                        const parsedJson = JSON.parse(parsedL1);
                        items[key] = {
                            value: value,
                            parsedValue: parsedJson,
                            originalKey: parsedJson.event || key,
                            propertiesKey: parsedJson.hasOwnProperty('properties') ? parsedJson.properties : null,
                            timestamp: Date.now()
                        };
                    } catch (parseError) {
                        items[key] = {
                            value: value,
                            parsedValue: null,
                            originalKey: key,
                            propertiesKey: null,
                            timestamp: Date.now()
                        };
                    }
                } catch (itemError) {
                    continue;
                }
            }
            return items;
        } catch (e) {
            console.warn('Error accessing localStorage:', e);
            return {};
        }
    }

    // Process localStorage items
    function processLocalStorageItems() {
        if (!isExtensionActive) return null;
        
        const items = safeGetLocalStorage();
        const currentStateStr = JSON.stringify(items);
        const lastStateStr = JSON.stringify(lastProcessedState);
        
        if (currentStateStr !== lastStateStr) {
            lastProcessedState = items;
            return items;
        }
        
        return null;
    }

    // Safe message sending
    function safeSendMessage(data) {
        if (!isExtensionActive || !port) return;
        
        try {
            port.postMessage({
                type: 'storageChanged',
                data: data
            });
        } catch (e) {
            handleConnectionError();
        }
    }

    // Check changes and notify
    function checkAndNotifyChanges() {
        if (!isExtensionActive) return;
        
        const items = processLocalStorageItems();
        if (items !== null) {
            safeSendMessage(items);
        }
    }

    // Setup monitoring
    function setupMonitoring() {
        if (!isExtensionActive) return;

        // Clear existing interval if any
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
        }

        // Inject monitor script
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('storage-monitor.js');
        script.onload = () => {
            script.remove();
            checkAndNotifyChanges();
        };
        (document.head || document.documentElement).appendChild(script);

        // Setup storage event listener
        window.addEventListener('storage', (e) => {
            if (e.key && e.key.startsWith('rudder_batch')) {
                checkAndNotifyChanges();
            }
        });

        // Setup custom event listener
        window.addEventListener('rudderstack_storage_changed', checkAndNotifyChanges);

        // Backup interval checker
        monitoringInterval = setInterval(checkAndNotifyChanges, 1000);
    }

    // Connection error handler
    function handleConnectionError() {
        isExtensionActive = false;
        cleanup();
        tryReconnect();
    }

    // Cleanup function
    function cleanup() {
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            monitoringInterval = null;
        }

        if (port) {
            try {
                port.disconnect();
            } catch (e) {}
            port = null;
        }
    }

    // Reconnection attempt
    function tryReconnect() {
        setTimeout(setupConnection, 1000);
    }

    // Setup connection
    function setupConnection() {
        try {
            cleanup();
            port = chrome.runtime.connect({ name: 'rudderstack-monitor' });
            
            port.onDisconnect.addListener(() => {
                if (chrome.runtime.lastError) {
                    handleConnectionError();
                }
            });

            isExtensionActive = true;
            setupMonitoring();
        } catch (e) {
            handleConnectionError();
        }
    }

    // Initialize
    setupConnection();

    // Cleanup on unload
    window.addEventListener('unload', cleanup);
})();