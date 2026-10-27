// Simulates the Android app: node scripts/simulate-sms.mjs <base_url> <DEVICE_API_KEY> <DEVICE_SECRET> <amount> <trx_id> [sender_id]
import { createHmac } from 'node:crypto';
const [base, key, secret, amount, trx, senderId = 'bKash'] = process.argv.slice(2);
if (!trx) { console.error('usage: simulate-sms.mjs <base_url> <api_key> <secret> <amount> <trx_id> [sender_id]'); process.exit(1); }
const body = JSON.stringify({ sender_id: senderId, amount, sender_number: '01712345678', trx_id: trx, sms_ts: Date.now() });
const ts = String(Date.now());
const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
const res = await fetch(`${base}/api/v1/mfs-callback`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-timestamp': ts, 'x-signature': sig },
  body,
});
console.log(res.status, await res.text());
