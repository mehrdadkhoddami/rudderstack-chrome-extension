// settings.js
const DEFAULT_BATCH_PATTERN = '/beacon/v1/batch';

const batchPatternInput  = document.getElementById('batchPattern');
const saveBtn            = document.getElementById('saveBtn');
const resetBtn           = document.getElementById('resetBtn');
const toast              = document.getElementById('toast');
const currentValueWrap   = document.getElementById('currentValueWrap');
const currentValueText   = document.getElementById('currentValueText');

// ── Load ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['batchUrlPattern'], (result) => {
    const saved = result.batchUrlPattern || DEFAULT_BATCH_PATTERN;
    batchPatternInput.value = saved;
    showCurrent(saved);
});

function showCurrent(pattern) {
    currentValueText.textContent = pattern;
    currentValueWrap.style.display = '';
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = 'toast ' + type;
    void toast.offsetWidth;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
}

// ── Save ──────────────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
    const val = batchPatternInput.value.trim();
    if (!val) {
        batchPatternInput.classList.add('error');
        showToast('Pattern cannot be empty.', 'error');
        return;
    }
    batchPatternInput.classList.remove('error');
    chrome.storage.local.set({ batchUrlPattern: val }, () => {
        showCurrent(val);
        showToast('Settings saved ✓');
    });
});

// ── Reset ─────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
    batchPatternInput.value = DEFAULT_BATCH_PATTERN;
    batchPatternInput.classList.remove('error');
    chrome.storage.local.set({ batchUrlPattern: DEFAULT_BATCH_PATTERN }, () => {
        showCurrent(DEFAULT_BATCH_PATTERN);
        showToast('Reset to default ✓');
    });
});

// ── Preset chips ──────────────────────────────────────────────────────────────
document.querySelectorAll('.chip[data-value]').forEach(chip => {
    chip.addEventListener('click', () => {
        batchPatternInput.value = chip.dataset.value;
        batchPatternInput.classList.remove('error');
    });
});

// ── Enter key ─────────────────────────────────────────────────────────────────
batchPatternInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
});
