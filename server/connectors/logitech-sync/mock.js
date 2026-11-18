// Mock transport returning the same JSON shape as the Logitech Sync Cloud API
// GET /org/{orgId}/place, built from the shared mock estate.

import { buildEstate, simulatedState, hash, mockWarranty } from '../../mock/estate.js';

export class LogitechSyncMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) {
    this.customerId = customerId;
    this.now = now;
    this.orgId = `mock-org-${customerId}`;
  }

  places() {
    const { customer, rooms } = buildEstate(this.customerId);
    if (!customer) return [];
    const t = this.now();
    return rooms
      .filter((r) => r.devices.some((d) => d.oem === 'logitech'))
      .map((room) => ({
        id: `${this.orgId}-${room.id}`,
        type: 'Room',
        name: room.room,
        group: `/${[room.region, room.country, room.site].filter((x) => x && x !== 'Unassigned').join('/')}/`,
        location: `/Building A/Floor ${room.floor}/`,
        seatCount: 4 + Math.floor(hash(room.id + 'seats') * 12),
        occupancy: 0,
        license: 'Select',
        createdAt: 1717200000000,
        devices: room.devices.filter((d) => d.oem === 'logitech').map((d) => this.device(d, room, t)),
      }));
  }

  device(d, room, t) {
    const sim = simulatedState(d.key, t);
    const status = sim.state === 'offline' ? 'Offline' : (hash(d.key + Math.floor(t / 300_000)) < 0.2 ? 'InUse' : 'Online');
    const healthStatus = { healthy: 'NoIssues', warning: 'Warning', critical: 'Error', offline: 'Error' }[sim.state];
    const base = {
      id: `${this.orgId}-${d.key.replace(/[^a-z0-9]/gi, '')}`,
      type: d.kind,
      name: d.kind === 'Computer' ? `DESKTOP-${d.key.replace(/[^A-Z0-9]/gi, '').slice(-5).toUpperCase()}` : d.model,
      status,
      healthStatus,
      lastSeen: sim.state === 'offline' ? sim.since : t - 3_600_000,
      createdAt: 1717200000000,
    };
    if (d.kind !== 'Generic') base.version = d.firmware;
    if (d.kind === 'Logitech' && d.serial) {
      base.serial = d.serial;
      const w = mockWarranty(d.key, t);
      base.warranty = { type: w.type === 'Extended' ? 'Select' : 'StandardWarranty', expiresAt: w.expiresAt };
    }
    if (d.kind === 'Computer') base.network = { ip: d.ip, mac: d.mac };
    if (d.kind === 'Logitech' && /Rally Bar|Tap IP/.test(d.model)) {
      base.network = { ip: d.ip, mac: d.mac, hostName: `${d.model.replace(/\s+/g, '')}-${d.serial.slice(-6)}`, wired: { mode: 'dhcp', address: d.ip, gateway: d.ip.replace(/\d+$/, '1'), subnetMask: '255.255.255.0', dns: ['10.0.0.53'] }, wireless: null };
    }
    if (d.kind === 'Logitech' && /^Rally/.test(d.model)) {
      const short = sim.state === 'warning' || sim.state === 'critical';
      base.peripherals = {
        camera: { count: { expected: 1, actual: 1 } },
        micPod: { count: { expected: 2, actual: short ? 1 : 2 } },
      };
    }
    return base;
  }

  async get(path, query = {}) {
    const m = path.match(/^\/org\/([^/]+)\/place$/);
    if (!m) throw new Error(`Mock Logitech Sync: unsupported path ${path}`);
    if (decodeURIComponent(m[1]) !== this.orgId) {
      const e = new Error('Logitech Sync returned 400: check the Org ID.');
      throw e;
    }
    const all = this.places();
    const limit = Math.min(Math.max(Number(query.limit ?? 1000), 1), 1000);
    const start = query.continuation ? Number(Buffer.from(query.continuation, 'base64').toString()) : 0;
    const page = all.slice(start, start + limit);
    const res = { places: query.projection === '' ? page.map((p) => ({ id: p.id })) : page };
    if (start + limit < all.length) res.continuation = Buffer.from(String(start + limit)).toString('base64');
    return res;
  }
}
