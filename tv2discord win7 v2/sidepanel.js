// ==========================================
// tv2dis — Side Panel UI Logic
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  // --- DOM References ---
  const btnPlay = document.getElementById('btnPlay');
  const btnTest = document.getElementById('btnTest');
  const btnSave = document.getElementById('btnSave');
  const btnCancel = document.getElementById('btnCancel');
  const btnPopout = document.getElementById('btnPopout');
  const timeSend = document.getElementById('timeSend');
  const syncCandleClose = document.getElementById('syncCandleClose');
  const onlyMarketOpen = document.getElementById('onlyMarketOpen');
  const amountTf = document.getElementById('amountTf');
  const webhookUrl = document.getElementById('webhookUrl');
  const statusBadge = document.getElementById('statusBadge');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const timerDisplay = document.getElementById('timerDisplay');
  const timerText = document.getElementById('timerText');
  const logContainer = document.getElementById('logContainer');

  // TF group references
  const tfGroups = [];
  const tfSelects = [];
  for (let i = 1; i <= 6; i++) {
    tfGroups.push(document.getElementById(`tfGroup${i}`));
    tfSelects.push(document.getElementById(`tf${i}`));
  }

  const TF_ORDER = ['1', '5', '15', '30', '60', '240', '1D'];

  let isRunning = false;
  let countdownInterval = null;

  // --- Initialize ---
  loadSettings();
  checkRunningState();

  // --- Event Listeners ---

  // Amount TF change → show/hide TF dropdowns & validate order
  amountTf.addEventListener('change', () => {
    updateTfVisibility();
    validateAndAdjustTfs(0);
  });

  // Add change listeners to each TF dropdown for strict ordering
  tfSelects.forEach((select, index) => {
    select.addEventListener('change', () => {
      validateAndAdjustTfs(index);
    });
  });

  // Play/Stop button
  btnPlay.addEventListener('click', async () => {
    if (isRunning) {
      // Stop
      chrome.runtime.sendMessage({ action: 'stop' }, (response) => {
        if (response && response.success) {
          setRunningState(false);
          addLog('⏹️ หยุดการทำงาน', 'info');
        }
      });
    } else {
      // Validate webhook
      const webhook = webhookUrl.value.trim();
      if (!webhook) {
        showToast('กรุณาใส่ Webhook URL ก่อน', 'error');
        webhookUrl.focus();
        return;
      }
      if (!webhook.startsWith('https://discord.com/api/webhooks/')) {
        showToast('Webhook URL ไม่ถูกต้อง', 'error');
        webhookUrl.focus();
        return;
      }

      // Save settings first
      await saveSettingsToStorage();

      // Start
      chrome.runtime.sendMessage({ action: 'start' }, (response) => {
        if (response && response.success) {
          setRunningState(true);
          addLog('▶️ เริ่มการทำงาน', 'success');
        } else {
          showToast(response?.error || 'เกิดข้อผิดพลาด', 'error');
        }
      });
    }
  });

  // Test button
  btnTest.addEventListener('click', async () => {
    const webhook = webhookUrl.value.trim();
    if (!webhook) {
      showToast('กรุณาใส่ Webhook URL ก่อน', 'error');
      webhookUrl.focus();
      return;
    }
    if (!webhook.startsWith('https://discord.com/api/webhooks/')) {
      showToast('Webhook URL ไม่ถูกต้อง', 'error');
      webhookUrl.focus();
      return;
    }

    await saveSettingsToStorage();

    btnTest.disabled = true;
    btnTest.querySelector('span').textContent = 'กำลังส่ง...';
    addLog('🧪 ทดสอบส่งรูป TF1...', 'info');

    chrome.runtime.sendMessage({ action: 'test' }, (response) => {
      btnTest.disabled = false;
      btnTest.querySelector('span').textContent = 'Test';
      if (response && response.success) {
        addLog('✅ ส่งรูปทดสอบสำเร็จ', 'success');
        showToast('ส่งรูปทดสอบสำเร็จ!', 'success');
      } else {
        addLog(`❌ ส่งรูปทดสอบล้มเหลว: ${response?.error || 'ไม่ทราบสาเหตุ'}`, 'error');
        showToast('ส่งรูปทดสอบล้มเหลว', 'error');
      }
    });
  });

  // Save button
  btnSave.addEventListener('click', async () => {
    validateAndAdjustTfs(0);
    await saveSettingsToStorage();
    showToast('บันทึกสำเร็จ!', 'success');
    addLog('💾 บันทึกการตั้งค่า', 'info');
  });

  // Cancel button
  btnCancel.addEventListener('click', () => {
    loadSettings();
    showToast('ยกเลิกการเปลี่ยนแปลง', 'error');
  });

  // Pop-out Window button (for Win 7 & standalone mode)
  if (btnPopout) {
    btnPopout.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'openWindow' });
    });
  }

  // Listen for log messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'log') {
      addLog(message.text, message.type || 'info');
    }
    if (message.action === 'stateChanged') {
      setRunningState(message.isRunning);
    }
    sendResponse({ received: true });
  });

  // Listen for storage changes (reactive countdown update)
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.tv2disState) {
        const newState = changes.tv2disState.newValue;
        if (newState) {
          setRunningState(newState.isRunning);
        }
      }
      if (changes.tv2disSettings) {
        loadSettings();
      }
    }
  });

  // --- Functions ---

  function getTfIndex(val) {
    const idx = TF_ORDER.indexOf(val);
    return idx >= 0 ? idx : 0;
  }

  /**
   * Enforce strict ascending order: TF1 < TF2 < TF3 < TF4 < TF5 < TF6
   * Prevents duplicates and ensures top TF is smaller and bottom TF is larger.
   */
  function validateAndAdjustTfs(changedIndex = 0) {
    const count = parseInt(amountTf.value) || 1;

    // Default ascending fallback order if needed: 1M, 5M, 15M, 30M, 1H, 4H, 1D
    const defaultDefaults = ['1', '5', '15', '30', '60', '240'];

    // Step 1: Forward adjustment (TF[i] must be strictly greater than TF[i-1])
    for (let i = 1; i < count; i++) {
      const prevIdx = getTfIndex(tfSelects[i - 1].value);
      let currIdx = getTfIndex(tfSelects[i].value);

      if (currIdx <= prevIdx) {
        currIdx = Math.min(prevIdx + 1, TF_ORDER.length - 1);
        tfSelects[i].value = TF_ORDER[currIdx];
      }
    }

    // Step 2: Backward adjustment (if last elements hit max limit)
    for (let i = count - 2; i >= 0; i--) {
      const nextIdx = getTfIndex(tfSelects[i + 1].value);
      let currIdx = getTfIndex(tfSelects[i].value);

      if (currIdx >= nextIdx) {
        currIdx = Math.max(0, nextIdx - 1);
        tfSelects[i].value = TF_ORDER[currIdx];
      }
    }

    // Step 3: Disable invalid options in each dropdown
    updateOptionDisability();
  }

  function updateOptionDisability() {
    const count = parseInt(amountTf.value) || 1;

    for (let i = 0; i < count; i++) {
      const select = tfSelects[i];
      const prevVal = i > 0 ? tfSelects[i - 1].value : null;
      const nextVal = i < count - 1 ? tfSelects[i + 1].value : null;

      const prevIdx = prevVal ? getTfIndex(prevVal) : -1;
      const nextIdx = nextVal ? getTfIndex(nextVal) : TF_ORDER.length;

      Array.from(select.options).forEach(opt => {
        const optIdx = getTfIndex(opt.value);
        // Disable if <= prev or >= next
        if ((prevIdx !== -1 && optIdx <= prevIdx) || (nextIdx !== TF_ORDER.length && optIdx >= nextIdx)) {
          opt.disabled = true;
        } else {
          opt.disabled = false;
        }
      });
    }
  }

  function updateTfVisibility() {
    const count = parseInt(amountTf.value);
    for (let i = 0; i < 6; i++) {
      tfGroups[i].style.display = i < count ? 'flex' : 'none';
    }
  }

  async function saveSettingsToStorage() {
    validateAndAdjustTfs(0);

    const settings = {
      timeSend: timeSend.value,
      syncCandleClose: syncCandleClose ? syncCandleClose.checked : true,
      onlyMarketOpen: onlyMarketOpen ? onlyMarketOpen.checked : true,
      amountTf: amountTf.value,
      webhookUrl: webhookUrl.value.trim(),
      timeframes: []
    };

    const count = parseInt(amountTf.value);
    for (let i = 0; i < count; i++) {
      settings.timeframes.push(tfSelects[i].value);
    }

    // Save all TF values (even hidden ones)
    settings.allTfValues = [];
    for (let i = 0; i < 6; i++) {
      settings.allTfValues.push(tfSelects[i].value);
    }

    await chrome.storage.local.set({ tv2disSettings: settings });
  }

  function loadSettings() {
    chrome.storage.local.get('tv2disSettings', (result) => {
      const settings = result.tv2disSettings;
      if (!settings) {
        // Defaults: TF1=15M, TF2=1H, TF3=4H, TF4=1D, TF5=5M, TF6=30M
        tfSelects[0].value = '15';
        tfSelects[1].value = '60';
        tfSelects[2].value = '240';
        tfSelects[3].value = '1D';
        if (syncCandleClose) syncCandleClose.checked = true;
        updateTfVisibility();
        validateAndAdjustTfs(0);
        return;
      }

      timeSend.value = settings.timeSend || '30';
      if (syncCandleClose) {
        syncCandleClose.checked = settings.syncCandleClose !== false;
      }
      if (onlyMarketOpen) {
        onlyMarketOpen.checked = settings.onlyMarketOpen !== false;
      }
      amountTf.value = settings.amountTf || '1';
      webhookUrl.value = settings.webhookUrl || '';

      // Restore TF selections
      if (settings.allTfValues && settings.allTfValues.length > 0) {
        for (let i = 0; i < 6; i++) {
          if (settings.allTfValues[i]) {
            tfSelects[i].value = settings.allTfValues[i];
          }
        }
      } else if (settings.timeframes && settings.timeframes.length > 0) {
        for (let i = 0; i < settings.timeframes.length && i < 6; i++) {
          tfSelects[i].value = settings.timeframes[i];
        }
      }

      updateTfVisibility();
      validateAndAdjustTfs(0);
    });
  }

  function checkRunningState() {
    chrome.storage.local.get('tv2disState', (result) => {
      const state = result.tv2disState;
      if (state && state.isRunning) {
        setRunningState(true);
      }
    });
  }

  function setRunningState(running) {
    isRunning = running;

    if (running) {
      btnPlay.classList.add('is-stop');
      btnPlay.querySelector('span').textContent = 'Stop';
      btnPlay.querySelector('svg').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      statusBadge.classList.add('running');
      statusText.textContent = 'Running';
      timerDisplay.style.display = 'flex';
      startCountdown();
    } else {
      btnPlay.classList.remove('is-stop');
      btnPlay.querySelector('span').textContent = 'Play';
      btnPlay.querySelector('svg').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
      statusBadge.classList.remove('running');
      statusText.textContent = 'Stopped';
      timerDisplay.style.display = 'none';
      stopCountdown();
    }
  }

  function startCountdown() {
    stopCountdown();

    const updateTimerText = () => {
      chrome.storage.local.get(['tv2disState', 'tv2disSettings'], (result) => {
        const state = result.tv2disState;
        const settings = result.tv2disSettings || {};
        if (!state || !state.isRunning || !state.nextAlarmTime) {
          timerText.textContent = 'กำลังส่ง...';
          return;
        }

        const now = Date.now();
        const remaining = state.nextAlarmTime - now;

        if (remaining <= 0) {
          timerText.textContent = 'กำลังจับภาพส่ง...';
        } else {
          const mins = Math.floor(remaining / 60000);
          const secs = Math.floor((remaining % 60000) / 1000);
          const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
          if (settings.syncCandleClose !== false) {
            timerText.textContent = `🕯️ รอจบแท่งเทียนใน ${timeStr}`;
          } else {
            timerText.textContent = `ส่งรอบถัดไปใน ${timeStr}`;
          }
        }
      });
    };

    updateTimerText();
    countdownInterval = setInterval(updateTimerText, 1000);
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function addLog(text, type = 'info') {
    // Remove empty state
    const emptyMsg = logContainer.querySelector('.log-empty');
    if (emptyMsg) emptyMsg.remove();

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    entry.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <span class="log-msg">${text}</span>
    `;

    // Insert at top
    logContainer.insertBefore(entry, logContainer.firstChild);

    // Limit to 50 entries
    const entries = logContainer.querySelectorAll('.log-entry');
    if (entries.length > 50) {
      entries[entries.length - 1].remove();
    }
  }

  function showToast(message, type = 'success') {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 350);
    }, 2500);
  }
});
