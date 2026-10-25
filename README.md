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

## 11. Customer accounts, special prices and free bundles

Customers can create an account (phone number + password) on **/account.html**. Buying without an account still works exactly as before.

**For customers**
- Log in to see their own special prices on the store (shown with a green "YOUR PRICE" tag).
- A "Your offers" list with free bundles they can send to any number, notices from the store, and their order history.
- Passwords are hashed (scrypt) and never stored in plain text. Too many wrong passwords locks that number for 15 minutes.

**For the store owner (Admin → Customers)**
- See every customer with their orders and spend this week and all time. Sort by "Top buyers this week" or filter to "3+ orders this week".
- Tick one or many customers, then **Give offer**: a special price for one bundle, a percent discount, or free bundles. Offers belong to the chosen customers only. You can set an end date and a use limit.
- The form warns you if an offer would sell below your cost.
- **Send notice** shows a message in the customer's account.
- Open a customer to cancel an offer, reset a password (a temporary password is shown once), disable the account, or keep a private note.

**How prices are protected:** the price is always worked out on the server from the database. The browser never sends a price, so a customer cannot change it. A free bundle can only be spent once per use, even if the button is tapped several times.

**Free bundles cost you money:** each one is bought from your DataHustle wallet when the customer sends it. They show in Orders as "FREE gift" and reduce your profit figures.

**Limits to know about:** accounts are not verified by SMS, so someone could register using another person's number. Offers are given to the account you choose in admin, so give them to people you know, and use **Reset password** or **Disable account** if a number was taken by the wrong person.

**Settings:** a WhatsApp channel or group link added in Admin → Settings shows a "Join our WhatsApp channel" button on the store.

No new environment variables are needed. Customer logins are signed with `ADMIN_SECRET`. To use a separate secret, set `CUSTOMER_SECRET`. The new database tables are created automatically on first start.

## 12. Second delivery provider: FastDealsGH

DataHustle stays the default. To deliver a network through FastDealsGH instead:

1. Fund your FastDealsGH wallet and add `FASTDEALS_API_KEY` in Render (Environment). Optional: `FASTDEALS_BASE_URL`, `FASTDEALS_MOCK_MODE`.
2. Admin → Settings → Delivery provider: press **Check FastDealsGH** to see matched plans and costs, then pick DataHustle or FastDealsGH for all orders and save. Switch back the same way.
3. Orders remember which provider delivered them (`orders.provider`). FastDeals has no webhook, so a poller checks their order status every 2 minutes.

Note: FastDeals has no idempotency key, so before retrying a timed-out order check their order history first.

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

## 13. Out of stock

The store never switches provider by itself, because the other provider's wallet may be empty or its prices different. It protects customers instead:
1. When a provider answers "out of stock" for a network (or its bundle list shows the network as out), that network is **paused for customers** with the friendly "out of stock" message, and a notice on the admin dashboard says why.
2. Paid orders that were refused wait under review. If the other provider has stock, switch that network in Settings → Delivery provider: the pause lifts and the waiting orders are sent to the new provider automatically.
3. Otherwise the store checks again about every 15 minutes (and every 10 minutes it looks at the provider's bundle list). When stock is back, the pause is removed by itself and a notice tells you.
4. A network you pause by hand is never reopened automatically.

Only a definite "out of stock" answer is handled this way. Timeouts are never retried automatically, to avoid buying the same bundle twice.

**Early warning.** About every 10 minutes the store asks DataHustle and FastDealsGH for their bundle lists and looks for a stock flag. Settings → Delivery provider → **Check stock** shows what each provider reports. Not every provider publishes stock; if it does not, the pause happens the moment an order is refused.

## 14. Customer pays the Paystack fee

By default the Paystack fee (about 1.95%, set `PAYSTACK_FEE_RATE` to change it) is added on top at checkout, so it comes out of the customer's payment instead of your profit. The checkout shows "Bundle GH₵5.00 + payment fee GH₵0.10". The order keeps the bundle price, the fee the customer added, and the fee you bear (the real Paystack fee minus the part the customer paid, usually about zero), so profit figures stay correct. Refunds return everything the customer paid. Turn this off in Settings ("Customer pays the Paystack fee") to absorb the fee yourself. Orders made before this change are unaffected.

## 15. First-time MTN buyers

New MTN numbers must be verified by MTN before data can be delivered (DataHustle and FastDealsGH both queue them, up to 7 days). When a customer picks an MTN bundle for a number that has never received a bundle from this store, a pop-up explains this and asks "Yes, continue" or "No, go back" before payment starts. Numbers that already got a bundle here are not asked. Settings lets you switch the pop-up off or change its wording.

## 16. Checking MTN numbers before payment (FastDealsGH)

When a customer picks an MTN bundle for a number we have never delivered to, the store asks FastDealsGH
whether that number is verified by MTN.

- **Verified** → no pop-up, straight to payment (remembered, so it is not checked again).
- **Not verified** → pop-up: "This number is not verified yet… can take up to 7 days. Continue?"
- **Could not check** (no key, slow, error) → the normal "First time on this number?" pop-up. Buying is never blocked.

Needs `FASTDEALS_API_KEY` in Render. Settings → "Check if an MTN number is verified" lets you test any number.
Switch and message are editable in Settings.

## 17. Orders stuck on "Processing" (DataHustle)

DataHustle tells the store an order is delivered through its webhook, and it switches the webhook off by
itself after repeated failures (for example while the site restarts). The store now:

- checks every 10 minutes and switches DataHustle's delivery updates back on if they are off;
- warns on the dashboard if updates arrive with the wrong `DATAHUSTLE_WEBHOOK_SECRET`;
- shows "N orders stuck on Processing" (DataHustle orders older than 20 minutes) with **Mark delivered**;
- accepts a "delivered" update for an order that was under review after a timeout.

## 18. Result checkers and AFA registration (FastDealsGH API v2)

Page: `/services.html` (linked from the home page when something is on sale). Admin: **Checkers & AFA**.

- Prices: FastDealsGH sets what they charge you (shown as *Cost*); you set your selling price. The difference is your profit.
  A product is only sold when it has a price, is switched on, is in stock and your price is above the cost.
- Payment first (Paystack), then the order goes to FastDealsGH with the order reference as the Idempotency-Key,
  so retries never charge twice. Checker PINs show straight away; AFA is checked every 10 minutes until approved/rejected.
- Sold out / invalid details → automatic Paystack refund. Wallet too low → "stuck" + dashboard alert; top up and press Retry.
- Privacy: Ghana Card number and date of birth are wiped once FastDealsGH has reviewed the registration;
  unpaid checkouts (with their details) are deleted after 2 hours (48 hours at most).
- Uses the same `FASTDEALS_API_KEY`. Sandbox: use a `fdg_test_…` key.

## 19. Letting the database sleep (Neon free plan: 100 compute hours a month)

Neon only counts compute while the database is awake, and puts it to sleep after 5 quiet minutes. If the
monthly allowance runs out, Neon switches the database off until the next billing period and the store stops.

The background checks therefore only touch the database while they have something to do
(`services/workHints.js`): code that creates work (an order waiting for FastDealsGH, a paid checker, an AFA
under review, an unpaid checkout) marks it in memory, and the check stops once nothing is left.

- Store settings are kept in memory (they only change through this server); changes always read the database first.
- FastDealsGH orders are re-checked every 2 minutes for up to a day, then show as "stuck" on the dashboard.
- AFA reviews are checked about once an hour (`AFA_CHECK_MINUTES`); customers opening their order get a fresh answer.
- Unpaid data checkouts are tidied once a day; the order page stops auto-refreshing after about 10 minutes.

When nobody is shopping and nothing is waiting, the database is not touched and can sleep.
