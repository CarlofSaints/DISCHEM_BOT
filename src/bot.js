require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPORT_URL =
  'https://bi.dischem.co.za/QvAJAXZfc/opendoc.htm' +
  '?document=sales%20analysis%20-%20daily%20detail.qvw' +
  '&lang=en-US&host=QVS%40qv-webserver';

const BOOKMARK_NAME = 'VITAL BOT';

async function runExport(client) {
  const { name, username, password, downloadDir } = client;

  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
  console.log(`\n[${name}] Starting export — ${new Date().toLocaleString()}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    httpCredentials: { username, password },
    viewport: null,
  });

  const page = await context.newPage();

  try {
    // ── STEP 1: Navigate ──────────────────────────────────────────────────────
    console.log(`[${name}] Navigating...`);
    try {
      await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (navErr) {
      const msg = navErr.message ?? '';
      if (
        msg.includes('ECONNREFUSED') ||
        msg.includes('ERR_NAME_NOT_RESOLVED') ||
        msg.includes('ERR_CONNECTION_REFUSED') ||
        msg.includes('ERR_INTERNET_DISCONNECTED') ||
        msg.includes('net::ERR_') ||
        msg.includes('NS_ERROR_NET')
      ) {
        throw new Error(`SITE_DOWN: ${msg}`);
      }
      throw navErr;
    }
    await page.waitForTimeout(3_000);

    // ── STEP 2: Login modal ───────────────────────────────────────────────────
    console.log(`[${name}] Checking for login modal...`);
    for (const frame of page.frames()) {
      try {
        await frame.waitForSelector('text=Userid', { timeout: 5_000 });
        console.log(`[${name}] Login modal found — filling credentials...`);
        await frame.locator('input[type="text"]:visible').first().click({ clickCount: 3 });
        await frame.locator('input[type="text"]:visible').first().fill(username);
        await frame.locator('input[type="password"]:visible').fill(password);
        await frame.locator('button:has-text("OK"), input[value="OK"]').click();
        console.log(`[${name}] Credentials submitted.`);
        break;
      } catch {}
    }

    // ── STEP 3: Wait for app ──────────────────────────────────────────────────
    console.log(`[${name}] Waiting for app to load...`);
    await page.waitForSelector('text=General Info', { timeout: 90_000 });
    await page.waitForTimeout(3_000);

    // ── STEP 4: Set up download listeners BEFORE triggering export ────────────
    const EXPORT_TIMEOUT = 900_000; // 15 min

    const popupPromise = context.waitForEvent('page', { timeout: EXPORT_TIMEOUT })
      .then(popup => ({ via: 'popup', popup }))
      .catch(() => null);

    const directDownloadPromise = page.waitForEvent('download', { timeout: EXPORT_TIMEOUT })
      .then(dl => ({ via: 'direct', dl }))
      .catch(() => null);

    // ── STEP 5: Open the bookmark ─────────────────────────────────────────────
    // The bookmark selector in QlikView is a TEXT INPUT in the toolbar (not a button).
    // You type the bookmark name and press Enter / select from dropdown.
    console.log(`[${name}] Opening bookmark "${BOOKMARK_NAME}" via toolbar input...`);
    let bookmarkApplied = false;

    // Strategy 1: known selectors for the bookmark input
    const bookmarkInputSelectors = [
      'input[placeholder="Select Bookmark"]',  // confirmed from diagnostic
      'input[placeholder*="Bookmark"]',
      'input[title*="Bookmark"]',
      'input[title*="bookmark"]',
      'select[title*="Bookmark"]',
      'input[id*="ookmark"]',
      'select[id*="ookmark"]',
      'input[name*="ookmark"]',
    ];
    for (const sel of bookmarkInputSelectors) {
      try {
        const el = page.locator(sel).first();
        await el.waitFor({ timeout: 2_000, state: 'visible' });
        // Click to focus, triple-click to clear, then type char-by-char to trigger autocomplete
        await el.click({ clickCount: 3 });
        await page.waitForTimeout(300);
        await el.pressSequentially(BOOKMARK_NAME, { delay: 80 });
        console.log(`[${name}] Bookmark input found (${sel}), typed "${BOOKMARK_NAME}" — waiting for dropdown...`);
        await page.waitForTimeout(1_500);

        // Keyboard-navigate the dropdown: ArrowDown highlights first item, Enter selects it
        await el.press('ArrowDown');
        await page.waitForTimeout(300);
        await el.press('Enter');
        console.log(`[${name}] ArrowDown + Enter sent to select bookmark.`);
        bookmarkApplied = true;
        break;
      } catch {}
    }

    // Strategy 2: find all visible text inputs in the toolbar area (y < 120px from top)
    if (!bookmarkApplied) {
      try {
        const inputs = await page.locator('input:visible').all();
        for (const input of inputs) {
          const box = await input.boundingBox();
          if (box && box.y < 120) {
            try {
              await input.click({ clickCount: 3 });
              await input.fill(BOOKMARK_NAME);
              await input.press('Enter');
              console.log(`[${name}] Bookmark input found by position (y=${Math.round(box.y)}), typed "${BOOKMARK_NAME}" + Enter.`);
              bookmarkApplied = true;
              break;
            } catch {}
          }
        }
      } catch {}
    }

    // Strategy 3: try <select> elements near the top of the page
    if (!bookmarkApplied) {
      try {
        const selects = await page.locator('select:visible').all();
        for (const sel of selects) {
          const box = await sel.boundingBox();
          if (box && box.y < 120) {
            try {
              await sel.selectOption({ label: BOOKMARK_NAME });
              console.log(`[${name}] Bookmark select found by position (y=${Math.round(box.y)}), selected "${BOOKMARK_NAME}".`);
              bookmarkApplied = true;
              break;
            } catch {}
          }
        }
      } catch {}
    }

    if (!bookmarkApplied) {
      // Diagnostic: dump all inputs + selects so we can identify the bookmark field
      const diag = await page.evaluate(() => {
        return [...document.querySelectorAll('input, select')].map(el => ({
          tag: el.tagName,
          type: el.getAttribute('type'),
          id: el.id || null,
          name: el.getAttribute('name') || null,
          title: el.getAttribute('title') || null,
          value: (el.value || '').slice(0, 50) || null,
          placeholder: el.getAttribute('placeholder') || null,
          pos: (() => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
          })(),
        }));
      });
      console.log(`[${name}] DIAGNOSTIC — all inputs/selects:`, JSON.stringify(diag, null, 2));
      throw new Error(`Could not find bookmark input field — see DIAGNOSTIC above`);
    }

    console.log(`[${name}] Waiting for report to load from bookmark...`);
    await page.waitForTimeout(12_000);

    // ── STEP 6: Click "Send to Excel" ────────────────────────────────────────
    // After bookmark applies, the report grid appears with a toolbar.
    // The Excel export button has title="Send to Excel".
    console.log(`[${name}] Looking for "Send to Excel" button...`);
    const excelSelectors = [
      '[title="Send to Excel"]',
      '[title*="Excel"]',
      '[alt*="Excel"]',
    ];
    let excelFound = false;
    for (const frame of page.frames()) {
      for (const sel of excelSelectors) {
        try {
          const loc = frame.locator(sel).first();
          await loc.waitFor({ timeout: 5_000, state: 'visible' });
          await loc.click();
          console.log(`[${name}] "Send to Excel" clicked (selector: ${sel}).`);
          excelFound = true;
          break;
        } catch {}
      }
      if (excelFound) break;
    }

    if (!excelFound) {
      // Diagnostic for the export button
      const diag = await page.evaluate(() => {
        return [...document.querySelectorAll('[title]')]
          .map(el => el.getAttribute('title'))
          .filter(t => t && t.length > 0);
      });
      console.log(`[${name}] DIAGNOSTIC — all [title] attrs after bookmark:`, JSON.stringify(diag, null, 2));
      throw new Error('Could not find "Send to Excel" button — see DIAGNOSTIC above');
    }

    // ── STEP 7: Wait for export to complete ──────────────────────────────────
    console.log(`[${name}] Export triggered. Waiting for file (large datasets take several minutes)...`);
    const exportResult = await Promise.race([popupPromise, directDownloadPromise]);
    if (!exportResult) throw new Error('Export timed out — no popup or download detected');
    console.log(`[${name}] Export delivered via: ${exportResult.via}`);

    // ── STEP 8: Save file ─────────────────────────────────────────────────────
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `${name}_StoreTotalSalesDailyByArticle_${dateStr}.xlsx`;
    const savePath = path.join(downloadDir, filename);

    let download;
    if (exportResult.via === 'popup') {
      console.log(`[${name}] Popup URL: ${exportResult.popup.url()}`);
      download = await exportResult.popup.waitForEvent('download', { timeout: 300_000 });
      try { exportResult.popup.close(); } catch {}
    } else {
      download = exportResult.dl;
    }

    console.log(`[${name}] Saving to: ${savePath}`);
    await download.saveAs(savePath);

    let fileSizeKb = null;
    if (fs.existsSync(savePath)) {
      const bytes = fs.statSync(savePath).size;
      fileSizeKb = bytes / 1024;
      console.log(`[${name}] ✓ Saved: ${savePath} (${fileSizeKb.toFixed(1)} KB)`);
    } else {
      console.warn(`[${name}] WARNING: file not found after saveAs`);
    }

    return { filePath: savePath, fileSizeKb };

  } catch (err) {
    console.error(`[${name}] ERROR:`, err.message);
    const ssPath = path.join(downloadDir, `error_${Date.now()}.png`);
    try {
      await page.screenshot({ path: ssPath, fullPage: true });
      console.error(`[${name}] Screenshot saved: ${ssPath}`);
    } catch {}
    console.error(`[${name}] Browser stays open for 60 s — check what's on screen...`);
    await page.waitForTimeout(60_000);
    throw err;
  } finally {
    await browser.close();
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const clients = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'clients.json'), 'utf-8')
  );
  const targetId = process.argv[2];
  const client = targetId ? clients.find(c => c.id === targetId) : clients[0];
  if (!client) { console.error(`Client "${targetId}" not found`); process.exit(1); }
  runExport(client).catch(err => { console.error('Failed:', err.message); process.exit(1); });
}

module.exports = { runExport };
