// Model and firmware master: the catalogue of make › model › device type,
// with an approved firmware baseline, lifecycle dates and known releases.
// Maintained by the super admin; every device is matched against it.
import crypto from 'node:crypto';

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Key that matches "Poly Studio X50" (make Poly) with "Studio X50". */
export function modelKey(make, model) {
  const mk = norm(make);
  let m = norm(model);
  if (mk && m.startsWith(mk) && m.length > mk.length) m = m.slice(mk.length);
  if (mk === 'logitech' && m.startsWith('logi')) m = m.slice(4);
  return `${mk}|${m}`;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!DATE.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`${label} must be a date (YYYY-MM-DD)`);
  return s;
};
const url = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^https:\/\/[^\s]+$/i.test(s)) throw new Error('Links must start with https://');
  return s.slice(0, 300);
};
const version = (v) => {
  const s = String(v || '').trim();
  if (!s || s.length > 40 || !/^[\w.\-+ ()]+$/.test(s)) throw new Error('Enter a firmware version such as 4.2.0');
  return s;
};

/** Validate and normalise a model record from the API. */
export function cleanModel(input, existing = null) {
  const make = String(input.make ?? existing?.make ?? '').trim().slice(0, 40);
  const model = String(input.model ?? existing?.model ?? '').trim().slice(0, 80);
  if (!make || !model) throw new Error('Make and model are required');
  const pick = (k, fn) => (input[k] === undefined ? existing?.[k] ?? null : fn(input[k]));
  return {
    id: existing?.id || `m-${crypto.randomUUID()}`,
    make,
    model,
    deviceType: String(input.deviceType ?? existing?.deviceType ?? 'Peripheral').trim().slice(0, 40) || 'Peripheral',
    monitoredBy: Array.isArray(input.monitoredBy) ? input.monitoredBy.map(String).slice(0, 8) : existing?.monitoredBy ?? [],
    baseline: pick('baseline', (v) => (v ? version(v) : null)),
    endOfSale: pick('endOfSale', (v) => date(v, 'End of sale')),
    endOfSupport: pick('endOfSupport', (v) => date(v, 'End of support')),
    endOfLife: pick('endOfLife', (v) => date(v, 'End of life')),
    lifecycleUrl: pick('lifecycleUrl', url),
    notes: pick('notes', (v) => (v ? String(v).trim().slice(0, 500) : null)),
    releases: existing?.releases ?? [],
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function cleanRelease(input) {
  return {
    version: version(input.version),
    releasedAt: date(input.releasedAt, 'Release date'),
    notesUrl: url(input.notesUrl),
    notes: input.notes ? String(input.notes).trim().slice(0, 300) : null,
    source: 'manual',
    firstSeenAt: null,
    addedAt: new Date().toISOString(),
  };
}

export function sortReleases(releases) {
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

const DAY = 86_400_000;
export const WARRANTY_SOON_DAYS = 90;

/** Lifecycle stage from a model's dates: the furthest stage already reached. */
export function lifecycleStage(m, now = Date.now()) {
  if (!m) return { stage: 'unknown', label: 'Not in model master' };
  const past = (d) => d && Date.parse(d) <= now;
  if (past(m.endOfLife)) return { stage: 'eol', label: 'End of life', date: m.endOfLife };
  if (past(m.endOfSupport)) return { stage: 'eos', label: 'End of support', date: m.endOfSupport };
  if (past(m.endOfSale)) return { stage: 'eosale', label: 'End of sale', date: m.endOfSale };
  const next = [['endOfSale', 'End of sale'], ['endOfSupport', 'End of support'], ['endOfLife', 'End of life']].find(([k]) => m[k] && Date.parse(m[k]) - now < 365 * DAY);
  if (next) return { stage: 'soon', label: `${next[1]} within 12 months`, date: m[next[0]] };
  if (!m.endOfSale && !m.endOfSupport && !m.endOfLife) return { stage: 'nodates', label: 'No lifecycle dates' };
  return { stage: 'supported', label: 'Supported' };
}

export function warrantyStatus(expires, now = Date.now()) {
  if (!expires) return 'unknown';
  const t = Date.parse(expires);
  if (t < now) return 'expired';
  if (t - now < WARRANTY_SOON_DAYS * DAY) return 'expiring';
  return 'active';
}
