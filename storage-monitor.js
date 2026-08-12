// storage-monitor.js — runs in PAGE context
(function() {
    try {
        let lastNotification = Date.now();
        const NOTIFICATION_DELAY = 50;
        const originalMethods = {};

        // ── Pattern state — populated via __rs_update_ls_patterns event ──────────
        // Fallback defaults match the built-in rules so monitoring works even before
        // contentScript sends the first pattern update.
        let _patterns = {
            patternRudder: true,
            patternQueue:  true,
            customRules:   [],
        };

        // Listen for pattern updates pushed by contentScript.js
        window.addEventListener('__rs_update_ls_patterns', (e) => {
            if (e.detail) {
                _patterns = {
                    patternRudder: e.detail.patternRudder !== false,
                    patternQueue:  e.detail.patternQueue  !== false,
                    customRules:   Array.isArray(e.detail.customRules) ? e.detail.customRules : [],
                };
            }
        });

        // ── Key matching — mirrors keyMatchesPatterns() in contentScript.js ──────
        function isTrackedKey(key) {
            if (!key) return false;
            if (_patterns.patternRudder && key.startsWith('rudder_') && key.endsWith('.batchQueue')) return true;
            if (_patterns.patternQueue  && key.startsWith('queue.')) return true;
            for (const rule of _patterns.customRules) {
                if (!rule.prefix) continue;
                if (key.startsWith(rule.prefix)) {
                    if (!rule.suffix || key.endsWith(rule.suffix)) return true;
                }
            }
            return false;
        }

        // Safely store original methods
        try {
            originalMethods.setItem    = localStorage.setItem.bind(localStorage);
            originalMethods.removeItem = localStorage.removeItem.bind(localStorage);
            originalMethods.clear      = localStorage.clear.bind(localStorage);
        } catch (e) {
            console.warn('Failed to store original localStorage methods');
            return;
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
                localStorage.setItem = function(key, value) {
                    originalMethods.setItem.call(localStorage, key, value);
                    if (isTrackedKey(key)) safeNotify();
                };

                localStorage.removeItem = function(key) {
                    originalMethods.removeItem.call(localStorage, key);
                    if (isTrackedKey(key)) safeNotify();
                };

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
