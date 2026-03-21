// Manual run script — processes pending triggers from the web app immediately.
// Usage:
//   npm run run-now                  → process all pending triggers from the API
//   npm run run-now -- vital         → run a specific client by id (bypasses triggers)
//   npm run run-now -- --all         → run ALL configured clients right now
//
// Falls back to clients.json if DCHEM_API_URL is not set.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { runExport } = require('./bot');
const { sendSiteDownEmail, sendFileSizeAlert } = require('./email');

const API_URL = (process.env.DCHEM_API_URL ?? '').replace(/\/$/, '');
const xlsx = require('xlsx');

// ── API helpers ────────────────────────────────────────────────────────────────
async function fetchConfig() {
  const r = await fetch(`${API_URL}/api/config`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  return r.json();
}

async function fetchTriggers() {
  const r = await fetch(`${API_URL}/api/triggers`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return [];
  return r.json();
}

async function deleteTrigger(clientId) {
  await fetch(`${API_URL}/api/triggers/${clientId}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

async function postLog(log) {
  await fetch(`${API_URL}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(log),
    signal: AbortSignal.timeout(10_000),
  });
}

// ── Date validation ────────────────────────────────────────────────────────────
function validateExcelDate(filePath) {
  try {
    const wb = xlsx.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'DD/MM/YYYY' });
    const dates = [];
    for (const row of rows) {
      const val = row[2];
      if (!val) continue;
      const str = String(val).trim();
      if (/total/i.test(str)) continue;
      const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) { dates.push(new Date(+m[3], +m[2] - 1, +m[1])); continue; }
      const d = new Date(str);
      if (!isNaN(d.getTime())) dates.push(d);
    }
    if (!dates.length) return { valid: false, latestDate: null, reason: 'No dates found in column C' };
    const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
    const latestStr = latest.toISOString().slice(0, 10);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    if (latest < yesterday) {
      return { valid: false, latestDate: latestStr, reason: `Data only up to ${latestStr} — expected yesterday (${yesterday.toISOString().slice(0, 10)})` };
    }
    return { valid: true, latestDate: latestStr, reason: null };
  } catch (err) {
    return { valid: false, latestDate: null, reason: `Could not read Excel: ${err.message}` };
  }
}

// ── Run a single client with full logging ──────────────────────────────────────
async function runClient(client, trigger = 'manual') {
  const startTime = Date.now();
  const log = {
    id: crypto.randomUUID(),
    clientId: client.id,
    clientName: client.name,
    timestamp: new Date().toISOString(),
    trigger,
    status: 'success',
    retryCount: 0,
    message: 'Export completed successfully',
  };

  try {
    const result = await runExport(client);
    log.filePath = result.filePath;
    log.fileSizeKb = result.fileSizeKb;

    // File size check
    if (client.expectedFileSizeKb > 0 && result.fileSizeKb) {
      const tol = (client.fileSizeTolerancePct ?? 20) / 100;
      const min = client.expectedFileSizeKb * (1 - tol);
      const max = client.expectedFileSizeKb * (1 + tol);
      if (result.fileSizeKb < min || result.fileSizeKb > max) {
        log.status = 'size_warning';
        log.message = `File size anomaly: expected ~${client.expectedFileSizeKb} KB, got ${result.fileSizeKb.toFixed(0)} KB`;
        console.warn(`[${client.name}] ⚠ ${log.message}`);
        await sendFileSizeAlert(client, result.fileSizeKb);
      }
    }

    // Date validation
    if (client.validation?.enabled && result.filePath) {
      const { valid, latestDate, reason } = validateExcelDate(result.filePath);
      log.latestDataDate = latestDate ?? undefined;
      if (!valid) {
        log.status = 'validation_fail';
        log.message = reason;
        console.warn(`[${client.name}] Data validation failed: ${reason}`);
      }
    }

  } catch (err) {
    if (err.message.startsWith('SITE_DOWN:')) {
      log.status = 'site_down';
      log.message = 'Dis-Chem BI site is unreachable';
      console.error(`[${client.name}] Site down — alert email suppressed until SEND_ALERTS=true`);
      await sendSiteDownEmail(client);
    } else {
      log.status = 'error';
      log.message = err.message;
      console.error(`[${client.name}] ERROR:`, err.message);
    }
  }

  log.durationMs = Date.now() - startTime;

  if (API_URL) {
    try {
      await postLog(log);
      console.log(`[${client.name}] Log posted → status: ${log.status}`);
    } catch {
      console.warn(`[${client.name}] Could not post log to API`);
    }
  }

  return log;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  console.log(`\nDis-Chem BI Bot — Manual Run (${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })})`);

  // Load clients — from API first, then local fallback
  let clients = [];
  if (API_URL) {
    try {
      clients = await fetchConfig();
      console.log(`Config fetched from API: ${clients.length} client(s)`);
    } catch (err) {
      console.warn(`API unreachable: ${err.message} — falling back to clients.json`);
    }
  }
  if (!clients.length) {
    const localPath = path.join(__dirname, '..', 'clients.json');
    if (fs.existsSync(localPath)) {
      clients = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
      console.log(`Local clients.json: ${clients.length} client(s)`);
    }
  }

  if (!clients.length) {
    console.error('No clients configured. Add clients via the web UI first.');
    process.exit(1);
  }

  // ── Mode 1: specific client by id ──────────────────────────────────────────
  if (arg && arg !== '--all') {
    const client = clients.find((c) => c.id === arg || c.name.toLowerCase() === arg.toLowerCase());
    if (!client) {
      console.error(`Client "${arg}" not found. Available: ${clients.map((c) => `${c.id} (${c.name})`).join(', ')}`);
      process.exit(1);
    }
    console.log(`Running client: ${client.name}\n`);
    await runClient(client, 'manual');
    return;
  }

  // ── Mode 2: --all flag ─────────────────────────────────────────────────────
  if (arg === '--all') {
    console.log(`Running ALL ${clients.length} client(s)...\n`);
    for (const client of clients) {
      await runClient(client, 'manual');
    }
    return;
  }

  // ── Mode 3: process pending triggers from the API (default) ───────────────
  if (API_URL) {
    const triggerIds = await fetchTriggers();
    if (!triggerIds.length) {
      console.log('No pending triggers in the queue.');
      console.log('Tip: click "Run Now" on a client in the web UI, then re-run this script.');
      console.log(`Or use: npm run run-now -- <clientId>  to run a specific client directly.`);
      return;
    }

    console.log(`Found ${triggerIds.length} pending trigger(s): ${triggerIds.join(', ')}\n`);
    for (const clientId of triggerIds) {
      const client = clients.find((c) => c.id === clientId);
      if (!client) {
        console.warn(`Trigger for unknown client id "${clientId}" — skipping`);
        continue;
      }
      // Acknowledge trigger first so it's not picked up again
      await deleteTrigger(clientId);
      console.log(`Processing trigger: ${client.name}`);
      await runClient(client, 'manual');
    }
    return;
  }

  // ── Fallback: no API, no arg → run first client ───────────────────────────
  console.log(`No DCHEM_API_URL set — running first client: ${clients[0].name}\n`);
  await runClient(clients[0], 'manual');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
