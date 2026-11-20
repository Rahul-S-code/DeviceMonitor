// Runs every connection on a schedule, tracks per-connection sync status,
// rebuilds the inventory, and turns health changes into alerts.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { createConnector, getConnectorClass } from '../connectors/registry.js';

const SEVERITY = { warning: 'warning', critical: 'critical', offline: 'critical' };
const MAX_ALERTS = 500;

export class SyncService extends EventEmitter {
  constructor({ store, vault, inventory, history = null, intervalMs = 30_000 }) {
    super();
    Object.assign(this, { store, vault, inventory, history, intervalMs });
    this.status = new Map(); // connectionId -> status
    this.lastHealth = new Map(); // deviceId -> health
    this.running = false;
    this.primed = false;
  }

  statusFor(connectionId) {
    return this.status.get(connectionId) ?? { state: 'never', lastRunAt: null, lastSuccessAt: null, durationMs: null, deviceCount: 0, error: null };
  }

  connectorFor(conn) {
    const creds = conn.mode === 'live' ? this.vault.decrypt(conn.secret) : {};
    return createConnector(conn, creds);
  }

  async syncConnection(conn) {
    const prev = this.statusFor(conn.id);
    this.status.set(conn.id, { ...prev, state: 'syncing' });
    this.emit('sync', { connectionId: conn.id, ...this.statusFor(conn.id) });
    const started = Date.now();
    try {
      // A customer with mock data switched off gets nothing from mock-mode connections:
      // its devices come only from live APIs and manual or bulk uploads.
      const mockOff = conn.mode !== 'live' && this.store.mockEnabled?.(conn.customerId) === false;
      const devices = mockOff ? [] : await this.connectorFor(conn).sync();
      this.inventory.setConnectionDevices(conn.id, devices);
      this.status.set(conn.id, { state: 'ok', mode: conn.mode, ...(mockOff ? { mockOff: true } : {}), lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), durationMs: Date.now() - started, deviceCount: devices.length, error: null });
      if (prev.state === 'error') this.raise({ kind: 'sync', severity: 'resolved', customerId: conn.customerId, connectionId: conn.id, message: `${conn.name}: sync recovered` });
    } catch (err) {
      // Keep the last good data so a flaky API doesn't blank the dashboard.
      this.status.set(conn.id, { ...prev, state: 'error', mode: conn.mode, lastRunAt: new Date().toISOString(), durationMs: Date.now() - started, error: err.message });
      if (prev.state !== 'error') this.raise({ kind: 'sync', severity: 'critical', customerId: conn.customerId, connectionId: conn.id, message: `${conn.name}: sync failed. ${err.message}` });
    }
    this.emit('sync', { connectionId: conn.id, ...this.statusFor(conn.id) });
  }

  async syncAll() {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(this.store.connections.map((c) => this.syncConnection(c)));
      this.refresh();
    } finally {
      this.running = false;
    }
  }

  async syncOne(connectionId) {
    const conn = this.store.connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('Connection not found');
    await this.syncConnection(conn);
    this.refresh();
    return this.statusFor(conn.id);
  }

  /** Rebuild inventory and emit alerts for health transitions. */
  refresh() {
    const devices = this.inventory.rebuild();
    // SLA history: devices fed only by mock connections get simulated history before recording began.
    const modeOf = new Map(this.store.connections.map((c) => [c.id, c.mode]));
    this.history?.record(devices.filter((d) => d.health !== 'unmonitored'), (d) => d.sources.every((x) => modeOf.get(x.connectionId) !== 'live'));
    // OEM release tracking: firmware versions seen for the first time on catalogued models.
    for (const { model, version } of this.store.recordFleetFirmware(devices)) {
      this.store.audit({ actor: { id: 'system', email: 'system', name: 'Sync', role: 'system' }, action: 'firmware.detected', target: `${model.make} ${model.model}`, details: { version, note: 'First seen in the fleet' } });
    }
    const seen = new Set();
    for (const d of devices) {
      seen.add(d.id);
      const before = this.lastHealth.get(d.id);
      this.lastHealth.set(d.id, d.health);
      if (before === d.health) continue;
      if (d.health === 'unmonitored' || (before === 'unmonitored' && d.health === 'healthy')) continue; // manual devices raise no alerts
      if (before === undefined && d.health === 'healthy') continue;
      if (before === undefined && this.primed === false && d.health !== 'healthy') {
        this.raise(deviceAlert(d, null, { initial: true }));
        continue;
      }
      if (before === undefined) { if (d.health !== 'healthy') this.raise(deviceAlert(d, null)); continue; }
      this.raise(deviceAlert(d, before));
    }
    for (const id of this.lastHealth.keys()) if (!seen.has(id)) this.lastHealth.delete(id);
    this.primed = true;
    this.emit('inventory', { builtAt: this.inventory.builtAt });
  }

  raise(alert) {
    const a = { id: crypto.randomUUID(), at: new Date().toISOString(), ...alert };
    this.store.data.alerts.unshift(a);
    this.store.data.alerts.length = Math.min(this.store.data.alerts.length, MAX_ALERTS);
    this.store.save();
    this.emit('alert', a);
    return a;
  }

  start() {
    this.syncAll();
    this.timer = setInterval(() => this.syncAll(), this.intervalMs);
  }

  stop() { clearInterval(this.timer); }
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

export { getConnectorClass };
