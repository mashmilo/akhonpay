import checkoutHtml from './checkout.html';

const enc = new TextEncoder();
const MAX_AMOUNT_MINOR = 10_000_000; // 100,000 Tk sanity cap
const MAX_VERIFY_ATTEMPTS = 12; // per session, stops TrxID guessing
const MAX_WEBHOOK_ATTEMPTS = 8;

const PROVIDERS = {
  bkash: { label: 'bKash', numberVar: 'BKASH_NUMBER', color: '#E2136E', senders: ['bkash', '16247'] },
  nagad: { label: 'Nagad', numberVar: 'NAGAD_NUMBER', color: '#E8590C', senders: ['nagad', '16167'] },
  rocket: { label: 'Rocket', numberVar: 'ROCKET_NUMBER', color: '#8C3494', senders: ['rocket', '16216'] },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  const x = enc.encode(String(a ?? '')),
    y = enc.encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const toMinor = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const randomId = () => 'ps_' + [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');
const providerForSender = (id) =>
  Object.keys(PROVIDERS).find((k) => PROVIDERS[k].senders.includes(String(id ?? '').trim().toLowerCase()));

function returnUrl(s) {
  if (!s.redirect_url) return null;
  const u = new URL(s.redirect_url);
  u.searchParams.set('order_id', s.order_id);
  u.searchParams.set('status', s.status === 'paid' ? 'success' : s.status);
  return u.toString();
}

export default {
  async fetch(req, env, ctx) {
    const p = new URL(req.url).pathname;
    const origin = new URL(req.url).origin;
    try {
      if (req.method === 'GET' && p === '/health') return json({ ok: true });
      if (req.method === 'POST' && p === '/api/v1/payment/create') return await createPayment(req, env, origin);
      if (req.method === 'POST' && p === '/api/v1/mfs-callback') return await mfsCallback(req, env);

      let m;
      if (req.method === 'GET' && p.match(/^\/pay\/ps_[a-f0-9]{36}$/))
        return new Response(checkoutHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
          },
        });
      if (req.method === 'GET' && (m = p.match(/^\/api\/v1\/session\/(ps_[a-f0-9]{36})$/))) return await sessionInfo(env, m[1]);
      if (req.method === 'POST' && (m = p.match(/^\/api\/v1\/session\/(ps_[a-f0-9]{36})\/verify$/)))
        return await verify(req, env, ctx, m[1]);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

/* ---------- Phase A: payment initiation ---------- */
async function createPayment(req, env, origin) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) return json({ error: 'unauthorized' }, 401);
  const client = await env.DB.prepare('SELECT * FROM clients WHERE api_key = ? AND active = 1').bind(apiKey).first();
  if (!client) return json({ error: 'unauthorized' }, 401);

  const b = await req.json().catch(() => null);
  if (!b) return json({ error: 'invalid_json' }, 400);

  const amount = toMinor(b.amount);
  const orderId = String(b.order_id ?? '').trim().slice(0, 100);
  const provider = String(b.provider ?? 'bkash').toLowerCase();
  if (!amount || amount > MAX_AMOUNT_MINOR) return json({ error: 'invalid_amount' }, 400);
  if (!orderId) return json({ error: 'invalid_order_id' }, 400);
  if (!PROVIDERS[provider]) return json({ error: 'invalid_provider' }, 400);
  const number = env[PROVIDERS[provider].numberVar];
  if (!number || number.includes('X')) return json({ error: 'provider_not_configured' }, 400);

  let redirect = null;
  if (b.redirect_url) {
    try {
      const r = new URL(b.redirect_url);
      // Only redirect back to the client's own domain (prevents open-redirect abuse)
      if (r.protocol !== 'https:' || r.hostname !== new URL(client.webhook_url).hostname) throw 0;
      redirect = r.toString();
    } catch {
      return json({ error: 'invalid_redirect_url' }, 400);
    }
  }

  const now = Date.now();
  const existing = await env.DB.prepare(
    'SELECT * FROM payment_sessions WHERE client_id = ? AND order_id = ? ORDER BY created_at DESC LIMIT 1'
  )
    .bind(client.id, orderId)
    .first();
  if (existing?.status === 'paid') return json({ error: 'order_already_paid' }, 409);
  if (existing?.status === 'pending' && existing.expires_at > now && existing.amount_minor === amount && existing.provider === provider)
    return json(sessionResponse(existing, origin));

  const ttl = Number(env.SESSION_TTL_MIN || 10) * 60_000;
  const s = { id: randomId(), client_id: client.id, order_id: orderId, provider, amount_minor: amount, created_at: now, expires_at: now + ttl };
  await env.DB.prepare(
    'INSERT INTO payment_sessions (id, client_id, order_id, provider, amount_minor, redirect_url, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)'
  )
    .bind(s.id, s.client_id, s.order_id, s.provider, s.amount_minor, redirect, s.created_at, s.expires_at)
    .run();
  return json(sessionResponse(s, origin), 201);
}

const sessionResponse = (s, origin) => ({
  session_id: s.id,
  checkout_url: `${origin}/pay/${s.id}`,
  expires_at: new Date(s.expires_at).toISOString(),
});

async function sessionInfo(env, id) {
  const s = await env.DB.prepare('SELECT * FROM payment_sessions WHERE id = ?').bind(id).first();
  if (!s) return json({ error: 'not_found' }, 404);
  const now = Date.now();
  const status = s.status === 'pending' && s.expires_at <= now ? 'expired' : s.status;
  const prov = PROVIDERS[s.provider];
  return json({
    status,
    order_id: s.order_id,
    amount: (s.amount_minor / 100).toFixed(2),
    provider: s.provider,
    provider_label: prov.label,
    color: prov.color,
    wallet_number: env[prov.numberVar],
    expires_at: s.expires_at,
    server_now: now,
    return_url: status === 'paid' ? returnUrl(s) : null,
  });
}

/* ---------- Phase B receiver: Android forwarder ---------- */
async function mfsCallback(req, env) {
  const raw = await req.text();
  const ts = req.headers.get('x-timestamp');
  if (!safeEqual(req.headers.get('x-api-key'), env.DEVICE_API_KEY)) return json({ error: 'unauthorized' }, 401);
  if (!ts || Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return json({ error: 'stale_request' }, 401);
  const expected = await hmacHex(env.DEVICE_SECRET, `${ts}.${raw}`);
  if (!safeEqual(req.headers.get('x-signature'), expected)) return json({ error: 'bad_signature' }, 401);

  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const provider = providerForSender(b.sender_id); // OriginatingAddress reported by the phone
  const amount = toMinor(b.amount);
  const trx = String(b.trx_id ?? '').trim().toUpperCase();
  if (!provider) return json({ error: 'unknown_sender' }, 422);
  if (!amount || amount > MAX_AMOUNT_MINOR || !/^[A-Z0-9]{6,20}$/.test(trx)) return json({ error: 'invalid_fields' }, 422);

  const now = Date.now();
  let smsTs = Number(b.sms_ts) || now;
  if (smsTs > now + 5 * 60_000) smsTs = now;
  const sender = /^01[3-9]\d{8}$/.test(String(b.sender_number ?? '')) ? b.sender_number : null;

  const r = await env.DB.prepare(
    'INSERT OR IGNORE INTO unclaimed_transactions (trx_id, provider, amount_minor, sender, sms_ts, received_at) VALUES (?,?,?,?,?,?)'
  )
    .bind(trx, provider, amount, sender, smsTs, now)
    .run();
  return json({ ok: true, duplicate: r.meta.changes === 0 });
}

/* ---------- Phase C: ledger validation ---------- */
async function verify(req, env, ctx, id) {
  const b = await req.json().catch(() => null);
  const trx = String(b?.trx_id ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(trx)) return json({ status: 'invalid_format' }, 400);

  const s = await env.DB.prepare('SELECT * FROM payment_sessions WHERE id = ?').bind(id).first();
  if (!s) return json({ error: 'not_found' }, 404);
  const now = Date.now();
  if (s.status === 'paid') return json({ status: 'paid', return_url: returnUrl(s) });
  if (s.status !== 'pending' || s.expires_at <= now) return json({ status: 'expired' }, 410);

  const bump = await env.DB.prepare('UPDATE payment_sessions SET attempts = attempts + 1 WHERE id = ? AND attempts < ?')
    .bind(id, MAX_VERIFY_ATTEMPTS)
    .run();
  if (bump.meta.changes === 0) return json({ status: 'too_many_attempts' }, 429);

  // Both statements run in ONE transaction (D1 batch). The claim only succeeds if
  // TrxID + amount + provider match an unclaimed row received after the session started,
  // and the session is still pending. Otherwise nothing changes.
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE unclaimed_transactions SET status = 'claimed', claimed_session = ?1, claimed_at = ?2
         WHERE trx_id = ?3 AND amount_minor = ?4 AND provider = ?5 AND status = 'unclaimed' AND sms_ts >= ?6
           AND EXISTS (SELECT 1 FROM payment_sessions WHERE id = ?1 AND status = 'pending' AND expires_at > ?2)`
      ).bind(id, now, trx, s.amount_minor, s.provider, s.created_at - 120_000),
      env.DB.prepare(
        `UPDATE payment_sessions SET status = 'paid', trx_id = ?2, paid_at = ?3, webhook_status = 'pending', next_webhook_at = ?3 + 60000
         WHERE id = ?1 AND status = 'pending'
           AND EXISTS (SELECT 1 FROM unclaimed_transactions WHERE claimed_session = ?1 AND trx_id = ?2)`
      ).bind(id, trx, now),
    ]);
  } catch (e) {
    // e.g. the one_paid_per_order index fired: another session already paid this order
    console.error(e);
    return json({ status: 'order_already_paid' }, 409);
  }

  if (res[0].meta.changes !== 1 || res[1].meta.changes !== 1) return json({ status: 'not_found' });
  ctx.waitUntil(deliverWebhook(env, id));
  const paid = await env.DB.prepare('SELECT * FROM payment_sessions WHERE id = ?').bind(id).first();
  return json({ status: 'paid', return_url: returnUrl(paid) });
}

/* ---------- Phase D: signed webhook ---------- */
async function deliverWebhook(env, id) {
  const s = await env.DB.prepare(
    'SELECT s.*, c.webhook_url, c.webhook_secret FROM payment_sessions s JOIN clients c ON c.id = s.client_id WHERE s.id = ?'
  )
    .bind(id)
    .first();
  if (!s || s.status !== 'paid' || s.webhook_status === 'delivered') return;

  const payload = {
    event: 'payment.success',
    session_id: s.id,
    order_id: s.order_id,
    status: 'success',
    amount: (s.amount_minor / 100).toFixed(2),
    trx_id: s.trx_id,
    provider: s.provider,
    paid_at: s.paid_at,
    ts: Date.now(),
  };
  payload.secure_hash = await hmacHex(
    s.webhook_secret,
    [payload.order_id, payload.status, payload.amount, payload.session_id, payload.ts].join('|')
  );

  let ok = false;
  try {
    const r = await fetch(s.webhook_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'mfs-gateway/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    ok = r.ok;
  } catch (_) {}

  const attempts = s.webhook_attempts + 1;
  if (ok) {
    await env.DB.prepare("UPDATE payment_sessions SET webhook_status = 'delivered', webhook_attempts = ? WHERE id = ?")
      .bind(attempts, id)
      .run();
  } else {
    const next = Date.now() + Math.min(2 ** attempts * 30_000, 3_600_000);
    await env.DB.prepare('UPDATE payment_sessions SET webhook_status = ?, webhook_attempts = ?, next_webhook_at = ? WHERE id = ?')
      .bind(attempts >= MAX_WEBHOOK_ATTEMPTS ? 'failed' : 'pending', attempts, next, id)
      .run();
  }
}

async function runCron(env) {
  const now = Date.now();
  await env.DB.prepare("UPDATE payment_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(now).run();
  const { results } = await env.DB.prepare(
    "SELECT id FROM payment_sessions WHERE status = 'paid' AND webhook_status = 'pending' AND next_webhook_at <= ? LIMIT 20"
  )
    .bind(now)
    .all();
  for (const r of results) await deliverWebhook(env, r.id);
}
