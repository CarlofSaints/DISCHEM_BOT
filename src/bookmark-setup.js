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

  // ── Step 1: Access Point — clears any stale QlikView session ─────────────────
  // Going straight to opendoc.htm reuses QlikView's server-side session for this
  // Windows identity (Carl).  Hitting the Access Point first lets QlikView's own
  // login flow start fresh, and may show a logout option we can click.
  const ACCESS_POINT = 'https://bi.dischem.co.za/QvAJAXZfc/';
  console.log('Navigating to QlikView Access Point...');
  await page.goto(ACCESS_POINT, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2_000);

  // Save a screenshot so we can see what the Access Point looks like
  const screenshotPath = path.join(__dirname, '..', 'debug-access-point.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Access Point URL:   ${page.url()}`);
  console.log(`Access Point title: ${await page.title()}`);
  console.log(`Screenshot saved → ${screenshotPath}\n`);

  // Try common QlikView logout patterns
  let loggedOut = false;
  const logoutSelectors = [
    'a:has-text("Logout")',
    'a:has-text("Log Out")',
    'a:has-text("Log off")',
    'a:has-text("Sign out")',
    'button:has-text("Logout")',
    '[id*="logout" i]',
    '[class*="logout" i]',
    '[href*="logout" i]',
  ];
  for (const sel of logoutSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 })) {
        console.log(`Found logout element (${sel}) — clicking...`);
        await el.click();
        await page.waitForTimeout(2_000);
        loggedOut = true;
        break;
      }
    } catch {}
  }
  if (!loggedOut) {
    console.log('No logout button found on Access Point — continuing to report.\n');
  }

  // ── Step 2: Navigate to the report ───────────────────────────────────────────
  console.log('Navigating to report...');
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3_000);

  // Log where we landed — helps diagnose auth differences between clients
  console.log(`Page URL:   ${page.url()}`);
  console.log(`Page title: ${await page.title()}\n`);

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
