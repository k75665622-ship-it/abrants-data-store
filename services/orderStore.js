const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Create a PostgreSQL database and add DATABASE_URL to your environment.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const NETWORK_CODES = { MTN: 'YELLO', Telecel: 'TELECEL', AirtelTigo: 'AT_PREMIUM' };
const NETWORK_RANK = { MTN: 1, Telecel: 2, AirtelTigo: 3 };

const DEFAULT_PLANS = [
  { id: 'mtn-1gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 1, label: '1GB', priceGHS: 5.0, providerCostGHS: 4.2, validity: '30 days' },
  { id: 'mtn-2gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 2, label: '2GB', priceGHS: 10.0, providerCostGHS: 8.8, validity: '30 days' },
  { id: 'mtn-5gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 5, label: '5GB', priceGHS: 25.0, providerCostGHS: 22.3, validity: '30 days' },
  { id: 'mtn-10gb', network: 'MTN', networkCode: 'YELLO', capacityGB: 10, label: '10GB', priceGHS: 45.0, providerCostGHS: 41.0, validity: '30 days' },
  { id: 'telecel-5gb', network: 'Telecel', networkCode: 'TELECEL', capacityGB: 5, label: '5GB', priceGHS: 22.0, providerCostGHS: 19.5, validity: '30 days' },
  { id: 'telecel-10gb', network: 'Telecel', networkCode: 'TELECEL', capacityGB: 10, label: '10GB', priceGHS: 40.0, providerCostGHS: 36.5, validity: '30 days' },
  { id: 'at-5gb', network: 'AirtelTigo', networkCode: 'AT_PREMIUM', capacityGB: 5, label: '5GB', priceGHS: 22.0, providerCostGHS: 19.5, validity: '30 days' },
  { id: 'at-10gb', network: 'AirtelTigo', networkCode: 'AT_PREMIUM', capacityGB: 10, label: '10GB', priceGHS: 42.0, providerCostGHS: 38.5, validity: '30 days' },
];

const DEFAULT_SETTINGS = {
  storeName: 'Abrants Data Store',
  announcement: '',
  announcementEnabled: false,
  supportWhatsapp: '',
  supportPhone: '',
  channelLink: '',
  providers: { MTN: 'datahustle', Telecel: 'datahustle', AirtelTigo: 'datahustle' },
  pausedNetworks: [],
  autoFailover: true,
  autoFailovers: {},
  autoPaused: {},
  adminAlerts: [],
  pauseMessage: "{network} bundles are temporarily out of stock with our supplier. We are sorting it out. Please try again later or choose another network. You have not been charged.",
  maintenanceMode: false,
  maintenanceMessage: "We are doing a quick upgrade. Please check back in a few minutes.",
  lowWalletThreshold: 100,
};

const ORDER_STATUSES = [
  'pending', 'paid', 'processing', 'fulfilled',
  'delivery_failed', 'delivery_review', 'refunding', 'refunded',
];

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function planSortOrder(network, capacityGB) {
  const rank = NETWORK_RANK[network] || 4;
  return rank * 1000 + Math.round(Number(capacityGB || 0) * 10);
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      plan_id TEXT NOT NULL,
      network TEXT NOT NULL,
      network_code TEXT NOT NULL,
      capacity_gb NUMERIC(10,2) NOT NULL,
      label TEXT NOT NULL,
      price_ghs NUMERIC(12,2) NOT NULL,
      provider_cost_ghs NUMERIC(12,2),
      payment_fee_ghs NUMERIC(12,2),
      phone TEXT NOT NULL,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_reference TEXT,
      purchase_id TEXT,
      tracking_id TEXT,
      refund_id TEXT,
      refund_status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
    CREATE INDEX IF NOT EXISTS idx_orders_provider_reference ON orders(provider_reference);

    CREATE TABLE IF NOT EXISTS store_plans (
      plan_id TEXT PRIMARY KEY,
      price_ghs NUMERIC(12,2) NOT NULL,
      provider_cost_ghs NUMERIC(12,2),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS blocked_numbers (
      phone TEXT PRIMARY KEY,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id BIGSERIAL PRIMARY KEY,
      order_reference TEXT NOT NULL REFERENCES orders(reference) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_reference ON order_events(order_reference, created_at DESC);

    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_audit (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      details JSONB,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);
  `);

  // Additive migrations. Safe to re-run on an existing database.
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_cost_ghs NUMERIC(12,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_fee_ghs NUMERIC(12,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_note TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'datahustle';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id BIGINT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_id BIGINT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS list_price_ghs NUMERIC(12,2);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'store';
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_offer ON orders(offer_id);
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS network TEXT;
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS network_code TEXT;
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS capacity_gb NUMERIC(10,2);
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS label TEXT;
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS validity TEXT;
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE store_plans ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_orders_plan_id ON orders(plan_id);
    CREATE INDEX IF NOT EXISTS idx_orders_reference_lower ON orders(LOWER(reference));
  `);

  await seedPlans();
  await seedSettings();
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    planId: row.plan_id,
    network: row.network,
    networkCode: row.network_code,
    capacityGB: Number(row.capacity_gb),
    label: row.label,
    priceGHS: Number(row.price_ghs),
    providerCostGHS: row.provider_cost_ghs == null ? null : Number(row.provider_cost_ghs),
    paymentFeeGHS: row.payment_fee_ghs == null ? null : Number(row.payment_fee_ghs),
    estimatedProfitGHS: row.provider_cost_ghs == null
      ? null
      : Number(row.price_ghs) - Number(row.provider_cost_ghs) - Number(row.payment_fee_ghs || 0),
    phone: row.phone,
    email: row.email,
    status: row.status,
    providerReference: row.provider_reference,
    purchaseId: row.purchase_id,
    trackingId: row.tracking_id,
    refundId: row.refund_id,
    refundStatus: row.refund_status,
    adminNote: row.admin_note || null,
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    offerId: row.offer_id == null ? null : Number(row.offer_id),
    listPriceGHS: row.list_price_ghs == null ? null : Number(row.list_price_ghs),
    source: row.source || 'store',
    provider: row.provider || 'datahustle',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function addEvent(reference, eventType, details = {}) {
  await pool.query(
    'INSERT INTO order_events (order_reference, event_type, details) VALUES ($1, $2, $3)',
    [reference, eventType, details]
  );
}

async function createOrder(order) {
  const result = await pool.query(`
    INSERT INTO orders
      (reference, plan_id, network, network_code, capacity_gb, label, price_ghs, provider_cost_ghs, payment_fee_ghs,
       phone, email, status, customer_id, offer_id, list_price_ghs, source)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14,'store')
    ON CONFLICT (reference) DO NOTHING
    RETURNING *
  `, [
    order.reference, order.planId, order.network, order.networkCode,
    order.capacityGB, order.label, order.priceGHS, order.providerCostGHS ?? null,
    order.paymentFeeGHS ?? null, order.phone, order.email || null,
    order.customerId ?? null, order.offerId ?? null, order.listPriceGHS ?? null,
  ]);
  // Safe to call twice for the same reference (e.g. webhook and status page at the same moment).
  if (!result.rows[0]) return getOrder(order.reference);
  await addEvent(order.reference, 'order.created', { status: 'pending', customerId: order.customerId ?? null, offerId: order.offerId ?? null });
  return mapOrder(result.rows[0]);
}

// A free bundle given by the store owner (no payment). It starts life as 'paid' so the
// normal delivery path takes over. Callers must already have reserved the offer use.
async function createGiftOrder(order, client = pool) {
  const result = await client.query(`
    INSERT INTO orders
      (reference, plan_id, network, network_code, capacity_gb, label, price_ghs, provider_cost_ghs, payment_fee_ghs,
       phone, email, status, customer_id, offer_id, list_price_ghs, source)
    VALUES ($1,$2,$3,$4,$5,$6,0,$7,0,$8,$9,'paid',$10,$11,$12,'gift')
    RETURNING *
  `, [
    order.reference, order.planId, order.network, order.networkCode, order.capacityGB, order.label,
    order.providerCostGHS ?? null, order.phone, order.email || null,
    order.customerId, order.offerId, order.listPriceGHS ?? null,
  ]);
  await client.query(
    'INSERT INTO order_events (order_reference, event_type, details) VALUES ($1, $2, $3)',
    [order.reference, 'gift.redeemed', { customerId: order.customerId, offerId: order.offerId }]
  );
  return mapOrder(result.rows[0]);
}

const ORDER_UPDATE_COLUMNS = {
  status: 'status',
  providerReference: 'provider_reference',
  purchaseId: 'purchase_id',
  trackingId: 'tracking_id',
  refundId: 'refund_id',
  refundStatus: 'refund_status',
  providerCostGHS: 'provider_cost_ghs',
  paymentFeeGHS: 'payment_fee_ghs',
  adminNote: 'admin_note',
  provider: 'provider',
};

function buildUpdate(changes) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, column] of Object.entries(ORDER_UPDATE_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      fields.push(`${column} = $${i++}`);
      values.push(changes[key]);
    }
  }
  return { fields, values, next: i };
}

async function updateOrder(reference, changes, eventType = 'order.updated') {
  const { fields, values, next } = buildUpdate(changes);
  if (!fields.length) return getOrder(reference);
  fields.push('updated_at = NOW()');
  values.push(reference);
  const result = await pool.query(
    `UPDATE orders SET ${fields.join(', ')} WHERE reference = $${next} RETURNING *`, values
  );
  if (!result.rows[0]) return null;
  await addEvent(reference, eventType, changes);
  return mapOrder(result.rows[0]);
}

// Atomically claims a pending order for fulfillment. This prevents the Paystack webhook
// and the customer's status-poll fallback from both purchasing the same bundle.
async function claimOrderForFulfillment(reference, payment = {}) {
  const expectedAmount = Number(payment.amountGHS);
  const expectedCurrency = payment.currency
    ? String(payment.currency).toUpperCase()
    : 'GHS';

  if (
    expectedCurrency !== 'GHS' ||
    !Number.isFinite(expectedAmount) ||
    expectedAmount <= 0
  ) {
    return null;
  }

  const result = await pool.query(`
    UPDATE orders
    SET status='paid',
        payment_fee_ghs = COALESCE($2, payment_fee_ghs),
        updated_at=NOW()
    WHERE reference=$1
      AND status='pending'
      AND price_ghs = $3
    RETURNING *
  `, [
    reference,
    payment.feeGHS != null && Number.isFinite(Number(payment.feeGHS))
      ? Number(payment.feeGHS)
      : null,
    expectedAmount
  ]);

  if (!result.rows[0]) return null;

  await addEvent(reference, 'payment.confirmed', {
    status: 'paid',
    amountGHS: expectedAmount,
    currency: expectedCurrency,
  });

  return mapOrder(result.rows[0]);
}

async function transitionOrder(reference, fromStatus, changes, eventType = 'order.updated') {
  const { fields, values, next } = buildUpdate(changes);
  if (!fields.length) return null;
  fields.push('updated_at = NOW()');
  values.push(reference, fromStatus);
  const result = await pool.query(
    `UPDATE orders SET ${fields.join(', ')} WHERE reference=$${next} AND status=$${next + 1} RETURNING *`, values
  );
  if (!result.rows[0]) return null;
  await addEvent(reference, eventType, changes);
  return mapOrder(result.rows[0]);
}

async function getOrder(reference) {
  const value = String(reference || '').trim();
  // Keep stored references unchanged: payment/provider references are case-sensitive.
  const exact = await pool.query('SELECT * FROM orders WHERE reference = $1', [value]);
  if (exact.rows[0]) return mapOrder(exact.rows[0]);
  const fallback = await pool.query('SELECT * FROM orders WHERE LOWER(reference) = LOWER($1) LIMIT 2', [value]);
  // Do not choose an arbitrary order if legacy references differ only by case.
  return fallback.rows.length === 1 ? mapOrder(fallback.rows[0]) : null;
}

async function findByProviderReference(providerReference) {
  const result = await pool.query('SELECT * FROM orders WHERE provider_reference = $1 LIMIT 1', [providerReference]);
  return mapOrder(result.rows[0]);
}

// Finds the order a DataHustle webhook is about. Normally the transaction reference matches.
// If it does not, fall back to the provider's order id, then to a single still-processing order
// with the same phone number, network and size (only when exactly one order fits).
async function findOrderForProviderEvent({ transactionId, orderId, phone, network, capacity }) {
  if (transactionId) {
    const r = await pool.query('SELECT * FROM orders WHERE provider_reference = $1 LIMIT 1', [String(transactionId)]);
    if (r.rows[0]) return mapOrder(r.rows[0]);
  }
  if (orderId) {
    const r = await pool.query('SELECT * FROM orders WHERE purchase_id = $1 LIMIT 1', [String(orderId)]);
    if (r.rows[0]) return mapOrder(r.rows[0]);
  }
  const p = normalizePhone(phone);
  const cap = Number(capacity);
  if (PHONE_RE.test(p) && Number.isFinite(cap)) {
    const r = await pool.query(
      `SELECT * FROM orders WHERE phone = $1 AND capacity_gb = $2 AND status = 'processing'
         AND ($3::text IS NULL OR network_code = $3) ORDER BY created_at ASC LIMIT 2`,
      [p, cap, network || null]
    );
    if (r.rows.length === 1) return mapOrder(r.rows[0]);
  }
  return null;
}

// Orders a provider without a webhook still has to confirm (see services/fulfillment.js).
async function getProcessingOrdersByProvider(provider, minAgeSeconds = 45, limit = 50) {
  const r = await pool.query(
    `SELECT * FROM orders WHERE provider = $1 AND status = 'processing' AND provider_reference IS NOT NULL
       AND updated_at < NOW() - ($2 || ' seconds')::interval ORDER BY created_at ASC LIMIT $3`,
    [provider, String(minAgeSeconds), limit]
  );
  return r.rows.map(mapOrder);
}

async function getOrderEvents(reference) {
  const result = await pool.query(
    'SELECT event_type, details, created_at FROM order_events WHERE order_reference = $1 ORDER BY created_at DESC',
    [reference]
  );
  return result.rows.map(r => ({ eventType: r.event_type, details: r.details, createdAt: r.created_at }));
}

function orderFilters({ status, search, network, from, to } = {}) {
  const where = [];
  const values = [];
  let i = 1;
  if (status && status !== 'all') {
    where.push(`status = $${i++}`);
    values.push(status);
  } else if (!search) {
    // Checkouts that were never paid are not real orders: keep them out of the default list.
    // They can still be found by choosing the "pending" filter or by searching.
    where.push(`status <> 'pending'`);
  }
  if (network && network !== 'all') {
    where.push(`network = $${i++}`);
    values.push(network);
  }
  if (search) {
    where.push(`(reference ILIKE $${i} OR phone ILIKE $${i} OR COALESCE(email,'') ILIKE $${i} OR COALESCE(provider_reference,'') ILIKE $${i})`);
    values.push(`%${search}%`);
    i++;
  }
  if (from) { where.push(`created_at >= $${i++}`); values.push(from); }
  if (to) { where.push(`created_at < ($${i++}::date + INTERVAL '1 day')`); values.push(to); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', values, next: i };
}
function boundedInteger(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.trunc(n), min), max)
    : fallback;
}

async function getAllOrders({ status, search, network, from, to, limit = 100, offset = 0 } = {}) {
  const { whereSql, values, next: startParam } = orderFilters({
    status,
    search,
    network,
    from,
    to
  });

  const limitValue = boundedInteger(limit, 100, 1, 500);
  const offsetValue = boundedInteger(offset, 0, 0, 2147483647);

  values.push(limitValue);
  values.push(offsetValue);

  const result = await pool.query(`
    SELECT * FROM orders ${whereSql}
    ORDER BY created_at DESC
    LIMIT $${startParam} OFFSET $${startParam + 1}
  `, values);

  return result.rows.map(mapOrder);
}

async function getOrdersPage({ status, search, network, from, to, page = 1, pageSize = 25 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 25, 5), 100);
  const current = Math.max(Number(page) || 1, 1);
  const { whereSql, values, next } = orderFilters({ status, search, network, from, to });

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM orders ${whereSql}`, values);
  const total = countResult.rows[0]?.total || 0;

  const rows = await pool.query(`
    SELECT * FROM orders ${whereSql}
    ORDER BY created_at DESC
    LIMIT $${next} OFFSET $${next + 1}
  `, [...values, size, (current - 1) * size]);

  return {
    rows: rows.rows.map(mapOrder),
    total,
    page: current,
    pageSize: size,
    pages: Math.max(Math.ceil(total / size), 1),
  };
}

async function getOrderStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
      COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
      COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled,
      COUNT(*) FILTER (WHERE status = 'delivery_failed')::int AS delivery_failed,
      COUNT(*) FILTER (WHERE status = 'delivery_review')::int AS delivery_review,
      COUNT(*) FILTER (WHERE status = 'refunding')::int AS refunding,
      COUNT(*) FILTER (WHERE status = 'refunded')::int AS refunded,
      COALESCE(SUM(price_ghs) FILTER (WHERE status IN ('paid','processing','fulfilled')), 0)::numeric AS revenue,
      COALESCE(SUM((price_ghs - COALESCE(provider_cost_ghs,0) - COALESCE(payment_fee_ghs,0))) FILTER (WHERE status IN ('paid','processing','fulfilled') AND provider_cost_ghs IS NOT NULL), 0)::numeric AS estimated_profit,
      COALESCE(SUM((price_ghs - COALESCE(provider_cost_ghs,0) - COALESCE(payment_fee_ghs,0))) FILTER (WHERE status = 'fulfilled' AND provider_cost_ghs IS NOT NULL), 0)::numeric AS realized_profit,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last_7d,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30d
    FROM orders
  `);
  const r = result.rows[0];

  const periods = await pool.query(`
    SELECT
      period,
      COUNT(*)::int AS orders,
      COALESCE(SUM(price_ghs) FILTER (WHERE status IN ('paid','processing','fulfilled')),0)::numeric AS revenue,
      COALESCE(SUM((price_ghs - COALESCE(provider_cost_ghs,0) - COALESCE(payment_fee_ghs,0))) FILTER (WHERE status IN ('paid','processing','fulfilled') AND provider_cost_ghs IS NOT NULL),0)::numeric AS profit,
      COUNT(*) FILTER (WHERE status='fulfilled')::int AS delivered,
      COUNT(*) FILTER (WHERE status IN ('delivery_failed','refunded'))::int AS failed_or_refunded
    FROM (
      SELECT 'today' AS period, * FROM orders WHERE created_at >= CURRENT_DATE
      UNION ALL
      SELECT 'week' AS period, * FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '6 days'
      UNION ALL
      SELECT 'month' AS period, * FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '29 days'
    ) x
    GROUP BY period
  `);

  const topBundles = await pool.query(`
    SELECT
      plan_id, network, label,
      COUNT(*)::int AS orders,
      COALESCE(SUM(price_ghs) FILTER (WHERE status IN ('paid','processing','fulfilled')),0)::numeric AS revenue,
      COALESCE(SUM((price_ghs - COALESCE(provider_cost_ghs,0) - COALESCE(payment_fee_ghs,0))) FILTER (WHERE status IN ('paid','processing','fulfilled') AND provider_cost_ghs IS NOT NULL),0)::numeric AS profit
    FROM orders
    WHERE created_at >= CURRENT_DATE - INTERVAL '29 days'
    GROUP BY plan_id, network, label
    ORDER BY revenue DESC, orders DESC
    LIMIT 6
  `);

  const series = await pool.query(`
    SELECT d::date AS day,
      COUNT(o.*)::int AS orders,
      COALESCE(SUM(o.price_ghs) FILTER (WHERE o.status IN ('paid','processing','fulfilled')),0)::numeric AS revenue,
      COALESCE(SUM((o.price_ghs - COALESCE(o.provider_cost_ghs,0) - COALESCE(o.payment_fee_ghs,0))) FILTER (WHERE o.status IN ('paid','processing','fulfilled') AND o.provider_cost_ghs IS NOT NULL),0)::numeric AS profit
    FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
    LEFT JOIN orders o ON o.created_at::date = d::date
    GROUP BY d ORDER BY d
  `);

  const networks = await pool.query(`
    SELECT network,
      COUNT(*)::int AS orders,
      COALESCE(SUM(price_ghs) FILTER (WHERE status IN ('paid','processing','fulfilled')),0)::numeric AS revenue
    FROM orders
    WHERE created_at >= CURRENT_DATE - INTERVAL '29 days'
    GROUP BY network ORDER BY revenue DESC
  `);

  const periodMap = Object.fromEntries(periods.rows.map(x => [x.period, {
    orders: x.orders,
    revenue: Number(x.revenue),
    profit: Number(x.profit),
    delivered: x.delivered,
    failedOrRefunded: x.failed_or_refunded,
  }]));

  return {
    total: r.total, pending: r.pending, paid: r.paid, processing: r.processing,
    fulfilled: r.fulfilled, deliveryFailed: r.delivery_failed, deliveryReview: r.delivery_review,
    refunding: r.refunding, refunded: r.refunded,
    revenue: Number(r.revenue), estimatedProfit: Number(r.estimated_profit), realizedProfit: Number(r.realized_profit),
    last24h: r.last_24h, last7d: r.last_7d, last30d: r.last_30d,
    periods: {
      today: periodMap.today || { orders: 0, revenue: 0, profit: 0, delivered: 0, failedOrRefunded: 0 },
      week: periodMap.week || { orders: 0, revenue: 0, profit: 0, delivered: 0, failedOrRefunded: 0 },
      month: periodMap.month || { orders: 0, revenue: 0, profit: 0, delivered: 0, failedOrRefunded: 0 },
    },
    series: series.rows.map(x => ({
      day: x.day, orders: x.orders, revenue: Number(x.revenue), profit: Number(x.profit),
    })),
    networks: networks.rows.map(x => ({ network: x.network, orders: x.orders, revenue: Number(x.revenue) })),
    topBundles: topBundles.rows.map(x => ({
      planId: x.plan_id, network: x.network, label: x.label, orders: x.orders,
      revenue: Number(x.revenue), profit: Number(x.profit),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Plans                                                              */
/* ------------------------------------------------------------------ */

async function seedPlans() {
  for (const plan of DEFAULT_PLANS) {
    await pool.query(`
      INSERT INTO store_plans
        (plan_id, network, network_code, capacity_gb, label, validity, price_ghs, provider_cost_ghs, active, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)
      ON CONFLICT (plan_id) DO UPDATE SET
        network           = COALESCE(store_plans.network, EXCLUDED.network),
        network_code      = COALESCE(store_plans.network_code, EXCLUDED.network_code),
        capacity_gb       = COALESCE(store_plans.capacity_gb, EXCLUDED.capacity_gb),
        label             = COALESCE(store_plans.label, EXCLUDED.label),
        validity          = COALESCE(store_plans.validity, EXCLUDED.validity),
        provider_cost_ghs = COALESCE(store_plans.provider_cost_ghs, EXCLUDED.provider_cost_ghs),
        sort_order        = CASE WHEN store_plans.sort_order = 0 THEN EXCLUDED.sort_order ELSE store_plans.sort_order END
    `, [
      plan.id, plan.network, plan.networkCode, plan.capacityGB, plan.label, plan.validity,
      plan.priceGHS, plan.providerCostGHS, planSortOrder(plan.network, plan.capacityGB),
    ]);
  }
}

function mapPlan(row) {
  return {
    id: row.plan_id,
    network: row.network,
    networkCode: row.network_code,
    capacityGB: Number(row.capacity_gb),
    label: row.label,
    validity: row.validity || '30 days',
    priceGHS: Number(row.price_ghs),
    providerCostGHS: row.provider_cost_ghs == null ? null : Number(row.provider_cost_ghs),
    active: row.active !== false,
    sortOrder: Number(row.sort_order || 0),
    pricePerGB: Number(row.capacity_gb) > 0 ? Number(row.price_ghs) / Number(row.capacity_gb) : Number(row.price_ghs),
  };
}

async function getPlans({ includeInactive = false } = {}) {
  const result = await pool.query(`
    SELECT plan_id, network, network_code, capacity_gb, label, validity,
           price_ghs, provider_cost_ghs, active, sort_order
    FROM store_plans
    ${includeInactive ? '' : 'WHERE active = TRUE'}
    ORDER BY sort_order ASC, network ASC, capacity_gb ASC
  `);
  return result.rows.map(mapPlan);
}

async function getPlan(planId) {
  const result = await pool.query('SELECT * FROM store_plans WHERE plan_id = $1', [planId]);
  return result.rows[0] ? mapPlan(result.rows[0]) : null;
}

async function createPlan(input) {
  const network = String(input.network || '').trim();
  const label = String(input.label || '').trim();
  const capacityGB = Number(input.capacityGB);
  const priceGHS = Number(input.priceGHS);
  const providerCostGHS = input.providerCostGHS == null || input.providerCostGHS === '' ? null : Number(input.providerCostGHS);
  const validity = String(input.validity || '30 days').trim() || '30 days';
  const networkCode = String(input.networkCode || NETWORK_CODES[network] || '').trim();
  const active = input.active !== false;

  if (!network || !label) return { error: 'Network and bundle label are required.' };
  if (!Number.isFinite(capacityGB) || capacityGB <= 0 || capacityGB > 5000) return { error: 'Enter a valid bundle size in GB.' };
  if (!Number.isFinite(priceGHS) || priceGHS < 0.01 || priceGHS > 10000) return { error: 'Enter a valid price between GH₵0.01 and GH₵10,000.' };
  if (providerCostGHS != null && (!Number.isFinite(providerCostGHS) || providerCostGHS < 0 || providerCostGHS > 10000)) {
    return { error: 'Enter a valid provider cost between GH₵0.00 and GH₵10,000.' };
  }
  if (!networkCode) return { error: 'Provider network code is required.' };

  let planId = slugify(`${network}-${label}`);
  if (!planId) planId = `plan-${Date.now()}`;
  let suffix = 2;
  while (await getPlan(planId)) {
    planId = `${slugify(`${network}-${label}`)}-${suffix++}`;
  }

  await pool.query(`
    INSERT INTO store_plans
      (plan_id, network, network_code, capacity_gb, label, validity, price_ghs, provider_cost_ghs, active, sort_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    planId, network, networkCode, capacityGB, label, validity, priceGHS, providerCostGHS, active,
    Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : planSortOrder(network, capacityGB),
  ]);
  return { plan: await getPlan(planId) };
}

const PLAN_COLUMNS = {
  priceGHS: 'price_ghs',
  providerCostGHS: 'provider_cost_ghs',
  label: 'label',
  capacityGB: 'capacity_gb',
  validity: 'validity',
  network: 'network',
  networkCode: 'network_code',
  active: 'active',
  sortOrder: 'sort_order',
};

async function updatePlan(planId, changes) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, column] of Object.entries(PLAN_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      fields.push(`${column} = $${i++}`);
      values.push(changes[key]);
    }
  }
  if (!fields.length) return getPlan(planId);
  fields.push('updated_at = NOW()');
  values.push(planId);
  const result = await pool.query(
    `UPDATE store_plans SET ${fields.join(', ')} WHERE plan_id = $${i} RETURNING *`, values
  );
  return result.rows[0] ? mapPlan(result.rows[0]) : null;
}

async function updatePlanPrice(planId, priceGHS) {
  const plan = await updatePlan(planId, { priceGHS });
  if (!plan) return null;
  return getPlan(planId);
}

async function updatePlanProviderCost(planId, providerCostGHS) {
  const plan = await updatePlan(planId, { providerCostGHS });
  if (!plan) return null;
  return getPlan(planId);
}

// A plan that already has orders is archived (hidden from customers) instead of
// hard-deleted, so historical order records stay intact.
async function deletePlan(planId) {
  const plan = await getPlan(planId);
  if (!plan) return null;
  const used = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE plan_id = $1', [planId]);
  if ((used.rows[0]?.n || 0) > 0) {
    await updatePlan(planId, { active: false });
    return { deleted: false, archived: true, orders: used.rows[0].n };
  }
  await pool.query('DELETE FROM store_plans WHERE plan_id = $1', [planId]);
  return { deleted: true, archived: false, orders: 0 };
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

async function seedSettings() {
  await pool.query(`
    INSERT INTO store_settings (key, value) VALUES ('store', $1::jsonb)
    ON CONFLICT (key) DO NOTHING
  `, [JSON.stringify(DEFAULT_SETTINGS)]);
}

async function getSettings() {
  const result = await pool.query("SELECT value FROM store_settings WHERE key = 'store'");
  const stored = result.rows[0]?.value || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  await pool.query(`
    INSERT INTO store_settings (key, value, updated_at) VALUES ('store', $1::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [JSON.stringify(next)]);
  return next;
}

/* ------------------------------------------------------------------ */
/* Audit log                                                          */
/* ------------------------------------------------------------------ */

async function logAdminAction(action, details = {}, ip = null) {
  try {
    await pool.query(
      'INSERT INTO admin_audit (action, details, ip) VALUES ($1, $2::jsonb, $3)',
      [action, JSON.stringify(details), ip]
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

async function getAuditLog(limit = 100) {
  const result = await pool.query(
    'SELECT action, details, ip, created_at FROM admin_audit ORDER BY created_at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return result.rows.map(r => ({ action: r.action, details: r.details, ip: r.ip, createdAt: r.created_at }));
}

/* ------------------------------------------------------------------ */
/* Blocked numbers                                                    */
/* ------------------------------------------------------------------ */

/*
 * Canonical phone form used for BOTH the block list and checkout.
 * Every entry point (checkout, history lookup, block, unblock) must go
 * through this, or a number can be blocked in one shape and bought in
 * another. Strips everything that is not a digit, so "055-123-4567",
 * "055 123 4567" and "0551234567" all collapse to the same value.
 * Also accepts Ghana +233XXXXXXXXX / 233XXXXXXXXX / 00233XXXXXXXXX,
 * converting them to local form. Never truncate an invalid number.
 */
function normalizePhone(value) {
   const digits = String(value == null ? '' : value).replace(/\D/g, '');
  if (/^(?:00233|233)\d{9}$/.test(digits)) return '0' + digits.slice(-9);
  return digits;
}

const PHONE_RE = /^0\d{9}$/;

async function getBlockedNumbers(search = '') {
  const term = String(search || '').trim();
  const result = term
    ? await pool.query(
      'SELECT phone, reason, created_at FROM blocked_numbers WHERE phone ILIKE $1 OR COALESCE(reason,\'\') ILIKE $1 ORDER BY created_at DESC',
      [`%${term}%`]
    )
    : await pool.query('SELECT phone, reason, created_at FROM blocked_numbers ORDER BY created_at DESC');
  return result.rows.map(r => ({ phone: r.phone, reason: r.reason || '', createdAt: r.created_at }));
}

/* Normalises internally too, so a caller can never accidentally query with an
 * un-canonical number and get a false "not blocked". */
async function isNumberBlocked(phone) {
  const canonical = normalizePhone(phone);
  if (!PHONE_RE.test(canonical)) return false;
  const result = await pool.query('SELECT 1 FROM blocked_numbers WHERE phone=$1', [canonical]);
  return result.rowCount > 0;
}

async function blockNumber(phone, reason = '') {
  const canonical = normalizePhone(phone);
  await pool.query(`INSERT INTO blocked_numbers (phone, reason) VALUES ($1,$2)
    ON CONFLICT (phone) DO UPDATE SET reason=EXCLUDED.reason`, [canonical, reason || null]);
  return { phone: canonical, reason };
}

async function unblockNumber(phone) {
  await pool.query('DELETE FROM blocked_numbers WHERE phone=$1', [normalizePhone(phone)]);
}

async function getOrderHistoryByPhone(phone, reference) {
  if (!reference) return [];
  const order = await getOrder(reference);
  if (!order || normalizePhone(order.phone) !== normalizePhone(phone)) return [];
  return [{
    reference: order.reference, network: order.network, label: order.label,
    priceGHS: order.priceGHS, status: order.status,
    createdAt: order.createdAt, updatedAt: order.updatedAt,
  }];
}

// Unpaid checkouts older than `hours`, oldest first.
async function getStalePendingOrders(hours = 24, limit = 50) {
  const result = await pool.query(
    `SELECT reference FROM orders
     WHERE status = 'pending' AND source = 'store' AND created_at < NOW() - ($1 || ' hours')::interval
     ORDER BY created_at ASC LIMIT $2`,
    [String(Math.max(Number(hours) || 24, 1)), Math.min(Number(limit) || 50, 200)]
  );
  return result.rows.map((r) => r.reference);
}

// Removes an order that was never paid. Does nothing if it has moved on from 'pending'.
async function deleteUnpaidOrder(reference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query("SELECT 1 FROM orders WHERE reference = $1 AND status = 'pending' FOR UPDATE", [reference]);
    if (!locked.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query('DELETE FROM order_events WHERE order_reference = $1', [reference]);
    await client.query('DELETE FROM orders WHERE reference = $1', [reference]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function getRecentOrdersByPhone(phone, limit = 5) {
  const result = await pool.query(`
    SELECT reference, network, label, price_ghs, status, created_at
    FROM orders WHERE phone=$1 AND status <> 'pending' ORDER BY created_at DESC LIMIT $2`, [phone, Math.min(Number(limit) || 5, 20)]);
  return result.rows.map(r => ({
    reference: r.reference, network: r.network, label: r.label, priceGHS: Number(r.price_ghs),
    status: r.status, createdAt: r.created_at,
  }));
}

// Old finished orders (delivered, or refunded) that can be cleared out. Orders that still need
// attention (paid, processing, under review, refunding, failed) are never included.
const CLEANABLE_STATUSES = ['fulfilled', 'refunded'];
async function countOldOrders(months) {
  const m = Math.max(1, Math.floor(Number(months) || 6));
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM orders WHERE status = ANY($1) AND created_at < NOW() - make_interval(months => $2)",
    [CLEANABLE_STATUSES, m]
  );
  return { count: r.rows[0].n, oldest: r.rows[0].oldest, newest: r.rows[0].newest, months: m };
}
async function deleteOldOrders(months) {
  const m = Math.max(1, Math.floor(Number(months) || 6));
  const r = await pool.query(
    "DELETE FROM orders WHERE status = ANY($1) AND created_at < NOW() - make_interval(months => $2)",
    [CLEANABLE_STATUSES, m]
  );
  return r.rowCount;
}

// Paid orders that a provider refused because the network was out of stock (nothing was bought).
async function getOutOfStockOrders(network, limit = 20) {
  const r = await pool.query(
    `SELECT * FROM orders o
      WHERE o.status = 'delivery_review' AND o.network = $1 AND o.provider_reference IS NULL AND o.refund_status IS NULL
        AND (SELECT e.event_type FROM order_events e WHERE e.order_reference = o.reference ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = 'delivery.out_of_stock'
      ORDER BY o.created_at ASC LIMIT $2`, [network, limit]);
  return r.rows.map(mapOrder);
}

module.exports = {
  getOutOfStockOrders,
  countOldOrders, deleteOldOrders,
  initDb,
  getStalePendingOrders,
  deleteUnpaidOrder,
  createOrder, updateOrder, transitionOrder, claimOrderForFulfillment,
  getOrder, getAllOrders, getOrdersPage, getOrderStats, getOrderEvents, findByProviderReference, findOrderForProviderEvent, getProcessingOrdersByProvider,
  getPlans, getPlan, createPlan, updatePlan, updatePlanPrice, updatePlanProviderCost, deletePlan,
  getSettings, saveSettings, createGiftOrder, pool,
  logAdminAction, getAuditLog,
  getBlockedNumbers, isNumberBlocked, blockNumber, unblockNumber,
  getOrderHistoryByPhone, getRecentOrdersByPhone,
  normalizePhone, PHONE_RE,
  ORDER_STATUSES, NETWORK_CODES,
};
