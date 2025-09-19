/*!
 * RudderStack Tracker chrome Extension
 * 
 * 1st versions Developed by: Mehrdad Khoddami (khoddami.me@gmail.com) (mehrdad.khoddami@zoodfood.com)
 * Initial Version: January 13, 2025
 * Description: View LocalStorage Contents of RudderStack
 * I build this extension with help of ChatGPT & Cluade
 * 
 * License: MIT
 * 
 * Changelog:
 * - v1.0.10: Initial version 
 */
 

// Store all seen items and current localStorage items
let seenItems = new Map();
let currentStorageItems = new Map();
let isFirstLoad = true;
let recentlyAddedItems = new Map();const filterInput = document.getElementById("filter-input");
const clearBtn = document.getElementById("clear-btn");
const itemList = document.getElementById("localStorage-items");

const JSON_CLASSES = {
    int: 'json-value',
    float: 'json-value',
    boolean: 'json-boolean',
    null: 'json-null',
    string: 'json-string',
    object: 'json-object',
    array: 'json-array'
};

function applyFilter() {
    let filterValue = filterInput.value.toLowerCase();
    let items = document.querySelectorAll("#localStorage-items .item");

    clearBtn.style.display = filterValue ? "block" : "none";
    items.forEach(item => {
		let subtitleEl = item.querySelector(".key-container .subtitle");
		let keyEl = item.querySelector(".key-container .key");
			if (!subtitleEl || !keyEl) {
			console.log(`Skipping index ${subtitleEl} due to missing elements.`);
			return;
		}
	
        let subtitle = subtitleEl.textContent.toLowerCase();
        let key = keyEl.textContent.toLowerCase();
        
        if (subtitle.includes(filterValue) || key.includes(filterValue)) {
            item.classList.remove("hidden");
        } else {
            item.classList.add("hidden");
        }
    });
}

filterInput.addEventListener("input", applyFilter);

clearBtn.addEventListener("click", function () {
    filterInput.value = "";
    clearBtn.style.display = "none";
    applyFilter(); // بعد از پاک شدن، همه آیتم‌ها دوباره نمایش داده شوند
});

const observer = new MutationObserver(() => {
    applyFilter();
});

observer.observe(itemList, { childList: true, subtree: true });

function getCurrentTabId(callback) {
    try {
        chrome.tabs.query({
            active: true,
            currentWindow: true
        }, function(tabs) {
            if (tabs && tabs[0] && tabs[0].id) {
                callback(tabs[0].id);
            } else {
                console.error('No active tab found');
                callback(null);
            }
        });
    } catch (e) {
        console.error('Error getting current tab:', e);
        callback(null);
    }
}

// Function that will be injected into the page to get localStorage items
// Function that will be injected into the page to get localStorage items
const getLocalStorageCode = () => {
    return function safeGetLocalStorage() {
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
                                const currentKey = currentItem.messageId || key;
                                items[currentKey] = {
                                    value: value,
                                    parsedValue: currentItem,
                                    originalKey: currentItem.event || currentKey,
                                    propertiesKey: currentItem.hasOwnProperty('properties') ? currentItem.properties : null,
                                    timestamp: Date.now()
                                };
                            }
                        }
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
    };
};


function createSentBadge() {
    const sentBadge = document.createElement('span');
    sentBadge.className = 'sent-badge';
    sentBadge.textContent = 'SENT';
    return sentBadge;
}

function getCurrentTabId(callback) {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        callback(tabs[0].id);
    });
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    getCurrentTabId((tabId) => {
        document.getElementById('clearButton').addEventListener('click', () => clearAllItems(tabId));

        chrome.storage.local.get([`seenItemsData_${tabId}`, `currentStorageItems_${tabId}`], function(result) {
            if (result[`seenItemsData_${tabId}`]) {
                seenItems = new Map(JSON.parse(result[`seenItemsData_${tabId}`]));
            }
            if (result[`currentStorageItems_${tabId}`]) {
                currentStorageItems = new Map(JSON.parse(result[`currentStorageItems_${tabId}`]));
            }

            // Initial load
            chrome.scripting.executeScript({
                target: {tabId: tabId},
                func: getLocalStorageCode(),
            }, displayResults);

            // Listen for updates
            chrome.runtime.onMessage.addListener((message) => {
                if (message.type === 'updatePopup' && (!message.tabId || message.tabId === tabId)) {
                    if (message.data) {
                        const fakeResults = [{result: message.data}];
                        displayResults(fakeResults);
                    }
                }
            });
        });
    });
});

// Add this new function
function updateStorage(tabId) {
    chrome.scripting.executeScript({
        target: {tabId: tabId},
        func: getLocalStorageCode(),
    }, displayResults);
}


// Function to clear all items and store current localStorage state
function clearAllItems(tabId) {
    // Clear UI first
    const container = document.getElementById('localStorage-items');
    container.innerHTML = '';

    // Reset data structures
    seenItems.clear();
    currentStorageItems.clear();
    batchEvents = [];
    recentlyAddedItems = new Map();

    // Clear storage with additional batch-related keys
    chrome.storage.local.remove([
        `seenItemsData_${tabId}`, 
        `currentStorageItems_${tabId}`,
        `lastBatchTimestamp_${tabId}` // Add this
    ]);

    // Try to notify contentScript with specific batch clear flag
    try {
        chrome.tabs.sendMessage(tabId, { 
            type: 'clearAll',
            clearBatch: true  // Add this flag
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('ContentScript not ready or not found');
            }
        });
    } catch (e) {
        console.log('Error sending message to contentScript:', e);
    }

    // Execute script to reset localStorage monitoring
    chrome.scripting.executeScript({
        target: {tabId: tabId},
        func: () => {
            // Reset monitoring state
            window.dispatchEvent(new CustomEvent('rudderstack_clear_monitoring'));
            // Clear localStorage data
            Object.keys(localStorage).forEach(key => {
                if (key.includes('rudder')) {
                    localStorage.removeItem(key);
                }
            });
            // Clear batch-related data in window
            if (window.processedBatchEvents) {
                window.processedBatchEvents.clear();
            }
            if (window.batchEvents) {
                window.batchEvents = [];
            }
            if (window.lastBatchTimestamp !== undefined) {
                window.lastBatchTimestamp = 0;
            }
            return {};
        }
    }, () => {
        // Restart monitoring with fresh state
        chrome.scripting.executeScript({
            target: {tabId: tabId},
            func: getLocalStorageCode(),
        }, results => {
            if (!results || !results[0]) return;

            // Store fresh state
            const currentItems = results[0].result || {};
            Object.entries(currentItems).forEach(([key, data]) => {
                currentStorageItems.set(key, data);
            });

            // Save fresh state to storage
            chrome.storage.local.set({
                [`seenItemsData_${tabId}`]: JSON.stringify([...seenItems]),
                [`currentStorageItems_${tabId}`]: JSON.stringify([...currentStorageItems]),
                [`lastBatchTimestamp_${tabId}`]: 0  // Reset batch timestamp
            });

            // Reset first load flag
            isFirstLoad = false;
        });
    });

    // Add button animation
    const button = document.getElementById('clearButton');
    button.classList.add('clearing');
    setTimeout(() => button.classList.remove('clearing'), 200);
}

// Update main event listener
document.addEventListener('DOMContentLoaded', function() {
    getCurrentTabId((tabId) => {
        if (!tabId) {
            console.log('No valid tab ID found');
            return;
        }

        document.getElementById('clearButton').addEventListener('click', () => clearAllItems(tabId));

        // Load stored data
        chrome.storage.local.get([`seenItemsData_${tabId}`, `currentStorageItems_${tabId}`], function(result) {
            try {
                if (result[`seenItemsData_${tabId}`]) {
                    seenItems = new Map(JSON.parse(result[`seenItemsData_${tabId}`]));
                }
                if (result[`currentStorageItems_${tabId}`]) {
                    currentStorageItems = new Map(JSON.parse(result[`currentStorageItems_${tabId}`]));
                }

                // Initial load
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    func: getLocalStorageCode(),
                }, displayResults);

                // Listen for updates
                chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                    if (message.type === 'updatePopup' && (!message.tabId || message.tabId === tabId)) {
                        if (message.data) {
                            const fakeResults = [{result: message.data}];
                            displayResults(fakeResults);
                        }
                        // Acknowledge receipt of message
                        if (sendResponse) {
                            sendResponse({ received: true });
                        }
                    }
                    // Keep the message channel open
                    return true;
                });
            } catch (e) {
                console.error('Error setting up popup:', e);
            }
        });
    });
});

// Add error handling to getCurrentTabId
function getCurrentTabId(callback) {
    try {
        chrome.tabs.query({
            active: true,
            currentWindow: true
        }, function(tabs) {
            if (tabs && tabs[0] && tabs[0].id) {
                callback(tabs[0].id);
            } else {
                console.error('No active tab found');
                callback(null);
            }
        });
    } catch (e) {
        console.error('Error getting current tab:', e);
        callback(null);
    }
}

// Parse a raw value into correct JS type
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

// Detect type of a value
function detectType(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return 'unknown';
}

// Generate HTML span for a value based on its type
function renderValueSpan(value, addQuotes = true) {
    const parsed = parseValue(value);
    const type = detectType(parsed);
    let display;

    switch(type) {
        case 'string':
            display = String(parsed);
            if (addQuotes) {
                display = `"${display}"`;
            }
            break;
        case 'null':
            display = 'null';
            break;
        default:
            display = parsed; // int, float, boolean 
    }

    return `<span class="${JSON_CLASSES[type]}">${display}</span>`;
}


// ---------- Pretty Print JSON ----------
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
            html += indentStr + '   <span class="' + keyClass + '">' + k + '</span>: '
                  + prettyPrintJson(v, indent + 1);
            if (i < entries.length - 1) html += ',';
            html += '<br>';
        });
        html += indentStr + '}';
    }

    return html;
}

// Create HTML element for an item
function createItemElement(key, data = {}, isSent = false) {  // default empty object for data
    // Ensure data is an object
    data = data || {};
    
    const itemDiv = document.createElement('div');
    itemDiv.className = 'item';
	itemDiv.setAttribute('data-key', key);
	
    if (isSent) {
        itemDiv.classList.add('sent-item');
    }
    if (data.isBatchEvent) {
        itemDiv.classList.add('batch-item');
    }
    
    const headerDiv = document.createElement('div');
    headerDiv.className = 'item-header';
    
    const keyContainer = document.createElement('div');
    keyContainer.className = 'key-container';
    
    const keyDiv = document.createElement('div');
    keyDiv.className = 'key';
    keyDiv.textContent = key || 'Unknown Key';
    
    const subtitleDiv = document.createElement('span');
    subtitleDiv.className = 'subtitle';
    
    // Safe access to originalKey
    const originalKey = (data && data.originalKey) ? data.originalKey : key || 'Unknown';
    subtitleDiv.textContent = originalKey;
    
    // Safe check for rudder_batch
    if (typeof originalKey === 'string' && originalKey.startsWith('rudder_batch')) {
        subtitleDiv.className = 'subtitle subtitle-type2';
    }
    
    // Add badges container
    const badgesContainer = document.createElement('div');
    badgesContainer.className = 'badges-container';
    
    // Add sent badge if item is sent
    if (isSent || data.isBatchEvent) {
        badgesContainer.appendChild(createSentBadge());
    }
    
    // Add timestamp if available
    if (data.timestamp) {
        const timeDiv = document.createElement('span');
        timeDiv.className = 'timestamp';
        timeDiv.textContent = new Date(data.timestamp).toLocaleTimeString('en-GB', { hour12: false });
        badgesContainer.appendChild(timeDiv);
    }
    
    // Add batch badge if it's a batch event
    if (data.isBatchEvent) {
        badgesContainer.appendChild(createBatchBadge());
    }
    
    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'toggle-icon collapsed';
    toggleIcon.innerHTML = '<img src="expand_more-128.png" class="view-more" />';
    
    const valueContainer = document.createElement('div');
    valueContainer.className = 'value-container';
    
    // Create Copy button and append it to the header
    const copyButton = createCopyButton(data.parsedValue || {});
    
    const propertiesDiv = document.createElement('div');
    propertiesDiv.className = 'properties-value';
    propertiesDiv.textContent = '';
    
    const insideValueContainer = document.createElement('div');
    insideValueContainer.className = 'inside-value-container';
    
    const valueDiv = document.createElement('pre');
    valueDiv.className = 'value';
    
    try {
        if (data.parsedValue) {
            valueDiv.innerHTML = prettyPrintJson(data.parsedValue);
        } else if (data.value) {
            valueDiv.textContent = data.value;
        } else {
            valueDiv.textContent = 'No value available';
        }
    } catch (e) {
        console.warn('Error formatting value:', e);
        valueDiv.textContent = data.value || 'Error displaying value';
    }
    
    try {
        if (data.propertiesKey) {
            propertiesDiv.appendChild(createTableFromJson(data.propertiesKey));
        } else {
            propertiesDiv.textContent = '';
        }
    } catch (e) {
        console.warn('Error creating properties table:', e);
        propertiesDiv.textContent = '';
    }
    
    keyContainer.appendChild(subtitleDiv);
    keyContainer.appendChild(keyDiv);
    keyContainer.appendChild(badgesContainer);
    
    headerDiv.appendChild(keyContainer);
    headerDiv.appendChild(toggleIcon);
    
    valueContainer.appendChild(propertiesDiv);
    valueContainer.appendChild(insideValueContainer);
    insideValueContainer.appendChild(copyButton);
    insideValueContainer.appendChild(valueDiv);

    itemDiv.appendChild(headerDiv);
    itemDiv.appendChild(valueContainer);
    
    headerDiv.addEventListener('click', () => {
        toggleIcon.classList.toggle('collapsed');
        valueContainer.classList.toggle('expanded');
    });

    return itemDiv;
}

// Add this new helper function
function createBatchBadge() {
    const batchBadge = document.createElement('span');
    batchBadge.className = 'badge batch-badge';
    batchBadge.textContent = 'BATCH';
    return batchBadge;
}

// Main function to display results

function displayResults(results) {
    if (!results || !results[0]) return;

    const currentItems = results[0].result;
    const container = document.getElementById('localStorage-items');

    getCurrentTabId((tabId) => {
        // Skip invalid or unwanted items
        const filteredItems = Object.entries(currentItems || {}).filter(([key, data]) => {
            if (
                (data.originalKey === 'source' || key === 'source') && 
                (!data.propertiesKey || data.propertiesKey === undefined)
            ) {
                console.log('Skipping source item:', { key, data });
                return false;
            }
            return true;
        });

        // If it's first load and we have stored items, display them
        if (isFirstLoad && seenItems.size > 0) {
            container.innerHTML = '';

            [...seenItems.entries()]
                .filter(([key, data]) => {
                    if (
                        (data.originalKey === 'source' || key === 'source') && 
                        (!data.propertiesKey || data.propertiesKey === undefined)
                    ) {
                        return false;
                    }
                    return true;
                })
                .sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0))
                .forEach(([key, data]) => {
                    const itemElement = createItemElement(key, data);
                    container.appendChild(itemElement);
                });

            isFirstLoad = false;
            return;
        }

        const existingElements = new Map(Array.from(container.children).map(el => 
            [el.querySelector('.key').textContent, el]
        ));

        // Clean up old entries from recentlyAddedItems
        const now = Date.now();
		const newRecentItems = new Map();
		for (const [key, timestamp] of recentlyAddedItems.entries()) {
			if (now - timestamp <= 3000) {
				newRecentItems.set(key, timestamp);
			}
		}
		recentlyAddedItems = newRecentItems;

        // Check for new items and mark removed ones
        for (const [key, data] of filteredItems) {
            // Skip if the item was recently added
            if (recentlyAddedItems.has(key)) {
                continue;
            }

            // Check if item is truly new
            if (!seenItems.has(key) && !currentStorageItems.has(key)) {
                seenItems.set(key, {
                    ...data,
                    firstSeen: Date.now()
                });

                // Save to chrome.storage.local
                chrome.storage.local.set({
                    [`seenItemsData_${tabId}`]: JSON.stringify([...seenItems])
                });

                // Add to recently added items
                recentlyAddedItems.set(key, Date.now());

                // Animate only this new item
                const itemElement = createItemElement(key, data);
                itemElement.classList.add('new-item');

                if (container.firstChild) {
                    container.insertBefore(itemElement, container.firstChild);
                } else {
                    container.appendChild(itemElement);
                }

                // Remove animation classes after delay
                setTimeout(() => {
                    itemElement.classList.add('transition-complete');
                    setTimeout(() => {
                        itemElement.classList.remove('new-item', 'transition-complete');
                    }, 300);
                }, 3000);

            } else if (existingElements.has(key)) {
                const itemElement = existingElements.get(key);
                const valueElement = itemElement.querySelector('.value');
                const currentValue = data.parsedValue ? 
                    prettyPrintJson(data.parsedValue) : 
                    data.value;

                if (valueElement.innerHTML !== currentValue) {
                    valueElement.innerHTML = currentValue;
                }

                existingElements.delete(key);
            }

            currentStorageItems.set(key, data);
        }

        // Save current storage items
        chrome.storage.local.set({
            [`currentStorageItems_${tabId}`]: JSON.stringify([...currentStorageItems])
        });

        // Mark remaining items as sent
        existingElements.forEach((element, key) => {
            if (!element.classList.contains('sent-item') && !recentlyAddedItems.has(key)) {
                element.classList.add('sent-item');
                const keyContainer = element.querySelector('.key-container');
                if (!keyContainer.querySelector('.sent-badge')) {
                    keyContainer.appendChild(createSentBadge());
                }
            }
        });

        // Cleanup old items from recentlyAddedItems after 3 seconds
        setTimeout(() => {
			const now = Date.now();
			const validItems = new Map();
			for (const [key, timestamp] of recentlyAddedItems.entries()) {
				if (now - timestamp <= 3000) {
					validItems.set(key, timestamp);
				}
			}
			recentlyAddedItems = validItems;
		}, 3000);
    });
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
        console.warn("Invalid URI component:", value);
    }
}

// ---------- Create Table ----------
function createTableFromJson(json) {
    const table = document.createElement('table');
    table.className = 'json-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Key','Value'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    const sortedEntries = Object.entries(json).sort((a,b) => a[0].localeCompare(b[0]));

    sortedEntries.forEach(([k,v]) => {
        const row = document.createElement('tr');

        const keyCell = document.createElement('td');
        keyCell.textContent = k;
        row.appendChild(keyCell);

        const valueCell = document.createElement('td');
        const type = detectType(v);
        if (['int','float','boolean','null','string'].includes(type)) {
            valueCell.innerHTML = renderValueSpan(v, false);
        } else {
            valueCell.innerHTML = prettyPrintJson(v);
        }

        row.appendChild(valueCell);
        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    return table;
}





// Function to create a Toast message
function showToast(message, type = 'info') {
    // Create toast element
    const toast = document.createElement('div');
    toast.classList.add('toast', type); // Add the appropriate class for the type (info, success, error)
    toast.textContent = message;

    // Append toast to the body
    document.body.appendChild(toast);

    // Trigger the show class to make the toast visible
    setTimeout(() => {
        toast.classList.add('show');
    }, 100);

    // After 3 seconds, hide and remove the toast
    setTimeout(() => {
        toast.classList.remove('show');
        // Remove the toast from the DOM after the fade-out transition
        setTimeout(() => {
            toast.remove();
        }, 500); // Match this time with the fade-out duration
    }, 1000); // Duration the toast stays visible
}


// Function to create a Copy button and handle the copy action
function createCopyButton(value) {
    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.textContent = 'Copy';

    copyButton.addEventListener('click', () => {
        // Check if value is an object and stringify it
        if (typeof value === 'object' && value !== null) {
            value = JSON.stringify(value, null, 2); // Convert object to formatted JSON string
        }

        // Copy value to clipboard
        navigator.clipboard.writeText(value)
            .then(() => {
                // Change button text to 'Copied!' and disable it
                copyButton.textContent = 'Copied!';
                copyButton.disabled = true;

                // Show the success toast message
                showToast('Text copied to clipboard!', 'success');

                // Show the success message for 1 second
                setTimeout(() => {
                    // Revert back to 'Copy' and enable the button
                    copyButton.textContent = 'Copy';
                    copyButton.disabled = false;
                }, 1000);
            })
            .catch((err) => {
                console.error('Failed to copy text: ', err);
                showToast('Failed to copy text: ', 'error');
            });
    });

    return copyButton;
}
/**
 * Attach a copy button inside each <tr> on hover.
 * - Uses the SVG as background.
 * - Clicking the button copies the row's text to clipboard.
 * - Adds a temporary 'copied' class on success for 2 seconds.
 */
(function attachRowCopySVG(joiner = ': ') {
  function createCopyButton() {
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
          const btn = createCopyButton();
          firstCell.prepend(btn);

          btn.addEventListener('click', e => {
            e.stopPropagation();
            copyRow(tr, btn);
          });
        }
      }
    });
  }

  function copyRow(tr, btn) {
    const cells = Array.from(tr.querySelectorAll('td, th'));
    const texts = cells.map(cell => cell.innerText.trim());
	
	
	const parsed = parseValue(texts[1]);
    const type = detectType(parsed);
    texts[1] = parsed;
	
	if (type == 'string') {
		texts[1] = `"${texts[1]}"`;
	}
		
	
    const finalText = texts.join(joiner);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(finalText).then(() => {
        showCopiedEffect(btn);
        showToast('Key-Value copied!', 'success');
      }).catch(() => fallbackCopy(finalText, btn));
    } else {
      fallbackCopy(finalText, btn);
    }
  }

  function fallbackCopy(text, btn) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);

      if (ok) {
        showCopiedEffect(btn);
        showToast('Key-Value copied!', 'success');
      }
    } catch (ex) {
      console.error('Fallback copy failed:', ex);
    }
  }

  // Add temporary 'copied' class to icon
  function showCopiedEffect(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 2000);
  }

  // Initial attach
  attachButtons();

  // Observe DOM changes if new rows are added dynamically
  const observer = new MutationObserver(attachButtons);
  observer.observe(document.body, { childList: true, subtree: true });
})();
