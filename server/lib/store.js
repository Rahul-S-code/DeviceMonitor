// Small JSON-file store for configuration (customers, users, connections,
// directories, device overrides, room schematics, recent alerts). Device
// inventory itself is rebuilt from the connectors on every sync.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MOCK_CUSTOMERS, buildEstate, registerMockCustomer, unregisterMockCustomer } from '../mock/estate.js';
import { hashPassword } from './auth.js';

const EMPTY = {
  customers: [], users: [], connections: [], siteDirectory: {}, roomDirectory: {},
  schematics: {}, deviceOverrides: {}, alerts: [],
};

export const roomKey = (customerId, site, room) => `${customerId}|${site}|${room}`;

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'store.json');
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
    const customer = { id, name: clean, platforms: platforms.slice(0, 4), createdAt: new Date().toISOString() };
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
      name: `${clean} · ${c.displayName || c.oem}`, settings: {}, secret: null, createdAt: new Date().toISOString(),
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

  updateCustomer(id, { name, sites, platforms }) {
    const c = this.customers.find((x) => x.id === id);
    if (!c) throw new Error('Customer not found');
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
    unregisterMockCustomer(id);
    this.save();
  }

  /** First-run demo data: three fictional customers, each with a mock Poly Lens and Logitech Sync connection. */
  seedIfEmpty(demoPassword) {
    if (this.customers.length) return false;
    for (const c of MOCK_CUSTOMERS) {
      this.customers.push({ id: c.id, name: c.name, platforms: [...new Set(c.platforms)] });
      this.data.siteDirectory[c.id] = Object.fromEntries(c.sites.map((s) => [s.name, cleanSite(s)]));
      for (const r of buildEstate(c.id).rooms) {
        // Logitech Sync has no platform field, so rooms it manages get a room-directory entry.
        if (r.oem !== 'poly') this.data.roomDirectory[roomKey(c.id, r.site, r.room)] = r.platform;
      }
      for (const oem of ['poly-lens', 'logitech-sync']) {
        this.connections.push({
          id: crypto.randomUUID(), customerId: c.id, oem, mode: 'mock',
          name: `${c.name} · ${oem === 'poly-lens' ? 'Poly Lens' : 'Logitech Sync'}`,
          settings: {}, secret: null, createdAt: new Date().toISOString(),
        });
      }
    }
    const pw = hashPassword(demoPassword);
    this.users.push({ id: 'u-admin', email: 'admin@provider.example', name: 'Service Desk Admin', role: 'provider_admin', customerId: null, password: pw });
    for (const c of MOCK_CUSTOMERS) {
      const slug = c.id.replace('cust-', '');
      this.users.push({ id: `u-${slug}`, email: `it@${slug}.example`, name: `${c.name} IT`, role: 'customer_viewer', customerId: c.id, password: pw });
    }
    this.flush();
    return true;
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
