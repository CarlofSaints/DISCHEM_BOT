// Email alerts for the Dis-Chem BI bot.
// NOTE: Alerts are built but NOT sent yet (SEND_ALERTS env var must be "true" to enable).
const { Resend } = require('resend');

const EMAIL_FROM = (process.env.EMAIL_FROM ?? 'report_sender@outerjoin.co.za').trim();
const ALERT_CC = 'missingitemalerts@outerjoin.co.za';
const SEND_ENABLED = process.env.SEND_ALERTS === 'true';

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY.trim());
}

async function trySend(to, cc, subject, html) {
  if (!SEND_ENABLED) {
    console.log(`[EMAIL SUPPRESSED] To: ${to} | Subject: ${subject}`);
    return;
  }
  const resend = getResend();
  if (!resend || !to) return;
  try {
    await resend.emails.send({ from: EMAIL_FROM, to, cc, subject, html });
    console.log(`[EMAIL SENT] To: ${to} | Subject: ${subject}`);
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
        <tr><td style="padding:4px 8px;color:#666;">Action needed</td><td style="padding:4px 8px;">Check bi.dischem.co.za is accessible, then trigger a manual run.</td></tr>
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

module.exports = { sendSiteDownEmail, sendFileSizeAlert };
