// Merge devices reported by more than one source into a single record.
//
// Match rules (within one customer only, never across customers):
//   1. Same serial number (normalised)
//   2. Same MAC address (normalised)
//   3. A device without hardware identity (e.g. a Logitech Sync "Generic"
//      peripheral) matches a device with the same model in the same site+room.
//
// The merged record takes its fields from the manufacturer's own cloud when
// available (Poly Lens for a Poly device), fills gaps from other sources, and
// takes the most severe health so a problem seen by any source is not hidden.
import { normaliseSerial, normaliseMac, HEALTH_RANK } from '../lib/device-model.js';

const OEM_MAKE = { 'poly-lens': 'Poly', 'logitech-sync': 'Logitech' };

function modelKey(m) {
  return String(m || '').toLowerCase().replace(/^(poly|logitech|logi)\s+/, '').replace(/[^a-z0-9]/g, '');
}

export function dedupeDevices(devices) {
  const parent = devices.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  const index = new Map();
  const link = (key, i) => { if (!key) return; if (index.has(key)) union(index.get(key), i); else index.set(key, i); };

  devices.forEach((d, i) => {
    const s = normaliseSerial(d.serial);
    const m = normaliseMac(d.mac);
    if (s) link(`s|${d.customerId}|${s}`, i);
    if (m) link(`m|${d.customerId}|${m}`, i);
  });

  // Rule 3: weak-identity devices join a strong device of the same model in the same room.
  const roomModel = new Map();
  devices.forEach((d, i) => {
    if (d.weakIdentity) return;
    const k = `${d.customerId}|${d.site}|${d.room}|${modelKey(d.model)}`.toLowerCase();
    if (!roomModel.has(k)) roomModel.set(k, i);
  });
  devices.forEach((d, i) => {
    if (!d.weakIdentity) return;
    const k = `${d.customerId}|${d.site}|${d.room}|${modelKey(d.model)}`.toLowerCase();
    if (roomModel.has(k)) union(roomModel.get(k), i);
  });

  const groups = new Map();
  devices.forEach((d, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(d);
  });

  return [...groups.values()].map(mergeGroup);
}

function mergeGroup(group) {
  if (group.length === 1) return { ...group[0], duplicateOf: [] };
  const score = (d) => (d.sources.some((s) => OEM_MAKE[s.oem] === d.make) ? 4 : 0) + (d.weakIdentity ? 0 : 2) + (d.serial ? 1 : 0);
  const sorted = [...group].sort((a, b) => score(b) - score(a));
  const primary = sorted[0];
  const merged = { ...primary, weakIdentity: false };
  for (const d of sorted.slice(1)) {
    for (const [k, v] of Object.entries(d)) if ((merged[k] === null || merged[k] === undefined || merged[k] === 'Unassigned') && v != null) merged[k] = v;
  }
  const worst = sorted.reduce((w, d) => (HEALTH_RANK[d.health] > HEALTH_RANK[w.health] ? d : w), primary);
  merged.health = worst.health;
  merged.healthReason = worst.healthReason
    ? `${worst.sources.map((s) => s.oem).join(', ')}: ${worst.healthReason}`
    : null;
  merged.lastSeen = sorted.map((d) => d.lastSeen).filter(Boolean).sort().pop() ?? null;
  merged.sources = sorted.flatMap((d) => d.sources.map((s) => ({ ...s, health: d.health })));
  merged.duplicateOf = sorted.slice(1).map((d) => d.id);
  return merged;
}
