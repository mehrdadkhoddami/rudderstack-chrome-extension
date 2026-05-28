// sidepanel-init.js
// Extracted from sidepanel.html inline scripts to comply with CSP

document.addEventListener('DOMContentLoaded', () => {
  // Settings button
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // ── Live stats updater ─────────────────────────────────────
  function updateStats() {
    if (typeof window.allItems === 'undefined') return;
    const statSent    = document.getElementById('statSent');
    const statQueued  = document.getElementById('statQueued');
    const statBatch   = document.getElementById('statBatch');
    if (!statSent) return;

    const total   = window.allItems.size;
    const sent    = window.sentMessageIds ? window.sentMessageIds.size : 0;
    const queued  = total - sent;
    const batch   = [...window.allItems.values()].filter(v => v.source === 'batch').length;

    statSent.textContent   = sent;
    statQueued.textContent = queued > 0 ? queued : 0;
    statBatch.textContent  = batch;
  }

  setInterval(updateStats, 1000);
});
