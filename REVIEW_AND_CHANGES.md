# Abrants Data Store — review & upgrade notes

## Short version

**The payment and delivery engine was already good — genuinely better than most first projects I see.** The weak spots were the *admin controls* and the *phone experience*. The admin could only change a price; it couldn't add a bundle, retry a stuck delivery, export data, or recover from a bad state. And the storefront was designed desktop-first with mobile as an afterthought, which is backwards for a Ghanaian data reseller.

I kept your architecture, your colour language (navy + yellow) and your fonts, and rebuilt both interfaces mobile-first. I also closed one real security hole and one real reliability bug.

You can preview everything right now, no database needed:

```
node preview/mock-server.js
```
then open `http://localhost:4173` (storefront) and `http://localhost:4173/admin.html` (dashboard).

---

## What was already strong (don't undo this)

- **Server-side payment verification before delivery.** You re-check the transaction status, exact GHS amount, currency *and* reference with Paystack before handing over data. Many people skip this and get robbed by a spoofed webhook.
- **Idempotent fulfilment.** `claimOrderForFulfillment` atomically moves `pending → paid`, so a webhook and a status-poll can't both buy the same bundle. That's a real race you'd already solved.
- **Raw-body webhook signature checks** for both Paystack (HMAC-SHA512) and DataHustle (HMAC-SHA256), using timing-safe comparison.
- **`delivery_review` for ambiguous errors.** Refusing to auto-refund when a network timeout *might* still have delivered is the correct, careful call.
- **Provider refunds tracked separately from customer refunds.** Subtle and important.
- **HttpOnly signed admin cookie**, login rate limiting, phone+reference required for order history (no enumeration), security headers, `X-Powered-By` off, same-origin CORS by default.
- **PostgreSQL** so orders survive redeploys.

---

## Problems I found and fixed

### Critical

**1. Your wholesale cost was being sent to customers.**
`GET /api/plans` returned the full plan object including `providerCostGHS`. Anyone who opened DevTools could read your exact margin on every bundle. The public endpoint now returns only `id, network, label, capacityGB, validity, priceGHS, pricePerGB`.

**2. Bundles were hardcoded in three separate places.**
`DEFAULT_PLANS` in `services/orderStore.js`, a `VALUES (...)` list inside the `getPlans()` SQL, and a note in the README telling you to edit `routes/api.js`. The admin could change a price but **could not add a bundle at all** — launching a 20GB MTN bundle meant editing SQL. Plans now live entirely in the `store_plans` table with full create/edit/hide/delete from the dashboard.

**3. Admin actions left no trace.**
Refunds, price changes and number blocks were invisible afterwards. If a refund was wrong, you'd have no way to see who did it or when. There's now an `admin_audit` table and an **Activity log** screen.

### Security gap found in follow-up testing

**A blocked number could still complete a purchase.**

Two separate causes, both fixed:

- **The preview never enforced the block list at all.** `preview/mock-server.js` had a `BLOCKED` array that only the admin screens read — `POST /api/checkout` ignored it completely. So in the preview you could block a number and then happily buy with it. That was my bug, introduced when I added the demo checkout. The mock now runs the same gates in the same order as the real route: maintenance → plan valid → phone format → email format → **blocked**.
- **The phone format was normalised in five places, inconsistently.** The server used `.replace(/\s/g,'')` (whitespace only) while the storefront used `.replace(/\D/g,'')` (all non-digits). Any variant the server didn't strip — `055-123-4567`, `(055) 123.4567` — would have failed validation *or*, worse, been looked up against the block list in a different shape from the one it was stored in.

There is now a single exported `normalizePhone()` + `PHONE_RE` in `services/orderStore.js`, used by checkout, order history, block and unblock. `isNumberBlocked()` normalises internally too, so a caller cannot accidentally query with an un-canonical value and get a false "not blocked". Every formatting variant now collapses to one canonical `0XXXXXXXXX`.

**Worth knowing, by design:** the block list is checked at *checkout* only. If a number is blocked after an order was already paid, that order still fulfils. That's deliberate — `confirmAndFulfill` runs the moment Paystack confirms, so by the time you block someone their order has normally shipped, and hard-stopping a paid order would strand your customer's money. Blocking is preventive.

### Reliability

**4. A fast DataHustle webhook could be silently dropped.**
The provider webhook only accepted a transition *from* `processing`. If their webhook arrived before your own database write finished moving the order to `processing`, the event matched zero rows and was discarded — the order would sit in `processing` forever even though the data was delivered. It now accepts the event from `processing` **or** `paid`.

**5. No way to recover a stuck order.**
The README mentioned refunding from the dashboard "if retry needs to happen", but there was no retry button. You now get **Retry delivery**, **Change status** and **Support note** on every order.

**6. Deleting a bundle would have orphaned order history.**
There was no delete endpoint, but the design invited one. Deleting a bundle that already has orders now *hides* it instead of deleting, so past orders keep their context.

**7. Refunds used a fuzzy lookup.**
`getAllOrders({ search: ref, limit: 5 })` then `.find()` — an `ILIKE %ref%` search can match the wrong row if one reference is a prefix of another. Now fetched by exact reference.

### Admin capability gaps

| Was missing | Now |
|---|---|
| Add / edit / hide / delete bundles | Full bundle management |
| Pagination (hard-capped at 100 orders) | Server-side pagination with totals |
| CSV export | Export respects your current filters |
| Date-range + network filters | Both added |
| Wallet low-balance warning | Threshold alert on the dashboard |
| Any chart | 14-day revenue bars + profit line |
| Store announcement to customers | Announcement banner control |
| Support contact for customers | WhatsApp / phone strip on the storefront |
| Pausing the store | Maintenance mode |
| `alert()` for every error | Proper toasts |
| Refetched all 5 endpoints on every click | Only the active screen loads |

### Mobile & UX

**8. Checkout was an inline panel below the plan grid.** On a phone you'd tap a plan and the page would jump; scroll away and you lose the checkout entirely. It's now a **bottom sheet** that slides over the page — the standard mobile pattern, and it feels like an app.

**9. No phone/network mismatch warning.** Ghana numbers are prefix-mapped (020/050 = Telecel, 026/056/027/057 = AirtelTigo, 024/054/055/059 = MTN). A customer could buy an MTN bundle for a Telecel number and the delivery just fails. The checkout now detects the network as they type and warns before they pay.

**10. The admin was unusable on a phone.** Wide tables with horizontal scrolling, and a wrapping row of nav pills that needed scrolling to reach "Orders". Tables now become readable cards under 760px, and the nav is a **fixed bottom tab bar** on phones with a **sidebar** on desktop.

**11. Tap targets were too small.** The "View" button was about 28px tall. Everything interactive is now 44px+ minimum, per Apple/Google guidance.

**12. No `viewport-fit=cover`.** On iPhones with a notch, content sat under the home indicator. Fixed, with `env(safe-area-inset-bottom)` padding throughout — including the sticky bottom bars.

**13. "Loading bundles…" as a loading state.** Replaced with skeleton cards.

**14. Layout bugs I caught while reviewing screenshots.** The admin brand wordmark collided with the wallet pill on narrow phones; the stat grid left one card orphaned on its own row; the "Live" label on bundle toggles clipped at the card edge; the drawer close button sat on the wrong side. All fixed.

**15. The admin logo "A" was rendering at 9px in grey.** `.topbar .brand span` was meant to style the "DATA STORE" subtitle, but `.brand-mark` is also a `<span>` inside `.brand` — and the two-class-plus-element selector outranks `.brand-mark.small`. So the yellow logo badge inherited `font-size:9px`, `color:var(--muted)` and `margin-top:3px`. Scoped the rules to `.topbar .brand>div` so they only touch the text block. (The storefront never had this — it only styles `.brand strong`.)

### Smaller things

- `PAYSTACK_PUBLIC_KEY` is in `.env.example` but never used by the code. Harmless — the redirect flow doesn't need it. Keep it only if you later add Paystack's inline popup.
- `attemptCustomerRefund` checks for `refundStatus === 'queued'`, but nothing ever sets that value. Dead condition; not harmful.
- Your admin error handling swallowed failures silently in several places (`catch(e){}`). Now surfaced as toasts.

---

## New features you now have

**Storefront**
- Bottom-sheet checkout, sticky network tabs, plan cards with **price per GB** and a **BEST VALUE** badge
- Live network detection from the phone prefix
- Skeleton loading, toast notifications, remembered email
- Announcement banner, WhatsApp support strip, FAQ section, PWA manifest ("Add to Home Screen")
- Rebuilt order-tracking page with a **progress stepper** (Payment → Sending → Delivered) and copy-reference

**Admin**
- Overview: revenue, realized profit, today / 7-day / 30-day breakdown, 14-day sales chart, top bundles, network split, alert strips (low wallet, maintenance, mock mode)
- Orders: status chips with live counts, search, network + date filters, pagination, CSV export, and a detail drawer with **retry / refund / force status / support note / full event timeline**
- Bundles: add, edit, hide, delete, price + cost editors with live margin preview
- Blocked numbers: add, search, unblock
- Settings: store name, announcement, support contacts, low-wallet threshold, maintenance mode
- Activity log: every admin action with timestamp and IP

---

## Before you go live — checklist

1. **Verify every price and provider cost** in Bundles & pricing against DataHustle's live `data-packages` response. The seeded values are placeholders and I have not verified them.
2. **Set `PAYSTACK_FEE_RATE`** to your actual rate. It's `0.0195` by default, which is an estimate used only for profit previews — the real fee comes back from Paystack after each payment.
3. **`DATAHUSTLE_MOCK_MODE=true` for testing.** Note: in mock mode no provider webhook ever fires, so orders stay in `processing` forever. That's expected — it's not a bug.
4. **Set `NODE_ENV=production`** when deployed, so the admin session cookie gets the `Secure` flag.
5. **Use a long random `ADMIN_PASSWORD` and a different `ADMIN_SECRET`.** They must not be the same value.
6. **Never commit `.env`.** It's in `.gitignore` — keep it that way.
7. Run a **small real-money test** before switching Paystack to live keys, then confirm both webhooks fire.
8. **Keep your DataHustle wallet funded.** The dashboard now warns you below your threshold — set that threshold to roughly a day's worth of sales.

---

## Remaining gaps worth knowing about

- **No automated tests.** For a payments system that's the biggest long-term risk. If you keep building on this, that's where I'd invest next.
- **Rate limiting is in-memory.** It resets on every redeploy and won't work if you ever run more than one server instance. Fine for one instance.
- **Receipts are sent by Paystack**, not by you. The email field is collected and stored, but your app doesn't send its own confirmation. That's acceptable — just know that's why.
- **One shared admin password.** Fine while it's just you. If you ever hire, you'll want per-user accounts.
- **No WhatsApp/SMS order confirmation.** For your market this is probably the single highest-value feature to add next — customers trust a message more than a web page.
