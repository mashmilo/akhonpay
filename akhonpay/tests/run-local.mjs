// Runs the real Worker code (server/src/index.js) on your computer with an in-memory SQLite database
// standing in for D1, then runs the full end-to-end suite against it over real HTTP.
//
//   node tests/run-local.mjs            run the suite (needs Node 22 or newer)
//   node tests/run-local.mjs --serve    keep the gateway running so you can click through the checkout page
import { register } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

register('./html-loader.mjs', import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { default: worker } = await import(join(root, 'server/src/index.js'));
const { D1Shim } = await import('./d1-shim.mjs');
const { runSuite } = await import('./e2e.mjs');

const serve = process.argv.includes('--serve');
const KEYS = { store: 'store_key_local_test', webhook: 'whsec_local_test', device: 'device_key_local_test', secret: 'device_secret_local_test' };

/* database */
const db = new D1Shim();
db.exec(readFileSync(join(root, 'server/schema.sql'), 'utf8'));

/* the store's webhook endpoint */
const webhook = {
  received: [], failFor: new Set(),
  failFirstFor(order) { this.failFor.add(order); },
  forOrder(order) { return this.received.filter((r) => r.body.order_id === order); },
};
const hookServer = createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(data); } catch {}
    webhook.received.push({ body, headers: req.headers });
    if (webhook.failFor.delete(body.order_id)) { res.statusCode = 500; return res.end('store is down'); }
    res.statusCode = 200; res.end('ok');
  });
});
await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${hookServer.address().port}/webhooks/mfs`;

db.prepare('INSERT INTO clients (name, api_key, webhook_secret, webhook_url) VALUES (?,?,?,?)').bind('Local Test Store', KEYS.store, KEYS.webhook, hookUrl).run();

/* the Worker, served over HTTP */
const env = {
  DB: db, DEVICE_API_KEY: KEYS.device, DEVICE_SECRET: KEYS.secret,
  BKASH_NUMBER: '01711000001', NAGAD_NUMBER: '01811000002', ROCKET_NUMBER: '01911000003', SESSION_TTL_MIN: '10',
};
const pending = new Set();
const ctx = { waitUntil: (p) => { const q = Promise.resolve(p).catch((e) => console.error('waitUntil:', e)).finally(() => pending.delete(q)); pending.add(q); }, passThroughOnException() {} };
const idle = async () => { while (pending.size) await Promise.all([...pending]); };

const gateway = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = `http://${req.headers.host}${req.url}`;
  const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const r = await worker.fetch(request, env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => gateway.listen(serve ? 8787 : 0, '127.0.0.1', r));
const base = `http://127.0.0.1:${gateway.address().port}`;

const hooks = {
  webhook, idle,
  runCron: async () => { await worker.scheduled({}, env, ctx); await idle(); },
  makeWebhookDue: (id) => db.prepare('UPDATE payment_sessions SET next_webhook_at = 0 WHERE id = ?').bind(id).run(),
  expire: (id) => db.prepare('UPDATE payment_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1000, id).run(),
  webhookStatus: async (id) => (await db.prepare('SELECT webhook_status s FROM payment_sessions WHERE id = ?').bind(id).first())?.s,
  trxStatus: async (trx) => (await db.prepare('SELECT status s FROM unclaimed_transactions WHERE trx_id = ?').bind(trx).first())?.s,
};

if (serve) {
  const mk = async (order, amount, provider) => (await (await fetch(base + '/api/v1/payment/create', {
    method: 'POST', headers: { 'x-api-key': KEYS.store, 'content-type': 'application/json' },
    body: JSON.stringify({ amount, order_id: order, provider, redirect_url: 'https://127.0.0.1/thanks' }),
  })).json()).checkout_url;
  console.log(`Gateway running at ${base}\n`);
  console.log('Open one of these checkout pages:');
  console.log('  bKash :', await mk('DEMO-1', 500, 'bkash'));
  console.log('  Nagad :', await mk('DEMO-2', 1250.5, 'nagad'));
  console.log('  Rocket:', await mk('DEMO-3', 99, 'rocket'));
  console.log('\nTo "receive an SMS" for DEMO-1, run in another terminal:');
  console.log(`  node server/scripts/simulate-sms.mjs ${base} ${KEYS.device} ${KEYS.secret} 500 TEST12345A bKash`);
  console.log('Then type TEST12345A on the page.   (Ctrl+C to stop)');
} else {
  const { failed } = await runSuite({
    base, storeKey: KEYS.store, deviceKey: KEYS.device, deviceSecret: KEYS.secret, webhookSecret: KEYS.webhook,
    redirectUrl: 'https://127.0.0.1/thanks', hooks,
  });
  gateway.close(); hookServer.close();
  process.exit(failed ? 1 : 0);
}
