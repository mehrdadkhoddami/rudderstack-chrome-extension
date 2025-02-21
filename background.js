// background.js
let lastUpdate = Date.now();
const DEBOUNCE_TIME = 100;
const connections = new Map();

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'rudderstack-monitor') {
        const tabId = port.sender.tab.id;
        connections.set(tabId, port);

        port.onMessage.addListener((message) => {
            if (message.type === 'storageChanged') {
                const now = Date.now();
                if (now - lastUpdate > DEBOUNCE_TIME) {
                    lastUpdate = now;
                    // Broadcast to popup
                    chrome.runtime.sendMessage({
                        type: 'updatePopup',
                        data: message.data,
                        tabId: tabId
                    }).catch(() => {});
                }
            }
        });

        port.onDisconnect.addListener(() => {
            connections.delete(tabId);
        });
    }
});