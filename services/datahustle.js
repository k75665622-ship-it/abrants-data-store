const axios = require('axios');

const client = axios.create({
  baseURL: 'https://api.datahustle.shop/api/developer',
  timeout: 15000,
  headers: {
    'X-API-Key': process.env.DATAHUSTLE_API_KEY,
    'Content-Type': 'application/json',
  },
});

/**
 * Places a data bundle order. DataHustle accepts this instantly (status:
 * "pending"/"processing") but actual delivery is confirmed later via their
 * webhook (order.completed / order.failed) - see routes/api.js.
 */
async function purchaseData({ network, phone, capacityGB, reference }) {
  if (process.env.DATAHUSTLE_MOCK_MODE === 'true') {
    console.log(`[MOCK] Would order ${capacityGB}GB (${network}) to ${phone} for order ${reference}`);
    return {
      accepted: true,
      transactionReference: `MOCK-TRX-${reference}`,
      purchaseId: `MOCK-${reference}`,
      mock: true,
      priceGHS: null,
    };
  }

  const res = await client.post('/purchase', {
    phoneNumber: phone,
    network,
    capacity: String(capacityGB),
    gateway: 'wallet',
  });

  const ok = res.data?.status === 'success';

  return {
    accepted: ok,
    transactionReference: res.data?.data?.transactionReference || null,
    purchaseId: res.data?.data?.purchaseId || null,
    priceGHS: res.data?.data?.price == null ? null : Number(res.data.data.price),
    raw: res.data,
  };
}

async function getWalletBalance() {
  const res = await client.get('/balance');
  return res.data?.data?.walletBalance;
}

async function getDataPackages(network) {
  const res = await client.get('/data-packages', {
    params: network ? { network } : {},
  });

  return res.data?.data;
}

module.exports = {
  purchaseData,
  getWalletBalance,
  getDataPackages,
};