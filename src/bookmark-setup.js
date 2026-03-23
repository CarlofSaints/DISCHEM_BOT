/**
 * Bookmark Setup Helper
 * Launches a browser logged in as the specified client so you can
 * manually create/verify the bookmark, then close the window when done.
 *
 * Each client gets its own browser profile — sessions never bleed between clients.
 *
 * Usage:  node src/bookmark-setup.js <clientId>
 * Example: node src/bookmark-setup.js philips-ph
 *
 * Run without an argument to use the first client in the list.
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPORT_URL =
  'https://bi.dischem.co.za/QvAJAXZfc/opendoc.htm' +
  '?document=sales%20analysis%20-%20daily%20detail.qvw' +
  '&lang=en-US&host=QVS%40qv-webserver';

async function main() {
  // ── Load client ──────────────────────────────────────────────────────────────
  let clients = [];

  const apiUrl = (process.env.DCHEM_API_URL ?? '').replace(/\/$/, '');
  if (apiUrl) {
    try {
      const r = await fetch(`${apiUrl}/api/config`);
      clients = await r.json();
    } catch {}
  }
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

  // ── Per-client browser profile ────────────────────────────────────────────────
  // Each client gets its own Chromium profile directory so their QlikView session
  // cookies are completely isolated.  First run = login form.  Later runs = session
  // resumes automatically.
  const profileDir = path.join(__dirname, '..', 'profiles', client.id);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('\n' + '='.repeat(60));
  console.log(`  Bookmark Setup — ${name}`);
  console.log('='.repeat(60));
  console.log(`  Username:      ${username}`);
  console.log(`  Bookmark name: ${bookmarkName}`);
  console.log(`  Profile:       profiles/${client.id}`);
  console.log('='.repeat(60));
  console.log('\nOpening browser...\n');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    slowMo: 100,
    acceptDownloads: true,
    httpCredentials: { username, password },
    viewport: null,
    args: ['--start-maximized'],
  });

  const page = await context.newPage();

  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3_000);

  // Handle QlikView login form on first-time setup for this client
  let loggedIn = false;
  for (const frame of page.frames()) {
    try {
      await frame.waitForSelector('text=Userid', { timeout: 8_000 });
      console.log('Login form detected — filling credentials...');
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
    console.log('Resuming existing session for this client.\n');
  }

  console.log('='.repeat(60));
  console.log('  BROWSER IS OPEN — do the following:');
  console.log('');
  console.log('  1. Wait for QlikView to fully load');
  console.log('  2. Navigate to the correct report/sheet');
  console.log('  3. Set your filters as needed');
  console.log('  4. Save a bookmark named exactly:');
  console.log(`     --> ${bookmarkName} <--`);
  console.log('  5. Verify the bookmark works');
  console.log('  6. Close this browser window when done');
  console.log('='.repeat(60) + '\n');

  await new Promise((resolve) => {
    context.on('close', resolve);
  });

  console.log('\nBrowser closed. Bookmark setup complete.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
