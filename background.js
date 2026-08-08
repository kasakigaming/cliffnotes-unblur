/*
 * CliffsNotes Unblur — service worker.
 *
 * Deliberately does no request interception. MV3 dropped webRequestBlocking,
 * and its replacement (declarativeNetRequest) can only block, redirect or
 * rewrite headers — it cannot read or modify a response body, which is the
 * only thing this extension needs from the network. That work happens in
 * inject.js, inside the page's own JS realm.
 *
 * What is left here: the on/off setting, the toolbar badge, and re-injecting
 * the content scripts into tabs that were already open at install time.
 */

const HOST_MATCH = '*://*.cliffsnotes.com/*';
const HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*cliffsnotes\.com\//i;

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get({ enabled: true });
  return enabled;
}

async function paintBadge(tabId, url) {
  if (!HOST_RE.test(url || '')) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const on = await isEnabled();
  await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: on ? '#1f9d55' : '#8a8f98',
  });
}

async function paintAllBadges() {
  const tabs = await chrome.tabs.query({ url: HOST_MATCH });
  await Promise.all(tabs.map((tab) => paintBadge(tab.id, tab.url)));
}

/**
 * Content scripts declared in the manifest only apply to navigations that
 * happen after install, so seed the tabs that are already open.
 */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: HOST_MATCH });
  for (const tab of tabs) {
    try {
      // inject.js is document_start-only by nature (it must patch fetch before
      // the page uses it), so on an already-loaded tab only the DOM layer is
      // worth injecting. The page is reloaded by the popup for the full effect.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
        world: 'ISOLATED',
      });
    } catch (err) {
      console.debug('[CliffsNotes Unblur] skip tab', tab.id, err.message);
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled === undefined) await chrome.storage.local.set({ enabled: true });
  await injectIntoOpenTabs();
  await paintAllBadges();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) paintAllBadges();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) paintBadge(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) paintBadge(tabId, tab.url);
});
