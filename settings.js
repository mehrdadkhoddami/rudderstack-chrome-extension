// settings.js
const DEFAULT_BATCH_PATTERN = '/beacon/v1/batch';

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ── Load saved settings ────────────────────────────────────────
chrome.storage.local.get(['batchUrlPattern', 'showJsonViewer', 'enableDebug'], (result) => {
  const pattern = result.batchUrlPattern || DEFAULT_BATCH_PATTERN;
  document.getElementById('batchPattern').value = pattern;

  const wrap = document.getElementById('currentValueWrap');
  const txt  = document.getElementById('currentValueText');
  if (pattern !== DEFAULT_BATCH_PATTERN) {
    wrap.style.display = '';
    txt.textContent = pattern;
  }

  // Toggle: showJsonViewer defaults to true
  const showJsonViewer = result.showJsonViewer !== false;
  document.getElementById('showJsonViewer').checked = showJsonViewer;

  // Toggle: enableDebug defaults to false
  const enableDebug = result.enableDebug === true;
  document.getElementById('enableDebug').checked = enableDebug;
});

// ── Save ───────────────────────────────────────────────────────
document.getElementById('saveBtn').addEventListener('click', () => {
  const patternInput = document.getElementById('batchPattern');
  const pattern = patternInput.value.trim();

  if (!pattern) {
    patternInput.classList.add('error');
    showToast('Pattern cannot be empty', 'error');
    return;
  }
  patternInput.classList.remove('error');

  const showJsonViewer = document.getElementById('showJsonViewer').checked;
  const enableDebug    = document.getElementById('enableDebug').checked;

  chrome.storage.local.set({ batchUrlPattern: pattern, showJsonViewer, enableDebug }, () => {
    const wrap = document.getElementById('currentValueWrap');
    const txt  = document.getElementById('currentValueText');
    wrap.style.display = '';
    txt.textContent = pattern;
    showToast('Settings saved ✓');
  });
});

// ── Reset ──────────────────────────────────────────────────────
document.getElementById('resetBtn').addEventListener('click', () => {
  document.getElementById('batchPattern').value = DEFAULT_BATCH_PATTERN;
  document.getElementById('showJsonViewer').checked = true;
  document.getElementById('enableDebug').checked = false;

  chrome.storage.local.set({
    batchUrlPattern: DEFAULT_BATCH_PATTERN,
    showJsonViewer: true,
    enableDebug: false,
  }, () => {
    document.getElementById('currentValueWrap').style.display = 'none';
    showToast('Reset to defaults ✓');
  });
});

// ── Preset chips ───────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('batchPattern').value = chip.dataset.value;
  });
});
