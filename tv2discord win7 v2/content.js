// ==========================================
// tv2dis — Content Script for TradingView
// Handles: TimeFrame switching via DOM & Keyboard
// ==========================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'changeTimeframe') {
    handleTimeframeChange(request.tf)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep sendResponse open for async Promise
  }
  if (request.action === 'closeOverlays') {
    dismissOpenDialogs()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'checkMarketStatus') {
    const status = checkMarketStatus();
    sendResponse(status);
    return true;
  }
  return true;
});

/**
 * Robust TimeFrame change handler for TradingView
 * Strategies:
 * 1. Toolbar direct button click
 * 2. Interval menu dropdown click
 * 3. Synthetic keyboard input fallback
 */
async function handleTimeframeChange(tf) {
  const targetTf = String(tf).trim();
  console.log(`[tv2dis] Changing TimeFrame to: ${targetTf}`);

  let result = null;

  // Try Strategy 1: Direct Toolbar Button
  if (tryDirectToolbarClick(targetTf)) {
    console.log(`[tv2dis] TimeFrame changed via direct toolbar button: ${targetTf}`);
    result = { success: true, method: 'toolbar' };
  } else if (await tryDropdownMenuClick(targetTf)) {
    // Try Strategy 2: Dropdown Menu
    console.log(`[tv2dis] TimeFrame changed via dropdown menu: ${targetTf}`);
    result = { success: true, method: 'dropdown' };
  } else {
    // Strategy 3: Keyboard Simulation
    console.log(`[tv2dis] Fallback to keyboard simulation for: ${targetTf}`);
    await simulateKeyboardInput(targetTf);
    result = { success: true, method: 'keyboard' };
  }

  // Ensure all dialogs (like "เปลี่ยนช่วง") are dismissed before returning
  await dismissOpenDialogs();
  return result;
}

/**
 * Strategy 1: Look for direct resolution button in top bar
 */
function tryDirectToolbarClick(tf) {
  const altTf = tf === '1D' ? 'D' : (tf === 'D' ? '1D' : tf);
  const searchTerms = getTfSearchTerms(tf);

  // 1. Direct attribute selectors
  const selectors = [
    `[data-value="${tf}"]`,
    `[data-value="${altTf}"]`,
    `button[data-value="${tf}"]`,
    `div[data-value="${tf}"]`
  ];

  for (const selector of selectors) {
    const btn = document.querySelector(selector);
    if (btn && isVisible(btn)) {
      btn.click();
      return true;
    }
  }

  // 2. Search top bar toolbar elements by text
  const headerToolbar = document.querySelector('#header-toolbar-intervals') ||
                        document.querySelector('[data-name="header-toolbar-intervals"]') ||
                        document.querySelector('div[class*="toolbar-"]');

  if (headerToolbar) {
    const buttons = Array.from(headerToolbar.querySelectorAll('button, div[role="button"], span'));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const txt = btn.textContent.trim().toLowerCase();
      if (searchTerms.some(term => txt === term.toLowerCase())) {
        btn.click();
        return true;
      }
    }
  }

  return false;
}

/**
 * Strategy 2: Click interval dropdown button and pick item
 */
async function tryDropdownMenuClick(tf) {
  const menuBtn = document.querySelector('[data-name="time-interval"]') ||
                  document.querySelector('#header-toolbar-intervals') ||
                  document.querySelector('button[aria-label*="interval"]') ||
                  document.querySelector('button[aria-label*="timeframe"]') ||
                  document.querySelector('button[id*="time-interval"]');

  if (!menuBtn) return false;

  menuBtn.click();
  await delay(350); // wait for menu popup to render

  const altTf = tf === '1D' ? 'D' : (tf === 'D' ? '1D' : tf);
  const itemSelectors = [
    `[data-value="${tf}"]`,
    `[data-value="${altTf}"]`,
    `[data-role="menuitem"][data-value="${tf}"]`,
    `div[data-role="menuitem"][data-value="${tf}"]`
  ];

  for (const selector of itemSelectors) {
    const item = document.querySelector(selector);
    if (item && isVisible(item)) {
      item.click();
      await delay(200);
      return true;
    }
  }

  // Search by text content inside open menu items
  const menuItems = Array.from(document.querySelectorAll('[data-role="menuitem"], div[role="option"], [class*="item-"], [class*="menuItem"]'));
  const searchTerms = getTfSearchTerms(tf);

  for (const item of menuItems) {
    if (!isVisible(item)) continue;
    const text = item.textContent.trim().toLowerCase();
    if (searchTerms.some(term => text === term.toLowerCase() || text.includes(term.toLowerCase()))) {
      item.click();
      await delay(200);
      return true;
    }
  }

  // Close menu if open without selection
  document.body.click();
  await delay(150);
  return false;
}

/**
 * Strategy 3: Simulate keyboard typing (e.g. typing "15" + Enter)
 */
async function simulateKeyboardInput(tf) {
  // Focus chart area
  const chartContainer = document.querySelector('.chart-container canvas') ||
                          document.querySelector('.chart-container') ||
                          document.querySelector('.layout__area--center') ||
                          document.body;

  chartContainer.focus();
  chartContainer.click();
  await delay(200);

  const chars = tf.split('');
  for (const char of chars) {
    dispatchKeyboardEvent(char);
    await delay(80);
  }

  // Press Enter
  await delay(120);
  dispatchKeyboardEvent('Enter');
  await delay(250);
}

function dispatchKeyboardEvent(key) {
  const isEnter = key === 'Enter';
  let keyCode = 13;
  let code = 'Enter';

  if (!isEnter) {
    if (!isNaN(key)) {
      keyCode = 48 + parseInt(key);
      code = `Digit${key}`;
    } else {
      keyCode = key.toUpperCase().charCodeAt(0);
      code = `Key${key.toUpperCase()}`;
    }
  }

  const opts = {
    key: key,
    code: code,
    keyCode: keyCode,
    which: keyCode,
    charCode: isEnter ? 0 : keyCode,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  // Dispatch ONCE to active element or window
  const target = document.activeElement || window;
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function getTfSearchTerms(tf) {
  const map = {
    '1': ['1m', '1 minute', '1 นาที'],
    '5': ['5m', '5 minutes', '5 นาที'],
    '15': ['15m', '15 minutes', '15 นาที'],
    '30': ['30m', '30 minutes', '30 นาที'],
    '60': ['1h', '1 hour', '60m', '1 ชั่วโมง'],
    '240': ['4h', '4 hours', '240m', '4 ชั่วโมง'],
    '1D': ['1d', '1 day', 'daily', '1 วัน'],
    'D': ['1d', '1 day', 'daily', '1 วัน']
  };
  return map[tf] || [tf];
}

function isVisible(elem) {
  if (!elem) return false;
  const rect = elem.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && window.getComputedStyle(elem).visibility !== 'hidden';
}

/**
 * Dismiss any open dialogs (like TradingView's "ค้นหาสัญลักษณ์" Symbol Search / "เปลี่ยนช่วง" Change Interval)
 * and click the chart canvas area to remove focus box before taking screenshots.
 */
async function dismissOpenDialogs() {
  // 1. Send Escape key event to close active modal
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  await delay(120);

  // 2. Click close button on dialogs (Symbol Search / Change Interval)
  const closeSelectors = [
    '[data-name="close"]',
    'button[aria-label="Close"]',
    'button[aria-label="ปิด"]',
    '[class*="closeButton-"]',
    '[class*="close-"]',
    '[data-role="button"][class*="close"]',
    'div[role="dialog"] button[class*="close"]'
  ];

  closeSelectors.forEach(sel => {
    const btns = document.querySelectorAll(sel);
    btns.forEach(btn => {
      if (isVisible(btn)) {
        try { btn.click(); } catch(e){}
      }
    });
  });

  // 3. Blur any active input field
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }

  // 4. Click neutral chart canvas area to clear focus and dismiss popups
  const chartCanvas = document.querySelector('.chart-container canvas') ||
                       document.querySelector('.layout__area--center canvas') ||
                       document.querySelector('.chart-container') ||
                       document.body;

  if (chartCanvas) {
    chartCanvas.click();
  }

  await delay(200);
}

/**
 * Detect market open / closed status from TradingView UI
 */
function checkMarketStatus() {
  // Strategy 1: Check known market status elements & badges
  const selectors = [
    '[data-name="market-status"]',
    '[class*="marketStatus"]',
    '[class*="market-status"]',
    '[class*="statusBadge"]',
    '[class*="symbolStatus"]',
    '[class*="marketState"]',
    '[class*="statusPill"]'
  ];

  for (const sel of selectors) {
    const elems = document.querySelectorAll(sel);
    for (const elem of elems) {
      if (!isVisible(elem)) continue;
      const text = elem.textContent.trim().toLowerCase();
      if (!text) continue;

      if (text.includes('ปิด') || text.includes('closed') || text.includes('post-market') || text.includes('pre-market')) {
        return { isMarketOpen: false, statusText: elem.textContent.trim() };
      }
      if (text.includes('เปิด') || text.includes('open')) {
        return { isMarketOpen: true, statusText: elem.textContent.trim() };
      }
    }
  }

  // Strategy 2: Look for elements with text matching 'เปิด' or 'ปิด'
  const textElems = Array.from(document.querySelectorAll('span, div, button'));
  for (const elem of textElems) {
    if (!isVisible(elem) || elem.children.length > 2) continue;
    const text = elem.textContent.trim().toLowerCase();

    if (text.startsWith('ปิด') || text === 'market closed' || text.includes('ตลาดปิด')) {
      return { isMarketOpen: false, statusText: elem.textContent.trim() };
    }
    if (text.startsWith('เปิด') || text === 'market open' || text.includes('ตลาดเปิด')) {
      return { isMarketOpen: true, statusText: elem.textContent.trim() };
    }
  }

  // Strategy 3: Check status dot color (green = open, red/grey = closed)
  const dots = document.querySelectorAll('[class*="statusDot"], [class*="statusIcon"], [class*="dot-"]');
  for (const dot of dots) {
    if (!isVisible(dot)) continue;
    const style = window.getComputedStyle(dot);
    const bg = style.backgroundColor;

    if (bg.includes('8, 153, 129') || bg.includes('0, 200') || bg.includes('38, 166, 154') || bg.includes('0, 212')) {
      return { isMarketOpen: true, statusText: 'เปิด (Green Dot)' };
    }
    if (bg.includes('242, 54, 69') || bg.includes('255, 82, 82') || bg.includes('120, 123, 134')) {
      return { isMarketOpen: false, statusText: 'ปิด (Red/Grey Dot)' };
    }
  }

  // Fallback: If no closed signal is found (e.g. 24/7 Crypto markets), treat as OPEN
  return { isMarketOpen: true, statusText: 'เปิด (24/7 / Default)' };
}

console.log('[tv2dis] Content script loaded on TradingView');

