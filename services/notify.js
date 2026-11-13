/*
 * What customers and agents are told by SMS, and when (services/sms.js sends it).
 *
 * Customers (Admin → Settings → Text messages → "Customers"):
 *   data     placed (sent to the network) / delivered / could not be delivered, money being refunded
 *   checkers the serial and PIN once bought / refund
 *   AFA      submitted / approved with the AFA ID / not approved / refund
 * Agents ("Agents"): shop approved, paused, closed, reopened; money sent to their MoMo.
 * The agent sign-up code is always sent when SMS is set up (it protects the sign-up).
 *
 * An order bought in an agent's shop is texted under the agent's shop name, with the agent's link to buy again.
 * Every function here returns at once and never throws: a text message must never stop an order.
 */
const sms = require('./sms');
const { getSettings } = require('./orderStore');
const { siteOrigin } = require('./siteUrl');

const money = (v) => 'GHS ' + Number(v || 0).toFixed(2);
const host = () => (siteOrigin() || 'https://abrantsdata.com').replace(/^https?:\/\//, '');

async function allowed(kind) {
  if (!sms.configured()) return false;
  try {
    const s = (await getSettings()).sms || {};
    return kind === 'agents' ? s.agents !== false : s.customers !== false;
  } catch { return false; }
}

// Who the message is from (the agent's shop, or the store) and where to buy again.
function brand(agentId) {
  if (agentId != null) {
    try {
      const a = require('./agents').getAgent(agentId);
      if (a) return { name: sms.plain(a.shopName).slice(0, 30) || 'Abrants Data', again: `${host()}/s/${a.slug}` };
    } catch { /* fall back to the store */ }
  }
  return { name: 'Abrants Data', again: host() };
}

function safely(fn) {
  return (...args) => { Promise.resolve().then(() => fn(...args)).catch((e) => console.warn('SMS skipped:', e.message)); };
}

/* ------------------------------------------------------------------ data bundles */

// row: an orders row as saved (snake_case), old: its status before this change.
const dataStatus = safely(async (row, old) => {
  if (!row || row.status === old || !(await allowed('customers'))) return;
  const b = brand(row.agent_id);
  const what = `${row.network} ${row.label}`;
  const total = Number(row.price_ghs) + Number(row.customer_fee_ghs || 0);
  let text = null;
  // "Placed" once, when the order first goes to the network (not again when the store retries a delivery).
  if (row.status === 'processing' && (old === 'paid' || old === 'pending')) text = `${b.name}: Your ${what} order for ${row.phone} has been placed. We will text you when it is delivered. Ref ${row.reference}`;
  else if (row.status === 'fulfilled') text = `${b.name}: ${what} has been delivered to ${row.phone}. Thank you! Buy again: ${b.again}`;
  else if (row.status === 'refunding' && Number(row.price_ghs) > 0) text = `${b.name}: Sorry, we could not deliver ${what} to ${row.phone}. Your ${money(total)} is being refunded. Ref ${row.reference}`;
  if (text) sms.send(row.phone, text, 'order.' + row.status);
});

/* ------------------------------------------------------------------ checkers and AFA */

const serviceStatus = safely(async (row) => {
  if (!row || !(await allowed('customers'))) return;
  const b = brand(row.agent_id);
  const total = Number(row.price_ghs) + Number(row.customer_fee_ghs || 0);
  let text = null;
  if (row.kind === 'checker' && row.status === 'completed') {
    const pins = Array.isArray(row.pins) ? row.pins : (typeof row.pins === 'string' ? JSON.parse(row.pins) : []);
    const list = pins.map((p, i) => `${pins.length > 1 ? (i + 1) + ') ' : ''}Serial ${p.serial} PIN ${p.pin}`).join(' ');
    const url = row.result_url && String(row.result_url).length <= 40 ? ` Check at ${String(row.result_url).replace(/^https?:\/\//, '')}` : '';
    text = `${b.name}: Your ${row.item_name}: ${list}.${url}`;
  } else if (row.kind === 'afa' && row.status === 'submitted') {
    const afa = typeof row.afa === 'string' ? JSON.parse(row.afa) : (row.afa || {});
    text = `${b.name}: Your MTN AFA registration${afa.full_name ? ' for ' + afa.full_name : ''} has been submitted. We will text you when it is approved.`;
  } else if (row.kind === 'afa' && row.status === 'approved') {
    text = `${b.name}: Your MTN AFA registration is approved.${row.afa_id ? ' AFA ID: ' + row.afa_id + '.' : ''} Dial *1848# on your MTN line to buy an AFA bundle.`;
  } else if (row.kind === 'afa' && row.status === 'rejected') {
    const why = row.note ? ` (${String(row.note).slice(0, 60)})` : '';
    text = `${b.name}: Your MTN AFA registration was not approved${why}. Please contact us. Ref ${row.reference}`;
  } else if (row.status === 'refunding') {
    text = `${b.name}: Sorry, we could not complete your ${row.item_name} order. Your ${money(total)} is being refunded. Ref ${row.reference}`;
  }
  if (text) sms.send(row.phone, text, row.kind + '.' + row.status);
});

/* ------------------------------------------------------------------ agents */

const agentStatus = safely(async (a, before) => {
  if (!a || a.status === before || !(await allowed('agents'))) return;
  let text = null;
  if (a.status === 'active') {
    text = before === 'pending'
      ? `Abrants: Your agent shop ${a.shopName} is approved! Share your link: ${host()}/s/${a.slug} Set your prices at ${host()}/agent`
      : `Abrants: Your agent shop ${a.shopName} is open again. Your link: ${host()}/s/${a.slug}`;
  } else if (a.status === 'suspended') text = `Abrants: Your agent shop ${a.shopName} has been paused. Please contact us if you have questions.`;
  else if (a.status === 'rejected') text = before === 'pending'
    ? `Abrants: Sorry, your agent application for ${a.shopName} was not approved. Please contact us if you have questions.`
    : `Abrants: Your agent account ${a.shopName} has been closed. Money you already earned will still be paid.`;
  if (text) sms.send(a.phone, text, 'agent.' + a.status);
});

const agentPaid = safely(async (a, payout) => {
  if (!a || !payout || !(await allowed('agents'))) return;
  sms.send(a.phone, `Abrants: We have sent ${money(payout.sentGHS)} to your MoMo ${payout.momoNumber} for your agent sales. Thank you!`, 'agent.paid');
});

/** The sign-up code. Waits for Arkesel, so the page can say whether it was sent. */
async function agentCode(phone, code) {
  return sms.sendNow(phone, `Your Abrants agent code is ${code}. It expires in 10 minutes. Do not share it with anyone.`, 'agent.code');
}

module.exports = { dataStatus, serviceStatus, agentStatus, agentPaid, agentCode };
