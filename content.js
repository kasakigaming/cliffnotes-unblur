/*
 * CliffsNotes Unblur — DOM layer (ISOLATED world).
 *
 * Three complementary passes, cheapest first:
 *   1. A static stylesheet with !important overrides — beats external
 *      stylesheets without touching a single node.
 *   2. A computed-style sweep — catches blur that arrives from any origin
 *      (external CSS, CSSOM, inline) because getComputedStyle already
 *      resolved it. Only ever runs on nodes we have not seen yet.
 *   3. Targeted paywall-overlay hiding, keyword-gated so we do not eat
 *      ordinary modals, dropdowns and backdrops.
 *
 * Work is driven by a MutationObserver, not a polling interval, and every
 * pass discards the mutation records it caused itself.
 */
(() => {
  'use strict';

  const STATE_ATTR = 'data-cn-unblur';
  const STYLE_ID = 'cn-unblur-style';
  const MARK = 'cnUnblurred';

  const stats = { elements: 0, rules: 0, overlays: 0 };

  let enabled = true;
  let observer = null;
  let scheduled = false;

  // ---------------------------------------------------------------------------
  // Pass 1 — static overrides
  // ---------------------------------------------------------------------------

  const CSS = `
/* Anything that advertises a blur in its markup or class name. */
[style*="blur"], [class*="blur" i], [class*="obfuscat" i], [class*="redact" i],
[data-blur], [data-blurred], [class*="locked" i] [class*="content" i] {
  filter: none !important;
  -webkit-filter: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* Fade-out masks used to taper a paragraph into the paywall. */
[class*="fade" i], [class*="gradient" i], [class*="teaser" i], [class*="preview" i] {
  -webkit-mask-image: none !important;
  mask-image: none !important;
}

/* Copy protection. pointer-events is deliberately NOT reset globally: some
   elements are legitimately click-through and forcing them back would put
   invisible layers in front of real controls. */
body, body * {
  user-select: text !important;
  -webkit-user-select: text !important;
  -moz-user-select: text !important;
}

/* Paywalls routinely lock scrolling on the root elements. */
html.cn-unblur-scroll, body.cn-unblur-scroll {
  overflow: auto !important;
  position: static !important;
  height: auto !important;
}
`;

  function installStylesheet() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    // <head> does not exist yet at document_start.
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStylesheet() {
    document.getElementById(STYLE_ID)?.remove();
  }

  // ---------------------------------------------------------------------------
  // Pass 2 — computed-style sweep
  // ---------------------------------------------------------------------------

  const hasBlur = (value) => !!value && value !== 'none' && value.includes('blur(');

  // getComputedStyle is the expensive part of every pass, so remember which
  // nodes we already resolved. A WeakSet rather than a data-attribute: it does
  // not touch the DOM, so it cannot itself generate mutations. Entries are
  // invalidated when style/class changes on that node.
  let visited = new WeakSet();

  function unblurElement(el) {
    if (!(el instanceof Element) || visited.has(el)) return;
    visited.add(el);

    const computed = getComputedStyle(el);
    let touched = false;

    if (hasBlur(computed.filter)) {
      el.style.setProperty('filter', 'none', 'important');
      el.style.setProperty('-webkit-filter', 'none', 'important');
      touched = true;
    }
    if (hasBlur(computed.backdropFilter) || hasBlur(computed.webkitBackdropFilter)) {
      el.style.setProperty('backdrop-filter', 'none', 'important');
      el.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
      touched = true;
    }
    if (computed.userSelect === 'none') {
      el.style.setProperty('user-select', 'text', 'important');
      touched = true;
    }

    if (touched) {
      el.dataset[MARK] = '1';
      stats.elements++;
    }
  }

  function sweep(root) {
    if (!(root instanceof Element) && !(root instanceof Document)) return;
    if (root instanceof Element) unblurElement(root);
    // A blur on a container is inherited visually by every descendant, so the
    // ancestor fix usually suffices — but the site also blurs leaves directly.
    for (const el of root.querySelectorAll('*')) unblurElement(el);
  }

  // ---------------------------------------------------------------------------
  // Pass 2b — rewrite blur rules directly in the CSSOM
  // ---------------------------------------------------------------------------
  //
  // Reaches same-origin and CORS-enabled stylesheets. Opaque cross-origin
  // sheets throw on .cssRules; the static overrides above are the fallback.

  const seenSheets = new WeakSet();

  function patchStyleSheets() {
    for (const sheet of document.styleSheets) {
      if (seenSheets.has(sheet)) continue;
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        seenSheets.add(sheet); // opaque; do not retry every mutation
        continue;
      }
      seenSheets.add(sheet);
      if (rules) patchRuleList(rules);
    }
  }

  function patchRuleList(rules) {
    for (const rule of rules) {
      if (rule.cssRules) {
        patchRuleList(rule.cssRules); // @media, @supports, @layer …
        continue;
      }
      const style = rule.style;
      if (!style) continue;
      if (hasBlur(style.filter) || hasBlur(style.webkitFilter)) {
        style.setProperty('filter', 'none', 'important');
        style.removeProperty('-webkit-filter');
        stats.rules++;
      }
      if (hasBlur(style.backdropFilter) || hasBlur(style.webkitBackdropFilter)) {
        style.setProperty('backdrop-filter', 'none', 'important');
        stats.rules++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 3 — paywall overlays
  // ---------------------------------------------------------------------------

  const PAYWALL_TEXT = /unlock|premium|subscribe|subscription|upgrade|sign\s?up|create an account|continue reading|get (full |instant )?access|start (your )?free trial/i;

  // Never touch structural nodes even if they match the heuristic.
  const STRUCTURAL = /^(HTML|BODY|MAIN|HEADER|FOOTER|NAV|ARTICLE)$/;

  function isPaywallOverlay(el) {
    const computed = getComputedStyle(el);
    const positioned = computed.position === 'fixed' || computed.position === 'sticky' ||
                       computed.position === 'absolute';
    if (!positioned) return false;

    const rect = el.getBoundingClientRect();
    const wide = rect.width >= innerWidth * 0.5;
    const tall = rect.height >= innerHeight * 0.25;
    if (!wide || !tall) return false;

    // Text gate is what keeps modals, dropdowns and plain backdrops safe.
    return PAYWALL_TEXT.test(el.innerText || '');
  }

  const OVERLAY_SELECTOR =
    '[class*="paywall" i], [class*="premium" i], [class*="upsell" i],' +
    '[class*="subscribe" i], [class*="unlock" i], [id*="paywall" i],' +
    '[class*="overlay" i], [class*="modal" i]';

  function considerOverlay(el) {
    if (el.dataset.cnUnblurHidden || STRUCTURAL.test(el.tagName)) return;
    if (!isPaywallOverlay(el)) return;
    el.dataset.cnUnblurHidden = '1';
    el.style.setProperty('display', 'none', 'important');
    stats.overlays++;
  }

  function hideOverlays(root) {
    const scope = root instanceof Element ? root : document.body;
    if (!scope) return;
    // The injected node may be the overlay itself, not its container.
    if (scope !== document.body && scope.matches(OVERLAY_SELECTOR)) considerOverlay(scope);
    for (const el of scope.querySelectorAll(OVERLAY_SELECTOR)) considerOverlay(el);
  }

  function restoreScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const computed = getComputedStyle(el);
      if (computed.overflow === 'hidden' || computed.position === 'fixed') {
        el.classList.add('cn-unblur-scroll');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Driver
  // ---------------------------------------------------------------------------

  function runAll(root = document) {
    if (!enabled) return;
    installStylesheet();
    patchStyleSheets();
    sweep(root);
    if (document.body) {
      hideOverlays(root instanceof Element ? root : document.body);
      restoreScroll();
    }
    // Drop the records our own writes just produced, so the observer does not
    // re-trigger on them. This is the whole loop-prevention story.
    observer?.takeRecords();
  }

  function schedule(roots) {
    if (scheduled || !enabled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (roots.size === 0 || roots.size > 20) {
        runAll(document);
      } else {
        for (const root of roots) runAll(root);
      }
      roots.clear();
    });
  }

  function startObserver() {
    if (observer) return;
    const pending = new Set();

    observer = new MutationObserver((records) => {
      if (!enabled) return;
      for (const record of records) {
        if (record.type === 'attributes') {
          // style/class changed — the cached computed style is stale.
          visited.delete(record.target);
          delete record.target.dataset[MARK];
          pending.add(record.target);
        } else {
          for (const node of record.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) pending.add(node);
          }
        }
      }
      if (pending.size) schedule(pending);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  /**
   * Undo everything we wrote to the DOM. CSSOM rules we rewrote in place are
   * not restorable — a reload brings those back, which is why the popup says so.
   */
  function revertAll() {
    for (const el of document.querySelectorAll('[data-cn-unblurred]')) { // dataset.cnUnblurred
      for (const prop of ['filter', '-webkit-filter', 'backdrop-filter',
                          '-webkit-backdrop-filter', 'user-select']) {
        el.style.removeProperty(prop);
      }
      delete el.dataset[MARK];
    }
    for (const el of document.querySelectorAll('[data-cn-unblur-hidden]')) {
      el.style.removeProperty('display');
      delete el.dataset.cnUnblurHidden;
    }
    document.documentElement.classList.remove('cn-unblur-scroll');
    document.body?.classList.remove('cn-unblur-scroll');
  }

  function setEnabled(next) {
    enabled = next;
    document.documentElement.setAttribute(STATE_ATTR, next ? 'on' : 'off');
    if (next) {
      visited = new WeakSet(); // force a fresh computed-style pass
      startObserver();
      runAll(document);
    } else {
      stopObserver();
      removeStylesheet();
      revertAll();
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  // An extension update leaves the previous content script running in already
  // open tabs, and background.js re-injects on install. Without this guard that
  // means two MutationObservers doing the same work and double-counted stats.
  if (document.documentElement.hasAttribute(STATE_ATTR)) return;

  // Publish the flag before anything else: inject.js reads it from <html>.
  document.documentElement.setAttribute(STATE_ATTR, 'on');
  installStylesheet();

  chrome.storage.local.get({ enabled: true }, ({ enabled: stored }) => {
    setEnabled(stored);
  });

  document.addEventListener('DOMContentLoaded', () => runAll(document));
  window.addEventListener('load', () => runAll(document));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) setEnabled(changes.enabled.newValue);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'rescan') {
      runAll(document);
      sendResponse({ ok: true, stats });
    } else if (message?.type === 'stats') {
      sendResponse({ ok: true, enabled, stats });
    }
    return false;
  });
})();
