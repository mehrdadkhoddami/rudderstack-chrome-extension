# RudderStack Tracker — Chrome Extension

A Chrome extension for monitoring, capturing, and displaying **RudderStack analytics events** in real time. It intercepts network requests, reads queued events from **localStorage**, and presents them in a clean **side panel** or **popup** with syntax-highlighted JSON, a properties table, and per-event copy controls.

---

## Features

### Event Capture
- Intercepts **fetch**, **XMLHttpRequest**, and **sendBeacon** calls whose URL matches a configurable pattern (default: `/beacon/v1/batch`)
- Falls back to **Chrome webRequest API** for tabs where the content script is not yet connected
- Reads queued events directly from **localStorage** using configurable key patterns
- Monitors localStorage in real time by patching `setItem` / `removeItem` / `clear` in page context
- Supports multiple payload shapes: standard `{ batch: [...] }`, direct event arrays, SDK v3 `item.event` wrappers, and thin `{ event: {...} }` wrappers

### Display
- **Side panel** (primary UI) — opens with a single toolbar click; stays open across page navigations
- **Popup** — lightweight alternative for quick inspection
- Syntax-highlighted, collapsible JSON viewer per event
- Flat **properties table** with key/value rows and per-row copy icons
- **SENT** badge on events confirmed to have been dispatched in a network batch
- **BATCH** badge on events captured via network interception
- Event timestamp shown in `HH:MM:SS` format
- Slide-in animation with glow pulse for newly arrived events
- Filter bar for instant text search across event names and keys
- Empty-state illustration when the list is clear

### Tab Isolation
- Each browser tab maintains its own independent event cache
- localStorage events are only ingested for the **currently active tab** to prevent same-origin bleed across tabs
- Network batch events are always attributed to the correct tab via a verified `tabId`
- Tab cache is wiped and persisted storage is cleaned up when a tab is closed

### Persistence
- Per-tab event list and sent-ID set are saved to `chrome.storage.local` (keyed by `tabId`) and restored when the panel is reopened
- A maximum of 200 events per tab is retained to stay within storage limits

### Settings
Accessible via the ⚙ button in the side panel or from `chrome://extensions`:

| Setting | Description |
|---|---|
| **Batch URL Pattern** | Substring matched against all POST request URLs. Supports path-only (`/beacon/v1/batch`) or full domain patterns. |
| **localStorage — rudder_* … *.batchQueue** | Toggle the built-in rule for the default RudderStack SDK key format. |
| **localStorage — queue.*** | Toggle the built-in rule used by snappfood and similar setups. |
| **Custom localStorage rules** | Add any number of `startsWith` + optional `endsWith` rules. |
| **Show JSON Viewer** | Toggle the raw JSON section and Copy button below the properties table. |
| **Enable Debug Logging** | Emit `console.log` output from background, content script, and interceptor. |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Web Page (tab)                    │
│                                                      │
│  interceptor.js ──── fetch / XHR / sendBeacon hook  │
│  storage-monitor.js ─ localStorage.setItem patch    │
│       │                        │                     │
│       └──────────┬─────────────┘                     │
│            CustomEvent                               │
└─────────────────────────────────────────────────────┘
          │ window.__rs_batch_captured
          │ rudderstack_storage_changed
          ▼
┌─────────────────────────┐
│    contentScript.js     │  chrome.runtime port
│  • pattern management   │ ──────────────────────►
│  • localStorage polling │                         │
│  • batch relay          │                         ▼
└─────────────────────────┘             ┌──────────────────────┐
                                        │    background.js     │
chrome.webRequest (fallback) ──────────►│  • connection map    │
                                        │  • webRequest guard  │
                                        │  • pattern broadcast │
                                        └──────────┬───────────┘
                                                   │ chrome.runtime.sendMessage
                                                   ▼
                                        ┌──────────────────────┐
                                        │  sidepanel / popup   │
                                        │  popup.js            │
                                        │  • per-tab cache     │
                                        │  • render / filter   │
                                        └──────────────────────┘
```

### Key Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — permissions, content scripts, side panel config |
| `background.js` | Service worker — port management, webRequest fallback, pattern broadcast |
| `contentScript.js` | Injected into every page — coordinates interceptor, localStorage monitor, and port relay |
| `interceptor.js` | Injected into page context — patches `fetch`, `XHR`, `sendBeacon` |
| `storage-monitor.js` | Injected into page context — patches `localStorage` write methods |
| `popup.js` | Shared UI logic for both popup and side panel — cache, render, tab switching |
| `sidepanel.html` / `popup.html` | UI shells |
| `sidepanel-init.js` | Side panel extras — settings button, live stats updater |
| `settings.html` / `settings.js` | Options page |
| `style.css` / `settings-style.css` | Design system — tokens, dark mode, component styles |

---

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/mehrdadkhoddami/rudderstack-chrome-extension
   ```
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the cloned folder.
5. Click the extension icon in the toolbar — the side panel opens automatically.

---

## Usage

1. Open any page that uses the RudderStack SDK.
2. Click the **RS·Tracker** toolbar icon to open the side panel.
3. Interact with the page — events appear in real time as they are queued or dispatched.
4. Click any event row to expand the **properties table** and **JSON viewer**.
5. Use the **filter bar** to search by event name or property key.
6. Click **Clear** to wipe the list for the current tab.
7. Open **Settings** (⚙) to adjust the URL pattern or localStorage key rules.

---

## Supported Payload Formats

| Format | Example source |
|---|---|
| `{ batch: [ ...events ] }` | Standard RudderStack SDK |
| `[ ...events ]` (bare array, first element has `messageId`) | Partner / custom setups |
| `{ item: { event: {...} }, attemptNumber }` | SDK v3 batchQueue wrapper |
| `{ event: {...} }` | Thin event wrapper |
| Direct event object `{ messageId, type, ... }` | `queue.*` keys |

---

## Known Limitations

- **Popup only updates while open.** The side panel is the recommended UI — it stays alive across navigations. The popup misses events that arrive while it is closed.
- **Same-origin localStorage.** localStorage is shared across all tabs of the same origin. The extension guards against cross-tab bleed by only reading localStorage for the active tab, but events already in storage before a second tab opened may appear in both.
- **Compressed / binary bodies.** `sendBeacon` with `FormData` and `fetch` with opaque `ReadableStream` bodies that have already been consumed cannot be read by the interceptor.

---

## Contributing

Pull requests are welcome. If you find a bug or have a feature suggestion, please open an issue.

## License

This project is licensed under the [MIT License](LICENSE).
