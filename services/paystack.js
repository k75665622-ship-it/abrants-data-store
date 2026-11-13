const axios = require('axios');

const paystack = axios.create({
  // Always Paystack. PAYSTACK_API_URL exists only so the tests can point at a stand-in.
  baseURL: process.env.PAYSTACK_API_URL || 'https://api.paystack.co',
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

/*
 * Transfers (agent payouts to MoMo). Paystack only lets registered businesses send transfers, takes the amount
 * plus its fee (GH₵1 per MoMo transfer) from the Paystack balance, and may ask for an OTP before sending.
 */
async function createTransferRecipient({ name, accountNumber, bankCode }) {
  const res = await paystack.post('/transferrecipient', {
    type: 'mobile_money', name, account_number: accountNumber, bank_code: bankCode, currency: 'GHS',
  });
  return res.data.data;
}

async function initiateTransfer({ amountGHS, recipient, reference, reason }) {
  const res = await paystack.post('/transfer', {
    source: 'balance', amount: Math.round(Number(amountGHS) * 100), recipient, reference, reason, currency: 'GHS',
  });
  return res.data.data;
}

async function finalizeTransfer(transferCode, otp) {
  const res = await paystack.post('/transfer/finalize_transfer', { transfer_code: transferCode, otp });
  return res.data.data;
}

async function verifyTransfer(reference) {
  const res = await paystack.get(`/transfer/verify/${encodeURIComponent(reference)}`);
  return res.data.data;
}

// -> [{ currency, balance (in GH₵) }]
async function getBalance() {
  const res = await paystack.get('/balance');
  return (res.data.data || []).map((b) => ({ currency: b.currency, balance: Number(b.balance) / 100 }));
}

module.exports = {
  initializeTransaction, verifyTransaction, refundTransaction,
  createTransferRecipient, initiateTransfer, finalizeTransfer, verifyTransfer, getBalance,
};
