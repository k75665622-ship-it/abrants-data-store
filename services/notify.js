/*
 * What customers and agents are told by SMS, and when (services/sms.js sends it).
 *
 * Customers (Admin → Settings → Text messages → "Customers"):
 *   data     placed (sent to the network) / delivered / could not be delivered, money being refunded
 *   checkers the serial and PIN once bought / refund
 *   AFA      submitted / approved with the AFA ID / not approved / refund
 * Agents ("Agents"): shop approved, paused (with the reason and until when), closed, reopened, deleted; strikes;
 *   messages from the store; money sent to their MoMo.
 * Always sent when SMS is set up (they protect the account): the agent sign-up code, the code to a MoMo number that is not
 * the agent's phone (at sign-up and when it changes), and the notice that the payout number changed.
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

// Builds an SMS of at most 160 characters around a piece of free text (a reason, a message), shortening only that text.
function fit(make, text) {
  const t = sms.plain(text).replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
  for (let n = t.length; n >= 0; n -= 1) {
    const cut = n < t.length ? t.slice(0, Math.max(0, n - 3)).replace(/\s+\S*$/, '') + '...' : t;
    const out = make(cut);
    if (sms.plain(out).length <= 160) return out;
  }
  return make('');
}
const shopShort = (a) => sms.plain(a.shopName).slice(0, 24);
const smsDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Accra' });

/** A message from the store (Admin → Agents → Message). */
const agentMessage = safely(async (a, text) => {
  if (!a || !(await allowed('agents'))) return;
  const full = `Abrants: ${sms.plain(text).replace(/\s+/g, ' ')}`;
  sms.send(a.phone, full.length <= 160 ? full : fit((t) => `Abrants: ${t} Read it all at ${host()}/agent`, text), 'agent.message');
});

const agentStrike = safely(async (a, n, reason) => {
  if (!a || !(await allowed('agents'))) return;
  sms.send(a.phone, fit((t) => `Abrants: Strike ${n} on your shop ${shopShort(a)}: ${t}. Please don't do it again. See ${host()}/agent`, reason), 'agent.strike');
});

const agentPaused = safely(async (a, until, reason) => {
  if (!a || !(await allowed('agents'))) return;
  const when = until ? `until ${smsDay(until)}` : 'until we reopen it';
  sms.send(a.phone, fit((t) => `Abrants: Your agent shop ${shopShort(a)} is paused ${when}. Reason: ${t}. See ${host()}/agent`, reason), 'agent.paused');
});

/** Closed and (now or after the last payout) deleted. Sent even though they can no longer log in. */
const agentDeleted = safely(async (a, { by, reason, waiting, owedGHS, pay }) => {
  if (!a || !(await allowed('agents'))) return;
  let text;
  if (by === 'agent') {
    text = `Abrants: Your agent shop ${shopShort(a)} is closed as you asked.` + (waiting
      ? ` We will send your ${money(owedGHS)} to your MoMo, then delete your account.`
      : ' Your account has been deleted.');
  } else {
    const after = waiting && pay ? ' Money you earned will be sent to your MoMo first.' : '';
    text = fit((t) => `Abrants: Your agent shop ${shopShort(a)} has been closed and deleted. Reason: ${t}.${after}`, reason);
  }
  sms.send(a.phone, text, 'agent.deleted');
});

/** Every shop switched off (with the reason and whether they come back), or back on. */
const programme = safely(async (a, on, s) => {
  if (!a || !(await allowed('agents'))) return;
  if (on) {
    sms.send(a.phone, a.status === 'active' ? `Abrants: Agent shops are open again. Your link works: ${host()}/s/${a.slug}` : 'Abrants: The agent programme is back on.', 'agent.programme');
    return;
  }
  const back = s.offReturn === 'never' ? 'The programme is ending; your earnings will be paid.'
    : s.offReturn === 'date' && s.offUntil ? `Back on ${smsDay(s.offUntil + 'T12:00:00Z')}.` : 'Back soon.';
  sms.send(a.phone, fit((t) => `Abrants: All agent shops are closed for now. Reason: ${t}. ${back} See ${host()}/agent`, s.offReason || ''), 'agent.programme');
});

/** The sign-up code. Waits for Arkesel, so the page can say whether it was sent. */
async function agentCode(phone, code) {
  return sms.sendNow(phone, `Your Abrants agent code is ${code}. It expires in 10 minutes. Do not share it with anyone.`, 'agent.code');
}

// The MoMo number an agent will be paid on: a code to that number proves it is real and theirs to use.
async function agentMomoCode(phone, code) {
  return sms.sendNow(phone, `Your Abrants MoMo code is ${code}. It confirms this number for agent payouts. It expires in 10 minutes. Do not share it.`, 'agent.code');
}

/** Their payout number changed: told on their own phone, so a change they did not make is noticed (payouts wait a day). */
function agentMomoChanged(a, number) {
  if (!a || !sms.configured()) return;
  const masked = String(number).slice(0, 3) + '****' + String(number).slice(-3);
  sms.send(a.phone, `Abrants: The MoMo number for payouts on your shop ${shopShort(a)} is now ${masked}. If you did not do this, contact Abrants now.`, 'agent.momo');
}

module.exports = { dataStatus, serviceStatus, agentStatus, agentPaid, agentCode, agentMomoCode, agentMomoChanged, agentMessage, agentStrike, agentPaused, agentDeleted, programme, fit };
