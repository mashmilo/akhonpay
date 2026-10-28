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
      if (req.method === 'GET' && p === '/') return new Response(demoHtml(!!env.DEMO_PASSCODE), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' } });
      if (req.method === 'POST' && p === '/api/demo/create') return await demoCreate(req, env, origin);
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

/* ---------- Demo portal: create a test payment from the browser (needs the DEMO_PASSCODE secret) ---------- */
async function demoCreate(req, env, origin) {
  if (!env.DEMO_PASSCODE) return json({ error: 'demo_disabled' }, 403);
  const b = await req.json().catch(() => null);
  if (!b || !safeEqual(b.passcode, env.DEMO_PASSCODE)) return json({ error: 'wrong_passcode' }, 401);
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 500) return json({ error: 'invalid_amount' }, 400);
  const client = await env.DB.prepare('SELECT * FROM clients WHERE active = 1 ORDER BY id LIMIT 1').first();
  if (!client) return json({ error: 'no_client_registered' }, 400);
  const order = 'demo-' + randomId().slice(3, 11);
  const inner = new Request(origin + '/api/v1/payment/create', {
    method: 'POST',
    headers: { 'x-api-key': client.api_key, 'content-type': 'application/json' },
    body: JSON.stringify({ amount, order_id: order, provider: b.provider }),
  });
  return await createPayment(inner, env, origin);
}

const demoHtml = (enabled) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Akhonpay demo</title>
<style>
:root{--bg:#f4f7fb;--card:#fff;--text:#0f1f5c;--muted:#5b6785;--line:#d9e0ee;--accent:#0f1f5c;--on:#fff;--err:#c0262d}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#141b33;--text:#e8ecf8;--muted:#9aa5c4;--line:#27314f;--accent:#2fd0e8;--on:#06121f;--err:#ff7b80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 20px;color:var(--muted);font-size:14px}
label{display:block;margin:14px 0 6px;font-size:13px;font-weight:600;color:var(--muted)}
input,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--text);font:inherit}
button{width:100%;margin-top:20px;padding:14px;border:0;border-radius:999px;background:var(--accent);color:var(--on);font:inherit;font-weight:600}
button:disabled{opacity:.6}#msg{min-height:22px;margin-top:12px;font-size:14px;color:var(--err)}
</style></head><body><main>
<h1>Akhonpay demo</h1><p>Create a test payment and open the real checkout page.</p>
${enabled ? `<form id="f">
<label for="amt">Amount (Tk, up to 500)</label><input id="amt" type="number" inputmode="decimal" min="1" max="500" step="0.01" value="10" required>
<label for="prov">Method</label><select id="prov"><option value="bkash">bKash</option><option value="nagad">Nagad</option><option value="rocket">Rocket</option></select>
<label for="code">Demo passcode</label><input id="code" type="password" autocomplete="off" required>
<button id="go" type="submit">Create payment</button><div id="msg" role="alert"></div></form>
<script>
document.getElementById('f').addEventListener('submit',async function(e){
  e.preventDefault();var b=document.getElementById('go'),m=document.getElementById('msg');b.disabled=true;m.textContent='';
  try{var r=await fetch('/api/demo/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:document.getElementById('amt').value,provider:document.getElementById('prov').value,passcode:document.getElementById('code').value})});
  var d=await r.json();if(r.ok&&d.checkout_url){location.href=d.checkout_url;return}
  m.textContent=({wrong_passcode:'Wrong passcode.',invalid_amount:'Amount must be between 1 and 500.',provider_not_configured:'That method has no wallet number set.'})[d.error]||('Error: '+(d.error||r.status));}
  catch(x){m.textContent='Network error.'}b.disabled=false});
</script>` : `<div id="msg">Demo is switched off. Set the DEMO_PASSCODE secret to turn it on.</div>`}
</main></body></html>`;

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
