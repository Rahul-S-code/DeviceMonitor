// Small JSON-file store for configuration (customers, users, connections,
// directories, recent alerts). Device inventory itself is rebuilt from the
// connectors on every sync and kept in memory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MOCK_CUSTOMERS, buildEstate } from '../mock/estate.js';
import { hashPassword } from './auth.js';

const EMPTY = { customers: [], users: [], connections: [], siteDirectory: {}, roomDirectory: {}, alerts: [] };

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'store.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = fs.existsSync(this.file) ? { ...EMPTY, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } : structuredClone(EMPTY);
    this.timer = null;
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

  roomPlatform(customerId, site, room) { return this.data.roomDirectory[`${customerId}|${site}|${room}`] ?? null; }

  setRoomPlatform(customerId, site, room, platform) {
    const k = `${customerId}|${site}|${room}`;
    if (platform) this.data.roomDirectory[k] = platform; else delete this.data.roomDirectory[k];
    this.save();
  }

  /** First-run demo data: three fictional customers, each with a mock Poly Lens and Logitech Sync connection. */
  seedIfEmpty(demoPassword) {
    if (this.customers.length) return false;
    for (const c of MOCK_CUSTOMERS) {
      this.customers.push({ id: c.id, name: c.name });
      this.data.siteDirectory[c.id] = Object.fromEntries(c.sites.map((s) => [s.name, { region: s.region, country: s.country }]));
      for (const r of buildEstate(c.id).rooms) {
        // Logitech Sync has no platform field, so rooms it manages get a room-directory entry.
        if (r.oem !== 'poly') this.data.roomDirectory[`${c.id}|${r.site}|${r.room}`] = r.platform;
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
}
