/*!
 * RudderStack LocalStorage Viewer
 * 
 * 1st versions Developed by: Mehrdad Khoddami (khoddami.me@gmail.com) (mehrdad.khoddami@zoodfood.com)
 * Initial Version: January 13, 2025
 * Description: View LocalStorage Contents of RudderStack
 * I build this extension with help of ChatGPT & Cluade
 * 
 * License: MIT
 * 
 * Changelog:
 * - v1.0.6: Initial version 
 */

// Function that will be injected into the page to get localStorage items
const getLocalStorageCode = () => {
    return function() {
        try {
            const items = {};
            const storage = { ...localStorage }; // Create a safe copy
            
            Object.keys(storage).forEach(key => {
                if (key.startsWith('rudder_batch')) {
                    const value = storage[key];
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
                    } catch (e) {
                        items[key] = {
                            value: value,
                            parsedValue: null,
                            originalKey: key,
                            propertiesKey: null,
                            timestamp: Date.now()
                        };
                    }
                }
            });
            
            return items;
        } catch (e) {
            console.error('Error processing localStorage:', e);
            return {};
        }
    };
};

function createSentBadge() {
    const sentBadge = document.createElement('span');
    sentBadge.className = 'sent-badge';
    sentBadge.textContent = 'sent';
    return sentBadge;
}

// Store all seen items and current localStorage items
let seenItems = new Map();
let currentStorageItems = new Map();
let isFirstLoad = true;

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
    chrome.scripting.executeScript({
        target: {tabId: tabId},
        func: getLocalStorageCode(),
    }, results => {
        if (!results || !results[0]) return;

        // Clear previous data
        seenItems.clear();
        currentStorageItems.clear();

        // Store current localStorage items
        const currentItems = results[0].result;
        Object.entries(currentItems).forEach(([key, data]) => {
            currentStorageItems.set(key, data);
        });

        // Save to storage
        chrome.storage.local.set({
            [`seenItemsData_${tabId}`]: JSON.stringify([...seenItems]),
            [`currentStorageItems_${tabId}`]: JSON.stringify([...currentStorageItems])
        });

        // Clear the container
        const container = document.getElementById('localStorage-items');
        container.innerHTML = '';

        // Reset first load flag
        isFirstLoad = false;
    });

    // Add button animation
    const button = document.getElementById('clearButton');
    button.classList.add('clearing');
    setTimeout(() => button.classList.remove('clearing'), 200);
}

function prettyPrintJson(obj) {
    const jsonLine = /^( *)("[\w]+": )?("[^"]*"|[\w.+-]*)?([,[{])?$/mg;
    const replacer = function(match, pIndent, pKey, pVal, pEnd) {
        const key = '<span class="json-key">';
        const val = '<span class="json-value">';
        const str = '<span class="json-string">';
        let r = pIndent || '';
        if (pKey)
            r = r + key + pKey.replace(/[": ]/g, '') + '</span>: ';
        if (pVal)
            r = r + (pVal[0] == '"' ? str : val) + pVal + '</span>';
        return r + (pEnd || '');
    };

    return JSON.stringify(obj, null, 3)
        .replace(/&/g, '&amp;')
        .replace(/\\"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(jsonLine, replacer);
}

// Create HTML element for an item
function createItemElement(key, data, isSent = false) {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'item';
    if (isSent) {
        itemDiv.classList.add('sent-item');
    }
    
    const headerDiv = document.createElement('div');
    headerDiv.className = 'item-header';
    
    const keyContainer = document.createElement('div');
    keyContainer.className = 'key-container';
    
    const keyDiv = document.createElement('div');
    keyDiv.className = 'key';
    keyDiv.textContent = key;
    
    const subtitleDiv = document.createElement('span');
    subtitleDiv.className = 'subtitle';
    subtitleDiv.textContent = data.originalKey;
    
    if (data.originalKey.startsWith('rudder_batch')) {
        subtitleDiv.className = 'subtitle-type2';
    }
    
    // Add sent badge if item is sent
    if (isSent) {
        keyContainer.appendChild(createSentBadge());
    }
    
    const toggleIcon = document.createElement('span');
    toggleIcon.className = 'toggle-icon collapsed';
    toggleIcon.innerHTML = '<img src="expand_more-128.png" class="view-more" />';
    
    const valueContainer = document.createElement('div');
    valueContainer.className = 'value-container';
	
	
    // Create Copy button and append it to the header
    const copyButton = createCopyButton(data.parsedValue);
    
    const propertiesDiv = document.createElement('div');
    propertiesDiv.className = 'properties-value';
    propertiesDiv.textContent = 'Properties:';
	
	
    
    const insideValueContainer = document.createElement('div');
    insideValueContainer.className = 'inside-value-container';
    
    const valueDiv = document.createElement('pre');
    valueDiv.className = 'value';

	
    if (data.parsedValue) {
        try {
            valueDiv.innerHTML = prettyPrintJson(data.parsedValue);
        } catch (e) {
            valueDiv.textContent = data.value;
        }
    } else {
        valueDiv.textContent = data.value;
    }
	
    if (data.propertiesKey) {
        try {
            propertiesDiv.appendChild(createTableFromJson(data.propertiesKey));
        } catch (e) {
            propertiesDiv.textContent = '';
        }
    } else {
        propertiesDiv.textContent = '';
    }
    
    keyContainer.appendChild(subtitleDiv);
    keyContainer.appendChild(keyDiv);
    
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

// Main function to display results
function displayResults(results) {
    if (!results || !results[0]) return;

    const currentItems = results[0].result;
    const container = document.getElementById('localStorage-items');

    getCurrentTabId((tabId) => {
        // If it's first load and we have stored items, display them
        if (isFirstLoad && seenItems.size > 0) {
            container.innerHTML = '';

            // Display stored items
            [...seenItems.entries()]
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

        // Check for new items and mark removed ones
        for (const [key, data] of Object.entries(currentItems)) {
            // Check if item is truly new (not in seenItems AND not in currentStorageItems)
            if (!seenItems.has(key) && !currentStorageItems.has(key)) {
                seenItems.set(key, {
                    ...data,
                    firstSeen: Date.now()
                });

                // Save to chrome.storage.local
                chrome.storage.local.set({
                    [`seenItemsData_${tabId}`]: JSON.stringify([...seenItems])
                });

                // Add new item with animation
                Array.from(container.children).forEach(child => {
                    child.classList.add('shifting-down');
                });

                setTimeout(() => {
                    Array.from(container.children).forEach(child => {
                        child.classList.remove('shifting-down');
                    });

                    const itemElement = createItemElement(key, data);
                    itemElement.classList.add('new-item');

                    if (container.firstChild) {
                        container.insertBefore(itemElement, container.firstChild);
                    } else {
                        container.appendChild(itemElement);
                    }

                    setTimeout(() => {
                        itemElement.classList.add('transition-complete');
                        setTimeout(() => {
                            itemElement.classList.remove('new-item', 'transition-complete');
                        }, 300);
                    }, 3000);
                }, 500);
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
        }

        existingElements.forEach((element, key) => {
            if (!element.classList.contains('sent-item')) {
                element.classList.add('sent-item');
                const keyContainer = element.querySelector('.key-container');
                if (!keyContainer.querySelector('.sent-badge')) {
                    keyContainer.appendChild(createSentBadge());
                }
            }
        });
    });
}


function createTableFromJson(json) {
    // Create the table element
    const table = document.createElement('table');
    table.className = 'json-table';

    // Create table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const keyHeader = document.createElement('th');
    keyHeader.textContent = 'Key';
    const valueHeader = document.createElement('th');
    valueHeader.textContent = 'Value';
    headerRow.appendChild(keyHeader);
    headerRow.appendChild(valueHeader);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Create table body
    const tbody = document.createElement('tbody');
    for (const [key, value] of Object.entries(json)) {
        const row = document.createElement('tr');

        // Create key cell
        const keyCell = document.createElement('td');
        keyCell.textContent = key;
        row.appendChild(keyCell);

        // Create value cell
        const valueCell = document.createElement('td');
        if (typeof value === 'object' && value !== null) {
            valueCell.textContent = JSON.stringify(value, null, 2);
        } else {
			if (value === null) {
				valueCell.textContent = 'null';
			} else {
				valueCell.textContent = value;
			}
        }
        row.appendChild(valueCell);

        tbody.appendChild(row);
    }
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
