// interceptor.js — runs in PAGE context
(function () {
    if (window.__rsInterceptorInjected) return;
    window.__rsInterceptorInjected = true;

    const me = document.currentScript || (function () {
        const scripts = document.getElementsByTagName('script');
        return scripts[scripts.length - 1];
    })();

    let PATTERN = (me && me.dataset && me.dataset.pattern)
        ? me.dataset.pattern
        : '/beacon/v1/batch';

    // Debug flag is pushed in from contentScript.js (page context has no
    // chrome.storage access). Defaults to off so we stay silent by default.
    let DEBUG = !!(me && me.dataset && me.dataset.debug === 'true');

    function rsLog(...args)  { if (DEBUG) console.log(...args); }
    function rsWarn(...args) { if (DEBUG) console.warn(...args); }

    rsLog('[RS Interceptor] Injected. Watching pattern:', PATTERN);

    window.addEventListener('__rs_update_pattern', (e) => {
        if (!e.detail) return;
        if (e.detail.pattern) {
            PATTERN = e.detail.pattern;
            rsLog('[RS Interceptor] Pattern updated to:', PATTERN);
        }
        if (typeof e.detail.debug === 'boolean') DEBUG = e.detail.debug;
    });

    window.addEventListener('__rs_update_debug', (e) => {
        if (e.detail && typeof e.detail.debug === 'boolean') DEBUG = e.detail.debug;
    });

    // ── Request correlation ───────────────────────────────────────────────────
    // Each intercepted POST gets an id so the response status can be matched
    // back to the events that were in its body.
    let _reqSeq = 0;
    function nextRequestId() {
        return 'rsreq_' + Date.now().toString(36) + '_' + (++_reqSeq);
    }

    function dispatchBatch(bodyText, sourceType, requestId) {
        try {
            const parsed = JSON.parse(bodyText);
            let batch = null;

            // Structure 1: standard RudderStack — { batch: [...] }
            if (parsed && Array.isArray(parsed.batch) && parsed.batch.length > 0) {
                batch = parsed.batch;
            }
            // Structure 2: direct array — [ {...event...}, ... ]
            // Used by partner.snappfood.ir and similar setups that POST a bare array.
            // Guard: first element must have messageId to avoid false positives.
            else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && parsed[0].messageId) {
                batch = parsed;
            }

            if (batch) {
                rsLog(`[RS Interceptor] Captured batch via ${sourceType}: ${batch.length} events (${requestId})`);
                window.dispatchEvent(new CustomEvent('__rs_batch_captured', {
                    detail: { batch: batch, timestamp: Date.now(), sourceType, requestId }
                }));
            }
        } catch (e) {
            rsWarn('[RS Interceptor] Failed to parse body:', e.message, '| preview:', bodyText ? bodyText.slice(0, 100) : 'empty');
        }
    }

    function dispatchResult(requestId, status, ok, error) {
        if (!requestId) return;
        try {
            rsLog(`[RS Interceptor] Result for ${requestId}: status=${status} ok=${ok}${error ? ' err=' + error : ''}`);
            window.dispatchEvent(new CustomEvent('__rs_batch_result', {
                detail: { requestId, status, ok, error: error || null, timestamp: Date.now() }
            }));
        } catch (e) { /* noop */ }
    }

    // Reads any of the body shapes an SDK might use and hands the text to
    // dispatchBatch. Returns nothing — dispatch may happen asynchronously.
    function readBody(body, sourceType, requestId) {
        try {
            if (typeof body === 'string') {
                dispatchBatch(body, sourceType, requestId);
            } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
                body.text().then(text => dispatchBatch(text, sourceType + '-blob', requestId)).catch(() => {});
            } else if (body instanceof ArrayBuffer) {
                dispatchBatch(new TextDecoder().decode(body), sourceType + '-arraybuffer', requestId);
            } else if (ArrayBuffer.isView(body)) {
                dispatchBatch(new TextDecoder().decode(body), sourceType + '-typedarray', requestId);
            } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                dispatchBatch(body.toString(), sourceType + '-urlsearchparams', requestId);
            } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
                rsWarn('[RS Interceptor] FormData body — cannot read');
            }
        } catch (e) {
            rsWarn('[RS Interceptor] readBody error:', e);
        }
    }

    // substring match
    function matchesPattern(url) {
        return url && url.includes(PATTERN);
    }

    // ── Override fetch ────────────────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;

        let url = '';
        if (typeof input === 'string') url = input;
        else if (isRequest) url = input.url;
        else if (input && input.url) url = input.url;
        else if (input) url = String(input);

        // Method can come from init OR from the Request object.
        const method = String(
            (init && init.method) || (isRequest ? input.method : '') || 'GET'
        ).toUpperCase();

        let requestId = null;

        if (matchesPattern(url) && method === 'POST') {
            requestId = nextRequestId();
            try {
                if (init && init.body !== undefined && init.body !== null) {
                    const body = init.body;
                    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
                        // tee() locks the original stream, so the request MUST be
                        // re-issued with one of the two branches.
                        const [s1, s2] = body.tee();
                        init = Object.assign({}, init, { body: s1, duplex: 'half' });
                        new Response(s2).text()
                            .then(text => dispatchBatch(text, 'fetch-stream', requestId))
                            .catch(() => {});
                    } else {
                        readBody(body, 'fetch', requestId);
                    }
                } else if (isRequest) {
                    // Body lives on the Request — clone so the original stays unread.
                    try {
                        input.clone().text()
                            .then(text => dispatchBatch(text, 'fetch-request', requestId))
                            .catch(() => {});
                    } catch (e) {
                        rsWarn('[RS Interceptor] Request clone failed:', e);
                    }
                }
            } catch (e) {
                rsWarn('[RS Interceptor] fetch override error:', e);
            }
        }

        // Pass the possibly-rebuilt init through — do NOT use `arguments`, which
        // still holds the original (now locked) stream body.
        const promise = origFetch.call(this, input, init);

        if (requestId) {
            promise.then(
                (res) => dispatchResult(requestId, res.status, res.ok),
                (err) => dispatchResult(requestId, 0, false, (err && err.message) || String(err))
            );
        }

        return promise;
    };

    // ── Override sendBeacon ───────────────────────────────────────────────────
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
        let requestId = null;
        if (matchesPattern(url)) {
            requestId = nextRequestId();
            readBody(data, 'sendBeacon', requestId);
        }

        const queued = origBeacon(url, data);

        // sendBeacon gives no HTTP status — only whether the browser accepted
        // the payload for delivery. Report failures only.
        if (requestId && queued === false) {
            dispatchResult(requestId, 0, false, 'sendBeacon rejected (payload too large or queue full)');
        }
        return queued;
    };

    // ── Override XMLHttpRequest ───────────────────────────────────────────────
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
        this.__rsUrl = url;
        this.__rsMethod = method;
        return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (String(this.__rsMethod || '').toUpperCase() === 'POST' && matchesPattern(this.__rsUrl)) {
            const requestId = nextRequestId();
            readBody(body, 'xhr', requestId);

            const xhr = this;
            this.addEventListener('loadend', function () {
                // status 0 with no response means network error / abort
                const status = xhr.status;
                dispatchResult(
                    requestId,
                    status,
                    status >= 200 && status < 300,
                    status === 0 ? 'network error or aborted' : null
                );
            }, { once: true });
        }
        return origSend.apply(this, arguments);
    };

    rsLog('[RS Interceptor] fetch, sendBeacon, XHR overrides active.');
})();
