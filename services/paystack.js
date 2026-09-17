const axios = require('axios');

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

async function initializeTransaction({ email, amountGHS, reference, metadata, callbackUrl }) {
  const res = await paystack.post('/transaction/initialize', {
    email,
    amount: Math.round(amountGHS * 100),
    reference,
    currency: 'GHS',
    metadata,
    callback_url: callbackUrl,
    channels: ['mobile_money', 'card'],
  });
  return res.data.data;
}

async function verifyTransaction(reference) {
  const res = await paystack.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  return res.data.data;
}

// Paystack accepts a transaction reference or transaction id. Refunds are queued;
// the final refund state is delivered by Paystack's refund webhooks.
async function refundTransaction(reference, amountGHS) {
  const body = {
    transaction: reference,
    currency: 'GHS',
    customer_note: 'Refund for an unsuccessful data bundle delivery.',
    merchant_note: `Abrants refund for ${reference}`,
  };
  if (Number.isFinite(Number(amountGHS))) body.amount = Math.round(Number(amountGHS) * 100);
  const res = await paystack.post('/refund', body);
  return res.data.data;
}

module.exports = { initializeTransaction, verifyTransaction, refundTransaction };
