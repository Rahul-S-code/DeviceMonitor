// Background sync scheduler.
//
// Every connection syncs on its own interval (a per-connection setting, or the
// global default from the admin page). Connections are staggered so they never
// all call their vendor APIs at once, at most SYNC_CONCURRENCY run at the same
// time, a sync that hangs is abandoned after SYNC_TIMEOUT_SECONDS, and a
// failing connection backs off exponentially. A snapshot identical to the last
// one changes nothing; a changed one rebuilds only that customer's inventory,
// and rebuilds are coalesced so a burst of syncs costs one rebuild.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { createConnector, getConnectorClass } from '../connectors/registry.js';

const SEVERITY = { warning: 'warning', critical: 'critical', offline: 'critical' };

/** Limits for sync intervals, in seconds. */
export const SYNC_LIMITS = Object.freeze({ min: 60, max: 86_400, default: 300 });
/** Choices offered on the admin page (any whole number of seconds in range is accepted). */
export const SYNC_PRESETS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400];
const MAX_BACKOFF_MS = 3_600_000;
const FIRST_RUN_SPREAD_MS = 30_000;
const ALERT_BURST = 25; // more alerts than this from one rebuild go out as one 'alerts' event

/** Minimum interval for a connector: its own documented limit, never below the global minimum. */
export function minIntervalFor(oem) {
  let C = null;
  try { C = getConnectorClass(oem); } catch { /* unknown connector */ }
  return Math.max(SYNC_LIMITS.min, Number(C?.minSyncSeconds) || 0);
}

/**
 * Validate an interval in seconds. null/'' means "use the default" (returns null).
 * Throws a readable error when it is out of range.
 */
export function cleanInterval(value, { min = SYNC_LIMITS.min, allowNull = true, label = 'Sync interval' } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new Error(`${label} must be a whole number of seconds`);
  if (n < min) throw new Error(`${label} must be at least ${fmtSeconds(min)}`);
  if (n > SYNC_LIMITS.max) throw new Error(`${label} can be at most ${fmtSeconds(SYNC_LIMITS.max)}`);
  return n;
}

export function fmtSeconds(s) {
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? '' : 's'}`;
  return `${s} seconds`;
}

export class SyncService extends EventEmitter {
  constructor({ store, vault, inventory, history = null, persistence = null, intervalMs = null, concurrency = Number(process.env.SYNC_CONCURRENCY) || 4, timeoutMs = Number(process.env.SYNC_TIMEOUT_SECONDS || 120) * 1000 }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { store, vault, inventory, history, persistence, concurrency: Math.max(1, concurrency), timeoutMs });
    // Default interval before an admin sets one: SYNC_INTERVAL_SECONDS (or the createApp option), else 5 minutes.
    this.envDefault = intervalMs ? Math.max(SYNC_LIMITS.min, Math.round(intervalMs / 1000)) : SYNC_LIMITS.default;
    this.status = new Map(); // connectionId -> status
    this.lastHealth = new Map(); // deviceId -> health
    this.nextAt = new Map(); // connectionId -> epoch ms of the next scheduled run
    this.failures = new Map(); // connectionId -> consecutive failures
    this.inFlight = new Map(); // connectionId -> promise
    this.timer = null;
    this.refreshTimer = null;
    this.primed = false;
    this.started = false;
  }

  // --- intervals ----------------------------------------------------------
  defaultIntervalSec() {
    const v = this.store.syncSettings?.().defaultIntervalSec;
    return typeof v === 'number' ? v : this.envDefault;
  }

  /** Effective interval for a connection, in seconds, with where it comes from. */
  intervalInfo(conn) {
    const min = minIntervalFor(conn.oem);
    const own = typeof conn.syncIntervalSec === 'number' ? conn.syncIntervalSec : null;
    const seconds = Math.max(min, own ?? this.defaultIntervalSec());
    return { seconds, source: own !== null ? 'connection' : 'default', min };
  }

  /** Re-plan a connection after its interval changed (keeps the last run, moves the next one). */
  reschedule(conn) {
    const st = this.statusFor(conn.id);
    const last = Date.parse(st.lastRunAt || '') || Date.now();
    const next = last + this.intervalInfo(conn).seconds * 1000;
    this.nextAt.set(conn.id, Math.max(Date.now() + 1000, next));
    this.kick();
  }

  rescheduleAll() { for (const c of this.store.connections) this.reschedule(c); }

  statusFor(connectionId) {
    const st = this.status.get(connectionId) ?? { state: 'never', lastRunAt: null, lastSuccessAt: null, durationMs: null, deviceCount: 0, error: null };
    const conn = this.store.connections.find((c) => c.id === connectionId);
    if (!conn) return st;
    const next = this.nextAt.get(connectionId);
    return { ...st, intervalSec: this.intervalInfo(conn).seconds, intervalSource: this.intervalInfo(conn).source, nextRunAt: this.started && next ? new Date(next).toISOString() : null, failures: this.failures.get(connectionId) || 0 };
  }

  connectorFor(conn) {
    const creds = conn.mode === 'live' ? this.vault.decrypt(conn.secret) : {};
    return createConnector(conn, creds);
  }

  // --- running one connection ------------------------------------------------
  /** Sync one connection now (joins a run already in progress). Does not rebuild the inventory. */
  syncConnection(conn) {
    if (this.inFlight.has(conn.id)) return this.inFlight.get(conn.id);
    const p = this.runConnection(conn).finally(() => this.inFlight.delete(conn.id));
    this.inFlight.set(conn.id, p);
    return p;
  }

  async runConnection(conn) {
    const prev = this.status.get(conn.id) ?? { state: 'never', lastRunAt: null, lastSuccessAt: null, durationMs: null, deviceCount: 0, error: null };
    this.status.set(conn.id, { ...prev, state: 'syncing' });
    this.emit('sync', { connectionId: conn.id, ...this.statusFor(conn.id) });
    const started = Date.now();
    let changed = false;
    try {
      // A customer with mock data switched off gets nothing from mock-mode connections:
      // its devices come only from live APIs and manual or bulk uploads.
      const mockOff = conn.mode !== 'live' && this.store.mockEnabled?.(conn.customerId) === false;
      const devices = mockOff ? [] : await withTimeout(this.connectorFor(conn).sync(), this.timeoutMs, `${conn.name} did not finish syncing within ${Math.round(this.timeoutMs / 1000)} seconds`);
      if (!this.store.connections.some((c) => c.id === conn.id)) return false; // deleted while syncing
      changed = this.inventory.setConnectionDevices(conn.id, devices, conn.customerId);
      const now = new Date().toISOString();
      this.status.set(conn.id, { state: 'ok', mode: conn.mode, ...(mockOff ? { mockOff: true } : {}), lastRunAt: now, lastSuccessAt: now, durationMs: Date.now() - started, deviceCount: devices.length, changed, error: null });
      this.failures.delete(conn.id);
      if (changed) this.persistence?.saveSnapshot({ connectionId: conn.id, customerId: conn.customerId, hash: this.inventory.snapshot(conn.id).hash, syncedAt: now, devices });
      if (prev.state === 'error') this.raise({ kind: 'sync', severity: 'resolved', customerId: conn.customerId, connectionId: conn.id, message: `${conn.name}: sync recovered` });
    } catch (err) {
      // Keep the last good data so a flaky API doesn't blank the dashboard.
      this.failures.set(conn.id, (this.failures.get(conn.id) || 0) + 1);
      this.status.set(conn.id, { ...prev, state: 'error', mode: conn.mode, lastRunAt: new Date().toISOString(), durationMs: Date.now() - started, error: err.message });
      if (prev.state !== 'error') this.raise({ kind: 'sync', severity: 'critical', customerId: conn.customerId, connectionId: conn.id, message: `${conn.name}: sync failed. ${err.message}` });
    }
    this.planNext(conn);
    this.emit('sync', { connectionId: conn.id, ...this.statusFor(conn.id) });
    return changed;
  }

  planNext(conn) {
    const base = this.intervalInfo(conn).seconds * 1000;
    const fails = this.failures.get(conn.id) || 0;
    // Failing connections back off: interval x2, x4... up to an hour (or the interval, if longer).
    const wait = fails ? Math.max(base, Math.min(base * 2 ** Math.min(fails, 6), MAX_BACKOFF_MS)) : base;
    const jitter = 1 + (Math.random() - 0.5) * 0.1; // +-5% so connections drift apart instead of bunching up
    this.nextAt.set(conn.id, Date.now() + Math.round(wait * jitter));
  }

  /** Sync every connection now, a few at a time, then rebuild. Used at first start, by tests and by "Sync all". */
  async syncAll() {
    const queue = [...this.store.connections];
    const worker = async () => { for (let c = queue.shift(); c; c = queue.shift()) await this.syncConnection(c); };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    this.refresh();
  }

  async syncOne(connectionId) {
    const conn = this.store.connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('Connection not found');
    await this.syncConnection(conn);
    this.refreshPending();
    return this.statusFor(conn.id);
  }

  // --- scheduler -------------------------------------------------------------
  start() {
    if (this.started) return;
    this.started = true;
    this.restore();
    const now = Date.now();
    for (const c of this.store.connections) {
      if (this.nextAt.has(c.id)) continue;
      const last = Date.parse(this.status.get(c.id)?.lastSuccessAt || '');
      const interval = this.intervalInfo(c).seconds * 1000;
      // Never synced (or overdue): spread first runs over 30 seconds. Otherwise resume the cycle.
      const spread = Math.min(interval, FIRST_RUN_SPREAD_MS);
      this.nextAt.set(c.id, Number.isFinite(last) && last + interval > now ? last + interval : now + Math.floor(stagger(c.id) * spread));
    }
    this.tick();
  }

  stop() {
    this.started = false;
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.refreshTimer); this.refreshTimer = null;
  }

  kick() { if (this.started) { clearTimeout(this.timer); this.timer = setTimeout(() => this.tick(), 0); this.timer.unref?.(); } }

  tick() {
    if (!this.started) return;
    clearTimeout(this.timer);
    const now = Date.now();
    const live = new Set();
    for (const c of this.store.connections) {
      live.add(c.id);
      if (!this.nextAt.has(c.id)) this.nextAt.set(c.id, now + Math.floor(stagger(c.id) * FIRST_RUN_SPREAD_MS));
    }
    for (const id of this.nextAt.keys()) if (!live.has(id)) { this.nextAt.delete(id); this.failures.delete(id); this.status.delete(id); }
    const due = this.store.connections.filter((c) => this.nextAt.get(c.id) <= now && !this.inFlight.has(c.id)).sort((a, b) => this.nextAt.get(a.id) - this.nextAt.get(b.id));
    for (const c of due) {
      if (this.inFlight.size >= this.concurrency) break;
      this.syncConnection(c).then((changed) => { if (changed) this.scheduleRefresh(); }).finally(() => this.kick());
    }
    const upcoming = Math.min(...[...this.nextAt.values()].filter((t) => t > now), now + 60_000);
    this.timer = setTimeout(() => this.tick(), Math.max(250, Math.min(upcoming - now, 60_000)));
    this.timer.unref?.();
  }

  /** Coalesce rebuilds: at most one per second however many connections finish. */
  scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refreshPending(); }, 1000);
    this.refreshTimer.unref?.();
  }

  /** Load the last snapshots (from disk or Postgres) so the dashboard is populated before the first sync. */
  restore() {
    const snaps = this.persistence?.loadSnapshots?.() || [];
    const known = new Map(this.store.connections.map((c) => [c.id, c]));
    let n = 0;
    for (const s of snaps) {
      const conn = known.get(s.connectionId);
      if (!conn) { this.persistence.deleteSnapshot(s.connectionId); continue; }
      if (this.inventory.snapshot(conn.id)) continue;
      this.inventory.setConnectionDevices(conn.id, s.devices, conn.customerId);
      this.status.set(conn.id, { state: 'ok', mode: conn.mode, restored: true, lastRunAt: s.syncedAt, lastSuccessAt: s.syncedAt, durationMs: null, deviceCount: s.devices.length, error: null });
      n++;
    }
    if (n) this.refreshPending();
    return n;
  }

  // --- inventory rebuilds and alerts --------------------------------------------
  /** Full rebuild after a configuration change. With a customer id, only that customer. */
  refresh(customerId) {
    this.inventory.invalidate(customerId);
    return this.apply(this.inventory.rebuild());
  }

  /** Rebuild only customers whose snapshots changed since the last rebuild. */
  refreshPending() {
    if (!this.inventory.pending) return null;
    return this.apply(this.inventory.rebuild());
  }

  apply(result) {
    const { devices, removed } = result;
    // SLA history: devices fed only by mock connections get simulated history before recording began.
    const modeOf = new Map(this.store.connections.map((c) => [c.id, c.mode]));
    this.history?.record(devices.filter((d) => d.health !== 'unmonitored'), (d) => d.sources.every((x) => modeOf.get(x.connectionId) !== 'live'));
    // OEM release tracking: firmware versions seen for the first time on catalogued models.
    for (const { model, version } of this.store.recordFleetFirmware(devices)) {
      this.store.audit({ actor: { id: 'system', email: 'system', name: 'Sync', role: 'system' }, action: 'firmware.detected', target: `${model.make} ${model.model}`, details: { version, note: 'First seen in the fleet' } });
    }
    const alerts = [];
    for (const d of devices) {
      const before = this.lastHealth.get(d.id);
      this.lastHealth.set(d.id, d.health);
      if (before === d.health) continue;
      if (d.health === 'unmonitored' || (before === 'unmonitored' && d.health === 'healthy')) continue; // manual devices raise no alerts
      if (before === undefined && d.health === 'healthy') continue;
      if (before === undefined && this.primed === false && d.health !== 'healthy') { alerts.push(deviceAlert(d, null, { initial: true })); continue; }
      if (before === undefined) { if (d.health !== 'healthy') alerts.push(deviceAlert(d, null)); continue; }
      alerts.push(deviceAlert(d, before));
    }
    for (const id of removed) this.lastHealth.delete(id);
    if (result.full) { const ids = this.inventory.byId; for (const id of this.lastHealth.keys()) if (!ids.has(id)) this.lastHealth.delete(id); }
    if (alerts.length) this.raiseMany(alerts);
    this.primed = true;
    this.emit('inventory', { builtAt: this.inventory.builtAt, customers: result.customers.length });
    return this.inventory.devices;
  }

  raise(alert) { return this.raiseMany([alert])[0]; }

  /** Store alerts (newest first, bounded by count and age) and announce them. */
  raiseMany(list) {
    const at = new Date().toISOString();
    const made = list.map((a) => ({ id: crypto.randomUUID(), at, ...a }));
    this.store.addAlerts(made);
    if (made.length > ALERT_BURST) this.emit('alerts', { count: made.length, at });
    else for (const a of made) this.emit('alert', a);
    return made;
  }
}

function deviceAlert(d, before, extra = {}) {
  const name = d.model.toLowerCase().startsWith(d.make.toLowerCase()) ? d.model : `${d.make} ${d.model}`;
  const recovered = d.health === 'healthy';
  const label = { warning: 'Warning', critical: 'Critical', offline: 'Offline', healthy: 'Healthy' }[d.health];
  return {
    kind: 'device',
    severity: recovered ? 'resolved' : SEVERITY[d.health],
    from: before,
    to: d.health,
    customerId: d.customerId,
    deviceId: d.id,
    site: d.site,
    room: d.room,
    make: d.make,
    model: d.model,
    platform: d.platform,
    oems: d.oems,
    errorCodes: recovered ? [] : d.errorCodes || [],
    message: recovered
      ? `${name} in ${d.room} recovered`
      : `${name} in ${d.room} is ${label}${d.healthReason ? `: ${d.healthReason}` : ''}`,
    ...extra,
  };
}

/** Stable position in [0, 1) per connection, so first runs are spread out the same way on every start. */
function stagger(id) {
  return crypto.createHash('md5').update(String(id)).digest().readUInt32BE(0) / 2 ** 32;
}

function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

export { getConnectorClass };
