// Small JSON-file store for configuration (customers, users, connections,
// directories, device overrides, room schematics, recent alerts). Device
// inventory itself is rebuilt from the connectors on every sync.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MOCK_CUSTOMERS, buildEstate, registerMockCustomer, unregisterMockCustomer, demoModels } from '../mock/estate.js';
import { modelKey, cleanModel, cleanRelease, sortReleases } from './models.js';
import { classifyDeviceType } from './device-model.js';
import { hashPassword } from './auth.js';

const EMPTY = {
  customers: [], users: [], connections: [], siteDirectory: {}, roomDirectory: {},
  schematics: {}, deviceOverrides: {}, alerts: [], models: [], audit: [], manualDevices: [],
  designs: [], apiChecks: {},
};
const MAX_AUDIT = 5000;
export const DEFAULT_SLA_TARGET = 99.5;
// Platform-side connections the demo customers get, by meeting platform.
const PLATFORM_OEM = { 'Microsoft Teams': 'teams-rooms', Zoom: 'zoom-rooms', 'Cisco Webex': 'webex-control-hub', 'Google Meet': 'google-meet-hardware' };
const OEM_LABEL = { 'poly-lens': 'Poly Lens', 'logitech-sync': 'Logitech Sync', 'teams-rooms': 'Teams Rooms', 'zoom-rooms': 'Zoom Rooms', 'webex-control-hub': 'Webex Control Hub', 'google-meet-hardware': 'Google Meet hardware' };

export const roomKey = (customerId, site, room) => `${customerId}|${site}|${room}`;

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'store.json');
    this.designDir = path.join(dataDir, 'designs');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = fs.existsSync(this.file) ? { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } : structuredClone(EMPTY);
    this.timer = null;
    this.registerMocks();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  close() { clearTimeout(this.timer); this.timer = null; }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get customers() { return this.data.customers; }
  get users() { return this.data.users; }
  get connections() { return this.data.connections; }

  customerName(id) { return this.customers.find((c) => c.id === id)?.name ?? id; }

  siteInfo(customerId, site) { return this.data.siteDirectory[customerId]?.[site] ?? null; }
  sitesFor(customerId) { return this.data.siteDirectory[customerId] ?? {}; }

  roomPlatform(customerId, site, room) { return this.data.roomDirectory[roomKey(customerId, site, room)] ?? null; }

  setRoomPlatform(customerId, site, room, platform) {
    const k = roomKey(customerId, site, room);
    if (platform) this.data.roomDirectory[k] = platform; else delete this.data.roomDirectory[k];
    this.save();
  }

  schematic(customerId, site, room) { return this.data.schematics[roomKey(customerId, site, room)] ?? null; }

  setSchematic(customerId, site, room, schematic) {
    const k = roomKey(customerId, site, room);
    if (schematic) this.data.schematics[k] = schematic; else delete this.data.schematics[k];
    this.save();
  }

  // --- room design documents (uploaded files) ---------------------------
  designsFor(customerId, site, room) {
    return this.data.designs.filter((d) => d.customerId === customerId && d.site === site && d.room === room);
  }

  designPath(d) { return path.join(this.designDir, `${d.id}.${d.ext}`); }

  addDesign(meta, buf) {
    const id = crypto.randomUUID();
    const d = { id, ...meta, size: buf.length, uploadedAt: new Date().toISOString() };
    fs.mkdirSync(this.designDir, { recursive: true });
    fs.writeFileSync(this.designPath(d), buf, { mode: 0o600 });
    this.data.designs.push(d);
    this.save();
    return d;
  }

  removeDesign(id) {
    const i = this.data.designs.findIndex((d) => d.id === id);
    if (i < 0) throw new Error('File not found');
    const [d] = this.data.designs.splice(i, 1);
    try { fs.unlinkSync(this.designPath(d)); } catch { /* already gone */ }
    this.save();
    return d;
  }

  override(deviceId) { return this.data.deviceOverrides[deviceId] ?? null; }

  /** Merge a patch into a device's manual overrides. null values remove a field. */
  patchOverride(deviceId, patch) {
    const cur = { ...(this.data.deviceOverrides[deviceId] || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') delete cur[k]; else cur[k] = v;
    }
    if (Object.keys(cur).length) this.data.deviceOverrides[deviceId] = cur; else delete this.data.deviceOverrides[deviceId];
  }

  clearOverride(deviceId) { delete this.data.deviceOverrides[deviceId]; }

  // --- audit log ----------------------------------------------------------
  /** Append an audit entry. Never pass secret values in `details`. */
  audit(entry) {
    const e = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
    this.data.audit.unshift(e);
    if (this.data.audit.length > MAX_AUDIT) this.data.audit.length = MAX_AUDIT;
    this.save();
    return e;
  }

  // --- model and firmware master -------------------------------------------
  get models() { return this.data.models; }

  findModel(make, model) {
    const k = modelKey(make, model);
    return this.models.find((m) => modelKey(m.make, m.model) === k) ?? null;
  }

  createModel(input) {
    const m = cleanModel(input);
    if (this.findModel(m.make, m.model)) throw new Error(`${m.make} ${m.model} is already in the model master`);
    this.models.push(m);
    this.save();
    return m;
  }

  updateModel(id, input) {
    const i = this.models.findIndex((m) => m.id === id);
    if (i < 0) throw new Error('Model not found');
    const m = cleanModel(input, this.models[i]);
    const clash = this.findModel(m.make, m.model);
    if (clash && clash.id !== id) throw new Error(`${m.make} ${m.model} is already in the model master`);
    this.models[i] = m;
    this.save();
    return m;
  }

  deleteModel(id) {
    const i = this.models.findIndex((m) => m.id === id);
    if (i < 0) throw new Error('Model not found');
    const [m] = this.models.splice(i, 1);
    this.save();
    return m;
  }

  addRelease(id, input) {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new Error('Model not found');
    const r = cleanRelease(input);
    const cur = m.releases.find((x) => x.version === r.version);
    if (cur) Object.assign(cur, { releasedAt: r.releasedAt ?? cur.releasedAt, notesUrl: r.notesUrl ?? cur.notesUrl, notes: r.notes ?? cur.notes, source: cur.source === 'fleet' ? 'fleet + manual' : 'manual' });
    else m.releases.push(r);
    sortReleases(m.releases);
    m.updatedAt = new Date().toISOString();
    this.save();
    return m;
  }

  removeRelease(id, version) {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new Error('Model not found');
    m.releases = m.releases.filter((r) => r.version !== version);
    if (m.baseline === version) m.baseline = null;
    this.save();
    return m;
  }

  /**
   * OEM release tracking: record firmware versions first seen in the fleet
   * against catalogued models. Returns the newly seen [{model, version}].
   */
  recordFleetFirmware(devices) {
    const fresh = [];
    const now = new Date().toISOString();
    const byKey = new Map(this.models.map((m) => [modelKey(m.make, m.model), m]));
    for (const d of devices) {
      if (!d.firmware) continue;
      const m = byKey.get(modelKey(d.make, d.model));
      if (!m || m.releases.some((r) => r.version === d.firmware)) continue;
      m.releases.push({ version: d.firmware, releasedAt: null, notesUrl: null, notes: null, source: 'fleet', firstSeenAt: now, addedAt: now });
      sortReleases(m.releases);
      fresh.push({ model: m, version: d.firmware });
    }
    if (fresh.length) this.save();
    return fresh;
  }

  /** Demo catalogue for the mock estate. Lifecycle dates are left for the admin to fill in. */
  seedModels() {
    if (this.models.length) return false;
    const now = new Date().toISOString();
    for (const d of demoModels()) {
      const m = cleanModel({ make: d.make, model: d.model, deviceType: classifyDeviceType(d.model), monitoredBy: [d.make === 'Poly' ? 'poly-lens' : 'logitech-sync'], baseline: d.versions[0], notes: 'Demo entry: baseline set to the newest mock firmware.' });
      m.releases = d.versions.map((v) => ({ version: v, releasedAt: null, notesUrl: null, notes: null, source: 'fleet', firstSeenAt: now, addedAt: now }));
      this.models.push(m);
    }
    return true;
  }

  // --- devices added by hand (kit with no API, or not yet connected) ------
  get manualDevices() { return this.data.manualDevices; }

  /**
   * Validate a manual device. Make and model come from the model master, or
   * are typed in under "Other" for kit the master doesn't list yet.
   */
  cleanManualDevice(input, existing = null) {
    const v = { ...existing, ...input };
    const customerId = String(v.customerId || '');
    if (!this.customers.some((c) => c.id === customerId)) throw new Error('Pick a customer');
    const text = (x, n) => (x === undefined || x === null ? null : String(x).trim().slice(0, n) || null);
    let model = null;
    let custom = null;
    if (v.modelId) {
      model = this.models.find((m) => m.id === v.modelId);
      if (!model) throw new Error('That model is no longer in the model master. Pick another or choose Other.');
    } else {
      custom = { make: text(v.make, 40), model: text(v.model, 80), deviceType: text(v.deviceType, 40) || 'Peripheral' };
      if (!custom.make || !custom.model) throw new Error('Enter the manufacturer and model, or pick them from the lists');
      // If the typed make and model are actually in the master, link to it.
      const known = this.findModel(custom.make, custom.model);
      if (known) { model = known; custom = null; }
    }
    const site = text(v.site, 60);
    const room = text(v.room, 80);
    if (!site || !room) throw new Error('Site and room are required');
    const serial = text(v.serial, 60);
    const mac = text(v.mac, 30);
    if (mac && String(mac).replace(/[^a-f0-9]/gi, '').length !== 12) throw new Error('MAC address must have 12 hex digits, e.g. 00:e0:db:12:34:56');
    const norm = (x) => String(x || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (serial && this.manualDevices.some((d) => d.id !== existing?.id && d.customerId === customerId && norm(d.serial) === norm(serial))) throw new Error(`A device with serial ${serial} has already been added for this customer`);
    const date = (x, label) => {
      if (!x) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x)) || Number.isNaN(Date.parse(x))) throw new Error(`${label} must be a date (YYYY-MM-DD)`);
      return String(x);
    };
    return {
      id: existing?.id || `manual:${crypto.randomUUID()}`,
      customerId, site, room, modelId: model?.id ?? null,
      make: custom?.make ?? null, model: custom?.model ?? null, deviceType: custom?.deviceType ?? null,
      serial, mac,
      firmware: text(v.firmware, 40), platform: text(v.platform, 30), assetTag: text(v.assetTag, 60), notes: text(v.notes, 500),
      warrantyExpires: date(v.warrantyExpires, 'Warranty end'), warrantyType: text(v.warrantyType, 40),
      createdAt: existing?.createdAt || new Date().toISOString(), createdBy: existing?.createdBy || v.createdBy || null,
      updatedAt: new Date().toISOString(),
    };
  }

  addManualDevice(input) {
    const d = this.cleanManualDevice(input);
    this.manualDevices.push(d);
    this.save();
    return d;
  }

  updateManualDevice(id, input) {
    const i = this.manualDevices.findIndex((d) => d.id === id);
    if (i < 0) throw new Error('Device not found');
    const { customerId, ...rest } = input; // a device cannot move between customers
    this.manualDevices[i] = this.cleanManualDevice(rest, this.manualDevices[i]);
    this.save();
    return this.manualDevices[i];
  }

  deleteManualDevice(id) {
    const i = this.manualDevices.findIndex((d) => d.id === id);
    if (i < 0) throw new Error('Device not found');
    const [d] = this.manualDevices.splice(i, 1);
    this.clearOverride(d.id);
    this.save();
    return d;
  }

  slaTarget(customerId) {
    const t = this.customers.find((c) => c.id === customerId)?.slaTarget;
    return typeof t === 'number' ? t : DEFAULT_SLA_TARGET;
  }

  /** Customers created through onboarding get mock devices generated from their sites. */
  registerMocks() {
    for (const c of this.customers) {
      if (MOCK_CUSTOMERS.some((m) => m.id === c.id)) continue;
      registerMockCustomer({
        id: c.id, name: c.name, platforms: c.platforms,
        sites: Object.entries(this.sitesFor(c.id)).map(([name, s]) => ({ name, ...s })),
      });
    }
  }

  /** Create a customer with sites, users, connections and rooms in one go (onboarding). */
  onboardCustomer({ name, platforms = [], sites = [], users = [], connections = [], rooms = [] }) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new Error('Customer name is required');
    if (this.customers.some((c) => c.name.toLowerCase() === clean.toLowerCase())) throw new Error('A customer with that name already exists');
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'customer';
    let id = `cust-${slug}`;
    while (this.customers.some((c) => c.id === id)) id = `cust-${slug}-${crypto.randomBytes(2).toString('hex')}`;
    const customer = { id, name: clean, platforms: platforms.slice(0, 4), slaTarget: DEFAULT_SLA_TARGET, createdAt: new Date().toISOString() };
    const siteDir = {};
    for (const s of sites) {
      const sname = String(s.name || '').trim().slice(0, 60);
      if (!sname) continue;
      siteDir[sname] = cleanSite(s);
    }
    const newUsers = users.filter((u) => u.email).map((u) => {
      const email = String(u.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${u.email}" is not a valid email`);
      if (this.users.some((x) => x.email === email)) throw new Error(`A user with email ${email} already exists`);
      if (!u.password || String(u.password).length < 8) throw new Error(`Password for ${email} must be at least 8 characters`);
      return { id: `u-${crypto.randomUUID()}`, email, name: String(u.name || email).slice(0, 80), role: 'customer_viewer', customerId: id, password: hashPassword(String(u.password)) };
    });
    this.customers.push(customer);
    this.data.siteDirectory[id] = siteDir;
    this.users.push(...newUsers);
    const conns = connections.map((c) => ({
      id: crypto.randomUUID(), customerId: id, oem: c.oem, mode: 'mock',
      name: `${clean} · ${c.displayName || OEM_LABEL[c.oem] || c.oem}`, settings: {}, secret: null, createdAt: new Date().toISOString(),
    }));
    this.connections.push(...conns);
    for (const r of rooms) {
      if (!r.site || !r.room) continue;
      if (r.platform) this.setRoomPlatform(id, r.site, r.room, r.platform);
      if (r.schematic) this.setSchematic(id, r.site, r.room, r.schematic);
    }
    this.registerMocks();
    // Mock Logitech rooms have no platform in the API; give them one from the customer's platforms.
    for (const r of buildEstate(id).rooms) {
      if (r.oem !== 'poly' && !this.roomPlatform(id, r.site, r.room)) this.data.roomDirectory[roomKey(id, r.site, r.room)] = r.platform;
    }
    this.save();
    return { customer, connections: conns, users: newUsers.length };
  }

  updateCustomer(id, { name, sites, platforms, slaTarget }) {
    const c = this.customers.find((x) => x.id === id);
    if (!c) throw new Error('Customer not found');
    if (slaTarget !== undefined) {
      const t = Number(slaTarget);
      if (!Number.isFinite(t) || t < 50 || t > 100) throw new Error('SLA target must be between 50 and 100 percent');
      c.slaTarget = Math.round(t * 1000) / 1000;
    }
    if (name) c.name = String(name).trim().slice(0, 80);
    if (Array.isArray(platforms)) c.platforms = platforms.slice(0, 4);
    if (Array.isArray(sites)) {
      const dir = {};
      for (const s of sites) { const n = String(s.name || '').trim().slice(0, 60); if (n) dir[n] = cleanSite(s); }
      this.data.siteDirectory[id] = dir;
    }
    unregisterMockCustomer(id);
    this.registerMocks();
    this.save();
    return c;
  }

  deleteCustomer(id) {
    const i = this.customers.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('Customer not found');
    this.customers.splice(i, 1);
    this.data.users = this.users.filter((u) => u.customerId !== id);
    this.data.connections = this.connections.filter((c) => c.customerId !== id);
    delete this.data.siteDirectory[id];
    for (const map of [this.data.roomDirectory, this.data.schematics]) for (const k of Object.keys(map)) if (k.startsWith(`${id}|`)) delete map[k];
    this.data.alerts = this.data.alerts.filter((a) => a.customerId !== id);
    this.data.manualDevices = this.manualDevices.filter((d) => d.customerId !== id);
    for (const d of this.data.designs.filter((x) => x.customerId === id)) this.removeDesign(d.id);
    unregisterMockCustomer(id);
    this.save();
  }

  /** First-run demo data: three fictional customers, each with a mock Poly Lens and Logitech Sync connection. */
  seedIfEmpty(demoPassword) {
    if (this.customers.length) return false;
    for (const c of MOCK_CUSTOMERS) {
      this.customers.push({ id: c.id, name: c.name, platforms: [...new Set(c.platforms)], slaTarget: DEFAULT_SLA_TARGET });
      this.data.siteDirectory[c.id] = Object.fromEntries(c.sites.map((s) => [s.name, cleanSite(s)]));
      for (const r of buildEstate(c.id).rooms) {
        // Logitech Sync has no platform field, so rooms it manages get a room-directory entry.
        if (r.oem !== 'poly') this.data.roomDirectory[roomKey(c.id, r.site, r.room)] = r.platform;
      }
      for (const oem of ['poly-lens', 'logitech-sync']) this.addMockConnection(c, oem);
      this.addPlatformConnections(c);
    }
    this.seedModels();
    this.data.phase3 = true;
    const pw = hashPassword(demoPassword);
    this.users.push({ id: 'u-admin', email: 'admin@provider.example', name: 'Service Desk Admin', role: 'provider_admin', customerId: null, password: pw });
    for (const c of MOCK_CUSTOMERS) {
      const slug = c.id.replace('cust-', '');
      this.users.push({ id: `u-${slug}`, email: `it@${slug}.example`, name: `${c.name} IT`, role: 'customer_viewer', customerId: c.id, password: pw });
    }
    this.flush();
    return true;
  }

  addMockConnection(c, oem) {
    this.connections.push({
      id: crypto.randomUUID(), customerId: c.id, oem, mode: 'mock',
      name: `${c.name} · ${OEM_LABEL[oem] || oem}`, settings: {}, secret: null, createdAt: new Date().toISOString(),
    });
  }

  addPlatformConnections(c) {
    for (const p of new Set(c.platforms)) {
      const oem = PLATFORM_OEM[p];
      if (oem && !this.connections.some((x) => x.customerId === c.id && x.oem === oem)) this.addMockConnection(c, oem);
    }
  }

  /** Bring older data files up to date (adds the super admin and site coordinates). */
  migrate(superPassword) {
    let changed = false;
    if (!this.users.some((u) => u.role === 'super_admin')) {
      this.users.unshift({ id: 'u-super', email: 'superadmin@provider.example', name: 'Super Admin', role: 'super_admin', customerId: null, password: hashPassword(superPassword) });
      changed = true;
    }
    for (const m of MOCK_CUSTOMERS) {
      const dir = this.data.siteDirectory[m.id];
      if (!dir) continue;
      for (const s of m.sites) if (dir[s.name] && dir[s.name].lat === undefined) { dir[s.name] = cleanSite({ ...s, ...dir[s.name] }); changed = true; }
    }
    // Phase 3: model master, platform connectors for the demo customers, SLA targets.
    // Runs once, so models or connections the admin later deletes stay deleted.
    if (!this.data.phase3) {
      this.seedModels();
      for (const m of MOCK_CUSTOMERS) {
        const c = this.customers.find((x) => x.id === m.id);
        if (c) this.addPlatformConnections({ ...c, platforms: m.platforms });
      }
      this.data.phase3 = true;
      changed = true;
    }
    if (changed) this.flush();
    return changed;
  }
}

function cleanSite(s) {
  const num = (v, lo, hi) => { const n = Number(v); return v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };
  const out = {
    region: String(s.region || 'Unassigned').trim().slice(0, 20) || 'Unassigned',
    country: String(s.country || '').trim().slice(0, 60) || undefined,
    city: String(s.city || '').trim().slice(0, 60) || undefined,
    address: String(s.address || '').trim().slice(0, 160) || undefined,
    lat: num(s.lat, -90, 90),
    lng: num(s.lng, -180, 180),
    mockRooms: num(s.mockRooms, 1, 30),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
