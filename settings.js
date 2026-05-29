// settings.js
const DEFAULT_BATCH_PATTERN = '/beacon/v1/batch';

const DEFAULT_CUSTOM_PATTERNS = [];

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ── Custom pattern rows ────────────────────────────────────────
let customPatterns = [];

function renderCustomPatterns() {
  const list = document.getElementById('customPatternsList');
  list.innerHTML = '';

  customPatterns.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.className = 'custom-rule-row';

    const prefixWrap = document.createElement('div');
    prefixWrap.className = 'rule-input-wrap';
    const prefixLabel = document.createElement('span');
    prefixLabel.className = 'rule-input-label';
    prefixLabel.textContent = 'startsWith';
    const prefixInput = document.createElement('input');
    prefixInput.type = 'text';
    prefixInput.className = 'rule-input';
    prefixInput.placeholder = 'e.g. rl_';
    prefixInput.spellcheck = false;
    prefixInput.autocomplete = 'off';
    prefixInput.value = rule.prefix;
    prefixInput.addEventListener('input', () => { customPatterns[idx].prefix = prefixInput.value.trim(); });
    prefixWrap.appendChild(prefixLabel);
    prefixWrap.appendChild(prefixInput);

    const suffixWrap = document.createElement('div');
    suffixWrap.className = 'rule-input-wrap';
    const suffixLabel = document.createElement('span');
    suffixLabel.className = 'rule-input-label';
    suffixLabel.textContent = 'endsWith';
    const suffixInput = document.createElement('input');
    suffixInput.type = 'text';
    suffixInput.className = 'rule-input';
    suffixInput.placeholder = 'optional';
    suffixInput.spellcheck = false;
    suffixInput.autocomplete = 'off';
    suffixInput.value = rule.suffix;
    suffixInput.addEventListener('input', () => { customPatterns[idx].suffix = suffixInput.value.trim(); });
    suffixWrap.appendChild(suffixLabel);
    suffixWrap.appendChild(suffixInput);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove-rule';
    removeBtn.title = 'Remove rule';
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    removeBtn.addEventListener('click', () => {
      customPatterns.splice(idx, 1);
      renderCustomPatterns();
    });

    row.appendChild(prefixWrap);
    row.appendChild(suffixWrap);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

document.getElementById('addPatternBtn').addEventListener('click', () => {
  customPatterns.push({ prefix: '', suffix: '' });
  renderCustomPatterns();
  const inputs = document.querySelectorAll('.rule-input');
  if (inputs.length) inputs[inputs.length - 2].focus();
});

// ── Load saved settings ────────────────────────────────────────
chrome.storage.local.get([
  'batchUrlPattern', 'showJsonViewer', 'enableDebug',
  'patternRudder', 'patternQueue', 'customLsPatterns'
], (result) => {
  const pattern = result.batchUrlPattern || DEFAULT_BATCH_PATTERN;
  document.getElementById('batchPattern').value = pattern;

  const wrap = document.getElementById('currentValueWrap');
  const txt  = document.getElementById('currentValueText');
  if (pattern !== DEFAULT_BATCH_PATTERN) {
    wrap.style.display = '';
    txt.textContent = pattern;
  }

  document.getElementById('showJsonViewer').checked = result.showJsonViewer !== false;
  document.getElementById('enableDebug').checked    = result.enableDebug === true;
  document.getElementById('patternRudder').checked  = result.patternRudder !== false;
  document.getElementById('patternQueue').checked   = result.patternQueue  !== false;

  customPatterns = Array.isArray(result.customLsPatterns) ? result.customLsPatterns : [];
  renderCustomPatterns();
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

  const validCustom = customPatterns.filter(r => r.prefix.length > 0);

  chrome.storage.local.set({
    batchUrlPattern:   pattern,
    showJsonViewer:    document.getElementById('showJsonViewer').checked,
    enableDebug:       document.getElementById('enableDebug').checked,
    patternRudder:     document.getElementById('patternRudder').checked,
    patternQueue:      document.getElementById('patternQueue').checked,
    customLsPatterns:  validCustom,
  }, () => {
    const wrap = document.getElementById('currentValueWrap');
    const txt  = document.getElementById('currentValueText');
    wrap.style.display = '';
    txt.textContent = pattern;
    customPatterns = validCustom;
    renderCustomPatterns();
    showToast('Settings saved \u2713');
  });
});

// ── Reset ──────────────────────────────────────────────────────
document.getElementById('resetBtn').addEventListener('click', () => {
  document.getElementById('batchPattern').value     = DEFAULT_BATCH_PATTERN;
  document.getElementById('showJsonViewer').checked = true;
  document.getElementById('enableDebug').checked    = false;
  document.getElementById('patternRudder').checked  = true;
  document.getElementById('patternQueue').checked   = true;
  customPatterns = [];
  renderCustomPatterns();

  chrome.storage.local.set({
    batchUrlPattern:  DEFAULT_BATCH_PATTERN,
    showJsonViewer:   true,
    enableDebug:      false,
    patternRudder:    true,
    patternQueue:     true,
    customLsPatterns: [],
  }, () => {
    document.getElementById('currentValueWrap').style.display = 'none';
    showToast('Reset to defaults \u2713');
  });
});

// ── Preset chips ───────────────────────────────────────────────
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('batchPattern').value = chip.dataset.value;
  });
});
