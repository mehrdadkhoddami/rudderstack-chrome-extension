// background.js
const connections = new Map();

// Helper function to parse request body
async function parseRequestBody(details) {
    try {
        if (details.requestBody && details.requestBody.raw) {
            const decoder = new TextDecoder('utf-8');
            const rawData = details.requestBody.raw[0].bytes;
            const bodyText = decoder.decode(rawData);
            return JSON.parse(bodyText);
        }
    } catch (e) {
        console.warn('Failed to parse batch request:', e);
    }
    return null;
}

// Monitor network requests
chrome.webRequest.onBeforeRequest.addListener(
    async (details) => {
        if (details.method === 'POST' && details.url.includes('/v1/batch')) {
            const tabId = details.tabId;
            const port = connections.get(tabId);
            
            if (port) {
                const requestData = await parseRequestBody(details);
                if (requestData && requestData.batch) {
                    port.postMessage({
                        type: 'batchRequest',
                        data: requestData.batch,
                        timestamp: Date.now()
                    });
                }
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
);

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'rudderstack-monitor') {
        const tabId = port.sender.tab.id;
        connections.set(tabId, port);

        port.onMessage.addListener((message) => {
            if (message.type === 'storageChanged') {
                chrome.runtime.sendMessage({
                    type: 'updatePopup',
                    data: {
                        ...message.data,
                        source: 'localStorage'
                    },
                    tabId: tabId
                }).catch(() => {});
            }
        });

        port.onDisconnect.addListener(() => {
            connections.delete(tabId);
        });
    }
});

// ✅ اضافه‌شده: باز کردن side panel وقتی روی آیکون کلیک میشه
chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setOptions({
        path: "sidepanel.html",
        enabled: true
    });
});

chrome.action.onClicked.addListener(async (tab) => {
    try {
        await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
        console.error("Error opening side panel:", e);
    }
});
