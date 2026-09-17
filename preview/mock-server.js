/*
 * Abrants Data Store — design preview server
 * ------------------------------------------
 * Serves the real `public/` folder with a fully mocked API so you can click
 * through the storefront and the admin dashboard WITHOUT PostgreSQL, Paystack
 * or DataHustle credentials.
 *
 *   node preview/mock-server.js        ->  http://localhost:4173
 *
 * This file is for previewing the interface only. The real server is server.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PREVIEW_PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ data */

let PLANS = [
  { id: 'mtn-1gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 1, label: '1GB', validity: '30 days', priceGHS: 5.0, providerCostGHS: 4.2, active: true, sortOrder: 1010 },
  { id: 'mtn-2gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 2, label: '2GB', validity: '30 days', priceGHS: 10.0, providerCostGHS: 8.8, active: true, sortOrder: 1020 },
  { id: 'mtn-5gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 5, label: '5GB', validity: '30 days', priceGHS: 25.0, providerCostGHS: 22.3, active: true, sortOrder: 1050 },
  { id: 'mtn-10gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 10, label: '10GB', validity: '30 days', priceGHS: 45.0, providerCostGHS: 41.0, active: true, sortOrder: 1100 },
  { id: 'telecel-5gb', network: 'Telecel', networkCode: 'TELECEL', capacityGB: 5, label: '5GB', validity: '30 days', priceGHS: 22.0, providerCostGHS: 19.5, active: true, sortOrder: 2050 },
  { id: 'telecel-10gb', network: 'Telecel', networkCode: 'TELECEL', capacityGB: 10, label: '10GB', validity: '30 days', priceGHS: 40.0, providerCostGHS: 36.5, active: true, sortOrder: 2100 },
  { id: 'at-5gb', network: 'AirtelTigo', networkCode: 'AT_PREMIUM', capacityGB: 5, label: '5GB', validity: '30 days', priceGHS: 22.0, providerCostGHS: 19.5, active: true, sortOrder: 3050 },
  { id: 'at-10gb', network: 'AirtelTigo', networkCode: 'AT_PREMIUM', capacityGB: 10, label: '10GB', validity: '30 days', priceGHS: 42.0, providerCostGHS: 38.5, active: false, sortOrder: 3100 },
];

let SETTINGS = {
  storeName: 'Abrants Data Store',
  announcement: 'Festive offer: 10GB for GH₵45 on MTN. Valid while stock lasts.',
  announcementEnabled: true,
  supportWhatsapp: '233551234567',
  supportPhone: '0551234567',
  maintenanceMode: false,
  maintenanceMessage: 'We are doing a quick upgrade. Please check back in a few minutes.',
  lowWalletThreshold: 100,
};

let BLOCKED = [
  { phone: '0201112223', reason: 'Repeated chargebacks', createdAt: daysAgo(3) },
  { phone: '0559998887', reason: 'Fraudulent card', createdAt: daysAgo(11) },
];

/* Mirror the real API's phone handling. Both the block list and checkout must
 * agree on the canonical form, otherwise a blocked number slips through. */
function normalizePhone(value) {
  return String(value == null ? '' : value).replace(/[\s-]/g, '');
}

function isBlocked(phone) {
  return BLOCKED.some(function (b) { return b.phone === phone; });
}

const AUDIT = [
  { action: 'settings.update', details: { announcementEnabled: true }, ip: '127.0.0.1', createdAt: hoursAgo(2) },
  { action: 'plan.update', details: { planId: 'mtn-10gb', changes: { priceGHS: 45 } }, ip: '127.0.0.1', createdAt: hoursAgo(20) },
  { action: 'order.refund', details: { reference: 'DB-1757000000000-a1b2c3', amount: 25 }, ip: '127.0.0.1', createdAt: hoursAgo(30) },
  { action: 'number.block', details: { phone: '0201112223' }, ip: '127.0.0.1', createdAt: daysAgo(3) },
  { action: 'orders.export', details: { rows: 48, status: 'all' }, ip: '127.0.0.1', createdAt: daysAgo(5) },
];

const STATUS_POOL = [
  'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled',
  'processing', 'processing', 'paid', 'pending', 'delivery_failed', 'delivery_review', 'refunded', 'refunding',
];

const PHONES = ['0244123456', '0551234567', '0209876543', '0265551234', '0543219876', '0591234567', '0567891234'];
const NAMES = ['Kwame A.', 'Ama B.', 'Yaw M.', 'Akosua D.', 'Kojo T.', 'Abena S.', 'Nana K.'];

let seed = 20260917;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick(list) { return list[Math.floor(rand() * list.length)]; }

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
function hoursAgo(n) { return new Date(Date.now() - n * 3600000).toISOString(); }

const ORDERS = [];
(function buildOrders() {
  let counter = 0;
  for (let day = 13; day >= 0; day--) {
    const perDay = 2 + Math.floor(rand() * 5);
    for (let i = 0; i < perDay; i++) {
      counter++;
      const plan = pick(PLANS.slice(0, 7));
      const status = pick(STATUS_POOL);
      const created = new Date(Date.now() - day * 86400000 - Math.floor(rand() * 20) * 3600000);
      const price = plan.priceGHS;
      const cost = plan.providerCostGHS;
      const fee = Math.round(price * 0.0195 * 100) / 100;
      const settled = ['paid', 'processing', 'fulfilled'].indexOf(status) !== -1;
      ORDERS.push({
        id: counter,
        reference: 'DB-' + (1757000000000 + counter * 9173) + '-' + Math.floor(rand() * 0xffff).toString(16).padStart(4, '0'),
        planId: plan.id,
        network: plan.network,
        networkCode: plan.networkCode,
        capacityGB: plan.capacityGB,
        label: plan.label,
        priceGHS: price,
        providerCostGHS: cost,
        paymentFeeGHS: settled ? fee : fee,
        estimatedProfitGHS: Math.round((price - cost - fee) * 100) / 100,
        phone: pick(PHONES),
        email: 'customer' + counter + '@example.com',
        status,
        providerReference: ['pending', 'paid', 'delivery_failed', 'delivery_review'].indexOf(status) === -1 ? 'DH-TRX-' + (90000 + counter) : null,
        purchaseId: null,
        trackingId: status === 'fulfilled' ? 'TRK-' + (50000 + counter) : null,
        refundId: status === 'refunded' ? 'RF-' + counter : null,
        refundStatus: status === 'refunded' ? 'processed' : (status === 'refunding' ? 'pending' : (status === 'delivery_failed' ? 'needs_manual_refund' : null)),
        adminNote: counter % 11 === 0 ? 'Customer called — number was ported. Checked and redelivered.' : null,
        createdAt: created.toISOString(),
        updatedAt: created.toISOString(),
      });
    }
  }
  ORDERS.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
})();

/* ------------------------------------------------------- demo checkout
 * A checkout in the preview creates a real (in-memory) order that advances
 * through the lifecycle over ~14 seconds, so the tracking page and the admin
 * dashboard both show the whole flow actually working. No Paystack, no
 * DataHustle, no database. This exists purely so the interface can be demoed.
 */

const DEMO_TIMELINE = [
  { after: 0, status: 'pending' },
  { after: 5000, status: 'paid' },
  { after: 11000, status: 'processing' },
  { after: 20000, status: 'fulfilled' },
];

let demoCounter = 0;

function createDemoOrder(plan, phone, email) {
  demoCounter += 1;
  const fee = Math.round(plan.priceGHS * 0.0195 * 100) / 100;
  const order = {
    id: 'demo-' + demoCounter,
    reference: 'DB-' + Date.now() + '-' + Math.floor(rand() * 0xffff).toString(16).padStart(4, '0'),
    planId: plan.id,
    network: plan.network,
    networkCode: plan.networkCode,
    capacityGB: plan.capacityGB,
    label: plan.label,
    priceGHS: plan.priceGHS,
    providerCostGHS: plan.providerCostGHS,
    paymentFeeGHS: fee,
    estimatedProfitGHS: Math.round((plan.priceGHS - (plan.providerCostGHS || 0) - fee) * 100) / 100,
    phone: phone || '0551234567',
    email: email || 'preview@example.com',
    status: 'pending',
    providerReference: null,
    purchaseId: null,
    trackingId: null,
    refundId: null,
    refundStatus: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    demo: true,
    demoStartedAt: Date.now(),
  };
  ORDERS.unshift(order);
  return order;
}

function advanceDemoOrder(order) {
  if (!order || !order.demo) return order;
  const elapsed = Date.now() - order.demoStartedAt;
  let status = 'pending';
  DEMO_TIMELINE.forEach(function (step) { if (elapsed >= step.after) status = step.status; });
  if (status !== order.status) {
    order.status = status;
    order.updatedAt = new Date().toISOString();
    if (status === 'processing') order.providerReference = 'DH-TRX-DEMO';
    if (status === 'fulfilled') order.trackingId = 'TRK-DEMO';
  }
  return order;
}

function stats() {
  const settled = ORDERS.filter(function (o) { return ['paid', 'processing', 'fulfilled'].indexOf(o.status) !== -1; });
  const count = function (s) { return ORDERS.filter(function (o) { return o.status === s; }).length; };
  const sum = function (list, fn) { return list.reduce(function (t, o) { return t + fn(o); }, 0); };

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const window = function (days) {
    return ORDERS.filter(function (o) { return new Date(o.createdAt) >= new Date(Date.now() - days * 86400000); });
  };
  const period = function (list) {
    const ok = list.filter(function (o) { return ['paid', 'processing', 'fulfilled'].indexOf(o.status) !== -1; });
    return {
      orders: list.length,
      revenue: sum(ok, function (o) { return o.priceGHS; }),
      profit: sum(ok, function (o) { return o.estimatedProfitGHS || 0; }),
      delivered: list.filter(function (o) { return o.status === 'fulfilled'; }).length,
      failedOrRefunded: list.filter(function (o) { return ['delivery_failed', 'refunded'].indexOf(o.status) !== -1; }).length,
    };
  };

  const series = [];
  for (let d = 13; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400000);
    const dayKey = day.toISOString().slice(0, 10);
    const list = ORDERS.filter(function (o) { return o.createdAt.slice(0, 10) === dayKey; });
    const ok = list.filter(function (o) { return ['paid', 'processing', 'fulfilled'].indexOf(o.status) !== -1; });
    series.push({
      day: dayKey,
      orders: list.length,
      revenue: sum(ok, function (o) { return o.priceGHS; }),
      profit: sum(ok, function (o) { return o.estimatedProfitGHS || 0; }),
    });
  }

  const month = window(30);
  const monthOk = month.filter(function (o) { return ['paid', 'processing', 'fulfilled'].indexOf(o.status) !== -1; });
  const byPlan = {};
  month.forEach(function (o) {
    const key = o.planId;
    if (!byPlan[key]) byPlan[key] = { planId: o.planId, network: o.network, label: o.label, orders: 0, revenue: 0, profit: 0 };
    byPlan[key].orders++;
    if (['paid', 'processing', 'fulfilled'].indexOf(o.status) !== -1) {
      byPlan[key].revenue += o.priceGHS;
      byPlan[key].profit += o.estimatedProfitGHS || 0;
    }
  });

  const byNetwork = {};
  month.forEach(function (o) {
    if (!byNetwork[o.network]) byNetwork[o.network] = { network: o.network, orders: 0, revenue: 0 };
    byNetwork[o.network].orders++;
    if (['paid', 'processing', 'fulfilled'].indexOf(o.status) !== -1) byNetwork[o.network].revenue += o.priceGHS;
  });

  return {
    total: ORDERS.length,
    pending: count('pending'), paid: count('paid'), processing: count('processing'),
    fulfilled: count('fulfilled'), deliveryFailed: count('delivery_failed'),
    deliveryReview: count('delivery_review'), refunding: count('refunding'), refunded: count('refunded'),
    revenue: sum(settled, function (o) { return o.priceGHS; }),
    estimatedProfit: sum(settled, function (o) { return o.estimatedProfitGHS || 0; }),
    realizedProfit: sum(ORDERS.filter(function (o) { return o.status === 'fulfilled'; }), function (o) { return o.estimatedProfitGHS || 0; }),
    last24h: window(1).length,
    last7d: window(7).length,
    last30d: window(30).length,
    periods: { today: period(ORDERS.filter(function (o) { return new Date(o.createdAt) >= startOfToday; })), week: period(window(7)), month: period(window(30)) },
    series,
    networks: Object.keys(byNetwork).map(function (k) { return byNetwork[k]; }).sort(function (a, b) { return b.revenue - a.revenue; }),
    topBundles: Object.keys(byPlan).map(function (k) { return byPlan[k]; }).sort(function (a, b) { return b.revenue - a.revenue; }).slice(0, 6),
    wallet: 742.55,
    mockMode: true,
    lowWallet: false,
    lowWalletThreshold: SETTINGS.lowWalletThreshold,
    maintenanceMode: SETTINGS.maintenanceMode,
  };
}

/* --------------------------------------------------------------- helpers */

function send(res, status, body, type) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (chunk) { raw += chunk; });
    req.on('end', function () {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); }
    });
  });
}

/* Public shape only - the real API never sends providerCostGHS to the browser. */
function withPerGB(plan) {
  return {
    id: plan.id, network: plan.network, networkCode: plan.networkCode,
    capacityGB: plan.capacityGB, label: plan.label, validity: plan.validity,
    priceGHS: plan.priceGHS,
    pricePerGB: plan.capacityGB > 0 ? plan.priceGHS / plan.capacityGB : plan.priceGHS,
  };
}

/* ------------------------------------------------------------------ api */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  /* ---- storefront ---- */

  if (p === '/api/plans') {
    return send(res, 200, PLANS.filter(function (x) { return x.active; }).map(withPerGB));
  }

  if (p === '/api/settings') {
    return send(res, 200, {
      storeName: SETTINGS.storeName,
      announcement: SETTINGS.announcement,
      announcementEnabled: SETTINGS.announcementEnabled,
      supportWhatsapp: SETTINGS.supportWhatsapp,
      supportPhone: SETTINGS.supportPhone,
      maintenanceMode: SETTINGS.maintenanceMode,
      maintenanceMessage: SETTINGS.maintenanceMessage,
    });
  }

  if (p === '/api/checkout') {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const email = String(body.email || '').trim();

    // Same gates, in the same order, as the real POST /api/checkout.
    if (SETTINGS.maintenanceMode) {
      return send(res, 503, { error: SETTINGS.maintenanceMessage || 'The store is temporarily closed.' });
    }
    const plan = PLANS.filter(function (x) { return x.id === body.planId && x.active; })[0];
    if (!plan) return send(res, 400, { error: 'That bundle is no longer available.' });
    if (!/^0\d{9}$/.test(phone)) return send(res, 400, { error: 'Enter a valid 10-digit phone number, e.g. 0551234567.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (isBlocked(phone)) {
      return send(res, 403, { error: 'This phone number is currently blocked from making purchases. Please contact support.' });
    }

    const order = createDemoOrder(plan, phone, email);
    return send(res, 200, {
      authorizationUrl: '/order-status.html?reference=' + encodeURIComponent(order.reference),
      reference: order.reference,
    });
  }

  if (p.startsWith('/api/order/')) {
    const ref = decodeURIComponent(p.split('/').pop());
    const order = ORDERS.filter(function (o) { return o.reference === ref; })[0];
    if (!order) return send(res, 404, { error: 'Order not found.' });
    advanceDemoOrder(order);
    // Same public shape the real API returns - no cost or profit fields.
    return send(res, 200, {
      reference: order.reference, status: order.status, label: order.label,
      network: order.network, capacityGB: order.capacityGB, priceGHS: order.priceGHS,
      phone: order.phone, createdAt: order.createdAt, updatedAt: order.updatedAt,
      refundStatus: order.refundStatus,
    });
  }

  if (p === '/api/history') {
    const phone = q.get('phone') || '';
    const ref = q.get('reference') || '';
    const rows = ORDERS.filter(function (o) { return o.phone === phone && o.reference === ref; })
      .map(function (o) {
        return { reference: o.reference, network: o.network, label: o.label, priceGHS: o.priceGHS, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt };
      });
    return send(res, 200, rows);
  }

  /* ---- admin ---- */

  if (p === '/api/admin/session') return send(res, 200, { authenticated: true });
  if (p === '/api/admin/login') return send(res, 200, { ok: true });
  if (p === '/api/admin/logout') return send(res, 200, { ok: true });
  if (p === '/api/admin/stats') return send(res, 200, stats());
  if (p === '/api/admin/wallet') {
    return send(res, 200, { balance: 742.55, mockMode: true, lowWalletThreshold: SETTINGS.lowWalletThreshold });
  }

  if (p === '/api/admin/orders/export') {
    const header = ['Reference', 'Date', 'Status', 'Network', 'Bundle', 'Customer paid (GHS)', 'Phone'];
    const lines = [header.join(',')];
    ORDERS.slice(0, 200).forEach(function (o) {
      lines.push([o.reference, o.createdAt, o.status, o.network, o.label, o.priceGHS, o.phone].join(','));
    });
    return send(res, 200, '\uFEFF' + lines.join('\n'), 'text/csv; charset=utf-8');
  }

  if (p.startsWith('/api/admin/orders/') && p.endsWith('/events')) {
    const ref = decodeURIComponent(p.split('/')[4]);
    const base = ORDERS.filter(function (o) { return o.reference === ref; })[0];
    const when = base ? base.createdAt : new Date().toISOString();
    return send(res, 200, [
      { eventType: 'delivery.completed', details: { status: 'fulfilled', trackingId: 'TRK-50001' }, createdAt: new Date(new Date(when).getTime() + 42000).toISOString() },
      { eventType: 'provider.order_accepted', details: { status: 'processing', providerReference: 'DH-TRX-90001' }, createdAt: new Date(new Date(when).getTime() + 9000).toISOString() },
      { eventType: 'payment.confirmed', details: { status: 'paid', amountGHS: base ? base.priceGHS : 25, currency: 'GHS' }, createdAt: new Date(new Date(when).getTime() + 4000).toISOString() },
      { eventType: 'order.created', details: { status: 'pending' }, createdAt: when },
    ]);
  }

  if (p.startsWith('/api/admin/orders/')) {
    // POST actions: /status, /note, /retry, /refund
    const parts = p.split('/');
    const ref = decodeURIComponent(parts[4]);
    const action = parts[5];
    const order = ORDERS.filter(function (o) { return o.reference === ref; })[0];
    if (!order) return send(res, 404, { error: 'Order not found.' });
    const body = await readBody(req);
    if (action === 'status' && body.status) order.status = body.status;
    if (action === 'note') order.adminNote = body.note || null;
    if (action === 'retry') order.status = 'processing';
    if (action === 'refund') { order.status = 'refunding'; order.refundStatus = 'pending'; }
    order.updatedAt = new Date().toISOString();
    return send(res, 200, order);
  }

  if (p === '/api/admin/orders') {
    let list = ORDERS.slice();
    const status = q.get('status');
    const search = (q.get('search') || '').toLowerCase();
    const network = q.get('network');
    if (status && status !== 'all') list = list.filter(function (o) { return o.status === status; });
    if (network && network !== 'all') list = list.filter(function (o) { return o.network === network; });
    if (search) {
      list = list.filter(function (o) {
        return (o.reference + ' ' + o.phone + ' ' + (o.email || '') + ' ' + (o.providerReference || '')).toLowerCase().indexOf(search) !== -1;
      });
    }
    if (!q.has('page') && !q.has('pageSize')) {
      return send(res, 200, list.slice(0, Number(q.get('limit') || 100)));
    }
    const page = Math.max(Number(q.get('page') || 1), 1);
    const size = Number(q.get('pageSize') || 25);
    return send(res, 200, {
      rows: list.slice((page - 1) * size, page * size),
      total: list.length,
      page,
      pageSize: size,
      pages: Math.max(Math.ceil(list.length / size), 1),
    });
  }

  if (p === '/api/admin/plans') {
    if (req.method === 'GET') return send(res, 200, PLANS.map(withPerGB));
    const body = await readBody(req);
    const id = String(body.network).toLowerCase() + '-' + String(body.label).toLowerCase().replace(/\s+/g, '');
    const plan = {
      id, network: body.network, networkCode: body.networkCode || 'YELLO',
      capacityGB: Number(body.capacityGB), label: body.label,
      validity: body.validity || '30 days', priceGHS: Number(body.priceGHS),
      providerCostGHS: body.providerCostGHS == null ? null : Number(body.providerCostGHS),
      active: true, sortOrder: 9000,
    };
    PLANS.push(plan);
    return send(res, 201, withPerGB(plan));
  }

  if (p.startsWith('/api/admin/plans/')) {
    const parts = p.split('/');
    const id = decodeURIComponent(parts[4]);
    const plan = PLANS.filter(function (x) { return x.id === id; })[0];
    if (!plan) return send(res, 404, { error: 'Bundle not found.' });
    if (req.method === 'DELETE') {
      PLANS = PLANS.filter(function (x) { return x.id !== id; });
      return send(res, 200, { deleted: true, archived: false, orders: 0 });
    }
    const body = await readBody(req);
    if (parts[5] === 'cost') plan.providerCostGHS = Number(body.providerCostGHS);
    else Object.keys(body).forEach(function (k) { if (k in plan) plan[k] = body[k]; });
    return send(res, 200, withPerGB(plan));
  }

  if (p === '/api/admin/blocked-numbers') {
    if (req.method === 'GET') {
      const search = (q.get('search') || '').toLowerCase();
      return send(res, 200, search ? BLOCKED.filter(function (b) { return (b.phone + b.reason).toLowerCase().indexOf(search) !== -1; }) : BLOCKED);
    }
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const reason = String(body.reason || '').trim().slice(0, 200);
    if (!/^0\d{9}$/.test(phone)) return send(res, 400, { error: 'Enter a valid 10-digit Ghana phone number.' });
    BLOCKED = BLOCKED.filter(function (b) { return b.phone !== phone; });
    BLOCKED.unshift({ phone: phone, reason: reason, createdAt: new Date().toISOString() });
    return send(res, 200, { phone: phone, reason: reason });
  }

  if (p.startsWith('/api/admin/blocked-numbers/')) {
    const phone = normalizePhone(decodeURIComponent(p.split('/')[4]));
    BLOCKED = BLOCKED.filter(function (b) { return b.phone !== phone; });
    return send(res, 200, { success: true });
  }

  if (p === '/api/admin/settings') {
    if (req.method === 'GET') return send(res, 200, SETTINGS);
    const body = await readBody(req);
    Object.keys(SETTINGS).forEach(function (k) { if (k in body) SETTINGS[k] = body[k]; });
    return send(res, 200, SETTINGS);
  }

  if (p === '/api/admin/audit') {
    return send(res, 200, AUDIT);
  }

  return send(res, 404, { error: 'Not found in preview mode.' });
}

/* -------------------------------------------------------------- static */

/* Injected into every HTML page served by the PREVIEW ONLY, so nobody can
 * mistake the simulated payments for real money. Never touches public/. */
const PREVIEW_BADGE = `
<div id="previewBadge" aria-hidden="true">Preview · no real payments</div>
<style>
  #previewBadge{
    position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 86px);
    /* Below the checkout sheet (120) and the admin modals (120/130) on purpose:
       those are full-screen overlays, and the badge must never cover a form
       error or a dialog. Above the sticky header (60) and bottom bar (70). */
    z-index:100;pointer-events:none;
    background:rgba(15,20,32,.9);color:#fff;border:1px solid rgba(255,255,255,.22);
    font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    letter-spacing:.02em;padding:7px 12px;border-radius:999px;white-space:nowrap;
    box-shadow:0 6px 18px rgba(0,0,0,.28);backdrop-filter:blur(6px);
  }
  @media (min-width:900px){ #previewBadge{ bottom:20px; } }
</style>
`;

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain');

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found: ' + rel);
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    let body = data;
    if (type.startsWith('text/html')) {
      const html = data.toString('utf8');
      body = Buffer.from(
        html.includes('</body>') ? html.replace('</body>', PREVIEW_BADGE + '</body>') : html + PREVIEW_BADGE,
        'utf8'
      );
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(function (err) {
      console.error(err);
      send(res, 500, { error: 'Preview server error.' });
    });
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, function () {
  console.log('');
  console.log('  Abrants preview running (mock data, no database needed)');
  console.log('');
  console.log('  Storefront   http://localhost:' + PORT + '/');
  console.log('  Admin        http://localhost:' + PORT + '/admin.html');
  console.log('  Order track  http://localhost:' + PORT + '/order-status.html');
  console.log('');
  console.log('  Open the storefront URL on your phone (same Wi-Fi) to test the mobile layout.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
