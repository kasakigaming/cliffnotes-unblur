/*
 * CliffsNotes Unblur — network layer (MAIN world).
 *
 * Runs in the page's own realm so that patching window.fetch / XMLHttpRequest
 * actually affects the page's requests. A content script in the default
 * ISOLATED world gets its own copy of those globals and would do nothing.
 *
 * This cannot live in the service worker: MV3 removed webRequestBlocking, and
 * declarativeNetRequest can only block/redirect/rewrite headers — it has no
 * access to response bodies, which is exactly what we need to rewrite here.
 */
(() => {
  'use strict';

  const API_PATTERN = /\/api\/v\d+\/documents\//i;
  const STATE_ATTR = 'data-cn-unblur';
  const INSTALLED = '__cnUnblurNetPatched';

  // Patching twice (extension update, or a re-injection) would nest the wrappers.
  if (window[INSTALLED]) return;
  Object.defineProperty(window, INSTALLED, { value: true });

  // The isolated-world script mirrors the on/off setting onto <html> for us.
  // Absent attribute means "not written yet" — default to enabled.
  const isEnabled = () => document.documentElement?.getAttribute(STATE_ATTR) !== 'off';

  const isTarget = (url) => typeof url === 'string' && API_PATTERN.test(url);

  /** Extract a URL string from any fetch() first argument. */
  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
      if (input && typeof input.url === 'string') return input.url;
    } catch (_) { /* exotic input, ignore */ }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Payload scrubbing
  // ---------------------------------------------------------------------------

  const SUBSTITUTIONS = [
    // filter: blur(8px)  ->  filter: none   (covers -webkit-/backdrop- variants)
    [/(-webkit-|backdrop-)?filter\s*:\s*[^;"'}]*blur\s*\([^)]*\)[^;"'}]*/gi, 'filter:none'],
    // bare blur() inside shorthand or SVG attributes
    [/blur\s*\(\s*[^)]*\)/gi, 'blur(0px)'],
    [/(-webkit-|-moz-|-ms-)?user-select\s*:\s*none/gi, 'user-select:text'],
    [/pointer-events\s*:\s*none/gi, 'pointer-events:auto'],
    // opacity:0 / visibility:hidden used to hide locked paragraphs
    [/visibility\s*:\s*hidden/gi, 'visibility:visible'],
  ];

  function scrubString(str) {
    // Cheap bail-out: most strings in a payload are prose, not CSS.
    if (!str || !/blur|user-select|pointer-events|visibility/.test(str)) return str;
    let out = str;
    for (const [re, to] of SUBSTITUTIONS) out = out.replace(re, to);
    return out;
  }

  /**
   * Walk any decoded JSON and scrub every string leaf. Doing it structurally
   * instead of reaching for `data.response.htmlPreviews` means we keep working
   * when the API shape changes.
   */
  function scrubJson(value, seen = new Set()) {
    if (typeof value === 'string') return scrubString(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = scrubJson(value[i], seen);
      return value;
    }
    for (const key of Object.keys(value)) value[key] = scrubJson(value[key], seen);
    return value;
  }

  /** Scrub a raw response body, JSON or HTML. Returns null when unchanged. */
  function scrubBody(text) {
    if (!text) return null;
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const scrubbed = JSON.stringify(scrubJson(JSON.parse(text)));
        return scrubbed === text ? null : scrubbed;
      } catch (_) { /* not JSON after all — fall through to text scrub */ }
    }
    const scrubbed = scrubString(text);
    return scrubbed === text ? null : scrubbed;
  }

  // ---------------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------------

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function fetch(...args) {
      const response = await nativeFetch.apply(this, args);
      if (!isEnabled() || !isTarget(urlOf(args[0]) || response.url)) return response;

      // 204/205/304 must not carry a body; rebuilding one would throw.
      if (response.status === 204 || response.status === 205 || response.status === 304) {
        return response;
      }

      try {
        const text = await response.clone().text();
        const scrubbed = scrubBody(text);
        if (scrubbed === null) return response;

        const patched = new Response(scrubbed, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        // `new Response()` reports an empty url; some callers read it.
        Object.defineProperty(patched, 'url', { value: response.url, enumerable: true });
        return patched;
      } catch (err) {
        console.warn('[CliffsNotes Unblur] fetch passthrough:', err);
        return response;
      }
    };
    // Keep the patch inconspicuous to feature-detection / logging code.
    Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
    window.fetch.toString = () => nativeFetch.toString();
  }

  // ---------------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------------
  //
  // Patch the prototype rather than replacing the constructor, so `instanceof`,
  // subclassing and static props keep working. The hook is installed from
  // open(), which pages call before attaching their own load handlers — that
  // ordering is what lets us rewrite responseText before the page reads it.

  const xhrProto = XMLHttpRequest.prototype;
  const nativeOpen = xhrProto.open;
  const URL_KEY = Symbol('cnUnblurUrl');

  xhrProto.open = function open(method, url, ...rest) {
    try {
      this[URL_KEY] = typeof url === 'string' ? url : String(url ?? '');
      if (isTarget(this[URL_KEY])) this.addEventListener('readystatechange', onReadyStateChange);
    } catch (_) { /* never break the page's request */ }
    return nativeOpen.call(this, method, url, ...rest);
  };
  Object.defineProperty(xhrProto.open, 'name', { value: 'open' });
  xhrProto.open.toString = () => nativeOpen.toString();

  function onReadyStateChange() {
    if (this.readyState !== 4 || !isEnabled()) return;
    this.removeEventListener('readystatechange', onReadyStateChange);

    const type = this.responseType;
    if (type !== '' && type !== 'text' && type !== 'json') return; // blob/arraybuffer: leave alone

    try {
      const raw = type === 'json' ? JSON.stringify(this.response) : this.responseText;
      const scrubbed = scrubBody(raw);
      if (scrubbed === null) return;

      if (type === 'json') {
        Object.defineProperty(this, 'response', {
          configurable: true,
          get: () => JSON.parse(scrubbed),
        });
      } else {
        Object.defineProperty(this, 'responseText', { configurable: true, get: () => scrubbed });
        Object.defineProperty(this, 'response', { configurable: true, get: () => scrubbed });
      }
    } catch (err) {
      console.warn('[CliffsNotes Unblur] XHR passthrough:', err);
    }
  }
})();
