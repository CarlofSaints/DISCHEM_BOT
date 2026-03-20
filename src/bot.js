const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPORT_URL =
  'https://bi.dischem.co.za/QvAJAXZfc/opendoc.htm' +
  '?document=sales%20analysis%20-%20daily%20detail.qvw' +
  '&lang=en-US&host=QVS%40qv-webserver';

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

  // Track QV session state from response bodies
  const qvState = { mark: '', stamp: '' };
  page.on('response', async (res) => {
    if (!res.url().includes('QvsViewClient')) return;
    try {
      const text = await res.text();
      const m = text.match(/\bmark="([0-9a-f]{16})"/);
      if (m?.[1]) qvState.mark = m[1];
      const s = text.match(/\bstamp="([0-9a-f]{16})"/);
      if (s?.[1]) qvState.stamp = s[1];
    } catch {}
  });

  try {
    // ── STEP 1: Navigate ───────────────────────────────────────────────────────
    console.log(`[${name}] Navigating...`);
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3_000);

    // ── STEP 2: QlikView internal Userid/Password modal ────────────────────────
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

    // ── STEP 3: Wait for app ───────────────────────────────────────────────────
    console.log(`[${name}] Waiting for app to load...`);
    await page.waitForSelector('text=General Info', { timeout: 90_000 });
    await page.waitForTimeout(3_000);

    // ── STEP 4: Sales tab ──────────────────────────────────────────────────────
    console.log(`[${name}] Clicking Sales tab...`);
    await page.locator('text=Sales').first().click();
    console.log(`[${name}] Waiting 15s for Sales panel to render...`);
    await page.waitForTimeout(15_000);

    if (!qvState.mark) throw new Error('No QlikView session mark captured');
    console.log(`[${name}] QV session → mark: ${qvState.mark}  stamp: ${qvState.stamp}`);

    // ── STEP 5: Listen for the download popup BEFORE triggering the export ─────
    // When export completes, QlikView's JS receives <open url="$/file.xlsx"/>
    // and calls window.open() — Playwright catches that as a new context page.
    const popupPromise = context.waitForEvent('page', { timeout: 120_000 });

    // Handle the "opened in another window" dialog (fire-and-forget)
    page.locator('text=opened in another window').waitFor({ timeout: 90_000 })
      .then(() => page.locator('button:has-text("OK")').click().catch(() => {}))
      .catch(() => {});

    // ── STEP 6: Inject commands via QlikView's OWN poll requests ───────────────
    // CSRF fix: we do NOT generate our own xrfkey. Instead we intercept QV's polls,
    // replace only the request body with our commands, and keep the URL unchanged.
    // QV's own xrfkey (URL param) still matches QV's own cookie → CSRF check passes.
    console.log(`[${name}] Setting up command injection...`);

    const cmdState = { phase: 'idle', reTime: null };

    await page.route('**/QvsViewClient.aspx**', async (route) => {
      const reqBody = route.request().postData() || '';

      // Use the stamp from the intercepted request (QV's last known stamp)
      const stampM = reqBody.match(/\bstamp="([0-9a-f]{16})"/);
      const curStamp = stampM?.[1] || qvState.stamp;

      const mkUpdate = (inner) =>
        `<update mark="${qvState.mark}" stamp="${curStamp}" cookie="true" scope="Document"` +
        ` view="sales analysis - daily detail.qvw" ident="null"` +
        ` userid="${username}" password="${password}">${inner}</update>`;

      if (cmdState.phase === 'idle') {
        // ── Injection 1: Document.9.RE — activate report object 9 ──────────────
        cmdState.phase = 'injected-re';
        cmdState.reTime = Date.now();
        console.log(`[${name}] → Injecting Document.9.RE (activate "Store Total Sales Daily by Article")...`);
        try {
          const resp = await route.fetch({ postData: mkUpdate('<set name="Document.9.RE" action="" />') });
          const text = await resp.text();
          const newStamp = text.match(/\bstamp="([0-9a-f]{16})"/)?.[1];
          if (newStamp) qvState.stamp = newStamp;
          console.log(`[${name}]   RE response (stamp ${newStamp}): ${text.slice(0, 300)}`);
          await route.fulfill({ status: resp.status(), contentType: 'text/xml; charset=UTF-8', body: text });
        } catch (e) {
          console.warn(`[${name}]   RE injection failed (${e.message}), continuing...`);
          await route.continue();
        }

      } else if (cmdState.phase === 'injected-re') {
        const elapsed = Date.now() - cmdState.reTime;
        if (elapsed >= 3000) {
          // ── Injection 2: Document.9.XL — trigger Excel export ────────────────
          cmdState.phase = 'injected-xl';
          console.log(`[${name}] → Injecting Document.9.XL (trigger Excel export, ${elapsed}ms after RE)...`);
          try {
            const resp = await route.fetch({
              postData: mkUpdate('<set name="Document.9.XL" action="" clientsizeWH="1905:945" />'),
            });
            const text = await resp.text();
            console.log(`[${name}]   XL response: ${text.slice(0, 300)}`);
            await route.fulfill({ status: resp.status(), contentType: 'text/xml; charset=UTF-8', body: text });
            console.log(`[${name}] Export triggered. QlikView will poll until ready (~30–60 s)...`);
          } catch (e) {
            console.warn(`[${name}]   XL injection failed (${e.message}), continuing...`);
            await route.continue();
          }

        } else {
          // Still within 3s of RE — pass through normally
          await route.continue();
        }

      } else {
        // After XL injected: pass all requests through.
        // QV's JS polls, gets <open url="$/file.xlsx"/>, calls window.open().
        await route.continue();
      }
    });

    // ── STEP 7: Wait for the export popup ─────────────────────────────────────
    const popup = await popupPromise;
    console.log(`[${name}] Popup opened: ${popup.url()}`);

    // ── STEP 8: Save the downloaded file ──────────────────────────────────────
    const download = await popup.waitForEvent('download', { timeout: 60_000 });
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `${name}_StoreTotalSalesDailyByArticle_${dateStr}.xlsx`;
    const savePath = path.join(downloadDir, filename);
    await download.saveAs(savePath);
    console.log(`[${name}] ✓ Saved: ${savePath}`);
    try { await popup.close(); } catch {}

  } catch (err) {
    console.error(`[${name}] ERROR:`, err.message);
    const ssPath = path.join(downloadDir, `error_${Date.now()}.png`);
    try {
      await page.screenshot({ path: ssPath, fullPage: true });
      console.error(`[${name}] Screenshot saved: ${ssPath}`);
    } catch {}
    console.error(`[${name}] Browser stays open for 30 s — check what's on screen...`);
    await page.waitForTimeout(30_000);
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
