// ==========================================
// tv2dis — Background Service Worker
// Handles: alarms, screenshot capture, webhook,
//          page refresh, TF switching, & state sync
// ==========================================

const ALARM_NAME = 'tv2dis-capture';
const TF_CHANGE_DELAY = 3000;   // 3 seconds wait after changing TimeFrame

// --- Open Side Panel on icon click ---
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('sidePanel behavior error:', error));

// --- Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'start') {
    handleStart(sendResponse);
    return true; // keep sendResponse alive for async
  }

  if (message.action === 'stop') {
    handleStop(sendResponse);
    return true;
  }

  if (message.action === 'test') {
    handleTest(sendResponse);
    return true;
  }
});

// --- Alarm Listener ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[tv2dis] Alarm fired, starting capture cycle...');
    executeCaptureAndSend();
  }
});

// --- Start ---
async function handleStart(sendResponse) {
  try {
    const settings = await getSettings();
    if (!settings || !settings.webhookUrl) {
      sendResponse({ success: false, error: 'ไม่พบการตั้งค่า Webhook URL' });
      return;
    }

    const intervalMinutes = parseInt(settings.timeSend) || 30;

    // Set alarm
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: intervalMinutes
    });

    // Save state
    const nextAlarmTime = Date.now() + (intervalMinutes * 60 * 1000);
    await chrome.storage.local.set({
      tv2disState: {
        isRunning: true,
        nextAlarmTime: nextAlarmTime,
        startedAt: Date.now()
      }
    });

    sendResponse({ success: true });

    // Execute immediately on first start
    sendLogToPanel('🚀 เริ่มระบบ — ส่งรอบแรกทันที...', 'success');
    executeCaptureAndSend();

  } catch (error) {
    console.error('[tv2dis] Start error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// --- Stop ---
async function handleStop(sendResponse) {
  try {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({
      tv2disState: { isRunning: false, nextAlarmTime: null }
    });
    sendResponse({ success: true });
    sendLogToPanel('⏹️ หยุดระบบเรียบร้อย', 'info');
  } catch (error) {
    console.error('[tv2dis] Stop error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// --- Test ---
async function handleTest(sendResponse) {
  try {
    const settings = await getSettings();
    if (!settings || !settings.webhookUrl) {
      sendResponse({ success: false, error: 'ไม่พบการตั้งค่า Webhook URL' });
      return;
    }

    const tab = await getTradingViewTab();
    if (!tab) {
      sendResponse({ success: false, error: 'ไม่พบแท็บ TradingView ที่เปิดอยู่' });
      return;
    }

    // Bring tab to front
    await activateTab(tab);
    await ensureContentScriptLoaded(tab.id);

    // Get TF1 value
    const tf1 = (settings.timeframes && settings.timeframes[0]) || '15';

    // Change timeframe
    sendLogToPanel(`🔄 เปลี่ยน TimeFrame เป็น ${getTfLabel(tf1)}...`, 'info');
    await sendMessageToTab(tab.id, { action: 'changeTimeframe', tf: tf1 });

    // Wait for chart to render
    await delay(TF_CHANGE_DELAY);

    // Ensure any open popups or "เปลี่ยนช่วง" dialogs are closed
    await sendMessageToTab(tab.id, { action: 'closeOverlays' }).catch(() => {});
    await delay(250);

    // Capture screenshot
    sendLogToPanel('📸 กำลังจับภาพ...', 'info');
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (e1) {
      dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    }

    // Send to Discord (Image only)
    sendLogToPanel('📤 กำลังส่งไป Discord...', 'info');
    await sendToDiscord(settings.webhookUrl, dataUrl);

    sendResponse({ success: true });

  } catch (error) {
    console.error('[tv2dis] Test error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// --- Execute Capture & Send (called by alarm) ---
async function executeCaptureAndSend() {
  try {
    const settings = await getSettings();
    if (!settings || !settings.webhookUrl) {
      sendLogToPanel('❌ ไม่พบการตั้งค่า Webhook URL', 'error');
      return;
    }

    let tab = await getTradingViewTab();
    if (!tab) {
      sendLogToPanel('❌ ไม่พบแท็บ TradingView ที่เปิดอยู่', 'error');
      return;
    }

    // Check running state before proceeding
    let state = await getState();
    if (!state.isRunning) return;

    // Bring tab & window to active foreground for screenshot capture
    await activateTab(tab);

    const timeframes = (settings.timeframes && settings.timeframes.length > 0)
      ? settings.timeframes
      : ['15'];

    // Step 0: Refresh TradingView page safely
    sendLogToPanel('🔄 Refreshing TradingView...', 'info');
    await reloadAndWaitTab(tab.id);
    await ensureContentScriptLoaded(tab.id);

    // Loop through each timeframe
    for (let i = 0; i < timeframes.length; i++) {
      // Re-check running state before each TF step
      state = await getState();
      if (!state.isRunning) {
        sendLogToPanel('⏹️ ยกเลิกการส่งเนื่องจากระบบถูกหยุด', 'info');
        return;
      }

      const tf = timeframes[i];
      const tfLabel = getTfLabel(tf);

      sendLogToPanel(`⏱️ [${i + 1}/${timeframes.length}] เปลี่ยน TF → ${tfLabel}`, 'info');

      // Send message to content script to change timeframe
      try {
        await sendMessageToTab(tab.id, { action: 'changeTimeframe', tf: tf });
      } catch (err) {
        sendLogToPanel(`⚠️ ไม่สามารถเปลี่ยน TF (${tfLabel}): ${err.message}`, 'error');
        continue;
      }

      // Wait for chart to render
      await delay(TF_CHANGE_DELAY);

      // Re-verify tab is active & ensure any open "เปลี่ยนช่วง" dialog is closed
      await activateTab(tab);
      await sendMessageToTab(tab.id, { action: 'closeOverlays' }).catch(() => {});
      await delay(250);

      // Capture screenshot
      sendLogToPanel(`📸 จับภาพ ${tfLabel}...`, 'info');
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (err) {
        try {
          dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        } catch (err2) {
          sendLogToPanel(`❌ จับภาพล้มเหลว (${tfLabel}): ${err2.message}`, 'error');
          continue;
        }
      }

      // Send to Discord (Image only)
      try {
        await sendToDiscord(settings.webhookUrl, dataUrl);
        sendLogToPanel(`✅ ส่ง ${tfLabel} สำเร็จ`, 'success');
      } catch (err) {
        sendLogToPanel(`❌ ส่ง ${tfLabel} ล้มเหลว: ${err.message}`, 'error');
      }

      // Small delay between sends to avoid rate limiting
      if (i < timeframes.length - 1) {
        await delay(1500);
      }
    }

    // Update next alarm time
    const intervalMinutes = parseInt(settings.timeSend) || 30;
    const nextAlarmTime = Date.now() + (intervalMinutes * 60 * 1000);
    await chrome.storage.local.set({
      tv2disState: {
        isRunning: true,
        nextAlarmTime: nextAlarmTime,
        startedAt: state.startedAt || Date.now()
      }
    });

    sendLogToPanel(`🏁 ส่งครบทุก TF — รอบถัดไปใน ${intervalMinutes} นาที`, 'success');

  } catch (error) {
    console.error('[tv2dis] captureAndSend error:', error);
    sendLogToPanel(`❌ เกิดข้อผิดพลาด: ${error.message}`, 'error');
  }
}

// --- Send screenshot to Discord Webhook ---
async function sendToDiscord(webhookUrl, dataUrl, content = '', retryCount = 0) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const formData = new FormData();
  if (content && content.trim() !== '') {
    formData.append('content', content);
  }
  formData.append('file', blob, `chart_${Date.now()}.png`);

  const result = await fetch(webhookUrl, {
    method: 'POST',
    body: formData
  });

  if (result.status === 429 && retryCount < 2) {
    const errData = await result.json().catch(() => ({}));
    const retryMs = errData.retry_after ? Math.ceil(errData.retry_after * 1000) : 5000;
    sendLogToPanel(`⏳ Discord Rate limit — รอ ${Math.ceil(retryMs / 1000)}s...`, 'info');
    await delay(retryMs);
    return sendToDiscord(webhookUrl, dataUrl, content, retryCount + 1);
  }

  if (!result.ok) {
    const text = await result.text();
    throw new Error(`Discord API error ${result.status}: ${text}`);
  }
}

// --- Activate Tab & Window ---
async function activateTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await delay(200);
  } catch (err) {
    console.warn('[tv2dis] Activate tab error:', err);
  }
}

// --- Reload tab and wait for load complete ---
function reloadAndWaitTab(tabId) {
  return new Promise((resolve) => {
    let timeoutId;

    const listener = (tid, changeInfo) => {
      if (tid === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);

    // Timeout after 12 seconds if load listener doesn't trigger
    timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 12000);
  });
}

// --- Ensure Content Script is ready in tab ---
async function ensureContentScriptLoaded(tabId) {
  try {
    await sendMessageToTab(tabId, { action: 'ping' });
  } catch (err) {
    // Content script not listening — dynamically inject
    console.log('[tv2dis] Injecting content.js into tab:', tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      await delay(300);
    } catch (injErr) {
      console.error('[tv2dis] Script injection failed:', injErr);
    }
  }
}

// --- Send message to content script in a tab ---
function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// --- Find TradingView tab ---
async function getTradingViewTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.tradingview.com/*' });
  if (tabs.length === 0) return null;
  const activeTab = tabs.find(t => t.active);
  return activeTab || tabs[0];
}

// --- Get settings from storage ---
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('tv2disSettings', (result) => {
      resolve(result.tv2disSettings || null);
    });
  });
}

// --- Get state from storage ---
function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get('tv2disState', (result) => {
      resolve(result.tv2disState || {});
    });
  });
}

// --- Send log to side panel ---
function sendLogToPanel(text, type = 'info') {
  chrome.runtime.sendMessage({ action: 'log', text, type })
    .catch(() => { /* Panel might not be open */ });
}

// --- TimeFrame label mapping ---
function getTfLabel(value) {
  const labels = {
    '1': '1M',
    '5': '5M',
    '15': '15M',
    '30': '30M',
    '60': '1H',
    '240': '4H',
    '1D': '1D',
    'D': '1D'
  };
  return labels[value] || value;
}

// --- Delay utility ---
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Restore state on service worker startup ---
chrome.runtime.onStartup.addListener(async () => {
  const state = await getState();
  if (state.isRunning) {
    console.log('[tv2dis] Restoring running state after browser restart...');
    const settings = await getSettings();
    if (settings) {
      const intervalMinutes = parseInt(settings.timeSend) || 30;
      await chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: intervalMinutes
      });
    }
  }
});
