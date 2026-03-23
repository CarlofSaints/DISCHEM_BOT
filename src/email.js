// Email alerts for the Dis-Chem BI bot.
// NOTE: Set SEND_ALERTS=true in .env to enable sending.
const { Resend } = require('resend');

const EMAIL_FROM = (process.env.EMAIL_FROM ?? 'report_sender@outerjoin.co.za').trim();
const ALERT_CC   = 'missingitemalerts@outerjoin.co.za';
const SEND_ENABLED = process.env.SEND_ALERTS === 'true';
const APP_URL = (process.env.DCHEM_API_URL ?? 'https://dischem-bi-manager.vercel.app').replace(/\/$/, '');

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY.trim());
}

// Parse comma-separated email string → array (Resend accepts arrays)
function parseEmails(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function trySend(notifyEmail, cc, subject, html) {
  const to = parseEmails(notifyEmail);
  if (!SEND_ENABLED) {
    console.log(`[EMAIL SUPPRESSED] To: ${to.join(', ')} | Subject: ${subject}`);
    return;
  }
  const resend = getResend();
  if (!resend || !to.length) return;
  try {
    await resend.emails.send({ from: EMAIL_FROM, to, cc: cc ? [cc] : undefined, subject, html });
    console.log(`[EMAIL SENT] To: ${to.join(', ')} | Subject: ${subject}`);
  } catch (err) {
    console.error('[EMAIL ERROR]', err.message);
  }
}

async function sendSiteDownEmail(client) {
  const subject = `[DIS-CHEM BOT] Site unreachable — ${client.name}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h2 style="color:#E31837;">Dis-Chem BI Site Unreachable</h2>
      <p>The bot could not connect to the Dis-Chem BI portal when attempting a scheduled export for <strong>${client.name}</strong>.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <tr><td style="padding:4px 8px;color:#666;">Client</td><td style="padding:4px 8px;font-weight:bold;">${client.name}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Time</td><td style="padding:4px 8px;">${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Action needed</td><td style="padding:4px 8px;">Check bi.dischem.co.za is accessible, then <a href="${APP_URL}/clients">trigger a manual run</a>.</td></tr>
      </table>
    </div>`;
  await trySend(client.notifyEmail, ALERT_CC, subject, html);
}

async function sendFileSizeAlert(client, actualKb) {
  const subject = `[DIS-CHEM BOT] Unusual file size — ${client.name}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h2 style="color:#F97316;">File Size Anomaly</h2>
      <p>The export file for <strong>${client.name}</strong> was materially different from the expected size.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <tr><td style="padding:4px 8px;color:#666;">Client</td><td style="padding:4px 8px;font-weight:bold;">${client.name}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Expected</td><td style="padding:4px 8px;">~${client.expectedFileSizeKb} KB ±${client.fileSizeTolerancePct}%</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Actual</td><td style="padding:4px 8px;font-weight:bold;">${actualKb.toFixed(0)} KB</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Time</td><td style="padding:4px 8px;">${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Action</td><td style="padding:4px 8px;">Please verify the downloaded file before using it.</td></tr>
      </table>
    </div>`;
  await trySend(client.notifyEmail, ALERT_CC, subject, html);
}

async function sendValidationSuccessEmail(client, log) {
  const time = new Date(log.timestamp).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const trigger = log.trigger === 'manual' ? 'Manual run' : 'Scheduled run';
  const subject = `[DIS-CHEM BOT] ✓ Export successful — ${client.name} ${client.reportType}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h2 style="color:#16a34a;">✓ Export Successful</h2>
      <p>The Dis-Chem BI export for <strong>${client.name}</strong> completed successfully. The data has been verified and includes figures from the previous day.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:12px;">
        <tr><td style="padding:4px 8px;color:#666;">Client</td><td style="padding:4px 8px;font-weight:bold;">${client.name}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Report type</td><td style="padding:4px 8px;">${client.reportType}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Exported at</td><td style="padding:4px 8px;">${time}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Latest data date</td><td style="padding:4px 8px;font-weight:bold;">${log.latestDataDate ?? 'n/a'}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Trigger</td><td style="padding:4px 8px;">${trigger}</td></tr>
        ${log.fileSizeKb ? `<tr><td style="padding:4px 8px;color:#666;">File size</td><td style="padding:4px 8px;">${log.fileSizeKb.toFixed(0)} KB</td></tr>` : ''}
      </table>
      <p style="margin-top:16px;font-size:13px;color:#666;">No action needed — the file has been saved to the configured export folder.</p>
    </div>`;
  await trySend(client.notifyEmail, null, subject, html);
}

async function sendValidationFailEmail(client, log) {
  const time = new Date(log.timestamp).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const attempts = (log.retryCount ?? 0) + 1;
  const subject = `[DIS-CHEM BOT] ✗ Export failed after ${attempts} attempt${attempts > 1 ? 's' : ''} — ${client.name}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h2 style="color:#dc2626;">✗ All Export Attempts Failed</h2>
      <p>The bot attempted to export data for <strong>${client.name}</strong> ${attempts} time${attempts > 1 ? 's' : ''} but could not confirm that the file contains data from the previous day.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:12px;">
        <tr><td style="padding:4px 8px;color:#666;">Client</td><td style="padding:4px 8px;font-weight:bold;">${client.name}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Report type</td><td style="padding:4px 8px;">${client.reportType}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Last attempt</td><td style="padding:4px 8px;">${time}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Attempts made</td><td style="padding:4px 8px;">${attempts}</td></tr>
        <tr><td style="padding:4px 8px;color:#666;">Reason</td><td style="padding:4px 8px;color:#dc2626;">${log.message.replace(/ — max retries.*$/, '')}</td></tr>
      </table>
      <p style="margin-top:20px;font-size:14px;">
        Once the data is available on Dis-Chem BI, please log in to the control panel and press
        <strong>Run Now</strong> for this client to trigger a fresh export:
      </p>
      <p style="margin-top:8px;">
        <a href="${APP_URL}/clients" style="display:inline-block;padding:10px 20px;background:#FC5424;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:14px;">
          Open Control Panel → Run Now
        </a>
      </p>
    </div>`;
  await trySend(client.notifyEmail, ALERT_CC, subject, html);
}

module.exports = { sendSiteDownEmail, sendFileSizeAlert, sendValidationSuccessEmail, sendValidationFailEmail };
