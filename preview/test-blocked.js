/*
 * Preview smoke test — blocked numbers must not be able to buy.
 *
 *   node preview/mock-server.js      (in one terminal)
 *   node preview/test-blocked.js     (in another)
 *
 * Mirrors the gates in the real POST /api/checkout, so a regression in the
 * preview shows up here rather than in a demo.
 */
const BASE = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + label.padEnd(58) +
    'got ' + String(actual).padEnd(6) + 'expected ' + expected
  );
}

async function checkout(body) {
  const r = await fetch(BASE + '/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = {};
  try { json = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, body: json };
}

async function block(phone, reason) {
  const r = await fetch(BASE + '/api/admin/blocked-numbers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, reason }),
  });
  return { status: r.status, body: await r.json() };
}

async function unblock(phone) {
  const r = await fetch(BASE + '/api/admin/blocked-numbers/' + encodeURIComponent(phone), { method: 'DELETE' });
  return r.status;
}

const PLAN = 'mtn-1gb';
const EMAIL = 'buyer@example.com';

(async () => {
  console.log('\n--- 1. a seeded blocked number cannot buy ---');
  const list = await (await fetch(BASE + '/api/admin/blocked-numbers')).json();
  const seeded = list[0].phone;
  console.log('  seeded blocked: ' + list.map((b) => b.phone).join(', '));
  check('checkout with blocked ' + seeded, (await checkout({ planId: PLAN, phone: seeded, email: EMAIL })).status, 403);

  console.log('\n--- 2. blocking works regardless of how the number is typed ---');
  const messy = '024 149-7084';          // spaces + dash
  const canonical = '0241497084';
  const b = await block(messy, 'test entry');
  check('block "' + messy + '"', b.status, 200);
  check('stored canonical form', b.body.phone, canonical);

  console.log('\n--- 3. the blocked number cannot buy in ANY format ---');
  check('as typed  "024 149-7084"', (await checkout({ planId: PLAN, phone: '024 149-7084', email: EMAIL })).status, 403);
  check('dashed    "024-149-7084"', (await checkout({ planId: PLAN, phone: '024-149-7084', email: EMAIL })).status, 403);
  check('padded    " 0241497084 "', (await checkout({ planId: PLAN, phone: ' 0241497084 ', email: EMAIL })).status, 403);
  check('plain     "0241497084"', (await checkout({ planId: PLAN, phone: canonical, email: EMAIL })).status, 403);

  console.log('\n--- 4. blocking twice does not create a duplicate ---');
  await block(canonical, 'again');
  const after = await (await fetch(BASE + '/api/admin/blocked-numbers')).json();
  check('entries for ' + canonical, after.filter((x) => x.phone === canonical).length, 1);

  console.log('\n--- 5. unblocking restores the ability to buy ---');
  check('unblock status', await unblock(canonical), 200);
  check('checkout after unblock', (await checkout({ planId: PLAN, phone: canonical, email: EMAIL })).status, 200);

  console.log('\n--- 6. other checkout gates still hold ---');
  check('invalid phone "12345"', (await checkout({ planId: PLAN, phone: '12345', email: EMAIL })).status, 400);
  check('country-code form', (await checkout({ planId: PLAN, phone: '+233551234567', email: EMAIL })).status, 400);
  check('bad email', (await checkout({ planId: PLAN, phone: '0551234567', email: 'nope' })).status, 400);
  check('unknown plan', (await checkout({ planId: 'nope', phone: '0551234567', email: EMAIL })).status, 400);
  check('inactive plan (at-10gb)', (await checkout({ planId: 'at-10gb', phone: '0265551234', email: EMAIL })).status, 400);
  check('blocking an invalid number', (await block('12345', 'x')).status, 400);

  console.log('\n' + (fail === 0
    ? 'ALL ' + pass + ' CHECKS PASSED'
    : fail + ' of ' + (pass + fail) + ' CHECKS FAILED') + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nTest run crashed:', e.message);
  console.error('Is the preview server running?  node preview/mock-server.js\n');
  process.exit(1);
});
