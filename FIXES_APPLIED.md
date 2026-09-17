# Abrants Data Store — fixes applied

This version keeps the original architecture and hardens the payment/fulfilment flow.

## Important changes

- Prevented duplicate DataHustle purchases when the Paystack webhook and order-status polling happen at the same time.
- Server now verifies Paystack payment status, exact GHS amount, currency, and reference before delivering data.
- Stores the actual Paystack fee returned by transaction verification when available.
- Paystack and DataHustle webhook bodies are verified from their raw request bytes.
- Added asynchronous Paystack customer-refund handling and refund-status webhook tracking.
- Provider-wallet refund events are no longer incorrectly treated as proof that the customer was refunded.
- Explicit provider delivery failures can trigger a Paystack refund; ambiguous network/API errors become `delivery_review` instead of an unsafe automatic refund.
- Added an admin refund button for failed/review orders.
- Added admin login rate limiting and checkout/order-history rate limiting.
- Removed the public phone-only order-history enumeration risk: history lookup now requires both phone number and order reference.
- Added safer browser security headers and disabled Express `X-Powered-By`.
- CORS is same-origin by default and can be explicitly enabled with `CORS_ORIGIN`.
- Fixed missing `updatePlanProviderCost` export.
- Fixed the old `DATAHUB_MOCK_MODE` typo.
- Added database fields for refund ID/status and delivery-review state.
- Updated default wholesale costs/customer prices to safe starting values. These are starting values only; verify your actual DataHustle API prices before launch.

## Before going live

1. Copy `.env.example` to `.env` and enter your real values.
2. Keep `DATAHUSTLE_MOCK_MODE=true` while testing the payment flow.
3. Deploy to a public HTTPS URL.
4. Configure the Paystack webhook at `/api/webhook/paystack`.
5. Configure the DataHustle webhook at `/api/webhook/datahustle` and set its generated secret.
6. Confirm both webhook signatures work.
7. Test a real/sandbox payment and verify the order lifecycle.
8. Only then set `DATAHUSTLE_MOCK_MODE=false`.
9. Verify every live DataHustle wholesale cost and customer selling price before accepting real orders.
10. Do not upload or commit `.env`.

## Important

The archive supplied for the patch intentionally excludes `.env` and `node_modules` so secrets and unnecessary binaries are not redistributed.
