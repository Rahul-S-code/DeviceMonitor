// Proactive checks: once a day (and on demand) look at each customer's estate
// and propose actions for the admin to approve or decline in the Action inbox.
//
// The rules are deterministic. Each produces "items" (one per device, connection
// or gap) with a stable key, grouped into actions by how they would be carried
// out. Reconciling against earlier actions gives the dedupe:
//   - an item already in an open action (proposed, approved, sent, failed) is not proposed again;
//   - an item in a declined action stays quiet until the action's snooze ends;
//   - open actions whose items have all cleared close themselves (resolved before
//     a decision, done after one).
// An AI-written summary or ranking can be added on top later; nothing here needs one.
import crypto from 'node:crypto';
import { getConnectorClass } from '../connectors/registry.js';

const DAY = 86_400_000;
export const SEVERITIES = ['high', 'medium', 'low'];
export const OPEN = new Set(['proposed', 'approved', 'sent', 'failed']);
export const STATUSES = ['proposed', 'approved', 'sent', 'failed', 'done', 'declined', 'resolved'];
export const RECURRING_INCIDENTS = 3; // incidents in 7 days that count as "keeps dropping"
export const DEFAULT_CHECKS = Object.freeze({ enabled: true, hourUtc: 6 });

export const RULES = {
  offline: { label: 'Offline device', area: 'Health' },
  faulty: { label: 'Faulty device', area: 'Health' },
  recurring: { label: 'Keeps dropping off', area: 'Health' },
  firmware: { label: 'Firmware below baseline', area: 'Baseline' },
  warranty: { label: 'Warranty', area: 'Lifecycle' },
  lifecycle: { label: 'End of support or life', area: 'Lifecycle' },
  connector: { label: 'Connection problem', area: 'Connections' },
  contact: { label: 'No site contact', area: 'Configuration' },
  platform: { label: 'Room without a meeting platform', area: 'Configuration' },
  warrantyData: { label: 'Missing warranty data', area: 'Configuration' },
};

// Actions tried in this order. Offline devices can't take a cloud command, so only a power-cycle helps.
const FIX_FOR = { offline: ['cycle'], faulty: ['reboot', 'restart', 'software-reboot', 'restart-room', 'cycle'] };
const AUTH_ERROR = /\b(401|403)\b|unauthori[sz]ed|forbidden|credential|token|api key|authori[sz]e|expired|invalid_client|access denied/i;

/** The vendor API action that can fix a device, or null. */
export function apiFix(store, d, rule) {
  for (const id of FIX_FOR[rule] || []) {
    for (const src of d.sources || []) {
      if (src.oem === 'manual') continue;
      const conn = store.connections.find((c) => c.id === src.connectionId);
      const C = conn && getConnectorClass(conn.oem);
      const a = C?.actions.find((x) => x.id === id);
      if (a && C.actionApplies(a, d, src)) {
        return { kind: 'api', connectionId: conn.id, oem: conn.oem, actionId: a.id, actionLabel: a.label, via: C.displayName, apiSet: a.api.set, endpoint: `${a.api.method} ${a.api.endpoint}`, mode: conn.mode, target: a.target };
      }
    }
  }
  return null;
}

const snap = (d) => ({
  deviceId: d.id, site: d.site, room: d.room, make: d.make, model: d.model, deviceType: d.deviceType,
  serial: d.serial ?? null, mac: d.mac ?? null, assetTag: d.assetTag ?? null, firmware: d.firmware ?? null,
  health: d.health, healthReason: d.healthReason ?? null, lastSeen: d.lastSeen ?? null,
  warrantyExpires: d.warrantyExpires ?? null, warrantyStatus: d.warrantyStatus ?? null, contractRef: d.contractRef ?? null,
  lifecycle: d.lifecycle ? { stage: d.lifecycle.stage, label: d.lifecycle.label, date: d.lifecycle.date ?? null } : null,
  oems: d.oems || [],
});
export const devName = (i) => (String(i.model || '').toLowerCase().startsWith(String(i.make || '').toLowerCase()) ? i.model : `${i.make} ${i.model}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Run every rule for one customer. Returns findings: [{ key, groupKey, rule, severity, site, ...meta, item }].
 */
export function findIssues({ store, inventory, history, sync, customerId, now = Date.now(), minDownMs = 15 * 60_000, contacts = null }) {
  const devs = inventory.forCustomer(customerId);
  const out = [];
  const add = (f) => out.push(f);
  const recentDone = new Map(); // item key -> action (done within 7 days), so a failed fix is not tried again the same way
  for (const a of store.actionsFor(customerId)) {
    if (a.status === 'done' && Date.parse(a.updatedAt) > now - 7 * DAY) for (const it of a.items) recentDone.set(it.key, a);
  }

  for (const d of devs) {
    // 1. Down now: offline (no cloud command can reach it) or critical (still online, so a reboot can).
    if (d.health === 'offline' || d.health === 'critical') {
      const rule = d.health === 'offline' ? 'offline' : 'faulty';
      const since = history?.devices?.[d.id]?.t?.at(-1)?.[0] ?? null;
      if (since && now - since < minDownMs) continue;
      const key = `${rule}:${d.id}`;
      const prior = recentDone.get(key);
      const viaApi = prior?.execution?.kind === 'api' ? null : apiFix(store, d, rule);
      const exec = viaApi || { kind: 'dispatch', runbook: 'power-cycle' };
      add({
        key, rule, severity: 'high', site: d.site, groupKey: `${rule}|${d.site}|${exec.kind === 'api' ? `${exec.connectionId}:${exec.actionId}` : 'dispatch'}`,
        execution: exec, item: { ...snap(d), downSince: since ? new Date(since).toISOString() : null, repeat: prior ? prior.ref : null },
      });
      continue;
    }
    // 2. Recurring: up now but dropped 3+ times in 7 days.
    if (history && d.health !== 'unmonitored') {
      const st = history.stats(d.id, now - 7 * DAY, now);
      const n = st.incidents.filter((i) => !i.ongoing).length;
      if (n >= RECURRING_INCIDENTS) {
        add({ key: `recurring:${d.id}`, rule: 'recurring', severity: 'medium', site: d.site, groupKey: `recurring|${d.site}|dispatch`, execution: { kind: 'dispatch', runbook: 'inspect' }, item: { ...snap(d), incidents: n, simulated: st.simulated } });
      }
    }
  }

  for (const d of devs) {
    // 3. Firmware below the customer's baseline, per model and target.
    if (d.firmwareStatus === 'behind' && d.baseline) {
      add({ key: `firmware:${d.id}@${d.baseline}`, rule: 'firmware', severity: 'medium', site: null, groupKey: `firmware|${d.modelId || `${d.make}|${d.model}`}|${d.baseline}`, execution: { kind: 'task', template: 'firmware', recipientRole: 'engineer' }, item: { ...snap(d), target: d.baseline, oem: (d.sources || []).find((s) => s.oem !== 'manual')?.oem || null } });
    }
    // 4. Warranty: expired (breaks the baseline) or expiring within the notice period.
    if (d.policy?.warrantyRequired && (d.warrantyStatus === 'expired' || d.warrantyStatus === 'expiring')) {
      add({ key: `warranty:${d.id}@${d.warrantyExpires}`, rule: 'warranty', severity: d.warrantyStatus === 'expired' ? 'medium' : 'low', site: null, groupKey: `warranty|${d.warrantyStatus}`, execution: { kind: 'task', template: 'warranty', recipientRole: 'renewals' }, item: snap(d) });
    }
    // 5. Lifecycle: past the customer's limit (end of sale, support or life).
    if (d.compliance && !d.compliance.lifecycle) {
      add({ key: `lifecycle:${d.id}@${d.lifecycle?.stage}`, rule: 'lifecycle', severity: d.lifecycle?.stage === 'eol' ? 'high' : 'medium', site: null, groupKey: `lifecycle|${d.modelId || `${d.make}|${d.model}`}`, execution: { kind: 'task', template: 'lifecycle', recipientRole: 'renewals' }, item: snap(d) });
    }
  }

  // 6. Connections: failing, credentials rejected, or not synced for a long time.
  for (const c of store.connections.filter((x) => x.customerId === customerId)) {
    const st = sync?.statusFor(c.id);
    if (!st) continue;
    const C = getConnectorClass(c.oem);
    const lastOk = Date.parse(st.lastSuccessAt || '');
    const staleAfter = Math.max(3 * (st.intervalSec || 300) * 1000, 2 * 3_600_000);
    const stale = st.state !== 'syncing' && st.state !== 'never' && Number.isFinite(lastOk) && now - lastOk > staleAfter;
    if (st.state !== 'error' && !stale) continue;
    const auth = st.state === 'error' && AUTH_ERROR.test(st.error || '');
    const base = { connectionId: c.id, connectionName: c.name, oem: c.oem, oemName: C.displayName, mode: c.mode, error: st.error || null, lastSuccessAt: st.lastSuccessAt || null, failures: st.failures || 0 };
    add({
      key: `connector:${c.id}:${auth ? 'auth' : 'sync'}`, rule: 'connector', severity: 'high', site: null, groupKey: `connector|${c.id}|${auth ? 'auth' : 'sync'}`,
      execution: auth ? { kind: 'config', link: '#/connections', linkLabel: 'Open Connections to re-enter the credentials' } : { kind: 'api', sync: true, connectionId: c.id, via: C.displayName, actionLabel: 'Retry the sync now' },
      item: { ...base, auth },
    });
  }

  // 7. Configuration gaps that stop actions from being carried out.
  const ct = contacts || store.contactsFor(customerId);
  const sites = new Map();
  for (const d of devs) sites.set(d.site, (sites.get(d.site) || 0) + 1);
  for (const [site, n] of sites) {
    if (!ct.sites?.[site]?.email) add({ key: `contact:${site}`, rule: 'contact', severity: 'low', site: null, groupKey: 'contact', execution: { kind: 'config', link: '#/inbox/contacts', linkLabel: 'Add site contacts' }, item: { site, devices: n } });
  }
  const unassigned = new Map();
  for (const d of devs) if (d.platform === 'Unassigned' && d.health !== 'unmonitored') unassigned.set(`${d.site}|${d.room}`, { site: d.site, room: d.room });
  for (const [k, r] of unassigned) add({ key: `platform:${k}`, rule: 'platform', severity: 'low', site: null, groupKey: 'platform', execution: { kind: 'config', link: '#/estate', linkLabel: 'Set the platform on each room page' }, item: r });
  const policy = store.effectivePolicy(customerId);
  if (policy.warrantyRequired) {
    for (const d of devs) if (d.warrantyStatus === 'unknown') add({ key: `warrantyData:${d.id}`, rule: 'warrantyData', severity: 'low', site: null, groupKey: 'warrantyData', execution: { kind: 'config', link: '#/devices', linkLabel: 'Add warranty dates (device panel, bulk edit or CSV import)' }, item: snap(d) });
  }
  return out;
}

/** Title and reason for an action from its rule and live items. */
export function describe(a) {
  const live = a.items.filter((i) => !i.cleared);
  const n = live.length || a.items.length;
  const first = live[0] || a.items[0] || {};
  const at = a.site ? ` at ${a.site}` : '';
  const ex = a.execution;
  switch (a.rule) {
    case 'offline':
    case 'faulty': {
      const what = a.rule === 'offline' ? 'offline' : 'reporting a fault';
      const verb = ex.kind === 'api' ? (ex.actionId === 'cycle' ? 'Power-cycle' : 'Restart') : 'Ask the site to power-cycle';
      const repeat = live.some((i) => i.repeat) ? ' A remote fix was tried in the last 7 days and did not hold, so this goes to the site.' : '';
      return {
        title: `${verb} ${n === 1 ? `${devName(first)} in ${first.room}` : plural(n, 'device')}${at}`,
        reason: `${plural(n, 'device')} ${n === 1 ? 'is' : 'are'} ${what}.${ex.kind === 'api' ? ` ${ex.via} can ${ex.actionLabel.toLowerCase()} remotely.` : ` No vendor API can ${a.rule === 'offline' ? 'reach an offline device' : 'restart these devices'}, so the steps go to the local contact.`}${repeat}`,
      };
    }
    case 'recurring':
      return { title: `Inspect ${n === 1 ? `${devName(first)} in ${first.room}` : plural(n, 'device')}${at}: keeps dropping off`, reason: `${plural(n, 'device')} went down ${RECURRING_INCIDENTS} or more times in the last 7 days (up to ${Math.max(...live.map((i) => i.incidents || 0), 0)}). That usually points to a loose cable, power or a network port, which needs someone on site.` };
    case 'firmware':
      return { title: `Update ${plural(n, 'device')} of ${devName(first)} to ${first.target}`, reason: `${plural(n, 'device')} run${n === 1 ? 's' : ''} firmware below the customer's baseline ${first.target}. None of the connected vendor APIs can push firmware, so this is a task for an engineer in the vendor portal.` };
    case 'warranty': {
      const expired = a.groupKey.endsWith('expired');
      return { title: `${expired ? 'Renew expired warranty' : 'Renew warranty before it ends'} for ${plural(n, 'device')}`, reason: expired ? `Warranty or support has ended on ${plural(n, 'device')}. The customer's baseline requires warranty cover.` : `Warranty or support ends within the customer's notice period on ${plural(n, 'device')}.` };
    }
    case 'lifecycle':
      return { title: `Plan replacement of ${plural(n, 'device')} of ${devName(first)}`, reason: `${devName(first)} is past the customer's lifecycle limit: ${first.lifecycle?.label || 'end of support'}${first.lifecycle?.date ? ` (${first.lifecycle.date})` : ''}.` };
    case 'connector':
      return first.auth
        ? { title: `Renew credentials for ${first.connectionName}`, reason: `${first.oemName} is rejecting the saved credentials${first.error ? `: ${first.error}` : ''}. Devices from this connection are not being updated until new credentials are saved.` }
        : { title: `Fix syncing for ${first.connectionName}`, reason: first.error ? `The last sync failed: ${first.error}` : `No successful sync since ${first.lastSuccessAt || 'it was added'}.` };
    case 'contact':
      return { title: `Add a local contact for ${plural(n, 'site')}`, reason: `${live.map((i) => i.site).slice(0, 5).join(', ')}${n > 5 ? '…' : ''} ${n === 1 ? 'has' : 'have'} no site contact (SPOC) email, so on-site steps can't be emailed there in one click.` };
    case 'platform':
      return { title: `Set the meeting platform for ${plural(n, 'room')}`, reason: 'These rooms have no meeting platform (the vendor API does not report one and nothing is set in the room directory), so platform filters and reports miss them.' };
    case 'warrantyData':
      return { title: `Record warranty dates for ${plural(n, 'device')}`, reason: 'The customer\'s baseline requires warranty cover, but no warranty end date is known for these devices, so expiry can\'t be checked.' };
    default:
      return { title: RULES[a.rule]?.label || a.rule, reason: '' };
  }
}

const groupSeverity = (items, fallback) => {
  const rank = { high: 0, medium: 1, low: 2 };
  return items.reduce((s, i) => (rank[i.severity] < rank[s] ? i.severity : s), fallback);
};

/**
 * Merge new findings into the customer's actions. Returns { created, updated, closed }.
 */
export function reconcile(store, customerId, findings, { now = Date.now(), snoozeDefaultDays = 30 } = {}) {
  const iso = new Date(now).toISOString();
  const byKey = new Map(findings.map((f) => [f.key, f]));
  const actions = store.actionsFor(customerId);
  const covered = new Set();
  const suppressed = new Set();
  let updated = 0; let closed = 0; let created = 0;
  for (const a of actions) {
    if (OPEN.has(a.status)) for (const it of a.items) covered.add(it.key);
    if (a.status === 'declined') {
      const until = Date.parse(a.snoozeUntil || '') || Date.parse(a.updatedAt) + snoozeDefaultDays * DAY;
      if (until > now) for (const it of a.items) suppressed.add(it.key);
    }
  }

  for (const a of actions) {
    if (!OPEN.has(a.status)) continue;
    let changed = false;
    for (const it of a.items) {
      const f = byKey.get(it.key);
      if (f && it.cleared) { it.cleared = false; delete it.clearedAt; changed = true; }
      if (!f && !it.cleared) { it.cleared = true; it.clearedAt = iso; changed = true; }
      if (f) Object.assign(it, f.item, { key: it.key, cleared: false });
    }
    // Proposed actions pick up new items of the same kind (same site and execution path).
    if (a.status === 'proposed') {
      for (const f of findings) {
        if (f.groupKey === a.groupKey && !covered.has(f.key) && !suppressed.has(f.key)) {
          a.items.push({ ...f.item, key: f.key }); covered.add(f.key); changed = true;
        }
      }
    }
    if (a.items.every((i) => i.cleared)) {
      const to = a.status === 'proposed' ? 'resolved' : 'done';
      a.status = to; a.updatedAt = iso;
      a.history.push({ at: iso, status: to, by: null, note: to === 'resolved' ? 'Cleared on its own before a decision' : 'The daily check found the issue fixed' });
      closed++; changed = true;
    }
    a.lastCheckedAt = iso;
    if (changed) { Object.assign(a, describe(a)); a.updatedAt = iso; updated++; }
  }

  const groups = new Map();
  for (const f of findings) {
    if (covered.has(f.key) || suppressed.has(f.key)) continue;
    if (!groups.has(f.groupKey)) groups.set(f.groupKey, []);
    groups.get(f.groupKey).push(f);
  }
  for (const [groupKey, fs] of groups) {
    const f0 = fs[0];
    const a = {
      id: crypto.randomUUID(), ref: store.nextActionRef(), customerId, rule: f0.rule, groupKey, site: f0.site,
      severity: groupSeverity(fs, f0.severity), execution: f0.execution,
      items: fs.map((f) => ({ ...f.item, key: f.key })),
      status: 'proposed', createdAt: iso, updatedAt: iso, lastCheckedAt: iso,
      history: [{ at: iso, status: 'proposed', by: null, note: 'Proposed by the daily check' }],
    };
    Object.assign(a, describe(a));
    store.addAction(a);
    created++;
  }
  store.save();
  return { created, updated, closed };
}

/** Daily scheduler plus run-now. */
export class ChecksService {
  constructor({ store, inventory, history, sync, minDownMs, onRun = null }) {
    Object.assign(this, { store, inventory, history, sync, minDownMs, onRun });
    this.timer = null;
    this.running = null;
  }

  settings() { return { ...DEFAULT_CHECKS, ...(this.store.settings.checks || {}) }; }

  /** Next scheduled run (ISO) or null when switched off. */
  nextRunAt(now = Date.now()) {
    const s = this.settings();
    if (!s.enabled) return null;
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.hourUtc);
    const last = Date.parse(s.lastRunAt || '');
    if (t <= now && Number.isFinite(last) && last >= t) t += DAY;
    return new Date(Math.max(t, now)).toISOString();
  }

  runCustomer(customerId, { now = Date.now(), by = null } = {}) {
    const findings = findIssues({ store: this.store, inventory: this.inventory, history: this.history, sync: this.sync, customerId, now, minDownMs: this.minDownMs });
    const r = reconcile(this.store, customerId, findings, { now });
    const s = this.store.settings;
    s.checks = { ...DEFAULT_CHECKS, ...(s.checks || {}) };
    s.checks.byCustomer = { ...(s.checks.byCustomer || {}), [customerId]: { at: new Date(now).toISOString(), by: by?.email || null, findings: findings.length, ...r } };
    this.store.save();
    return { findings: findings.length, ...r };
  }

  runAll({ now = Date.now(), by = null } = {}) {
    const out = {};
    for (const c of this.store.customers) out[c.id] = this.runCustomer(c.id, { now, by });
    const s = this.store.settings.checks;
    s.lastRunAt = new Date(now).toISOString();
    this.store.save();
    this.onRun?.(out);
    return out;
  }

  /** Run when today's slot has passed and today's run hasn't happened. */
  tick(now = Date.now()) {
    const s = this.settings();
    if (!s.enabled) return false;
    if (this.sync && !this.inventory.builtAt) return false; // nothing synced yet
    const d = new Date(now);
    const slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.hourUtc);
    const last = Date.parse(s.lastRunAt || '');
    if (now < slot || (Number.isFinite(last) && last >= slot)) return false;
    try { this.runAll({ now }); } catch (e) { console.error(`[checks] ${e.message}`); }
    return true;
  }

  start() {
    if (this.timer) return;
    const loop = () => { this.tick(); this.timer = setTimeout(loop, 5 * 60_000); this.timer.unref?.(); };
    this.timer = setTimeout(loop, 60_000);
    this.timer.unref?.();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }
}
