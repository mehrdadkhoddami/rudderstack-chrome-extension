// interceptor.js
// این فایل به عنوان web_accessible_resource تعریف شده
// و از contentScript با <script src> inject میشه — با CSP کار میکنه
(function () {
    if (window.__rsInterceptorInjected) return;
    window.__rsInterceptorInjected = true;

    // Pattern رو از data attribute اسکریپت میخونیم
    const me = document.currentScript || (function () {
        const scripts = document.getElementsByTagName('script');
        return scripts[scripts.length - 1];
    })();
    const PATTERN = (me && me.dataset && me.dataset.pattern) ? me.dataset.pattern : '/beacon/v1/batch';

    console.log('[RS Interceptor] Injected. Watching pattern:', PATTERN);

    function dispatchBatch(bodyText, sourceType) {
        try {
            const parsed = JSON.parse(bodyText);
            if (parsed && Array.isArray(parsed.batch) && parsed.batch.length > 0) {
                console.log(`[RS Interceptor] Captured batch via ${sourceType}: ${parsed.batch.length} events`);
                window.dispatchEvent(new CustomEvent('__rs_batch_captured', {
                    detail: { batch: parsed.batch, timestamp: Date.now(), sourceType }
                }));
            }
        } catch (e) {
            console.warn('[RS Interceptor] Failed to parse body:', e.message, '| preview:', bodyText ? bodyText.slice(0, 100) : 'empty');
        }
    }

    function matchesPattern(url) {
        return url && url.includes(PATTERN);
    }

    // ── Override fetch ────────────────────────────────────────────────────────
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (matchesPattern(url) && init && (init.method || '').toUpperCase() === 'POST') {
            try {
                const body = init.body;
                if (typeof body === 'string') {
                    dispatchBatch(body, 'fetch');
                } else if (body instanceof Blob) {
                    body.text().then(text => dispatchBatch(text, 'fetch-blob')).catch(() => {});
                } else if (body instanceof ArrayBuffer) {
                    dispatchBatch(new TextDecoder().decode(body), 'fetch-arraybuffer');
                } else if (body instanceof ReadableStream) {
                    // ReadableStream: clone and read
                    const [s1, s2] = body.tee();
                    init = { ...init, body: s1 };
                    new Response(s2).text().then(text => dispatchBatch(text, 'fetch-stream')).catch(() => {});
                }
            } catch (e) {
                console.warn('[RS Interceptor] fetch override error:', e);
            }
        }
        return origFetch.apply(this, arguments);
    };

    // ── Override sendBeacon ───────────────────────────────────────────────────
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
        if (matchesPattern(url)) {
            try {
                if (typeof data === 'string') {
                    dispatchBatch(data, 'sendBeacon');
                } else if (data instanceof Blob) {
                    data.text().then(text => dispatchBatch(text, 'sendBeacon-blob')).catch(() => {});
                } else if (data instanceof ArrayBuffer) {
                    dispatchBatch(new TextDecoder().decode(data), 'sendBeacon-arraybuffer');
                } else if (data instanceof FormData) {
                    console.warn('[RS Interceptor] sendBeacon with FormData — cannot read body');
                }
            } catch (e) {
                console.warn('[RS Interceptor] sendBeacon override error:', e);
            }
        }
        return origBeacon(url, data);
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
        if ((this.__rsMethod || '').toUpperCase() === 'POST' && matchesPattern(this.__rsUrl)) {
            try {
                if (typeof body === 'string') {
                    dispatchBatch(body, 'xhr');
                } else if (body instanceof Blob) {
                    body.text().then(text => dispatchBatch(text, 'xhr-blob')).catch(() => {});
                } else if (body instanceof ArrayBuffer) {
                    dispatchBatch(new TextDecoder().decode(body), 'xhr-arraybuffer');
                }
            } catch (e) {
                console.warn('[RS Interceptor] XHR override error:', e);
            }
        }
        return origSend.apply(this, arguments);
    };

    console.log('[RS Interceptor] fetch, sendBeacon, XHR overrides active.');
})();
