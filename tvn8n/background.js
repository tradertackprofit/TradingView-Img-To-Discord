// ==========================================
// TradingView To N8N — Background Service Worker
// Handles: alarms, screenshot capture, webhook,
//          page refresh, TF switching, & state sync
// ==========================================

const ALARM_NAME = 'tvn8n-capture';
const TF_CHANGE_DELAY = 3000;   // 3 seconds wait after changing TimeFrame

// --- Open Side Panel on icon click (if supported by Chrome version) ---
if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('sidePanel behavior error:', error));
}

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

  if (message.action === 'openWindow') {
    chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html'),
      type: 'popup',
      width: 400,
      height: 680
    });
    sendResponse({ success: true });
    return true;
  }
});

// --- Alarm Listener ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === 'tv2dis-capture') {
    console.log('[tvn8n] Alarm fired, starting capture cycle...');
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
    const isSyncCandle = settings.syncCandleClose !== false;

    if (isSyncCandle) {
      const nextAlarmTime = getNextCandleCloseTime(intervalMinutes);
      await chrome.alarms.create(ALARM_NAME, {
        when: nextAlarmTime,
        periodInMinutes: intervalMinutes
      });

      const stateData = {
        isRunning: true,
        nextAlarmTime: nextAlarmTime,
        startedAt: Date.now()
      };
      await chrome.storage.local.set({ tvn8nState: stateData, tv2disState: stateData });

      sendResponse({ success: true });

      const waitMs = nextAlarmTime - Date.now();
      const waitMins = Math.floor(waitMs / 60000);
      const waitSecs = Math.floor((waitMs % 60000) / 1000);
      const targetDate = new Date(nextAlarmTime);
      const timeStr = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}:${String(targetDate.getSeconds()).padStart(2, '0')}`;

      sendLogToPanel(`🕯️ เริ่มระบบ — รอจบแท่งเทียนรอบถัดไปเวลา ${timeStr} (อีก ${waitMins}m ${waitSecs}s)...`, 'info');
    } else {
      const nextAlarmTime = Date.now() + (intervalMinutes * 60 * 1000);
      await chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: intervalMinutes
      });

      const stateData = {
        isRunning: true,
        nextAlarmTime: nextAlarmTime,
        startedAt: Date.now()
      };
      await chrome.storage.local.set({ tvn8nState: stateData, tv2disState: stateData });

      sendResponse({ success: true });

      sendLogToPanel('🚀 เริ่มระบบ — ส่งรอบแรกทันที...', 'success');
      executeCaptureAndSend();
    }

  } catch (error) {
    console.error('[tvn8n] Start error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// --- Stop ---
async function handleStop(sendResponse) {
  try {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear('tv2dis-capture');
    const stopState = { isRunning: false, nextAlarmTime: null };
    await chrome.storage.local.set({ tvn8nState: stopState, tv2disState: stopState });
    sendResponse({ success: true });
    sendLogToPanel('⏹️ หยุดระบบเรียบร้อย', 'info');
  } catch (error) {
    console.error('[tvn8n] Stop error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// --- Test ---
async function handleTest(sendResponse) {
  try {
    const settings = await getSettings();
    const targetWebhook = (settings && settings.testWebhookUrl)
      || (settings && settings.webhookUrl)
      || 'https://fightable-unprejudicial-deonna.ngrok-free.dev/webhook-test/tv';

    const tab = await getTradingViewTab();
    if (!tab) {
      sendResponse({ success: false, error: 'ไม่พบแท็บ TradingView ที่เปิดอยู่' });
      return;
    }

    // Bring tab to front
    await activateTab(tab);
    await ensureContentScriptLoaded(tab.id);

    // Get TF1 value
    const tf1 = (settings && settings.timeframes && settings.timeframes[0]) || '15';
    const tfLabel = getTfLabel(tf1);

    // Change timeframe
    sendLogToPanel(`🔄 เปลี่ยน TimeFrame เป็น ${tfLabel}...`, 'info');
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

    // Send to N8N
    sendLogToPanel('📤 กำลังส่งไป N8N Webhook...', 'info');
    await sendToN8N(targetWebhook, dataUrl, tfLabel);

    sendResponse({ success: true });

  } catch (error) {
    console.error('[tvn8n] Test error:', error);
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

    // Step 0.5: Check market status if "ส่งเฉพาะตอนตลาดเปิดเท่านั้น" is enabled
    if (settings.onlyMarketOpen !== false) {
      try {
        const statusRes = await sendMessageToTab(tab.id, { action: 'checkMarketStatus' });
        if (statusRes && statusRes.isMarketOpen === false) {
          const statusText = statusRes.statusText || 'ตลาดปิดอยู่';
          const { nextAlarmTime } = await updateNextCycleAlarm(settings, state);
          const targetDate = new Date(nextAlarmTime);
          const timeStr = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;
          sendLogToPanel(`⏸️ ตลาดปิดอยู่ (${statusText}) — ข้ามการส่งในรอบนี้ (เช็กอีกครั้งเวลา ${timeStr})`, 'info');
          return;
        }
      } catch (marketErr) {
        console.warn('[tv2dis] Check market status warning:', marketErr);
      }
    }

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

      // Send to N8N Webhook
      try {
        await sendToN8N(settings.webhookUrl || 'https://fightable-unprejudicial-deonna.ngrok-free.dev/webhook/tv', dataUrl, tfLabel);
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
    const { nextAlarmTime, isSyncCandle, intervalMinutes } = await updateNextCycleAlarm(settings, state);

    if (isSyncCandle) {
      const targetDate = new Date(nextAlarmTime);
      const timeStr = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;
      sendLogToPanel(`🏁 ส่งครบทุก TF — รอจบแท่งถัดไปเวลา ${timeStr}`, 'success');
    } else {
      sendLogToPanel(`🏁 ส่งครบทุก TF — รอบถัดไปใน ${intervalMinutes} นาที`, 'success');
    }

  } catch (error) {
    console.error('[tvn8n] captureAndSend error:', error);
    sendLogToPanel(`❌ เกิดข้อผิดพลาด: ${error.message}`, 'error');
  }
}

// --- Helper: Update next alarm cycle ---
async function updateNextCycleAlarm(settings, state) {
  const intervalMinutes = parseInt(settings.timeSend) || 30;
  const isSyncCandle = settings.syncCandleClose !== false;
  let nextAlarmTime;

  if (isSyncCandle) {
    nextAlarmTime = getNextCandleCloseTime(intervalMinutes);
    await chrome.alarms.create(ALARM_NAME, {
      when: nextAlarmTime,
      periodInMinutes: intervalMinutes
    });
  } else {
    nextAlarmTime = Date.now() + (intervalMinutes * 60 * 1000);
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: intervalMinutes
    });
  }

  const newState = {
    isRunning: true,
    nextAlarmTime: nextAlarmTime,
    startedAt: (state && state.startedAt) ? state.startedAt : Date.now()
  };
  await chrome.storage.local.set({ tvn8nState: newState, tv2disState: newState });

  return { nextAlarmTime, isSyncCandle, intervalMinutes };
}

// --- Send screenshot to N8N Webhook ---
async function sendToN8N(webhookUrl, dataUrl, timeframe = '', content = '', retryCount = 0) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const formData = new FormData();
  formData.append('file', blob, `chart_${timeframe}_${Date.now()}.png`);
  formData.append('timeframe', timeframe);
  formData.append('timestamp', new Date().toISOString());
  if (content && content.trim() !== '') {
    formData.append('content', content);
  }

  const result = await fetch(webhookUrl, {
    method: 'POST',
    body: formData
  });

  if (result.status === 429 && retryCount < 2) {
    const errData = await result.json().catch(() => ({}));
    const retryMs = errData.retry_after ? Math.ceil(errData.retry_after * 1000) : 5000;
    sendLogToPanel(`⏳ N8N Rate limit — รอ ${Math.ceil(retryMs / 1000)}s...`, 'info');
    await delay(retryMs);
    return sendToN8N(webhookUrl, dataUrl, timeframe, content, retryCount + 1);
  }

  if (!result.ok) {
    const text = await result.text();
    throw new Error(`N8N Webhook error ${result.status}: ${text}`);
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
    chrome.storage.local.get(['tvn8nSettings', 'tv2disSettings'], (result) => {
      resolve(result.tvn8nSettings || result.tv2disSettings || null);
    });
  });
}

// --- Get state from storage ---
function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['tvn8nState', 'tv2disState'], (result) => {
      resolve(result.tvn8nState || result.tv2disState || {});
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
/**
 * Calculate the exact timestamp of the next candle close boundary.
 * @param {number|string} intervalMinutes - Interval in minutes (e.g. 5, 15, 30, 60, 240, 1440)
 * @param {number} bufferSeconds - Additional seconds to wait after candle boundary (default 3s)
 * @returns {number} Unix timestamp in milliseconds
 */
function getNextCandleCloseTime(intervalMinutes, bufferSeconds = 3) {
  const now = Date.now();
  const mins = parseInt(intervalMinutes, 10) || 30;
  const intervalMs = mins * 60 * 1000;

  // Calculate next clock boundary (aligned to UTC clock)
  let nextBoundary = Math.ceil(now / intervalMs) * intervalMs;

  // Add buffer seconds (so TradingView has time to draw closed candle)
  let targetTime = nextBoundary + (bufferSeconds * 1000);

  // If targetTime is within 5 seconds from now, pick the next candle boundary to avoid triggering immediately on partial candle
  if (targetTime - now < 5000) {
    targetTime += intervalMs;
  }

  return targetTime;
}

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
      const isSyncCandle = settings.syncCandleClose !== false;

      if (isSyncCandle) {
        const nextAlarmTime = getNextCandleCloseTime(intervalMinutes);
        await chrome.alarms.create(ALARM_NAME, {
          when: nextAlarmTime,
          periodInMinutes: intervalMinutes
        });
        await chrome.storage.local.set({
          tv2disState: {
            ...state,
            nextAlarmTime: nextAlarmTime
          }
        });
      } else {
        await chrome.alarms.create(ALARM_NAME, {
          periodInMinutes: intervalMinutes
        });
      }
    }
  }
});
