// Baseline standards, in two tiers.
//
// Advisory: the provider's recommended standard. Firmware targets come from the
// model master (one approved baseline per model); the advisory policy sets the
// warranty and lifecycle rules. Maintained by the super admin, and versioned.
//
// Customer: each customer's own standard, versioned. A customer can follow the
// advisory as-is, aim for the highest level (newest known release of every
// model), or pin individual models lower or higher than advisory. Warranty and
// lifecycle rules can follow the advisory policy or be set per customer.
// Devices are judged against their customer's baseline; drift from the
// advisory is shown alongside.
import { compareVersions } from './models.js';

export const LEVELS = {
  advisory: 'Follow advisory',
  latest: 'Highest (newest known release)',
};
// Per-model firmware rule. Anything else is a pinned version.
export const RULES = ['advisory', 'latest', 'none'];
// Lifecycle stage from which a device no longer meets the baseline.
export const LIFECYCLE_LIMITS = {
  eosale: 'End of sale (or discontinued)',
  eos: 'End of support',
  eol: 'End of life',
  none: 'Not enforced',
};
const STAGE_RANK = { eosale: 1, discontinued: 1, eos: 2, eol: 3 };

export const DEFAULT_ADVISORY_POLICY = Object.freeze({ warrantyRequired: true, warrantyNoticeDays: 90, lifecycleLimit: 'eos' });

const VERSION = /^[\w.\-+ ()]{1,40}$/;

/** Validate a warranty/lifecycle policy. */
export function cleanPolicy(p = {}, base = DEFAULT_ADVISORY_POLICY) {
  const days = p.warrantyNoticeDays === undefined ? base.warrantyNoticeDays : Number(p.warrantyNoticeDays);
  if (!Number.isInteger(days) || days < 0 || days > 730) throw new Error('Warranty notice must be a whole number of days between 0 and 730');
  const limit = p.lifecycleLimit === undefined ? base.lifecycleLimit : String(p.lifecycleLimit);
  if (!LIFECYCLE_LIMITS[limit]) throw new Error(`Lifecycle limit must be one of ${Object.keys(LIFECYCLE_LIMITS).join(', ')}`);
  return { warrantyRequired: p.warrantyRequired === undefined ? base.warrantyRequired : p.warrantyRequired !== false, warrantyNoticeDays: days, lifecycleLimit: limit };
}

/**
 * Validate a customer baseline submitted from the API.
 * `models` maps modelId -> rule ('advisory' | 'latest' | 'none' | a version).
 * `policy` null means "follow the advisory policy".
 */
export function cleanCustomerBaseline(input, knownModelIds) {
  const level = input.level ?? 'advisory';
  if (!LEVELS[level]) throw new Error('Level must be "advisory" or "latest"');
  const models = {};
  for (const [id, raw] of Object.entries(input.models || {})) {
    if (!knownModelIds.has(id)) throw new Error('A model in the baseline is no longer in the model master. Reload and try again.');
    const rule = String(raw ?? '').trim();
    if (!rule || rule === level) continue; // same as the default: no exception needed
    if (!RULES.includes(rule) && !VERSION.test(rule)) throw new Error(`"${rule}" is not a firmware version`);
    models[id] = rule;
  }
  const policy = input.policy ? cleanPolicy(input.policy) : null;
  const note = input.note ? String(input.note).trim().slice(0, 300) : null;
  return { level, models, policy, note };
}

/** Newest release recorded for a model (releases are kept newest first). */
export const latestRelease = (m) => m?.releases?.[0]?.version ?? null;

/**
 * Firmware target for one model under a customer baseline.
 * Returns { target, advisory, latest, rule, source, drift }.
 * drift compares the customer target with the advisory: above | same | below | not-enforced | no-advisory.
 */
export function resolveFirmware(model, cb) {
  const advisory = model?.baseline ?? null;
  const latest = latestRelease(model);
  const rule = (model && cb?.models?.[model.id]) || cb?.level || 'advisory';
  let target; let source;
  if (rule === 'advisory') { target = advisory; source = 'advisory'; }
  else if (rule === 'latest') { target = latest || advisory; source = latest ? 'latest' : 'advisory'; }
  else if (rule === 'none') { target = null; source = 'not enforced'; }
  else { target = rule; source = 'customer'; }
  let drift;
  if (rule === 'none') drift = 'not-enforced';
  else if (!advisory) drift = 'no-advisory';
  else if (!target) drift = 'not-enforced';
  else { const c = compareVersions(target, advisory); drift = c > 0 ? 'above' : c < 0 ? 'below' : 'same'; }
  return { target, advisory, latest, rule, source, drift };
}

/** Does a lifecycle stage breach the policy's limit? */
export function lifecycleBreach(stage, limit) {
  if (limit === 'none') return false;
  return (STAGE_RANK[stage] || 0) >= STAGE_RANK[limit];
}

/** Firmware status from a version and a target. */
export function firmwareStatus(firmware, target) {
  if (!target) return null;
  const c = compareVersions(firmware, target);
  return c < 0 ? 'behind' : c > 0 ? 'ahead' : 'compliant';
}
