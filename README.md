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

**Lost updates are caught up.** DataHustle sends each update once and gives the store 10 seconds to answer. If the
store is asleep (Render's free plan), restarting, or the webhook is off or wrongly signed, that update is gone and
the order used to sit on "Processing" until someone pressed **Mark delivered**. Now the store asks DataHustle itself
(`pollProviderOrders` in `services/fulfillment.js`):

- an order still waiting after 2 minutes is looked up with DataHustle's `GET /order-status/{code}`; "completed"
  marks it delivered, "failed" or "refunded" fails it and starts the customer's refund, exactly as the webhook does;
- it runs 20 seconds after the store starts (so anything delivered while it slept is fixed on waking) and then every
  2 minutes while orders are waiting; orders older than 3 days are left for the admin;
- the code that address needs (DataHustle's own "DM-..." order code) is saved in `orders.provider_order_ref`. It is
  taken from the purchase answer, or from any webhook for that order, or looked up in DataHustle's recent orders
  (`GET /usage/history`) by the purchase id / transaction reference DataHustle gave us. Never by phone number;
- that recent-orders list is not documented, so only its "completed" is trusted. A failure (which refunds the
  customer) is only ever taken from the documented order-status answer;
- if an order cannot be found at DataHustle it stays as it is, and the log says which field names DataHustle sent
  (names only), so the lookup can be adjusted.

## 18. Result checkers and AFA registration (FastDealsGH API v2)

Page: `/services.html` (linked from the home page when something is on sale). Admin: **Checkers & AFA**.

- Prices: FastDealsGH sets what they charge you (shown as *Cost*); you set your selling price. The difference is your profit.
  A product is only sold when it has a price, is switched on, is in stock and your price is above the cost.
- Payment first (Paystack), then the order goes to FastDealsGH with the order reference as the Idempotency-Key,
  so retries never charge twice. Checker PINs show straight away; AFA is checked about once an hour until approved/rejected.
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
- Orders a provider has not confirmed (FastDealsGH, or a DataHustle order whose update was lost) are asked about
  every 2 minutes for the first half hour, then every 10 minutes, every 30 minutes after 3 hours and hourly after a
  day (FastDealsGH for a day, DataHustle for 3 days), then show as "stuck" on the dashboard. A new order is always
  looked at straight away.
- The keep-awake request (section 24) is answered from memory and never touches the database.
- AFA reviews are checked about once an hour (`AFA_CHECK_MINUTES`); customers opening their order get a fresh answer.
- Unpaid data checkouts are tidied once a day; the order page stops auto-refreshing after about 10 minutes.

When nobody is shopping and nothing is waiting, the database is not touched and can sleep.

## 20. The home page opens with the get-started content

`public/index.html`, top to bottom (the layout the client asked for):
- A short first screen: "Data. Results. AFA.", one sentence, and **Explore our services**. It is the same for everyone and
  does not change after the page loads.
- **What do you need today?** (`#services`): Buy data, Result checkers (live names and lowest price), MTN AFA registration
  (yellow, full width, opens the AFA explanation), and Need help? (WhatsApp, or a call link if only a phone number is set
  in admin; hidden when neither is set).
- "What is MTN AFA?" (`#afa`), "How buying works", the members promo (guests only), then the store: "Pick a bundle"
  (`#bundles`), why Abrants, FAQ (`#faq`).

Notes:
- The AFA bundle details are what MTN's AFA menu showed in October 2026 (monthly, no data: GH₵10 for 258 MTN minutes,
  30 minutes to other networks, 500 CUG minutes and 25 SMS, 30 days). MTN's help centre still lists older GH₵6 bundles.
  Update `public/index.html` (the AFA card and the AFA section) when MTN changes the offer. The text does not say AFA is
  only for farmers (client's choice).
- There used to be a separate `/welcome.html`; old links to it open the home page (`/welcome.html#afa` lands on the AFA part).

## 21. Security headers (and what the review checked)

Every response carries security headers set in `server.js`, including a **Content Security Policy**. The policy
allows only our own scripts (`script-src 'self'`) and only calls back to our own API (`connect-src 'self'`), so a
script slipped into a page by any future bug cannot run or send data anywhere. `style-src` also allows
`'unsafe-inline'` (a few pages use `style=""` attributes) and Google Fonts; `font-src` allows `fonts.gstatic.com`.

**If you ever add something loaded from another website** (an analytics script, a chat widget, a font or image
host, an embedded video), the browser will block it until you add that address to the matching line of the policy.

`Strict-Transport-Security` (HTTPS only) and `Cross-Origin-Opener-Policy` are also sent; HSTS is only sent when
`NODE_ENV=production`, never in local development over plain http.

**Set `TRUST_PROXY=true` on Render.** The app sits behind Render's proxy, so without it every visitor looks like
the same address and the rate limits (login attempts, checkout, order lookups) cannot tell people apart.

The rest of the protection was reviewed and left as it was, because it was already right: all database queries use
placeholders (`$1`, `$2`) so nothing typed in can become part of a query; admin and customer sessions are signed,
HttpOnly cookies (customer passwords are hashed with scrypt, and a password change invalidates old sessions);
prices are always worked out on the server; orders are signed into the Paystack transaction and verified
server-to-server before anything is delivered; Paystack and DataHustle webhooks are signature-checked; and every
value shown on a page goes through `esc()` first, including the customer-supplied AFA details shown in the admin
dashboard.

## 22. Tracking links for influencers (Admin → Links)

In **Admin → Links** the owner types a name (say "Kwame") and gets a short link like `https://abrantsdata.com/k7m2x`.
The code is random, so nothing in the link says who it is for or that it is tracked; the name only shows in Admin.
One link per influencer opens the whole website (data, AFA and result checkers are all on it), so an influencer is
never asked to promote several links. He sends it to the influencer; the page
shows what that link brought: orders, customers (and how many were new), sales, profit and, if he set an amount per order,
the commission earned. The period can be 7 days, 30 days, this month or all time.

How it works:
- Opening `/k7m2x` (`server.js`) leaves a 10-minute `abrants_from` cookie and redirects to the plain home page.
  `public/js/track.js` moves it into the browser's storage for 30 days (the most recent link wins) and removes the
  cookie; `app.js` / `services.js` send it with checkout. The codes of the saved links are held in memory, so opening
  a link never reads the database. They are loaded when the store starts.
- Codes are 5 random characters (no i, l, o, 0, 1). A code can never be the name of a real page or folder (`admin`,
  `api`, `services`, ...). Unknown or deleted codes give the normal "not found" page.
- Old links like `/?from=kwame` keep working, and the address is tidied to `/` once the page opens. Links that were
  made before this change keep their old code, now opened as `/kwame`; make a new link for a hidden one.
- The tag is lowercase letters, digits, `-` and `_`, 40 at most; anything else is ignored.
- It is saved on the order in `orders.campaign` and `service_orders.campaign`. For data bundles it travels inside the
  signed order details, so it cannot be changed on the way through Paystack. Do not confuse it with the older
  `orders.source`, which means store order vs free gift.
- Only **paid** orders count (same statuses as the dashboard's revenue; checkers and AFA once paid and not refunded).
  A customer is **new** when that was their first paid order here, ever, whatever period is shown.
- Deleting a link stops it working but keeps its orders; they show under "Tags not saved as links". A tag typed by hand (for example
  `?from=tiktok`) shows there too, with a "Save as link" button, so no order is ever hidden.
- Each order's detail in Admin shows the link it came from, and the orders CSV has a new last column, `Link`.

What it does **not** do: count clicks. That would write to the database on every visit and keep the Neon database awake
(section 19). Opening a link writes nothing; the database is only touched when someone buys. An order is missed when the
buyer opens the link on one phone and buys on another, or clears their browser first.

## 23. Your own address, not the Render one (SITE_URL)

Render gives the store an address like `abrants-data-store.onrender.com` as well as your own domain. Both work. Set
**`SITE_URL`** in Render (Environment) to `https://abrantsdata.com` (no slash at the end) and:
- links made in **Admin → Links** always use the real domain, even if you opened Admin on the Render address;
- anyone who opens a page on the Render address is sent to the real domain, keeping the tag in the address. Only page
  visits are redirected (GET, and never `/api`), so Paystack and DataHustle webhooks keep working wherever they point.
  Render's health check counts a redirect as healthy, so deploys are not affected.

Without `SITE_URL` nothing changes, except that Admin → Links warns when it was opened on an `onrender.com` address.

## 24. Staying awake on Render's free plan

A free Render web service is put to sleep after 15 minutes without a visitor. The next visitor waits about a minute
on Render's loading screen, and a sleeping store cannot answer DataHustle's delivery updates (section 17).

`services/keepAwake.js` asks for the store's own `/api/ping` page every 10 minutes through its public address
(`RENDER_EXTERNAL_URL`, which Render sets by itself; otherwise `SITE_URL`). Render sees a visit and leaves the store
running. Nothing needs setting up: it starts by itself on Render and does nothing on your own computer.

- `/api/ping` answers "ok" from memory. No database, so Neon still sleeps when nobody is buying.
- It cannot wake a store that is already asleep (nothing runs then). The first visitor does, and from then on it
  stays awake. Render also restarts free services now and then; the store comes back by itself.
- Free hours: Render gives a workspace 750 free hours a month and one store running all month uses up to 744.
  **A second free web service in the same workspace would push it over**, and Render then suspends free services
  until the next month. Keep only this one, or move to a paid instance.
- On a paid instance it changes nothing. `KEEP_AWAKE=false` switches it off; `KEEP_AWAKE_URL` picks another address.
- An outside monitor (for example UptimeRobot, free) pointed at `https://your-domain/api/ping` every 5 minutes does
  the same job from outside and also tells you if the store goes down. Optional.

Render's free instances are meant for trying things out. For a shop taking payments the paid instance is the safer
home: no sleeping, no monthly hour limit.

## 25. Agents (Admin → Agents)

People sign up at `/agent`, get their own shop link (`abrantsdata.com/s/kwame-data-hub`) and sell everything the
store sells: data, result checkers and AFA. **Off until the owner switches it on** in Admin → Agents.

**Money**
- The owner sets an **agent price** per product (or "X% below store price for all"). Empty = the store price.
- Each agent sets their own selling price: never below their agent price, no upper limit. Their shop shows their prices.
- The agent earns *selling price − agent price*. When the store pays the Paystack fee, the agent's part of the fee
  (1.95% of what they added) comes off their earning; when the customer pays it, they keep it all. Either way the store
  takes exactly what it would on a sale at the agent price. Profit figures in Admin leave out the agents' share.
- The earning is saved on the order (`agent_id`, `agent_base_ghs`, `agent_earning_ghs`, signed with the rest of the order
  so it cannot be changed through Paystack). It becomes the agent's when the order is delivered (checker PINs sent, AFA
  approved), then waits the **hold** (24 hours by default) before it can be paid. Failed or refunded orders earn
  nothing; if the agent was already paid for one, the same amount comes off their next payout (`agent_earnings`).

**Payouts** (to the agent's MoMo)
- *I pay them by MoMo*: the owner sends it himself and presses "I paid …" (or "Mark everyone due as paid").
- *Paystack sends it*: Paystack Transfers, from the Paystack balance, GH₵1 per MoMo transfer. Paystack only allows
  transfers for **registered businesses**, the balance must hold the money, and if OTP is on Paystack sends a code that
  is typed in Admin (or switch OTP off in Paystack's Preferences). Weekly automatic payouts are optional (from 10:00 on the
  chosen day). Paystack reports the result (`transfer.success`, `transfer.failed`, `transfer.reversed`) to the webhook URL
  the store already uses.
- A payout covers everything ready, minus the payout fee (setting, GH₵1 by default). "Pay everyone due" only pays agents
  above the minimum (GH₵20 by default) and waits a day after an agent changes their MoMo number.
- A payout with no clear answer from Paystack is never retried blindly: "Check" asks Paystack; failed or reversed
  payouts go back into the agent's balance.

**Shops**: a shop link opens the agent's own shop page (section 27). The store's own accounts and offers are not there.
The shop is remembered for that browser tab (`js/shop.js`), so the checker/AFA page and the order page after paying carry
the shop's name and lead back to it; opening abrantsdata.com itself leaves the shop. Paused, closed or deleted shops, and
the programme switched off, show a polite "This shop is closed" page with a link to the store.

**Neon**: agents are kept in memory, so opening a shop link costs no database query. The database is used when someone
buys, when an agent or the owner opens their pages, and on payout day.

**Sign-up**: agents read the terms (`/agent-terms.html`, also shown as a pop-up whose "I agree" only works once read to
the end). The accepted version is saved (`agents.terms_version`, `TERMS_VERSION` in `services/agents.js`). After changing
the terms, bump `TERMS_VERSION` and update the date on the page: every agent then sees "The agent terms have changed" on
their dashboard until they read and accept them. With SMS set up (section 26), sign-up also needs a 6-digit code texted to
the agent's phone. One MoMo number belongs to one agent.

**Approving**: the store pays only into the MoMo number on the account, so before approving, start a MoMo transfer to that
number and check that the name shown matches the agent's name, then cancel it. Admin reminds you when you press Approve.

## 26. Text messages (SMS, mNotify)

The store texts customers and agents from its own name. Off until `MNOTIFY_API_KEY` is set; nothing else changes without it.

**Set up** (once), in the mNotify app (app.bms.africa):
1. Wallet → Load Wallet, then Purchase Bundle to turn the money into texts. "Non-expiry" texts never run out; "Expiry"
   ones are cheaper but end with the month.
2. Sender IDs → Add Sender ID: `ABRANTS` (at most 11 letters), with what it is for. Approval takes 15–50 minutes.
3. Your account (top right) → Developer → V2.0 → Create API key, then switch the key on under Actions.
4. Render → Environment: `MNOTIFY_API_KEY` = that key (and `SMS_SENDER` if the approved name is not `ABRANTS`). Never
   paste the key anywhere else.

Admin → Settings → Text messages shows which company sends, the texts left and the last messages, sends a test SMS and
switches customer or agent messages off. **Low credit**: mNotify says how many texts are left with every message; under
50 (`SMS_LOW_CREDIT`) a notice appears on the Admin dashboard, and another when texts stop. Without credit customers get
no texts and nobody can sign up as an agent (the sign-up code is a text), so top up before it runs out.

Arkesel still works: with `ARKESEL_API_KEY` set and no `MNOTIFY_API_KEY` (or `SMS_PROVIDER=arkesel`), texts go through
Arkesel as before (`services/sms.js`).

**What is sent**
- Data: when the order is placed with the network, when it is delivered (with the link to buy again) and when it
  cannot be delivered (refund). Each one once per order, even when the network reports the same thing twice.
- Result checkers: the Serial and PIN of every checker. AFA: received, approved (with the AFA ID), rejected or refunded.
- Agents: the sign-up code, approved (with their shop link), paused (with the reason and until when), reopened, closed or
  deleted, strikes, messages from the store (section 27), and every payout.
- MoMo numbers: at sign-up, a MoMo number that is not the agent's phone gets its own code (two code boxes), so payouts
  only go to a real number the agent can use. Changing the MoMo number later (Settings) sends a code to the new number
  first (unless it is their own phone), then tells their phone that it changed. Payouts to a new number still wait a day.
  Codes work once, for the number they were sent to, at most 3 per number in 30 minutes, and never show in Admin.
- Orders from an agent's shop are sent in the agent's shop name.

Messages use plain characters only (`GHS`, not `GH₵`) so each fits in one SMS (160 characters). Sending happens in the
background: a slow or failing SMS never holds up a payment, a delivery or a page. Network errors are tried once more.

## 27. The agent's own shop, "My shop", strikes and deleting

**The shop page** (`/s/kwame-data-hub`, `public/shop.html`, `css/shop.css`, `js/shop-page.js`): a market stall. A striped
awning over a signboard in the agent's colour with their logo or photo, shop name and a few words about them, WhatsApp and
Share buttons, their announcement, then a price board: data by network (their "Popular" ones first), result checkers and
AFA, at their prices. The checkout is the store's own (`js/app.js`). The server writes the shop's name, description and logo
into the page (`services/agentShop.js`), so a link shared on WhatsApp previews with the shop's own name. When the agent
opens their own shop, the WhatsApp button becomes **Manage my shop**.

**Customers stay in the shop** (`js/shop.js`): a shop has its own order page (`/s/kwame-data-hub/order`) and checker/AFA
page (`/s/kwame-data-hub/services`), and Paystack sends customers back there after paying. On those pages the header,
footer, tab title and help link are the shop's, and every link that would lead to the store's own pages (home, account,
order page, checker page) leads to the shop's instead, including links a page adds later. The shop page itself has no
link to the store. Only a closed shop points customers to the store, because it cannot sell. Opening the store's own
address (abrantsdata.com) leaves the shop.

**My shop for the agent** (`/agent`, `js/agent-dash.js`): Home (money, today/this week/this month, latest sales),
Prices (their price, shown or hidden in the shop, "Popular", 6 at most), My shop (logo or photo, 8 colours, about line,
announcement, WhatsApp, with a live picture of the signboard), Money (sales and payouts), Inbox, and Settings (MoMo,
password, log out, **Delete my shop**). A QR poster (shop colour, name, QR code and link) can be downloaded for WhatsApp
status or printing. Logos are cut square and shrunk to 320 × 320 in the browser before upload (150 KB at most).

**Home page**: someone logged in as an agent sees their shop instead of "Become an agent", and a shop button in the bar at
the bottom (`js/myshop.js`, only for browsers where an agent has logged in).

**Admin → Agents → an agent**: Send a message, Give a strike, Pause the shop (1 week, 2 weeks, 1, 3 or 6 months, or until
you reopen it), Delete the shop, Remove logo. "Message all agents" at the top. Every one of these goes to the agent's Inbox
and by SMS (section 26). A strike carries the reason; the third one says the shop can be paused or deleted next time. A
strike given by mistake can be removed. A timed pause reopens by itself when the time is up (checked every 5 minutes,
from memory). The admin decides what happens after strikes.

**Deleting** (`services/agentCare.js`): the shop closes at once. When nothing is owed, it is deleted straight away;
otherwise the agent is paid first ("Pay everyone due" pays them whatever the minimum), then it is deleted. Deleting erases
the name, phone, password, MoMo details, logo, about line and messages; sales and payout records stay. The link stays
reserved so nobody can take it over. The admin can delete without paying (fraud: unpaid earnings are cancelled and later
deliveries earn nothing) and can stop the phone and MoMo numbers from signing up again (kept only as hashes).

**Neon**: opening a shop page, its logo (after the first time), the home page's "My shop" and the agent's inbox when
nothing is new read nothing from the database. The 5-minute check reads it only when a pause is due to end.

**Switching every shop off** (Admin → Agents → the "Agent programme" switch): you first say why and whether shops come
back (soon, on a date, or never). Every agent gets it in their Inbox and by SMS (unless you untick it), sees a pop-up the
next time they open their page, and sees the reason on their own shop page. Customers see "This shop is closed right now"
and, if you gave one, when it is back. With a date, shops switch back on by themselves that day (from 06:00), and agents
are told. Switching back on by hand tells them too.

## 28. Chat with us (Admin → Inbox, and each agent's Inbox → Customers)

A "Chat with us" button on the store, the checker/AFA page, the order page, the account page, the agent page and every
agent shop (`js/chat.js`, `css/chat.css`, `services/chat.js`, `routes/chat.js`). Website only, never SMS.

- **Whose chat it is**: on the store's own pages the chat is with Abrants (Admin → Inbox). Inside an agent's shop (the shop
  page and its order and checker pages) it is with that agent: the chat shows the shop's name, logo and colour, and the
  agent answers in their Inbox → Customers (`js/agent-chats.js`). Abrants does not see those chats. One browser can have
  a chat with Abrants and with each shop, kept apart (one cookie each). The agent on their own shop, or a closed shop,
  chats with Abrants. Deleting a shop deletes its customers' chats.
- **The agent's side**: Inbox has Customers (their shop's chats, with an unread count) and From Abrants. A chat shows as
  "Customer K7M2QD", with the phone number if they gave one; About shows their orders in this shop only. Ready-made
  replies, Mark done, Delete. On a phone an open chat fills the screen. "My shop" on the home page and the agent page
  count waiting chats.

- **Who is writing**: a logged-in agent shows as their shop; a logged-in customer by name, phone and email; anyone else
  as "Visitor K7M2QD" (a chat ID with no 0/O or 1/I). A visitor's chat stays in that browser for a year (a cookie), so
  closing the browser and coming back shows the same chat. A visitor who later logs in keeps their chat. Visitors can
  give the phone number they used for an order when they start.
- **What the admin sees** (Admin → Inbox, `admin-inbox.js`): every chat, newest first, unread ones marked, with filters
  (Unread, Agents, Customers, Visitors, Done) and search. "About" shows their phone, email, chat ID, the page or shop they
  wrote from, and their latest orders (by their phone number and the last order this browser made). Ready-made replies,
  Mark done (it reopens if they write again), Delete. The menu shows how many chats are unread; the website shows
  "Online now" while the admin has Admin open.
- **Settings** (bottom of the Inbox): switch the chat button off, and how long chats with no new message are kept
  (7, 30 or 90 days; 30 by default). Old chats are deleted once a day.
- **Neon**: chats and unread counts are kept in memory. The checks the pages make every few seconds (and the button on
  every page), for customers, Admin and agents alike, are answered from memory. The database is used when a message is sent, when someone reads new messages,
  and when a chat is opened for the first time after the server starts. Messages are small (a few hundred bytes each).
- **Limits**: 1000 characters per message; 20 messages in 5 minutes per chat; 8 new chats an hour from one place.

## 29. Activity log (Admin → Activity log)

Every admin action in plain words, grouped by day ("Refunded order DB-… (GH₵5.00)", "Paused Kwame Data Hub for
1 month", "Changed the store settings: Maintenance mode: switched on"), with a filter by kind and a search
(`admin-activity.js`). Settings changes record only what actually changed.
