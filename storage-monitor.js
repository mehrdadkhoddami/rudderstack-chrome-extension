// --- perf helpers auto-injected ---
(function(){
  if (window.__perfHelpersInjected) return;
  window.__perfHelpersInjected = true;
  window._throttle = function(fn, wait){ var last=0, t; return function(){ var now=Date.now(); if(now-last>wait){ last=now; fn.apply(this, arguments);} }; };
  window._debounce = function(fn, wait){ var t; return function(){ var ctx=this, args=arguments; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,args); }, wait); }; };
  window._rafLoop = function(cb){ var active=true; function loop(){ if(!active) return; try{ cb(); }catch(e){ console.error(e);} requestAnimationFrame(loop);} requestAnimationFrame(loop); return function stop(){ active=false; }; };
})();
// --- end perf helpers ---

// storage-monitor.js
(function() {
    try {
        let lastNotification = Date.now();
        const NOTIFICATION_DELAY = 50;
        const originalMethods = {};

        // Safely store original methods
        try {
            originalMethods.setItem = localStorage.setItem.bind(localStorage);
            originalMethods.removeItem = localStorage.removeItem.bind(localStorage);
            originalMethods.clear = localStorage.clear.bind(localStorage);
        } catch (e) {
            console.warn('Failed to store original localStorage methods');
            return; // Exit if we can't access localStorage
        }

        // Safe notification function
        function safeNotify() {
            const now = Date.now();
            if (now - lastNotification > NOTIFICATION_DELAY) {
                lastNotification = now;
                try {
                    window.dispatchEvent(new CustomEvent('rudderstack_storage_changed'));
                } catch (e) {
                    console.warn('Failed to dispatch storage event');
                }
            }
        }

        // Safe method override
        function safeOverride() {
            try {
                // Override setItem
                localStorage.setItem = function(key, value) {
                    originalMethods.setItem.call(localStorage, key, value);
                    if (key && key.startsWith('rudder_batch')) {
                        safeNotify();
                    }
                };

                // Override removeItem
                localStorage.removeItem = function(key) {
                    originalMethods.removeItem.call(localStorage, key);
                    if (key && key.startsWith('rudder_batch')) {
                        safeNotify();
                    }
                };

                // Override clear
                localStorage.clear = function() {
                    originalMethods.clear.call(localStorage);
                    safeNotify();
                };
            } catch (e) {
                console.warn('Failed to override localStorage methods');
            }
        }

        // Initialize monitoring
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', safeOverride);
        } else {
            safeOverride();
        }

    } catch (e) {
        console.warn('Failed to initialize storage monitor');
    }
})();

function setupClearListener() {
    window.addEventListener('rudderstack_clear_monitoring', () => {
        // Reset internal state
        lastProcessedState = {};
        lastNotification = 0;
        
        // Clear any existing intervals
        if (monitorInterval) {
            clearInterval(monitorInterval);
            monitorInterval = null;
        }
    });
}