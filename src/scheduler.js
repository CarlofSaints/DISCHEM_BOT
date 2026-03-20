const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { runExport } = require('./bot');

const clientsFile = path.join(__dirname, '..', 'clients.json');
const clients = JSON.parse(fs.readFileSync(clientsFile, 'utf-8'));

console.log(`Dis-Chem Export Scheduler started — ${new Date().toLocaleString()}`);
console.log(`Loaded ${clients.length} client(s):\n`);

for (const client of clients) {
  console.log(`  [${client.name}] Schedule: "${client.schedule}" (cron)`);

  cron.schedule(client.schedule, async () => {
    console.log(`\n[CRON] Triggered export for ${client.name}`);
    try {
      await runExport(client);
    } catch (err) {
      console.error(`[CRON] Export failed for ${client.name}:`, err.message);
    }
  }, {
    timezone: 'Africa/Johannesburg',
  });
}

console.log('\nScheduler running. Press Ctrl+C to stop.\n');
