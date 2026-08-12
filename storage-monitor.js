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

        // Throttled, payload-free ping — used for removals, where there is
        // nothing to attribute.
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

        // Writes carry their payload so contentScript.js can record exactly which
        // events THIS document produced.
        //
        // localStorage is shared by every tab and window on the origin, so a plain
        // re-read cannot tell "we wrote this" from "another window wrote this and
        // we can now see it". Only the patched setItem of the document that made
        // the call runs, which makes this the one reliable ownership signal.
        // Never throttled — dropping a write would lose the event permanently.
        function notifyWrite(key, value) {
            try {
                lastNotification = Date.now();
                window.dispatchEvent(new CustomEvent('rudderstack_storage_changed', {
                    detail: { key: key, value: value }
                }));
            } catch (e) {
                console.warn('Failed to dispatch storage write event');
            }
        }

        // Safe method override
        function safeOverride() {
            try {
                localStorage.setItem = function(key, value) {
                    originalMethods.setItem.call(localStorage, key, value);
                    if (isTrackedKey(key)) notifyWrite(key, value);
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

        // Patch immediately. Waiting for DOMContentLoaded left a long window in
        // which SDK writes happened through the unpatched setItem and were never
        // attributed to this document.
        safeOverride();

    } catch (e) {
        console.warn('Failed to initialize storage monitor');
    }
})();
