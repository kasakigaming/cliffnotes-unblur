'use strict';

const HOST_RE = /^https?:\/\/([a-z0-9-]+\.)*cliffsnotes\.com\//i;

const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const rescanBtn = document.getElementById('rescan');
const reloadBtn = document.getElementById('reload');
const fields = {
  elements: document.getElementById('stat-elements'),
  rules: document.getElementById('stat-rules'),
  overlays: document.getElementById('stat-overlays'),
};

let tab = null;

const onCliffsNotes = () => HOST_RE.test(tab?.url || '');

function renderStats(stats) {
  fields.elements.textContent = stats ? stats.elements : '–';
  fields.rules.textContent = stats ? stats.rules : '–';
  fields.overlays.textContent = stats ? stats.overlays : '–';
}

function setStatus(text, tone = '') {
  status.textContent = text;
  status.className = `status ${tone}`;
}

/** Content script may be absent (tab loaded before install) — treat as no data. */
async function ask(type) {
  if (!onCliffsNotes()) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    return null;
  }
}

async function refresh() {
  const { enabled = true } = await chrome.storage.local.get({ enabled: true });
  toggle.checked = enabled;

  if (!onCliffsNotes()) {
    setStatus('Open a cliffsnotes.com page to use this.', 'inactive');
    rescanBtn.disabled = true;
    reloadBtn.disabled = true;
    renderStats(null);
    return;
  }

  rescanBtn.disabled = !enabled;
  reloadBtn.disabled = false;

  if (!enabled) {
    setStatus('Disabled on this site.', 'off');
    renderStats(null);
    return;
  }

  const response = await ask('stats');
  if (!response) {
    setStatus('Not running on this tab yet — reload the page.', 'off');
    renderStats(null);
    return;
  }
  setStatus('Active on this page.');
  renderStats(response.stats);
}

toggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: toggle.checked });
  await refresh();
});

rescanBtn.addEventListener('click', async () => {
  const response = await ask('rescan');
  if (response) {
    renderStats(response.stats);
    setStatus('Rescanned.');
  } else {
    setStatus('Nothing to scan — reload the page.', 'off');
  }
});

reloadBtn.addEventListener('click', async () => {
  await chrome.tabs.reload(tab.id);
  window.close();
});

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
})();
