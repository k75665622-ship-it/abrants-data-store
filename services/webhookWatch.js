/*
 * DataHustle confirms deliveries through its webhook and switches the webhook off by itself after
 * repeated failures (for example while the site was redeploying). When that happens orders stay on
 * "processing" even though the data arrived. This keeps the webhook switched on.
 */
const dh = require('./datahustle');

// The status response shape is not documented; look for the first on/off flag anywhere in it.
function findActiveFlag(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(value)) {
    if (/^(is_?active|active|enabled|is_?enabled)$/i.test(k) && typeof v === 'boolean') return v;
  }
  for (const v of Object.values(value)) {
    const found = findActiveFlag(v, depth + 1);
    if (found != null) return found;
  }
  return null;
}

async function webhookWatchTick(addAlert) {
  if (process.env.DATAHUSTLE_MOCK_MODE === 'true' || !process.env.DATAHUSTLE_API_KEY) return { skipped: true };
  const status = await dh.getWebhookStatus();
  if (findActiveFlag(status) !== false) return { active: true };
  await dh.setWebhookActive(true);
  console.warn('DataHustle webhook was switched off; switched it back on.');
  await addAlert('danger', 'DataHustle had stopped sending delivery updates, so orders stayed on "Processing". Updates are switched back on.');
  return { active: false, reenabled: true };
}

module.exports = { webhookWatchTick, findActiveFlag };
