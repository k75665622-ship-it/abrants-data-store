// Paystack Ghana takes a flat percentage. When the customer pays the fee, the amount asked from
// Paystack is the price grossed up so that, after Paystack's cut, the store keeps the full price.
function feeRate() { const r = Number(process.env.PAYSTACK_FEE_RATE || 0.0195); return Number.isFinite(r) && r >= 0 && r < 0.5 ? r : 0.0195; }
function chargeFor(priceGHS, customerPays) {
  const price = Number(priceGHS);
  if (!customerPays) return price;
  return Math.ceil(Math.round((price * 100) / (1 - feeRate()) * 1e6) / 1e6) / 100; // round up to the pesewa
}
const round2 = (n) => Math.round(Number(n) * 100) / 100;
module.exports = { feeRate, chargeFor, round2 };
