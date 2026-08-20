# Backend services

Both are optional. With neither deployed the game is fully playable: the
leaderboard falls back to local scores and challenge links, and the paid store
is hidden entirely.

Both are Cloudflare Workers, which have a free tier that comfortably covers a
game of this size. You need a Cloudflare account; I cannot create one for you.

---

## 1. Global leaderboard

```bash
cd server
npx wrangler login
npx wrangler kv namespace create SCORES     # paste the id into wrangler.toml
npx wrangler deploy --config wrangler.toml
```

Wrangler prints a URL like `https://gem-quest-leaderboard.<you>.workers.dev`.
Put it in `src/game/config.ts` as `LEADERBOARD_URL`, then `npm run deploy`.

**What it does.** `POST /submit` records a score; `GET /top?level=N` returns the
top 50 for a level, or the all-levels board at `level=0`. One row per player, so
a good player does not fill the board.

**What it cannot do.** The game is open source and runs on the player's device,
so a determined person can post a score they did not earn. The Worker rejects
implausible values, filters names, and rate limits each IP, which stops casual
spoofing. Making it airtight would mean running the game on the server and
replaying every move — a much larger piece of work. Scores are anonymous: a
random device id and whatever name the player types, no accounts, no email.

---

## 2. Payments

This one takes real money, so read this part properly.

```bash
cd server
npx wrangler kv namespace create ORDERS     # paste the id into payments-wrangler.toml
npx wrangler secret put STRIPE_SECRET_KEY --config payments-wrangler.toml
npx wrangler deploy --config payments-wrangler.toml
```

Set `SITE_URL` in `payments-wrangler.toml` to the deployed game, put the Worker
URL in `src/game/config.ts` as `PAYMENTS_URL`, then `npm run deploy`.

**How it works.** The player is sent to a Stripe-hosted checkout page; card
details never touch this game or this Worker. On return, the client asks the
Worker to confirm the session was actually paid before anything is granted, and
each session can be redeemed once. Prices live on the server, so a tampered
client cannot pay a penny for a bundle.

**Before switching it on, note:**

- Entitlements are stored on the device, because the game has no accounts.
  Clearing browser data, or switching phone, loses them. Add sign-in first if
  that is not acceptable — paying customers reasonably expect to keep what they
  bought.
- You become the merchant. Refunds, chargebacks, receipts, and sales tax or VAT
  registration are yours to handle, and the thresholds vary by country.
- Consumer law generally requires a refund policy and clear pricing before
  purchase, shown in the app.
- The game's art is friendly and will attract children. Selling to minors is
  regulated in several places (parental consent, refund rights, and rules on
  making purchases prominent to under-16s). Worth checking before launch.

Test everything with Stripe's test keys and card `4242 4242 4242 4242` first.
