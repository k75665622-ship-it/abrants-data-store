# Abrants Data Store — setup guide

A working data-bundle storefront: customer picks a bundle → pays with MoMo/card  
via Paystack → your server automatically orders it from DataHustle → DataHustle  
confirms delivery via their own webhook.

Built for the tools you already have: Node.js, VS Code, Postman, Git.

> **See the interface first.** You can preview the whole UI with realistic fake  
> data, no database or API keys required:
>
> ```
> node preview/mock-server.js
> ```
>
> Storefront http://localhost:4173 · Admin `http://localhost:4173/admin.html`  
> · Order tracking `http://localhost:4173/order-status.html`  
> Open the storefront URL on your phone (same Wi-Fi) to check the mobile layout.  
> `preview/` is only for looking at the design — the real server is `server.js`.

---

## 1. Install dependencies

```
npm install
```

## 2. Set up your secret keys

```
cp .env.example .env
```

Open `.env` in VS Code and fill in:

- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` — dashboard.paystack.com →  
  Settings → API Keys & Webhooks. Use the `sk_test_...` keys first.  
  (Only the secret key is used by the code; Paystack's redirect flow doesn't  
  need the public key. Keep it if you later add the inline popup.)
- `DATAHUSTLE_API_KEY` — datahustle.shop → Developer → API Keys → generate one  
  (or `POST /api/developer/generate-api-key` in Postman).
- Leave `DATAHUSTLE_MOCK_MODE=true` for now — lets you test the payment/order  
  flow without spending real DataHustle wallet balance.
- `DATAHUSTLE_WEBHOOK_SECRET` — you'll get this in step 6, once deployed.
- `ADMIN_PASSWORD` and `ADMIN_SECRET` — two *different* long random values.

**Never commit `.env` to Git and never paste it into a chat.** It's already  
excluded via `.gitignore`.

## 3. Set up PostgreSQL

Create a PostgreSQL database on your host (Render, Neon, Supabase, Railway,  
etc.) and copy its connection string into `DATABASE_URL`. On startup the app  
creates and migrates every table it needs: `orders`, `order_events`,  
`store_plans`, `store_settings`, `blocked_numbers`, `admin_audit`.

Do not expose `DATABASE_URL` or `ADMIN_PASSWORD` to customers or commit them.

## 4. Fund your DataHustle wallet

DataHustle purchases come out of a prepaid wallet, not per-transaction billing.  
On their dashboard: Add Money → top up via MoMo/card. Check your balance  
anytime with `GET /api/developer/balance` (try it in Postman with header  
`X-API-Key: your_key`).

Set a **low wallet alert threshold** in the admin Settings screen so you get  
warned on the dashboard before deliveries start failing.

## 5. Run it locally

```
npm start
```

Visit `http://localhost:3000`. Pick a bundle, pay with a Paystack test  
card/MoMo number, and watch the order-status page update.

> In mock mode no DataHustle webhook ever fires, so orders stay at  
> `processing` forever. That is expected, not a bug.

### 5b. Preview it without any keys (design demo)

Want to click through the site — or show it to the client — before you have  
Paystack and DataHustle credentials? There's a zero-dependency mock server:

```
node preview/mock-server.js
```

Then open `http://localhost:4173`.

It serves the **real** `public/` folder, so what you see is the actual  
interface — only the API is faked. No PostgreSQL, no keys, no `.env` needed.

What works in the preview:

| Thing | Behaviour |
|---|---|
| Storefront | Real — bundles, network tabs, checkout sheet, live prefix detection |
| **Buying a bundle** | Creates a real (in-memory) order that walks `pending → paid → processing → fulfilled` over ~20 seconds |
| Order tracking | Real — the stepper advances and the page polls itself |
| Admin dashboard | Real — seeded with ~60 fake orders, bundles, blocked numbers, audit log |
| Add / edit bundles | Real — changes show up on the storefront immediately |
| Blocked numbers | Real — a blocked number is refused at checkout in any format |
| Actual money | **Nothing.** No Paystack call, no DataHustle call, nothing is charged |

There's also a smoke test for the checkout gates (blocked numbers, phone
format, unknown/inactive bundles):

```
node preview/test-blocked.js     # run in a second terminal, server must be up
```

Every page served by the preview carries a small **"Preview · no real payments"**  
badge so nobody mistakes it for the live site. That badge is injected by  
`preview/mock-server.js` only — it is not in `public/`, so your production  
pages are untouched.

## 6. Deploy, then wire up both webhooks

You need a real public URL before either webhook works (DataHustle and Paystack  
both need to reach your server, not your laptop).

**Paystack webhook** — dashboard → Settings → API Keys & Webhooks → set:

```
https://your-domain.com/api/webhook/paystack
```

**DataHustle webhook** — call this once in Postman (replace the URL and use  
your real API key):

```
POST https://api.datahustle.shop/api/developer/webhook/configure
Headers: X-API-Key: your_datahustle_api_key
Body:
{
  "url": "https://your-domain.com/api/webhook/datahustle",
  "events": {
    "orderCreated": true,
    "orderProcessing": true,
    "orderCompleted": true,
    "orderFailed": true,
    "orderRefunded": true
  }
}
```

The response includes a `secret` — **copy it immediately, it's shown only  
once** — and paste it into `DATAHUSTLE_WEBHOOK_SECRET` in your deployed  
environment variables. Test it fired correctly with  
`POST /api/developer/webhook/test`.

Once both webhooks are confirmed working, set `DATAHUSTLE_MOCK_MODE=false` and  
switch Paystack to live keys only after a small real-money smoke test. Keep a  
funded DataHustle wallet and verify every live bundle price before launch.

## 7. Deploy it so it's live

Easiest for a first project: [Render.com](https://render.com) (free tier) or  
[Railway.app](https://railway.app).

1. Push this folder to a GitHub repo (`git init`, `git add .`, `git commit`,  
   push).
2. On Render/Railway: "New Web Service" → connect your GitHub repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add every variable from your `.env` into their "Environment Variables"  
   dashboard (never upload the `.env` file itself).
5. Set `NODE_ENV=production` so the admin session cookie gets the `Secure`  
   flag, and `TRUST_PROXY=true` so rate limiting sees the real client IP.
6. Buy a domain (e.g. Namecheap) and point it at your app if you want a  
   custom address instead of the free subdomain.

## 8. Admin dashboard

Open `/admin.html` on your deployed site and sign in with `ADMIN_PASSWORD`.  
Admin authentication uses an HttpOnly signed cookie; never put the admin  
password in a URL or query string.

**Overview** — revenue, realized profit, today / 7-day / 30-day breakdown,  
a 14-day sales chart, your best-selling bundles, a network split, and alerts  
for a low provider wallet, maintenance mode or mock mode.

**Orders** — filter by status chip, search by reference / phone / email /  
provider reference, filter by network and date range, page through history,  
export a CSV of whatever you're currently filtering, and open any order for a  
full detail drawer: **Retry delivery**, **Refund customer**, **force a status**,  
**save a support note**, and the complete event timeline.

**Bundles & pricing** — add a bundle, edit it, hide it from customers, or  
remove it. Set the customer price and the provider cost; the estimated profit  
and margin update live. Deleting a bundle that already has orders *hides* it  
instead, so your order history stays intact.

**Blocked numbers** — block a phone number from starting new checkouts, with a  
reason and search. Numbers are stored in one canonical form, so it doesn't  
matter whether you type `0241497084`, `024 149 7084` or `024-149-7084` — they  
all block the same number, and the customer cannot get around it by typing it  
differently at checkout. Blocking is **preventive**: it stops new purchases, it  
does not cancel an order that has already been paid for.

**Settings** — store name, an announcement banner for the storefront, support  
WhatsApp/phone shown to customers, low-wallet threshold, and maintenance mode  
to pause new checkouts.

**Activity log** — every admin action (price change, refund, retry, block,  
settings edit) with a timestamp and IP address.

## 9. Keep prices current

DataHustle's wholesale prices change. Check current prices anytime:

```
GET https://api.datahustle.shop/api/developer/data-packages
Header: X-API-Key: your_key
```

Then update the **Provider cost** field for each bundle in  
**Bundles & pricing** in the admin dashboard. No code changes needed.

The seeded prices in `DEFAULT_PLANS` (`services/orderStore.js`) are safe  
starting placeholders only — they are inserted once on first run and never  
overwrite anything you change afterwards.

## 10. Testing with Postman

- `POST http://localhost:3000/api/checkout` with body  
  `{ "planId": "mtn-1gb", "phone": "0551234567", "email": "you@example.com" }`  
  to test checkout without touching the UI.
- Hit `GET /api/developer/data-packages` and `/balance` directly against  
  DataHustle to sanity-check your API key works, before wiring anything else.

## Notes

- Orders are stored in PostgreSQL and survive server restarts/redeploys.
- Order lifecycle: `pending` → `paid` → `processing` → `fulfilled`  
  (or `delivery_failed` → `refunding` → `refunded` when the provider  
  explicitly reports failure). An ambiguous provider/network error becomes  
  `delivery_review` so you never accidentally refund a bundle that may still  
  be delivered. Provider-wallet refunds and customer Paystack refunds are  
  tracked separately.
- Only bundles marked **Live** in the admin are shown to customers. The public  
  `/api/plans` endpoint deliberately does not expose your provider cost.
- See `REVIEW_AND_CHANGES.md` for the full audit, what changed and why, and  
  the remaining known gaps.
