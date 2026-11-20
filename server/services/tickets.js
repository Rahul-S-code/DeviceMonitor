// ServiceNow incidents, set up per customer.
//
// What raises an incident (each can be switched off per customer):
//   - a device offline, critical or (optionally) warning for longer than the
//     delay (default 10 minutes, so short blips don't open tickets)
//   - an issue an end user reports
//   - an Action inbox dispatch or task that is approved
//   - an admin pressing "Raise incident" on a device
// One fault gets one incident: the device's ticket is updated, not duplicated,
// and an incident still open in ServiceNow from before a restart is found again
// through its correlation_id. When the device recovers the incident gets a work
// note and is resolved (if auto-resolve is on). If someone resolves or closes it
// in ServiceNow first, no new incident is raised until the device recovers and
// fails again. Devices that were already faulty when the integration was
// switched on are skipped unless "include existing faults" is set.
import crypto from 'node:crypto';
import { ServiceNowClient, MockServiceNowClient, cleanInstanceUrl, correlationId, incidentUrl, CLOSED_STATES, STATE_LABEL, PRIORITY_MAP } from '../lib/servicenow.js';
import { ERROR_CODES } from '../lib/issues.js';

export const TRIGGERS = ['offline', 'critical', 'warning', 'reports', 'dispatches'];
export const DEFAULT_ITSM = Object.freeze({
  provider: 'servicenow', enabled: false, mode: 'mock', instanceUrl: '', username: '',
  assignmentGroup: '', category: 'hardware', callerId: '', closeCode: 'Solution provided',
  triggers: { offline: true, critical: true, warning: false, reports: true, dispatches: true },
  priorities: { offline: 2, critical: 3, warning: 4, report: 3, dispatch: 3 },
  delayMinutes: 10, autoResolve: true, includeExisting: false,
});
const OPEN = new Set(['open', 'failed']);
const POLL_MS = 5 * 60_000;
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const MAX_CREATE_PER_RUN = 20;
const TICKET_RETENTION_DAYS = 180;

const deviceName = (d) => (String(d.model || '').toLowerCase().startsWith(String(d.make || '').toLowerCase()) ? d.model : `${d.make} ${d.model}`);
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

/** Validate settings from the admin form. Returns a full config (secret handled by the caller). */
export function cleanItsm(input = {}, current = DEFAULT_ITSM) {
  const c = { ...DEFAULT_ITSM, ...current, triggers: { ...DEFAULT_ITSM.triggers, ...current.triggers }, priorities: { ...DEFAULT_ITSM.priorities, ...current.priorities } };
  if ('enabled' in input) c.enabled = !!input.enabled;
  if ('mode' in input) c.mode = input.mode === 'live' ? 'live' : 'mock';
  if ('instanceUrl' in input) c.instanceUrl = cleanInstanceUrl(input.instanceUrl);
  for (const k of ['username', 'assignmentGroup', 'category', 'callerId', 'closeCode']) if (k in input) c[k] = String(input[k] ?? '').trim().slice(0, 100);
  if (input.triggers) for (const k of TRIGGERS) if (k in input.triggers) c.triggers[k] = !!input.triggers[k];
  if (input.priorities) for (const k of Object.keys(DEFAULT_ITSM.priorities)) if (k in input.priorities) {
    const p = Number(input.priorities[k]);
    if (!PRIORITY_MAP[p]) throw new Error('Priority must be 1 to 5');
    c.priorities[k] = p;
  }
  if ('delayMinutes' in input) {
    const n = Number(input.delayMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 1440) throw new Error('Wait before raising must be 0 to 1,440 minutes');
    c.delayMinutes = n;
  }
  if ('autoResolve' in input) c.autoResolve = !!input.autoResolve;
  if ('includeExisting' in input) c.includeExisting = !!input.includeExisting;
  if (c.enabled && c.mode === 'live' && !c.instanceUrl) throw new Error('Enter the instance URL before switching on live mode');
  if (c.enabled && c.mode === 'live' && !c.username) throw new Error('Enter the ServiceNow user name before switching on live mode');
  return c;
}

export class TicketService {
  constructor({ store, vault, inventory, sync, publicUrl = null, clientFactory = null, now = () => Date.now() }) {
    Object.assign(this, { store, vault, inventory, sync, now });
    this.publicUrl = publicUrl ?? (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null));
    this.clientFactory = clientFactory;
    this.badSince = new Map(); // deviceId -> { health, since }
    this.lastPoll = new Map(); // customerId -> ms
    this.running = null;
    this.again = false;
    this.timer = null;
    this.onInventory = () => this.schedule();
    this.onAlert = (a) => { if (a?.kind === 'report') this.onReport(a).catch((e) => console.error(`[servicenow] report: ${e.message}`)); };
  }

  // --- storage --------------------------------------------------------------
  get all() { return (this.store.data.tickets ||= []); }
  configs() { return (this.store.data.itsm ||= {}); }
  config(customerId) { const c = this.configs()[customerId]; return c ? cleanItsm({}, c) : { ...DEFAULT_ITSM, triggers: { ...DEFAULT_ITSM.triggers }, priorities: { ...DEFAULT_ITSM.priorities } }; }
  rawConfig(customerId) { return this.configs()[customerId] || null; }
  forCustomer(customerId) { return this.all.filter((t) => t.customerId === customerId); }
  openFor(key) { return this.all.find((t) => t.key === key && OPEN.has(t.state)) || null; }
  latestFor(key) { return this.all.find((t) => t.key === key) || null; }

  /** Save settings. creds: { password } (blank keeps the stored one). Returns the public view. */
  saveConfig(customerId, input, creds = {}, actor = null) {
    const before = this.rawConfig(customerId);
    const prev = before ? this.config(customerId) : null;
    const next = cleanItsm(input, before || DEFAULT_ITSM);
    // A password never follows a changed instance or user: retype it.
    const secrets = before?.secret ? this.vault.decrypt(before.secret) : {};
    if (prev && (prev.instanceUrl !== next.instanceUrl || prev.username !== next.username) && !creds.password) delete secrets.password;
    if (typeof creds.password === 'string' && creds.password !== '') secrets.password = creds.password;
    if (creds.password === null) delete secrets.password;
    if (next.enabled && next.mode === 'live' && !secrets.password) throw new Error('Enter the ServiceNow password before switching on live mode');
    // Faults already open when the integration is switched on are left alone (unless asked).
    let skip = before?.skipDevices || [];
    if (next.enabled && !prev?.enabled) skip = next.includeExisting ? [] : this.inventory.forCustomer(customerId).filter((d) => this.triggerFor(next, d)).map((d) => d.id);
    this.configs()[customerId] = { ...next, secret: Object.keys(secrets).length ? this.vault.encrypt(secrets) : null, skipDevices: skip, updatedAt: new Date().toISOString(), updatedBy: actor?.email || null, lastTest: before?.lastTest || null };
    this.store.save();
    this.schedule();
    return this.publicConfig(customerId);
  }

  publicConfig(customerId) {
    const raw = this.rawConfig(customerId);
    const c = this.config(customerId);
    const open = this.forCustomer(customerId).filter((t) => t.state === 'open').length;
    const failed = this.forCustomer(customerId).filter((t) => t.state === 'failed').length;
    return { ...c, hasPassword: !!(raw?.secret && this.vault.decrypt(raw.secret).password), configured: !!raw, updatedAt: raw?.updatedAt || null, updatedBy: raw?.updatedBy || null, lastTest: raw?.lastTest || null, skipped: raw?.skipDevices?.length || 0, openTickets: open, failedTickets: failed };
  }

  client(customerId, cfg = this.config(customerId), password = null) {
    if (this.clientFactory) return this.clientFactory(customerId, cfg);
    if (cfg.mode !== 'live') return new MockServiceNowClient(customerId);
    const raw = this.rawConfig(customerId);
    const pw = password ?? (raw?.secret ? this.vault.decrypt(raw.secret).password : null);
    return new ServiceNowClient({ instanceUrl: cfg.instanceUrl, username: cfg.username, password: pw });
  }

  /** Test with saved or unsaved values. */
  async test(customerId, input = null, password = null, actor = null) {
    let r;
    try {
      const cfg = input ? cleanItsm({ ...input, enabled: false }, this.rawConfig(customerId) || DEFAULT_ITSM) : this.config(customerId);
      const saved = this.config(customerId);
      // A saved password is only used against the instance and user it was saved for.
      const samePlace = cfg.instanceUrl === saved.instanceUrl && cfg.username === saved.username;
      const pw = password || (samePlace ? null : '');
      r = await this.client(customerId, cfg, pw).test({ assignmentGroup: cfg.assignmentGroup });
      r.mode = cfg.mode;
    } catch (e) { r = { ok: false, message: e.message }; }
    const raw = this.rawConfig(customerId);
    if (raw) { raw.lastTest = { at: new Date().toISOString(), ok: r.ok, message: r.message, by: actor?.email || null, mode: r.mode || null }; this.store.save(); }
    return r;
  }

  // --- lifecycle --------------------------------------------------------------
  start() {
    this.sync.on('inventory', this.onInventory);
    this.sync.on('alert', this.onAlert);
    this.timer = setInterval(() => this.schedule(), 60_000);
    this.timer.unref?.();
    this.schedule();
  }

  stop() {
    this.sync.off('inventory', this.onInventory);
    this.sync.off('alert', this.onAlert);
    clearInterval(this.timer);
  }

  /** Run reconcile now, or once more after the current run. */
  schedule() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.reconcile(); } while (this.again);
      } catch (e) { console.error(`[servicenow] ${e.message}`); } finally { this.running = null; }
    })();
    return this.running;
  }

  async reconcile() {
    for (const [cid, raw] of Object.entries(this.configs())) {
      if (!raw?.enabled) continue;
      if (!this.store.customers.some((c) => c.id === cid)) { delete this.configs()[cid]; continue; }
      try { await this.reconcileCustomer(cid); } catch (e) { console.error(`[servicenow] ${cid}: ${e.message}`); }
    }
    this.prune();
  }

  triggerFor(cfg, d) {
    if (d.health === 'offline' && cfg.triggers.offline) return 'offline';
    if (d.health === 'critical' && cfg.triggers.critical) return 'critical';
    if (d.health === 'warning' && cfg.triggers.warning) return 'warning';
    return null;
  }

  async reconcileCustomer(cid) {
    const cfg = this.config(cid);
    const raw = this.rawConfig(cid);
    const client = this.client(cid, cfg);
    const now = this.now();
    const devices = this.inventory.forCustomer(cid);
    const byId = new Map(devices.map((d) => [d.id, d]));
    const skip = new Set(raw.skipDevices || []);
    let created = 0;

    for (const d of devices) {
      const trig = d.health === 'unmonitored' ? null : this.triggerFor(cfg, d);
      const prev = this.badSince.get(d.id);
      if (!trig) {
        this.badSince.delete(d.id);
        if (d.health === 'healthy') skip.delete(d.id); // recovered: the next fault may raise an incident
        continue;
      }
      if (!prev) this.badSince.set(d.id, { health: d.health, since: now });
      else if (prev.health !== d.health) {
        const t = this.openFor(`device:${d.id}`);
        if (t?.state === 'open') await this.note(cid, client, t, `Estate Monitor: ${deviceName(d)} is now ${d.health}${d.healthReason ? ` (${d.healthReason})` : ''}.`);
        prev.health = d.health;
      }
      if (skip.has(d.id)) continue;
      const open = this.openFor(`device:${d.id}`);
      if (open?.state === 'open') continue;
      if (open?.state === 'failed' && open.nextTryAt > now) continue;
      const since = this.badSince.get(d.id).since;
      if (now - since < cfg.delayMinutes * 60_000 && !open) continue;
      if (created >= MAX_CREATE_PER_RUN) break; // the rest go on the next run, a minute later
      created++;
      await this.raiseForDevice(cid, cfg, client, d, trig, open);
    }

    // Recovered or removed devices: resolve their incidents.
    for (const t of this.forCustomer(cid).filter((x) => x.kind === 'device' && OPEN.has(x.state))) {
      const d = byId.get(t.deviceId);
      if (d && this.triggerFor(cfg, d) && d.health !== 'unmonitored') continue;
      if (t.state === 'failed') { this.setState(t, 'cancelled', 'Device recovered before the incident could be raised'); continue; }
      await this.resolve(cid, cfg, client, t, d ? `${deviceName(d)} recovered (now ${d.health}).` : 'The device is no longer in the estate.', d);
    }

    // Action inbox items finished outside the normal Done button (cleared by the checks, declined...).
    for (const t of this.forCustomer(cid).filter((x) => x.kind === 'action' && x.state === 'open')) {
      const a = this.store.action(t.actionId);
      if (!a || ['done', 'resolved', 'declined'].includes(a.status)) await this.resolve(cid, cfg, client, t, a ? `${a.ref} is ${a.status} in the Action inbox.` : 'The Action inbox item was removed.');
    }

    // Incidents resolved or closed by someone in ServiceNow.
    if (now - (this.lastPoll.get(cid) || 0) >= POLL_MS) {
      this.lastPoll.set(cid, now);
      const open = this.forCustomer(cid).filter((t) => t.state === 'open' && t.sysId);
      for (let i = 0; i < open.length; i += 50) {
        try {
          const rows = await client.states(open.slice(i, i + 50).map((t) => t.sysId));
          const byId2 = new Map(rows.map((r) => [r.sys_id, r]));
          for (const t of open.slice(i, i + 50)) {
            const r = byId2.get(t.sysId);
            if (!r) continue;
            t.snState = String(r.state);
            if (CLOSED_STATES.has(t.snState) || r.active === 'false') {
              this.setState(t, 'closed', `${STATE_LABEL[t.snState] || 'Closed'} in ServiceNow`);
              if (t.deviceId) skip.add(t.deviceId); // no new incident until the device recovers
            }
          }
        } catch (e) { raw.lastError = { at: new Date().toISOString(), message: e.message }; }
      }
    }
    raw.skipDevices = [...skip];
    this.store.save();
  }

  // --- raising ----------------------------------------------------------------
  deviceIncident(cid, cfg, d, trig, by = null, note = null) {
    const name = deviceName(d);
    const label = { offline: 'offline', critical: 'critical', warning: 'warning' }[trig] || d.health;
    const codes = (d.errorCodes || d.issues?.map((i) => i.code) || []).filter(Boolean);
    const lines = [
      `${name} is ${label} in ${d.room}, ${d.site}.`,
      d.healthReason ? `Reason: ${d.healthReason}` : null,
      note ? `Note from ${by || 'Estate Monitor'}: ${note}` : null,
      '',
      `Customer: ${this.store.customerName(cid)}`,
      `Site: ${d.site}`, `Room: ${d.room}`,
      `Device: ${d.make} ${d.model} (${d.deviceType || 'device'})`,
      d.serial ? `Serial: ${d.serial}` : null, d.mac ? `MAC: ${d.mac}` : null, d.ip ? `IP: ${d.ip}` : null,
      d.firmware ? `Firmware: ${d.firmware}` : null,
      d.platform && d.platform !== 'Unassigned' ? `Meeting platform: ${d.platform}` : null,
      `Reported by: ${(d.oems || []).join(', ') || 'Estate Monitor'}`,
      ...codes.flatMap((c) => { const e = ERROR_CODES[c]; return e ? ['', `${c} ${e.title}: ${e.meaning}`, 'Likely causes:', ...e.causes.slice(0, 5).map((x) => `- ${x}`)] : []; }),
      '',
      this.publicUrl ? `Open in Estate Monitor: ${this.publicUrl}/#/devices` : null,
      'Raised automatically by Estate Monitor. It resolves this incident when the device recovers.',
    ].filter((x) => x !== null);
    return {
      title: clip(`${name} ${label}: ${d.room}, ${d.site}`, 160),
      priority: cfg.priorities[trig] || 3,
      description: lines.join('\n'),
    };
  }

  async raiseForDevice(cid, cfg, client, d, trig, existing = null, { by = null, note = null, manual = false } = {}) {
    const key = `device:${d.id}`;
    const inc = this.deviceIncident(cid, cfg, d, trig || d.health, by, note);
    const alert = this.store.data.alerts.find((a) => a.deviceId === d.id && a.severity !== 'resolved');
    const t = existing || this.newTicket(cid, { kind: 'device', key, deviceId: d.id, title: inc.title, priority: inc.priority, alertIds: alert ? [alert.id] : [], site: d.site, room: d.room, manual, by });
    return this.push(cid, cfg, client, t, inc);
  }

  newTicket(cid, fields) {
    const t = { id: crypto.randomUUID(), customerId: cid, state: 'failed', number: null, sysId: null, url: null, snState: null, attempts: 0, nextTryAt: 0, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resolvedAt: null, history: [], ...fields };
    this.all.unshift(t);
    return t;
  }

  /** Create the incident in ServiceNow (or adopt an open one with the same correlation id). */
  async push(cid, cfg, client, t, inc) {
    t.mode = client.mode;
    try {
      const corr = correlationId(t.key);
      let row = await client.findOpen(corr);
      const adopted = !!row;
      if (!row) {
        const pm = PRIORITY_MAP[inc.priority] || PRIORITY_MAP[3];
        row = await client.create({
          short_description: inc.title, description: inc.description, impact: String(pm.impact), urgency: String(pm.urgency), priority: inc.priority,
          ...(cfg.category ? { category: cfg.category } : {}),
          ...(cfg.assignmentGroup ? { assignment_group: cfg.assignmentGroup } : {}),
          ...(cfg.callerId ? { caller_id: cfg.callerId } : {}),
          correlation_id: corr, correlation_display: 'Estate Monitor',
        });
      }
      Object.assign(t, { sysId: row.sys_id, number: row.number, snState: String(row.state || '1'), url: client.mode === 'live' ? incidentUrl(client.instanceUrl, row.sys_id) : null, error: null, nextTryAt: 0 });
      this.setState(t, 'open', adopted ? `Found open incident ${row.number} in ServiceNow` : `Raised ${row.number}${client.mode === 'mock' ? ' (mock)' : ''}`);
      this.audit(cid, 'servicenow.incident_created', `${row.number} ${t.title}`, { key: t.key, adopted, mode: client.mode });
    } catch (e) {
      t.attempts = (t.attempts || 0) + 1;
      t.nextTryAt = this.now() + RETRY_MS[Math.min(t.attempts - 1, RETRY_MS.length - 1)];
      t.error = e.message;
      this.setState(t, 'failed', `Could not raise the incident: ${e.message}`);
      const raw = this.rawConfig(cid);
      if (raw) raw.lastError = { at: new Date().toISOString(), message: e.message };
    }
    this.store.save();
    return t;
  }

  async note(cid, client, t, text) {
    try { await client.update(t.sysId, { work_notes: text }); this.log(t, text); } catch (e) { this.log(t, `Work note failed: ${e.message}`); }
    this.store.save();
  }

  async resolve(cid, cfg, client, t, why, d = null) {
    const text = `Estate Monitor: ${why}`;
    if (!cfg.autoResolve) {
      if (!t.recoveredNoted) { await this.note(cid, client, t, `${text} Auto-resolve is off, so it is left open.`); t.recoveredNoted = true; }
      return;
    }
    try {
      await client.update(t.sysId, { state: '6', close_code: cfg.closeCode || 'Solution provided', close_notes: text, work_notes: text });
      t.resolvedAt = new Date().toISOString();
      t.snState = '6';
      const rec = d && this.store.data.alerts.find((a) => a.deviceId === d.id && a.severity === 'resolved');
      if (rec && !t.alertIds.includes(rec.id)) t.alertIds.push(rec.id);
      this.setState(t, 'resolved', `Resolved: ${why}`);
      this.audit(cid, 'servicenow.incident_resolved', `${t.number} ${t.title}`, { key: t.key });
    } catch (e) {
      // Usually a close code that this instance doesn't have. Leave a note, keep the ticket open, say why.
      t.error = `Could not resolve: ${e.message}`;
      if (!t.recoveredNoted) { await this.note(cid, client, t, `${text} (It could not be resolved automatically: ${e.message})`); t.recoveredNoted = true; }
      this.log(t, t.error);
    }
    this.store.save();
  }

  setState(t, state, note) {
    t.state = state;
    t.updatedAt = new Date().toISOString();
    this.log(t, note);
  }

  log(t, note) {
    t.history = [{ at: new Date().toISOString(), note: clip(note, 300) }, ...(t.history || [])].slice(0, 20);
  }

  audit(cid, action, target, details) {
    this.store.audit({ actor: { id: 'system', email: 'system', name: 'ServiceNow', role: 'system' }, customerId: cid, action, target, details });
  }

  prune() {
    const cutoff = new Date(this.now() - TICKET_RETENTION_DAYS * 86_400_000).toISOString();
    const before = this.all.length;
    this.store.data.tickets = this.all.filter((t) => OPEN.has(t.state) || t.updatedAt >= cutoff).slice(0, 20_000);
    if (this.store.data.tickets.length !== before) this.store.save();
  }

  // --- other triggers -----------------------------------------------------------
  async onReport(a) {
    const cfg = this.config(a.customerId);
    if (!cfg.enabled || !cfg.triggers.reports) return null;
    const key = `report:${a.id}`;
    if (this.latestFor(key)) return null;
    const d = a.deviceId ? this.inventory.get(a.deviceId) : null;
    const title = clip(`Reported: ${a.message.replace(/^Reported by [^:]+: /, '')}`, 160);
    const lines = [a.message, a.details ? `\n${a.details}` : '', '', `Customer: ${this.store.customerName(a.customerId)}`, a.site ? `Site: ${a.site}` : '', a.room ? `Room: ${a.room}` : '', d ? `Device: ${d.make} ${d.model}${d.serial ? `, serial ${d.serial}` : ''}` : '', `Reported by: ${a.reportedBy?.name || ''} <${a.reportedBy?.email || ''}>`, '', 'Raised by Estate Monitor from a user report.'].filter((x) => x !== '');
    const t = this.newTicket(a.customerId, { kind: 'report', key, alertIds: [a.id], deviceId: a.deviceId || null, title, priority: cfg.priorities.report, site: a.site, room: a.room });
    return this.push(a.customerId, cfg, this.client(a.customerId, cfg), t, { title, priority: cfg.priorities.report, description: lines.join('\n') });
  }

  /** Action inbox: an approved dispatch or task raises an incident; done resolves it. */
  async onAction(a, event) {
    const cfg = this.config(a.customerId);
    if (!cfg.enabled) return null;
    const key = `action:${a.id}`;
    const client = this.client(a.customerId, cfg);
    if (event === 'done') {
      const t = this.openFor(key);
      if (t?.state === 'open') await this.resolve(a.customerId, cfg, client, t, `${a.ref} marked done in the Action inbox.`);
      else if (t) this.setState(t, 'cancelled', 'Action done before the incident was raised');
      return t;
    }
    if (!cfg.triggers.dispatches || !['dispatch', 'task'].includes(a.execution?.kind)) return null;
    if (this.openFor(key)) return null;
    const title = clip(`${a.ref} ${a.title}`, 160);
    const items = (a.items || []).filter((i) => !i.cleared).slice(0, 25);
    const lines = [a.title, a.reason || '', '', `Customer: ${this.store.customerName(a.customerId)}`, a.site ? `Site: ${a.site}` : '', a.dispatch?.to ? `Sent to: ${a.dispatch.to}` : '', '', ...items.map((i) => `- ${[i.make, i.model].filter(Boolean).join(' ') || i.site || i.key}${i.room ? `, ${i.room}` : ''}${i.serial ? ` (serial ${i.serial})` : ''}`), '', `Raised by Estate Monitor for Action inbox item ${a.ref}. It resolves when the action is marked done.`].filter((x, i, arr) => x !== '' || arr[i - 1] !== '');
    const t = this.newTicket(a.customerId, { kind: 'action', key, actionId: a.id, title, priority: cfg.priorities.dispatch, site: a.site });
    return this.push(a.customerId, cfg, client, t, { title, priority: cfg.priorities.dispatch, description: lines.join('\n') });
  }

  /** "Raise incident" on the device panel. */
  async raiseManual(cid, deviceId, { by = null, note = null } = {}) {
    const cfg = this.config(cid);
    if (!cfg.enabled) throw new Error('ServiceNow is not switched on for this customer');
    const d = this.inventory.get(deviceId);
    if (!d || d.customerId !== cid) throw new Error('Device not found');
    const open = this.openFor(`device:${d.id}`);
    if (open?.state === 'open') return open;
    if (!this.badSince.has(d.id)) this.badSince.set(d.id, { health: d.health, since: this.now() });
    return this.raiseForDevice(cid, cfg, this.client(cid, cfg), d, d.health, open, { by, note: note || null, manual: true });
  }

  /** Retry a failed ticket now. */
  async retry(t) {
    const cfg = this.config(t.customerId);
    if (t.state !== 'failed') return t;
    t.nextTryAt = 0;
    if (t.kind === 'device') {
      const d = this.inventory.get(t.deviceId);
      if (!d) { this.setState(t, 'cancelled', 'The device is no longer in the estate'); this.store.save(); return t; }
      return this.raiseForDevice(t.customerId, cfg, this.client(t.customerId, cfg), d, d.health, t);
    }
    if (t.kind === 'action') {
      const a = this.store.action(t.actionId);
      if (!a) { this.setState(t, 'cancelled', 'The action no longer exists'); this.store.save(); return t; }
      this.setState(t, 'cancelled', 'Retried');
      return this.onAction(a, 'approved');
    }
    // report
    const alert = this.store.data.alerts.find((x) => x.id === t.alertIds?.[0]);
    if (!alert) { this.setState(t, 'cancelled', 'The report is no longer in the alert feed'); this.store.save(); return t; }
    this.all.splice(this.all.indexOf(t), 1);
    return this.onReport(alert);
  }

  /** Public view of a ticket. */
  view(t) {
    return { id: t.id, kind: t.kind, number: t.number, url: t.url, state: t.state, snState: t.snState, snStateLabel: STATE_LABEL[t.snState] || null, title: t.title, priority: t.priority, deviceId: t.deviceId || null, actionId: t.actionId || null, alertIds: t.alertIds || [], site: t.site || null, room: t.room || null, mode: t.mode, error: t.error, createdAt: t.createdAt, updatedAt: t.updatedAt, resolvedAt: t.resolvedAt, history: t.history, manual: !!t.manual, customerId: t.customerId };
  }

  /** alertId -> ticket brief, for the alert feed. */
  byAlert(customerIds) {
    const allowed = new Set(customerIds);
    const m = new Map();
    for (const t of this.all) if (allowed.has(t.customerId) && t.number) for (const id of t.alertIds || []) if (!m.has(id)) m.set(id, { number: t.number, state: t.state, url: t.url });
    return m;
  }
}
