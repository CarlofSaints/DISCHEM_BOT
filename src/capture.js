/**
 * Network capture script — run this, manually do the export in the browser,
 * and all QlikView AJAX requests/responses will be saved to capture-log.json
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPORT_URL =
  'https://bi.dischem.co.za/QvAJAXZfc/opendoc.htm' +
  '?document=sales%20analysis%20-%20daily%20detail.qvw' +
  '&lang=en-US&host=QVS%40qv-webserver';

const clients = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'clients.json'), 'utf-8')
);
const client = clients[0];
const { username, password } = client;

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    httpCredentials: { username, password },
    viewport: null,
  });

  const page = await context.newPage();
  const captured = [];

  // Intercept ALL requests from this domain
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('dischem.co.za')) return;
    captured.push({
      type: 'request',
      method: req.method(),
      url,
      postData: req.postData() || null,
      time: new Date().toISOString(),
    });
    console.log(`→ ${req.method()} ${url.slice(0, 120)}`);
    if (req.postData()) console.log(`  BODY: ${req.postData().slice(0, 200)}`);
  });

  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('dischem.co.za')) return;
    let body = '';
    try { body = await res.text(); } catch {}
    captured.push({
      type: 'response',
      status: res.status(),
      url,
      body: body.slice(0, 500),
      time: new Date().toISOString(),
    });
    // Highlight anything that looks like a report or export
    if (
      url.toLowerCase().includes('report') ||
      url.toLowerCase().includes('excel') ||
      url.toLowerCase().includes('export') ||
      url.toLowerCase().includes('print') ||
      body.toLowerCase().includes('store total')
    ) {
      console.log(`*** INTERESTING RESPONSE: ${url}`);
      console.log(`    Body: ${body.slice(0, 300)}`);
    }
  });

  console.log('\nNavigating and logging in...\n');
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3_000);

  // Handle QlikView modal
  for (const frame of page.frames()) {
    try {
      await frame.waitForSelector('text=Userid', { timeout: 5_000 });
      await frame.locator('input[type="text"]:visible').first().fill(username);
      await frame.locator('input[type="password"]:visible').fill(password);
      await frame.locator('button:has-text("OK"), input[value="OK"]').click();
      console.log('Logged in.\n');
      break;
    } catch {}
  }

  // Auto-navigate to Sales tab
  await page.waitForSelector('text=General Info', { timeout: 90_000 });
  await page.waitForTimeout(2_000);
  console.log('Clicking Sales tab...');
  await page.locator('text=Sales').first().click();
  console.log('Sales tab clicked — report list is loading.\n');

  console.log('='.repeat(60));
  console.log('BROWSER IS OPEN. Do the following manually:');
  console.log('  1. Wait for the report list to appear on the right');
  console.log('  2. Double-click "Store Total Sales Daily by Article"');
  console.log('  3. Click "Send to Excel" (or however you export it)');
  console.log('  4. Wait for the download to start');
  console.log('  All network requests are being captured.');
  console.log('  You have 120 seconds.');
  console.log('='.repeat(60) + '\n');

  await page.waitForTimeout(120_000);

  // Save capture log
  const logPath = path.join(__dirname, '..', 'capture-log.json');
  fs.writeFileSync(logPath, JSON.stringify(captured, null, 2));
  console.log(`\nCapture saved to: ${logPath}`);
  console.log(`Total requests captured: ${captured.length}`);

  await browser.close();
})();
