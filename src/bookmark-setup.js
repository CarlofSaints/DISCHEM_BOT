/**
 * Bookmark Setup Helper
 * Launches a browser logged in as the specified client so you can
 * manually create/verify the bookmark, then close the window when done.
 *
 * Usage:  node src/bookmark-setup.js <clientId>
 * Example: node src/bookmark-setup.js avid-001
 *
 * Client IDs are shown when the scheduler starts ("Config fetched from API: ...").
 * Alternatively, run without an argument to use the first client in the list.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPORT_URL =
  'https://bi.dischem.co.za/QvAJAXZfc/opendoc.htm' +
  '?document=sales%20analysis%20-%20daily%20detail.qvw' +
  '&lang=en-US&host=QVS%40qv-webserver';

async function main() {
  // ── Load client ──────────────────────────────────────────────────────────────
  let clients = [];

  // Try fetching from the web app first
  const apiUrl = (process.env.DCHEM_API_URL ?? '').replace(/\/$/, '');
  if (apiUrl) {
    try {
      const r = await fetch(`${apiUrl}/api/config`);
      clients = await r.json();
    } catch {}
  }
  // Fallback to local clients.json
  if (!clients.length) {
    const localPath = path.join(__dirname, '..', 'clients.json');
    if (fs.existsSync(localPath)) {
      clients = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    }
  }

  if (!clients.length) {
    console.error('No clients found. Add a client via the web app first.');
    process.exit(1);
  }

  const targetId = process.argv[2];
  const client = targetId
    ? clients.find((c) => c.id === targetId || c.name.toLowerCase() === targetId.toLowerCase())
    : clients[0];

  if (!client) {
    console.error(`Client "${targetId}" not found.`);
    console.log('Available clients:');
    clients.forEach((c) => console.log(`  ${c.id}  —  ${c.name}`));
    process.exit(1);
  }

  const { name, username, password } = client;
  const bookmarkName = client.bookmarkName || name.toUpperCase() + ' BOT';

  console.log('\n' + '='.repeat(60));
  console.log(`  Bookmark Setup — ${name}`);
  console.log('='.repeat(60));
  console.log(`  Username:      ${username}`);
  console.log(`  Bookmark name: ${bookmarkName}`);
  console.log('='.repeat(60));
  console.log('\nOpening browser — logging in as this client...\n');

  // ── Override Windows credentials for bi.dischem.co.za ────────────────────────
  // The Dis-Chem BI server uses Windows NTLM authentication, which Chromium
  // handles at the OS level using whoever is currently logged into Windows.
  // cmdkey lets us store per-server credentials so Windows uses the CLIENT'S
  // account for this hostname instead of your own Windows session.
  const HOST = 'bi.dischem.co.za';
  try {
    execSync(`cmdkey /delete:${HOST}`, { stdio: 'ignore' });
  } catch { /* nothing stored yet — that's fine */ }
  try {
    execSync(`cmdkey /add:${HOST} /user:${username} /pass:${password}`);
    console.log(`Windows credentials set for ${HOST} → ${username}`);
  } catch (e) {
    console.warn(`cmdkey failed (non-fatal): ${e.message}`);
  }

  // ── Launch browser ───────────────────────────────────────────────────────────
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

  // ── Step 1: Navigate to report, then clear cookies to bust the ghost session ──
  // QlikView maintains a server-side session cookie tied to the Windows identity.
  // If a previous client run left a session alive (Avid, etc.), opendoc.htm will
  // reuse that session and show a blank page with no login form.
  // Fix: navigate once (NTLM auth passes), note what cookies QlikView set, clear
  // them all, then reload — QlikView sees no session cookie and presents a fresh
  // login form.
  console.log('First pass — establishing NTLM auth and capturing session cookies...');
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3_000);

  const screenshotPath = path.join(__dirname, '..', 'debug-before-clear.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`URL after first pass:   ${page.url()}`);
  console.log(`Title after first pass: ${await page.title()}`);
  console.log(`Screenshot saved → ${screenshotPath}`);

  const cookies = await context.cookies();
  console.log(`Session cookies found: ${cookies.map((c) => c.name).join(', ') || 'none'}`);

  // Clear cookies + localStorage + sessionStorage
  console.log('Clearing cookies and browser storage...');
  await context.clearCookies();
  await page.evaluate(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });
  console.log('Storage cleared. Reloading...\n');
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);

  console.log(`Page URL:   ${page.url()}`);
  console.log(`Page title: ${await page.title()}\n`);

  // ── If we're still on the blank QlikView page, click "Close" ─────────────────
  // The "Close" link in the blank document view navigates to QlikView's session
  // management page.  Intercepting that navigation tells us the real logout URL.
  const closeLink = page.locator('text=Close').first();
  const isBlank = await closeLink.isVisible({ timeout: 3_000 }).catch(() => false);

  if (isBlank) {
    console.log('Still on blank QlikView page — clicking "Close" (SPA action, not navigation)...');
    await closeLink.click();

    // Close fires an AJAX call and mutates the DOM in-place — no page navigation.
    // Wait for QlikView to re-render whatever it shows next (login form, doc list, etc.)
    await page.waitForTimeout(5_000);

    const afterClosePath = path.join(__dirname, '..', 'debug-after-close.png');
    await page.screenshot({ path: afterClosePath, fullPage: true });
    console.log(`After Close — screenshot: ${afterClosePath}`);
    console.log(`After Close — URL:        ${page.url()}`);
    console.log(`After Close — Title:      ${await page.title()}\n`);

    // Dump visible text so we can see what QlikView rendered
    const bodyText = await page.evaluate(() =>
      document.body.innerText.trim().slice(0, 500)
    );
    console.log('Page text after Close (first 500 chars):');
    console.log(bodyText || '(empty)');
    console.log('');
  }

  // Handle QlikView login modal if it appears
  let loggedIn = false;
  for (const frame of page.frames()) {
    try {
      await frame.waitForSelector('text=Userid', { timeout: 8_000 });
      console.log('Login modal found — filling credentials...');
      await frame.locator('input[type="text"]:visible').first().click({ clickCount: 3 });
      await frame.locator('input[type="text"]:visible').first().fill(username);
      await frame.locator('input[type="password"]:visible').fill(password);
      await frame.locator('button:has-text("OK"), input[value="OK"]').click();
      console.log('Credentials submitted.\n');
      loggedIn = true;
      break;
    } catch {}
  }
  if (!loggedIn) {
    console.log('No login modal detected — assuming Windows auth handled it.\n');
  }

  console.log('='.repeat(60));
  console.log('  BROWSER IS OPEN — do the following:');
  console.log('');
  console.log(`  1. Wait for QlikView to fully load`);
  console.log(`  2. Navigate to the correct report/sheet`);
  console.log(`  3. Set your filters as needed`);
  console.log(`  4. Save a bookmark named exactly:`);
  console.log(`     --> ${bookmarkName} <--`);
  console.log(`  5. Verify the bookmark works`);
  console.log(`  6. Close this browser window when done`);
  console.log('='.repeat(60) + '\n');

  // Keep process alive until browser is closed
  await new Promise((resolve) => {
    browser.on('disconnected', resolve);
  });

  // Clean up — remove stored credentials so they don't persist on this machine
  try { execSync(`cmdkey /delete:${HOST}`, { stdio: 'ignore' }); } catch {}
  console.log(`Windows credentials cleared for ${HOST}.`);
  console.log('\nBrowser closed. Bookmark setup complete.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
