// background.js – Safe MV3 Version
const connections = new Map();
const messageQueue = new Map(); // ذخیره پیام‌ها برای تب‌هایی که هنوز port ندارند

function parseRequestBody(details) {
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

// ارسال ایمن پیام به port یا ذخیره در queue
function safePostMessage(tabId, message) {
    const port = connections.get(tabId);
    if (port && port.sender) {
        try {
            port.postMessage(message);
        } catch (err) {
            console.warn('Port not available, queuing message:', err);
            if (!messageQueue.has(tabId)) messageQueue.set(tabId, []);
            messageQueue.get(tabId).push(message);
        }
    } else {
        if (!messageQueue.has(tabId)) messageQueue.set(tabId, []);
        messageQueue.get(tabId).push(message);
    }
}

// ارسال ایمن پیام با sendMessage
function safeSendMessage(message) {
    try {
        chrome.runtime.sendMessage(message).catch(err => {
            console.warn('No receiving end for sendMessage:', err);
        });
    } catch (err) {
        console.warn('Runtime sendMessage failed:', err);
    }
}

// مانیتور شبکه
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.method === 'POST' && details.url.includes('/v1/batch')) {
            const tabId = details.tabId;
            const requestData = parseRequestBody(details);
            if (requestData && requestData.batch) {
                safePostMessage(tabId, {
                    type: 'batchRequest',
                    data: requestData.batch,
                    timestamp: Date.now()
                });
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
);

// مدیریت اتصال port از popup یا content script
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'rudderstack-monitor') return;

    const tabId = port.sender.tab?.id;
    if (!tabId) return;

    connections.set(tabId, port);

    // اگر queue داریم، پیام‌ها را ارسال کنیم
    if (messageQueue.has(tabId)) {
        const queue = messageQueue.get(tabId);
        queue.forEach(msg => {
            try {
                port.postMessage(msg);
            } catch (err) {
                console.warn('Failed to send queued message:', err);
            }
        });
        messageQueue.delete(tabId);
    }

    port.onMessage.addListener((message) => {
        if (message.type === 'storageChanged') {
            safeSendMessage({
                type: 'updatePopup',
                data: { ...message.data, source: 'localStorage' },
                tabId: tabId
            });
        }
    });

    port.onDisconnect.addListener(() => {
        connections.delete(tabId);
    });
});

// پاکسازی اتصالات وقتی تب بسته می‌شود
chrome.tabs.onRemoved.addListener((tabId) => {
    connections.delete(tabId);
    messageQueue.delete(tabId);
});
