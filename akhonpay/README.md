# Akhonpay

Self-hosted payment gateway for personal bKash / Nagad / Rocket accounts. No official merchant API needed.

- `server/`  Cloudflare Worker + D1: API, checkout page (English/বাংলা, dark mode), signed webhooks
- `android/` Kotlin SMS forwarder app (built free by GitHub Actions)
- `tests/`   end-to-end suite: `npm test` (local) or `npm run test:live` (deployed)
- `docs/DEPLOY.md`  step-by-step free deployment (GitHub + Cloudflare)

Start with `docs/DEPLOY.md`.
