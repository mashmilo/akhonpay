# Akhonpay: deploy guide (100% free tier)

You will set up three things: the **server** (Cloudflare Workers + D1), the **Android app** (built free by GitHub Actions) and your **store** (receives the webhook). Total cost: 0 BDT. You need a computer with Node 22+ for the first setup.

```
Customer ─▶ Store ──create session──▶ Server (Cloudflare) ◀──signed SMS JSON── Android phone (your SIM)
                  ◀────signed webhook────┘
```

## 0. Accounts
- GitHub account (free), Cloudflare account (free, no card needed for Workers/D1).
- A spare Android phone (7.0+) with the SIM that receives the payments, always on and connected to the internet.

## 1. Put the project on GitHub
```bash
cd akhonpay
git init && git add . && git commit -m "akhonpay"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/akhonpay.git
git branch -M main && git push -u origin main
```
A **public** repo gives unlimited free Actions minutes. Secrets are never in the repo (see `.gitignore`), so public is safe, but keep your real wallet numbers out of committed files if you prefer: step 3 shows how to set them in the dashboard instead.

## 2. Test everything on your computer first (no accounts needed)
```bash
npm test              # 60 checks: sessions, spoofing, replay, double-spend, webhook signature, retries
npm run demo          # starts the gateway on http://127.0.0.1:8787 and prints 3 checkout links
```
Open a printed link, then in a second terminal run the `simulate-sms.mjs` line it prints, and type the TrxID on the page. You should see the paid screen.

## 3. Deploy the server
```bash
cd server
npm install
npx wrangler login
npx wrangler d1 create akhonpay          # copy the printed database_id into server/wrangler.toml
npx wrangler d1 execute akhonpay --remote --file=schema.sql
```
Edit `server/wrangler.toml`: set `BKASH_NUMBER`, `NAGAD_NUMBER`, `ROCKET_NUMBER` (leave unused ones as `01XXXXXXXXX`).

Create the two phone secrets (generate random values; save them, the phone needs both):
```bash
openssl rand -hex 24     # DEVICE_API_KEY
openssl rand -hex 32     # DEVICE_SECRET
npx wrangler secret put DEVICE_API_KEY
npx wrangler secret put DEVICE_SECRET
npx wrangler deploy
```
No `openssl`? Use `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Your gateway is now live at `https://akhonpay.<your-subdomain>.workers.dev`. Check `…/health`.

### Register your store
```bash
openssl rand -hex 24     # STORE_API_KEY
openssl rand -hex 32     # STORE_WEBHOOK_SECRET
npx wrangler d1 execute akhonpay --remote --command \
 "INSERT INTO clients (name, api_key, webhook_secret, webhook_url) VALUES ('My Shop','<STORE_API_KEY>','<STORE_WEBHOOK_SECRET>','https://yourshop.com/webhooks/mfs')"
```
The store's `redirect_url` must be on the same domain as `webhook_url`/your store (the server rejects other domains).

### Auto-deploy on every push (optional)
In GitHub: Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN` (create at dash.cloudflare.com/profile/api-tokens with the "Edit Cloudflare Workers" template; also add D1 Edit permission) and `CLOUDFLARE_ACCOUNT_ID` (shown on the Workers overview page). The workflow `deploy-server.yml` runs the tests, then deploys.

### Custom domain (optional, free)
Add your domain to Cloudflare, then Worker → Settings → Domains & Routes → Add custom domain, for example `pay.yourdomain.com`.

## 4. Test the live server (still without the phone)
```bash
cd ..   # project root
GATEWAY_URL=https://akhonpay.<you>.workers.dev STORE_API_KEY=... DEVICE_API_KEY=... DEVICE_SECRET=... \
REDIRECT_URL=https://yourshop.com/thanks npm run test:live
```
The webhook checks are skipped live (they need a receiver that the script controls); everything else runs. It leaves a few harmless `E2E…` rows behind. Do not run it while a real customer is paying: it uses test TrxIDs but shares the same database.

## 5. Build and install the Android app
1. GitHub → Actions → **Build Android APK** → Run workflow. When it finishes, download the `akhonpay-forwarder-apk` artifact and unzip it.
2. Copy the APK to the phone and install it (allow "install unknown apps").
3. **Android 13+:** Settings → Apps → Akhonpay → ⋮ → **Allow restricted settings**, then grant the SMS permission. Without this step the SMS permission stays greyed out.
4. Open the app: enter the server URL, `DEVICE_API_KEY` and `DEVICE_SECRET`, tap Save, then **Test server connection**. "OK" means URL, key, secret and clock are all correct.
5. Turn off battery optimisation for the app. On Xiaomi/Oppo/Vivo/Realme also enable autostart and lock the app in recents.
6. Check the sender IDs your phone really shows for bKash/Nagad/Rocket against `SmsParser.kt` and `server/src/index.js` (the `senders` lists). Paste a real SMS (numbers blanked) into the app's **Parse sample** box and confirm it extracts the right amount and TrxID.
7. Send yourself a small real payment (for example 10 BDT) and look at the result:
```bash
cd server
npx wrangler d1 execute akhonpay --remote --command "SELECT trx_id, amount, status FROM unclaimed_transactions ORDER BY id DESC LIMIT 5"
```

## 6. Connect your store
Examples are in `server/client-example/` (`webhook.js`, `webhook.php`).
1. Create a session: `POST <server>/api/v1/payment/create` with header `x-api-key: <STORE_API_KEY>` and JSON `{amount, order_id, provider, redirect_url}`. Send the customer to the returned `checkout_url`.
2. Mark the order paid **only** from the webhook: verify `secure_hash` (HMAC-SHA256 with your webhook secret), compare `amount` with your own order, and make the handler idempotent (webhooks can arrive twice).
3. Never trust the browser redirect as proof of payment.

## Free tier limits and care
- Workers free: 100,000 requests/day; D1 free: 5 GB. The once-a-minute cron uses about 1,440 requests/day. This is plenty for a personal shop.
- Keep the phone charged, online and with the SIM active. If it is off, customers cannot verify until it returns, and the SMS uploads then catch up (they stay queued).
- Rotate `DEVICE_API_KEY`/`DEVICE_SECRET` if the phone is lost: `wrangler secret put …` again, then update the app.
- Be aware this approach depends on SMS wording that bKash/Nagad/Rocket can change, and that these personal-account services may restrict automated use of personal wallets. Check their terms for your situation, and keep amounts and daily volume reasonable.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| App "Test server connection" says unauthorized | wrong `DEVICE_API_KEY` |
| says bad_signature | wrong `DEVICE_SECRET` |
| says stale_request | phone clock is off; enable automatic date & time |
| SMS permission greyed out | do step 5.3 (Allow restricted settings) |
| SMS arrives but nothing uploaded | sender ID not in the list, or the parser did not match; use Parse sample |
| Customer enters TrxID, says not found | amount differs from the session, wrong provider, or SMS not uploaded yet |
| Webhook never reaches the store | check `webhook_url`; the server retries with backoff every minute |
