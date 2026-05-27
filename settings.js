// settings.js
const DEFAULT_PATTERN = '/beacon/v1/batch';

const patternInput   = document.getElementById('batchPattern');
const saveBtn        = document.getElementById('saveBtn');
const resetBtn       = document.getElementById('resetBtn');
const toastEl        = document.getElementById('toast');
const currentWrap    = document.getElementById('currentValueWrap');
const currentText    = document.getElementById('currentValueText');

// ── Load saved value ──────────────────────────────────────────────
chrome.storage.local.get(['batchUrlPattern'], (result) => {
  const saved = result.batchUrlPattern || DEFAULT_PATTERN;
  patternInput.value = saved;
  showCurrentValue(saved);
});

// ── Preset chips ──────────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    patternInput.value = chip.dataset.value;
    patternInput.focus();
  });
});

// ── Save ──────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const val = patternInput.value.trim();
  if (!val) {
    showToast('Pattern cannot be empty.', 'error');
    patternInput.focus();
    return;
  }
  chrome.storage.local.set({ batchUrlPattern: val }, () => {
    showCurrentValue(val);
    showToast('Settings saved!', 'success');
  });
});

// ── Reset ─────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  patternInput.value = DEFAULT_PATTERN;
  chrome.storage.local.set({ batchUrlPattern: DEFAULT_PATTERN }, () => {
    showCurrentValue(DEFAULT_PATTERN);
    showToast('Reset to default.', 'success');
  });
});

// ── Save on Enter ─────────────────────────────────────────────────
patternInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});

// ── Helpers ───────────────────────────────────────────────────────
function showCurrentValue(val) {
  currentText.textContent = val;
  currentWrap.style.display = 'block';
}

let toastTimer;
function showToast(msg, type = 'success') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  // force reflow so re-triggering works
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}
