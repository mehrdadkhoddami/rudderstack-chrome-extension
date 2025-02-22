(() => {
    let lastProcessedState = {};
    let isExtensionActive = true;
    let port = null;
    let monitoringInterval = null;
    let batchEvents = [];
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    let processedBatchEvents = new Map();
	let lastBatchTimestamp = 0;
	
	// Add message listener at the top level of your IIFE
	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (message.type === 'clearAll' && message.clearBatch) {
			console.log('Received clearAll command with batch clear');
			clearAllData();
			sendResponse({ success: true });
		}
		return true;
	});
	
	function clearAllData() {
		try {
			// Clear all batch-related data
			batchEvents = [];
			processedBatchEvents.clear();
			lastBatchTimestamp = 0;
			lastProcessedState = {};
			
			// Clear any existing intervals
			if (monitoringInterval) {
				clearInterval(monitoringInterval);
				monitoringInterval = null;
			}

			console.log('Cleared all batch data and tracking structures');
			
			// Restart monitoring with fresh state
			setupMonitoring();
		} catch (e) {
			console.error('Error in clearAllData:', e);
		}
	}

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
		
		try {
			const items = safeGetLocalStorage();
			
			// Add batch events if available
			if (batchEvents.length > 0) {
				batchEvents.forEach((event, index) => {
					const eventKey = `batch_${event.event || event.type}_${lastBatchTimestamp}`;
					
					items[eventKey] = {
						value: JSON.stringify(event),
						parsedValue: event,
						originalKey: event.event || 'Batch Event',
						propertiesKey: event.properties || null,
						timestamp: lastBatchTimestamp,
						isBatchEvent: true
					};
				});
			}
			
			const currentStateStr = JSON.stringify(items);
			const lastStateStr = JSON.stringify(lastProcessedState);
			
			if (currentStateStr !== lastStateStr) {
				lastProcessedState = items;
				return items;
			}
			
			return null;
		} catch (e) {
			console.error('Error processing items:', e);
			return null;
		}
	}

    // Check changes and notify
    function checkAndNotifyChanges() {
        try {
            if (!isExtensionActive || !chrome.runtime) {
                cleanup();
                return;
            }

            const items = processLocalStorageItems();
            if (items && port) {
                try {
                    port.postMessage({
                        type: 'storageChanged',
                        data: items
                    });
                } catch (e) {
                    console.log('Error posting message:', e);
                    handleConnectionError();
                }
            }
        } catch (e) {
            console.error('Error in checkAndNotifyChanges:', e);
        }
    }

    // Setup monitoring
    function setupMonitoring() {
        try {
            if (!isExtensionActive || !chrome.runtime) {
                cleanup();
                return;
            }

            // Clear existing interval
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

        } catch (e) {
            console.error('Error in setupMonitoring:', e);
            cleanup();
        }
    }

    // Connection error handler
    function handleConnectionError() {
        try {
            cleanup();
            
            if (chrome.runtime && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                setTimeout(setupConnection, 1000 * Math.pow(2, reconnectAttempts));
            }
        } catch (e) {
            console.log('Error in handleConnectionError:', e);
        }
    }

    // Cleanup function
    function cleanup() {
        try {
            if (monitoringInterval) {
                clearInterval(monitoringInterval);
                monitoringInterval = null;
            }

            if (port) {
                try {
                    port.disconnect();
                } catch (e) {
                    console.log('Error disconnecting port:', e);
                }
                port = null;
            }

            batchEvents = [];
            processedBatchEvents.clear();
			lastBatchTimestamp = 0; 
            isExtensionActive = false;
            lastProcessedState = {};

        } catch (e) {
            console.log('Error in cleanup:', e);
        }
    }

    // Setup connection
    function setupConnection() {
        try {
            if (!chrome.runtime) {
                cleanup();
                return;
            }

            cleanup();
            port = chrome.runtime.connect({ name: 'rudderstack-monitor' });
            
            port.onMessage.addListener((message) => {
				try {
					if (message.type === 'batchRequest') {
						 //cleared state
						if (lastBatchTimestamp === 0) {
							console.log('Processing batch after clear');
							processedBatchEvents.clear(); // Ensure clean slate
						}
						// Check if this batch is newer than our last processed batch
						if (message.timestamp <= lastBatchTimestamp) {
							console.log('Skipping older or duplicate batch:', {
								currentTimestamp: message.timestamp,
								lastProcessedTimestamp: lastBatchTimestamp
							});
							return;
						}

						console.log('Raw Batch data received:', {
							type: message.type,
							timestamp: message.timestamp,
							dataLength: message.data?.length || 0
						});

						// Update last batch timestamp
						lastBatchTimestamp = message.timestamp;
						
						// Process new batch events
						const newBatchEvents = [];
						
						message.data.forEach(event => {
							const eventKey = event.event || event.type;
							const existingEvent = processedBatchEvents.get(eventKey);
							
							if (!existingEvent || existingEvent.timestamp < message.timestamp) {
								newBatchEvents.push(event);
								processedBatchEvents.set(eventKey, {
									timestamp: message.timestamp,
									key: eventKey
								});
								console.log('Processing batch event:', {
									type: eventKey,
									timestamp: message.timestamp
								});
							}
						});

						if (newBatchEvents.length > 0) {
							batchEvents = newBatchEvents.map(event => ({
								...event,
								timestamp: message.timestamp
							}));
							
							console.log('New batch events to be displayed:', 
								batchEvents.map(event => ({
									type: event.event || event.type,
									timestamp: event.timestamp
								}))
							);
							checkAndNotifyChanges();
						} else {
							console.log('No new events to process in this batch');
						}
					}
				} catch (e) {
					console.error('Error processing batch events:', {
						error: e.message,
						stack: e.stack,
						messageType: message?.type,
						messageData: JSON.stringify(message?.data, null, 2)
					});
				}
			});

            port.onDisconnect.addListener(() => {
                try {
                    if (chrome.runtime.lastError) {
                        cleanup();
                    }
                } catch (e) {
                    console.log('Error in disconnect listener:', e);
                }
            });

            isExtensionActive = true;
            setupMonitoring();
        } catch (e) {
            console.log('Error in setupConnection:', e);
            cleanup();
        }
    }

    // Cleanup old processed events periodically
    setInterval(() => {
        const now = Date.now();
        for (const [key, data] of processedBatchEvents.entries()) {
            if (now - data.timestamp > 5000) {
                processedBatchEvents.delete(key);
            }
        }
    }, 5000);

    // Initialize
    try {
        if (chrome.runtime) {
            setupConnection();
        }
    } catch (e) {
        console.log('Error during initialization:', e);
    }

    // Cleanup on unload
    window.addEventListener('unload', () => {
        try {
            cleanup();
        } catch (e) {
            console.log('Error during unload cleanup:', e);
        }
    });
})();