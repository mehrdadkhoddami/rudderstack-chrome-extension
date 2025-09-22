// background.js (Manifest V3 service worker compatible)

// Keep track of active connections with content scripts
const connections = new Map();

// Helper function to parse request body safely
async function parseRequestBody(details) {
  try {
    if (details.requestBody && details.requestBody.raw) {
      const decoder = new TextDecoder("utf-8");
      const rawData = details.requestBody.raw[0].bytes;
      const bodyText = decoder.decode(rawData);
      return JSON.parse(bodyText);
    }
  } catch (e) {
    console.warn("Failed to parse batch request:", e);
  }
  return null;
}

// Monitor outgoing network requests (batch POST requests)
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method === "POST" && details.url.includes("/v1/batch")) {
      const tabId = details.tabId;
      const port = connections.get(tabId);

      if (port) {
        const requestData = await parseRequestBody(details);
        if (requestData && requestData.batch) {
          port.postMessage({
            type: "batchRequest",
            data: requestData.batch,
            timestamp: Date.now(),
          });
        }
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// Handle connection from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "rudderstack-monitor") {
    const tabId = port.sender.tab.id;
    connections.set(tabId, port);

    port.onMessage.addListener((message) => {
      if (message.type === "storageChanged") {
        // Forward update to popup
        chrome.runtime
          .sendMessage({
            type: "updatePopup",
            data: {
              ...message.data,
              source: "localStorage",
            },
            tabId: tabId,
          })
          .catch(() => {});
      }
    });

    port.onDisconnect.addListener(() => {
      connections.delete(tabId);
    });
  }
});

// Enable side panel on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({
    path: "sidepanel.html",
    enabled: true,
  });
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.error("Error opening side panel:", e);
  }
});
