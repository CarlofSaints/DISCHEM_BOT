require('dotenv').config();
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { runExport } = require('./bot');
const { sendSiteDownEmail, sendFileSizeAlert } = require('./email');

const API_URL = (process.env.DCHEM_API_URL ?? '').replace(/\/$/, '');
const TRIGGER_POLL_MS = 30_000;

// ── Cron expression builder ────────────────────────────────────────────────────
function scheduleToCron(schedule) {
  const [hh, mm] = schedule.time.split(':').map(Number);
  switch (schedule.frequency) {
    case 'weekly': {
      const days = (schedule.days ?? [1, 2, 3, 4, 5]).join(',');
      return `${mm} ${hh} * * ${days}`;
    }
    case 'monthly':
      return `${mm} ${hh} ${schedule.dayOfMonth ?? 1} * *`;
    default: // daily
      return `${mm} ${hh} * * *`;
  }
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function fetchConfig() {
  const r = await fetch(`${API_URL}/api/config`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`);
  return r.json();
}

async function fetchTriggers() {
  const r = await fetch(`${API_URL}/api/triggers`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return [];
  return r.json();
}

async function deleteTrigger(clientId) {
  await fetch(`${API_URL}/api/triggers/${clientId}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
}

async function postLog(log) {
  await fetch(`${API_URL}/api/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(log),
    signal: AbortSignal.timeout(10_000),
  });
}

// ── Date validation helper ─────────────────────────────────────────────────────
function validateExcelDate(filePath) {
  try {
    const xlsx = require('xlsx');
    const wb = xlsx.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'DD/MM/YYYY' });

    const dates = [];
    for (const row of rows) {
      const val = row[2]; // column C
      if (!val) continue;
      const str = String(val).trim();
      if (/total/i.test(str)) continue;

      // DD/MM/YYYY
      const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) {
        dates.push(new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
        continue;
      }
      // ISO / other parseable date
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

// ── Run with full logging + retry logic ───────────────────────────────────────
async function runWithLogging(client, trigger) {
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

  const MAX_RETRIES = client.validation?.enabled ? (client.validation.maxRetries ?? 3) : 0;
  const RETRY_WAIT_MS = (client.validation?.retryWaitMinutes ?? 30) * 60_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[${client.name}] Retry ${attempt}/${MAX_RETRIES} — waiting ${client.validation.retryWaitMinutes} min...`);
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
      log.retryCount = attempt;
      log.status = 'retrying';
      if (API_URL) postLog({ ...log }).catch(() => {});
    }

    try {
      const result = await runExport(client);

      log.filePath = result.filePath;
      log.fileSizeKb = result.fileSizeKb;

      // ── File size check ────────────────────────────────────────────────────
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

      // ── Date validation ────────────────────────────────────────────────────
      if (client.validation?.enabled && result.filePath) {
        const { valid, latestDate, reason } = validateExcelDate(result.filePath);
        log.latestDataDate = latestDate ?? undefined;
        if (!valid) {
          console.warn(`[${client.name}] Validation fail: ${reason}`);
          if (attempt < MAX_RETRIES) {
            log.status = 'validation_fail';
            log.message = reason;
            continue; // retry
          }
          // Out of retries
          log.status = 'validation_fail';
          log.message = `${reason} — max retries (${MAX_RETRIES}) exhausted`;
        }
      }

      if (log.status === 'success' || log.status === 'size_warning') {
        log.durationMs = Date.now() - startTime;
        break; // done
      }
    } catch (err) {
      log.durationMs = Date.now() - startTime;

      if (err.message.startsWith('SITE_DOWN:')) {
        log.status = 'site_down';
        log.message = 'Dis-Chem BI site is unreachable';
        console.error(`[${client.name}] Site down.`);
        await sendSiteDownEmail(client);
        break; // don't retry site-down — just alert and stop
      }

      log.status = 'error';
      log.message = err.message;
      console.error(`[${client.name}] ERROR:`, err.message);
      if (attempt >= MAX_RETRIES) break;
    }
  }

  log.durationMs = log.durationMs ?? (Date.now() - startTime);

  // Post log to web app
  if (API_URL) {
    try {
      await postLog(log);
      console.log(`[${client.name}] Log posted (${log.status})`);
    } catch {
      console.warn(`[${client.name}] Could not post log to API`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nDis-Chem BI Manager — Scheduler starting (${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })})`);
  if (!API_URL) console.warn('DCHEM_API_URL not set — running in local-only mode (no logs or triggers)');

  // Fetch client config from API, fall back to local clients.json
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
    console.warn('No clients found. Add clients via the web UI, then restart the scheduler.');
  }

  // Build cron jobs (multiple schedules per client)
  let jobCount = 0;
  for (const client of clients) {
    const schedules = client.schedules?.length
      ? client.schedules
      : [{ id: 'default', label: 'Default', frequency: 'daily', time: '06:00' }];

    for (const schedule of schedules) {
      const expr = scheduleToCron(schedule);
      const label = schedule.label || schedule.frequency;
      console.log(`  Scheduled: [${client.name}] "${label}" → ${expr} (JHB time)`);
      cron.schedule(expr, () => {
        console.log(`\n[CRON] ${client.name} — ${label}`);
        runWithLogging(client, 'schedule');
      }, { timezone: 'Africa/Johannesburg' });
      jobCount++;
    }
  }
  console.log(`\n${jobCount} cron job(s) active.`);

  // Poll for manual triggers every 30s
  if (API_URL) {
    async function pollTriggers() {
      try {
        const triggers = await fetchTriggers();
        for (const clientId of triggers) {
          const client = clients.find((c) => c.id === clientId);
          if (!client) continue;
          // Delete trigger first to prevent double-run
          await deleteTrigger(clientId).catch(() => {});
          console.log(`\n[MANUAL] Trigger received for: ${client.name}`);
          runWithLogging(client, 'manual'); // fire-and-forget
        }
      } catch {
        // Silently ignore poll failures
      }
      setTimeout(pollTriggers, TRIGGER_POLL_MS);
    }
    setTimeout(pollTriggers, TRIGGER_POLL_MS); // first poll after 30s
    console.log('Polling for manual triggers every 30s.\n');
  }

  console.log('Scheduler running. Press Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
