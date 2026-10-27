// Akhonpay end-to-end test suite.
//
//   Local (no accounts, no network):   node tests/run-local.mjs
//   Against a deployed gateway:        GATEWAY_URL=... STORE_API_KEY=... DEVICE_API_KEY=... DEVICE_SECRET=... node tests/e2e.mjs
//
// The suite plays all three roles: the store (creates sessions), the phone (sends signed SMS payloads)
// and the customer (verifies a TrxID). Checks marked [local] also need the hooks that run-local.mjs provides
// (a webhook receiver and a way to expire sessions), so they are skipped against a live gateway.
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hmac = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');
const rid = () => Math.random().toString(36).slice(2, 11).toUpperCase().padEnd(9, '0');

export async function runSuite(cfg) {
  const { base, storeKey, deviceKey, deviceSecret, webhookSecret = null, redirectUrl = null, hooks = null } = cfg;
  const run = 'E2E' + Date.now().toString(36).toUpperCase();
  let passed = 0, failed = 0, skipped = 0;

  const check = (name, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}${detail ? '   -> ' + detail : ''}`); }
  };
  const skip = (name, why) => { skipped++; console.log(`  skip  ${name} (${why})`); };
  const section = (t) => console.log(`\n${t}`);

  const call = async (method, path, { headers = {}, body, raw } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };

  const createSession = (over = {}) =>
    call('POST', '/api/v1/payment/create', {
      headers: { 'x-api-key': storeKey },
      body: { amount: 500, order_id: `${run}-${rid()}`, provider: 'bkash', ...(redirectUrl ? { redirect_url: redirectUrl } : {}), ...over },
    });

  // What the Android app does: sign `${timestamp}.${rawBody}` with the device secret.
  const sms = async (fields, { key = deviceKey, secret = deviceSecret, ts = Date.now(), signWith } = {}) => {
    const body = JSON.stringify({ sender_id: 'bKash', amount: '500.00', sender_number: '01712345678', sms_ts: Date.now(), ...fields });
    const sig = hmac(signWith ?? secret, `${ts}.${body}`);
    return call('POST', '/api/v1/mfs-callback', { headers: { 'x-api-key': key, 'x-timestamp': String(ts), 'x-signature': sig }, raw: body });
  };
  const verify = (sid, trx) => call('POST', `/api/v1/session/${sid}/verify`, { body: { trx_id: trx } });

  /* ------------------------------------------------------------------ */
  section('1. Health');
  {
    const r = await call('GET', '/health');
    check('GET /health -> 200 {ok:true}', r.status === 200 && r.json?.ok === true, r.text);
    const nf = await call('GET', '/nope');
    check('unknown route -> 404', nf.status === 404);
  }

  /* ------------------------------------------------------------------ */
  section('2. Phase A: store creates a payment session');
  let main; // session reused below
  const mainOrder = `${run}-MAIN`;
  {
    let r = await call('POST', '/api/v1/payment/create', { body: { amount: 500, order_id: 'X' } });
    check('no x-api-key -> 401', r.status === 401, r.text);
    r = await call('POST', '/api/v1/payment/create', { headers: { 'x-api-key': 'wrong' }, body: { amount: 500, order_id: 'X' } });
    check('wrong x-api-key -> 401', r.status === 401);
    r = await createSession({ amount: 0 });
    check('amount 0 -> 400 invalid_amount', r.status === 400 && r.json?.error === 'invalid_amount', r.text);
    r = await createSession({ amount: -5 });
    check('negative amount -> 400', r.status === 400);
    r = await createSession({ amount: 99999999 });
    check('amount above the cap -> 400', r.status === 400);
    r = await createSession({ order_id: '' });
    check('empty order_id -> 400 invalid_order_id', r.status === 400 && r.json?.error === 'invalid_order_id', r.text);
    r = await createSession({ provider: 'paypal' });
    check('unknown provider -> 400 invalid_provider', r.status === 400 && r.json?.error === 'invalid_provider', r.text);
    r = await createSession({ redirect_url: 'https://evil.example/steal' });
    check('redirect_url on another domain -> 400 (no open redirect)', r.status === 400 && r.json?.error === 'invalid_redirect_url', r.text);
    r = await createSession({ redirect_url: 'http://insecure.example/x' });
    check('non-https redirect_url -> 400', r.status === 400);

    r = await createSession({ order_id: mainOrder });
    main = r.json;
    check('valid create -> 201 with session_id, checkout_url, expires_at',
      r.status === 201 && /^ps_[a-f0-9]{36}$/.test(main?.session_id ?? '') && main?.checkout_url?.endsWith('/pay/' + main?.session_id) && !!main?.expires_at, r.text);
    const mins = (Date.parse(main.expires_at) - Date.now()) / 60000;
    check('session expires in about 10 minutes', mins > 9 && mins <= 10.1, mins.toFixed(2) + ' min');
    r = await createSession({ order_id: mainOrder });
    check('same order, same amount -> same session returned (idempotent)', r.status === 200 && r.json?.session_id === main.session_id, r.text);
  }

  /* ------------------------------------------------------------------ */
  section('3. Checkout page and session info');
  {
    const page = await call('GET', `/pay/${main.session_id}`);
    check('GET /pay/<session> -> 200 HTML', page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? ''));
    check('page is the Akhonpay checkout (brand, TrxID input, verify button)', /Akhonpay/.test(page.text) && /id="trx"/.test(page.text) && /id="verify"/.test(page.text));
    check('page cannot be framed (x-frame-options: DENY)', page.headers.get('x-frame-options') === 'DENY');
    check('page is not cached', /no-store/.test(page.headers.get('cache-control') ?? ''));
    const bad = await call('GET', '/pay/ps_nothex');
    check('malformed session link -> 404', bad.status === 404);

    const info = await call('GET', `/api/v1/session/${main.session_id}`);
    const j = info.json ?? {};
    check('session info: pending, amount 500.00, bKash', info.status === 200 && j.status === 'pending' && j.amount === '500.00' && j.provider_label === 'bKash', info.text);
    check('session info shows the wallet number and no return_url yet', /^01\d{9}$/.test(j.wallet_number ?? '') && j.return_url === null, info.text);
    const none = await call('GET', '/api/v1/session/ps_' + '0'.repeat(36));
    check('unknown session -> 404', none.status === 404);
  }

  /* ------------------------------------------------------------------ */
  section('4. Phase B: the phone posts an SMS (authentication and spoofing)');
  const trxMain = 'TM' + rid();
  {
    let r = await sms({ trx_id: trxMain }, { key: 'wrong-key' });
    check('wrong device API key -> 401', r.status === 401, r.text);
    r = await sms({ trx_id: trxMain }, { signWith: 'not-the-secret' });
    check('bad HMAC signature -> 401 bad_signature', r.status === 401 && r.json?.error === 'bad_signature', r.text);
    r = await sms({ trx_id: trxMain }, { ts: Date.now() - 10 * 60_000 });
    check('timestamp 10 minutes old -> 401 stale_request (blocks captured-request replay)', r.status === 401 && r.json?.error === 'stale_request', r.text);

    // tampered body: sign one body, send another
    const ts = Date.now(), signed = JSON.stringify({ sender_id: 'bKash', amount: '1.00', trx_id: trxMain, sms_ts: ts });
    const t = await call('POST', '/api/v1/mfs-callback', {
      headers: { 'x-api-key': deviceKey, 'x-timestamp': String(ts), 'x-signature': hmac(deviceSecret, `${ts}.${signed}`) },
      raw: signed.replace('1.00', '9999.00'),
    });
    check('body changed after signing -> 401', t.status === 401, t.text);

    r = await sms({ trx_id: trxMain, sender_id: 'MyShop' });
    check('unknown sender id (not a payment provider) -> 422 unknown_sender', r.status === 422 && r.json?.error === 'unknown_sender', r.text);
    r = await sms({ trx_id: trxMain, sender_id: '+8801712345678' });
    check('SMS from a normal phone number (spoof attempt) -> 422', r.status === 422, r.text);
    r = await sms({ trx_id: 'ab' });
    check('malformed TrxID -> 422 invalid_fields', r.status === 422 && r.json?.error === 'invalid_fields', r.text);
    r = await sms({ trx_id: trxMain, amount: 'abc' });
    check('non-numeric amount -> 422', r.status === 422);

    r = await sms({ trx_id: trxMain });
    check('valid SMS stored -> 200 {ok:true, duplicate:false}', r.status === 200 && r.json?.ok === true && r.json?.duplicate === false, r.text);
    r = await sms({ trx_id: trxMain });
    check('same TrxID posted again -> duplicate:true (unique trx_id)', r.status === 200 && r.json?.duplicate === true, r.text);
    r = await sms({ trx_id: trxMain, amount: '9000.00' });
    check('same TrxID with a different amount cannot overwrite the first row', r.status === 200 && r.json?.duplicate === true, r.text);
  }

  /* ------------------------------------------------------------------ */
  section('5. Phase C: the customer verifies (strict TrxID + amount match)');
  {
    let r = await verify(main.session_id, 'x');
    check('TrxID too short -> 400 invalid_format', r.status === 400 && r.json?.status === 'invalid_format', r.text);
    r = await verify(main.session_id, 'NOSUCH' + rid());
    check('TrxID that was never received -> not_found', r.status === 200 && r.json?.status === 'not_found', r.text);

    // right TrxID, wrong amount: the ledger row is 9000 only if it were overwritten; ledger has 500, so test with a 700 session
    const s700 = (await createSession({ amount: 700 })).json;
    r = await verify(s700.session_id, trxMain);
    check('right TrxID but wrong amount (session wants 700, SMS was 500) -> not_found', r.json?.status === 'not_found', r.text);

    // right TrxID + amount, wrong provider
    const nagadTrx = 'NG' + rid();
    await sms({ trx_id: nagadTrx, sender_id: 'Nagad', amount: '500.00' });
    r = await verify(main.session_id, nagadTrx);
    check('Nagad SMS cannot pay a bKash session -> not_found', r.json?.status === 'not_found', r.text);

    // an SMS that was received long before the session started
    const oldTrx = 'OLD' + rid();
    await sms({ trx_id: oldTrx, sms_ts: Date.now() - 60 * 60_000 });
    const sOld = (await createSession()).json;
    r = await verify(sOld.session_id, oldTrx);
    check('SMS timestamped an hour before the session -> not_found (old SMS cannot be reused)', r.json?.status === 'not_found', r.text);

    // happy path
    r = await verify(main.session_id, trxMain.toLowerCase());
    check('correct TrxID (typed in lower case) -> paid', r.status === 200 && r.json?.status === 'paid', r.text);
    if (redirectUrl) {
      const u = new URL(r.json?.return_url ?? 'http://x');
      check('return_url carries order_id and status=success', u.searchParams.get('order_id') === mainOrder && u.searchParams.get('status') === 'success', r.text);
    } else skip('return_url content', 'no REDIRECT_URL configured');
    r = await verify(main.session_id, trxMain);
    check('verifying the paid session again is harmless (still paid)', r.status === 200 && r.json?.status === 'paid');
    const info = await call('GET', `/api/v1/session/${main.session_id}`);
    check('session info now says paid', info.json?.status === 'paid', info.text);
    r = await createSession({ order_id: mainOrder });
    check('creating another session for the paid order -> 409 order_already_paid', r.status === 409 && r.json?.error === 'order_already_paid', r.text);
  }

  /* ------------------------------------------------------------------ */
  section('6. Replay and double-spend protection');
  {
    const sA = (await createSession()).json, sB = (await createSession()).json;
    const r1 = await verify(sB.session_id, trxMain);
    check('claimed TrxID cannot pay a second order', r1.json?.status === 'not_found', r1.text);

    const trx = 'RC' + rid();
    await sms({ trx_id: trx });
    const [a, b] = await Promise.all([verify(sA.session_id, trx), verify(sB.session_id, trx)]);
    const paid = [a, b].filter((x) => x.json?.status === 'paid').length;
    check('one TrxID verified on two sessions at the same moment -> exactly one is paid', paid === 1, `${a.text} | ${b.text}`);

    const sC = (await createSession()).json;
    let last;
    for (let i = 0; i < 12; i++) last = await verify(sC.session_id, 'WRONG' + rid());
    check('first 12 wrong guesses are answered not_found', last.json?.status === 'not_found', last.text);
    last = await verify(sC.session_id, 'WRONG' + rid());
    check('13th guess -> 429 too_many_attempts (TrxID brute force blocked)', last.status === 429 && last.json?.status === 'too_many_attempts', last.text);
    const good = 'LK' + rid();
    await sms({ trx_id: good });
    last = await verify(sC.session_id, good);
    check('a locked session refuses even the correct TrxID', last.status === 429, last.text);
  }

  /* ------------------------------------------------------------------ */
  section('7. Phase D: signed webhook  [local]');
  if (!hooks || !webhookSecret) {
    skip('webhook delivery, signature, retry, expiry', 'needs the local runner (a live gateway posts to your real store, not to this script)');
  } else {
    const order = `${run}-HOOK`;
    const s = (await createSession({ order_id: order, amount: 1250.5, provider: 'nagad' })).json;
    const trx = 'WH' + rid();
    hooks.webhook.failFirstFor(order);                 // the store answers 500 once, to test the retry path
    await sms({ trx_id: trx, sender_id: 'Nagad', amount: '1,250.50' });
    const v = await verify(s.session_id, trx);
    check('Nagad 1,250.50 (comma format) verifies a 1250.5 Nagad session', v.json?.status === 'paid', v.text);
    await hooks.idle();
    const got = () => hooks.webhook.forOrder(order);
    check('first webhook attempt reached the store (store answered 500)', got().length === 1, 'received ' + got().length);

    await hooks.makeWebhookDue(s.session_id);
    await hooks.runCron();
    check('cron retried the webhook', got().length === 2, 'received ' + got().length);

    const p = got()[1].body;
    check('payload: event, order_id, status=success, amount, trx_id, provider',
      p.event === 'payment.success' && p.order_id === order && p.status === 'success' && p.amount === '1250.50' && p.trx_id === trx && p.provider === 'nagad', JSON.stringify(p));
    const expected = hmac(webhookSecret, [p.order_id, p.status, p.amount, p.session_id, p.ts].join('|'));
    check('secure_hash is a valid HMAC-SHA256 under the store webhook secret', p.secure_hash === expected);
    const tampered = hmac(webhookSecret, [p.order_id, p.status, '1.00', p.session_id, p.ts].join('|'));
    check('a changed amount would NOT match the signature (store can detect tampering)', p.secure_hash !== tampered);
    check('webhook timestamp is fresh', Math.abs(Date.now() - p.ts) < 60_000);

    await hooks.makeWebhookDue(s.session_id);
    await hooks.runCron();
    check('after a 200 from the store the webhook is not sent again', got().length === 2, 'received ' + got().length);
    check('database marks the webhook delivered', (await hooks.webhookStatus(s.session_id)) === 'delivered');

    // expiry
    const e = (await createSession()).json;
    const etrx = 'EX' + rid();
    await sms({ trx_id: etrx });
    await hooks.expire(e.session_id);
    const ev = await verify(e.session_id, etrx);
    check('verifying an expired session -> 410 expired', ev.status === 410 && ev.json?.status === 'expired', ev.text);
    const ei = await call('GET', `/api/v1/session/${e.session_id}`);
    check('expired session info says expired', ei.json?.status === 'expired', ei.text);
    check('the SMS stays unclaimed after a failed late attempt', (await hooks.trxStatus(etrx)) === 'unclaimed');
  }

  console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  return { passed, failed, skipped };
}

/* CLI: run against a deployed gateway */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const need = ['GATEWAY_URL', 'STORE_API_KEY', 'DEVICE_API_KEY', 'DEVICE_SECRET'];
  const miss = need.filter((k) => !process.env[k]);
  if (miss.length) {
    console.error(`Missing: ${miss.join(', ')}\n\nExample:\n  GATEWAY_URL=https://akhonpay.you.workers.dev STORE_API_KEY=... DEVICE_API_KEY=... DEVICE_SECRET=... \\\n  [REDIRECT_URL=https://yourshop.com/thanks] node tests/e2e.mjs`);
    process.exit(2);
  }
  console.log(`Running against ${process.env.GATEWAY_URL}\n(This creates a few E2E-* test sessions and test TrxIDs in that database; they are harmless.)`);
  const { failed } = await runSuite({
    base: process.env.GATEWAY_URL.replace(/\/$/, ''),
    storeKey: process.env.STORE_API_KEY,
    deviceKey: process.env.DEVICE_API_KEY,
    deviceSecret: process.env.DEVICE_SECRET,
    redirectUrl: process.env.REDIRECT_URL || null,
  });
  process.exit(failed ? 1 : 0);
}
