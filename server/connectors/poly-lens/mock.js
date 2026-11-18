// Mock transport that answers the same GraphQL operations as the live Poly
// Lens API, in the same response shape, using the shared mock estate.
// The connector's paging and mapping code runs unchanged against it.

import { buildEstate, simulatedState } from '../../mock/estate.js';

const APP_NAMES = {
  'Microsoft Teams': 'Microsoft Teams',
  Zoom: 'Zoom Rooms',
  'Google Meet': 'Google Meet',
  'Cisco Webex': 'Webex',
};

export class PolyLensMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) {
    this.customerId = customerId;
    this.now = now;
    this.tenantId = `mock-tenant-${customerId}`;
  }

  nodes() {
    const { customer, rooms } = buildEstate(this.customerId);
    if (!customer) return [];
    const t = this.now();
    const out = [];
    for (const room of rooms) {
      room.devices.filter((d) => d.oem === 'poly').forEach((d) => {
        const sim = simulatedState(d.key, t);
        const connected = sim.state !== 'offline';
        const usb = d.model === 'Poly Studio' || d.model === 'Poly CCX 600';
        out.push({
          id: `pl-${d.key.replace(/[^a-z0-9]/gi, '').slice(-24)}`,
          name: `${room.room} ${d.model.replace('Poly ', '')}`,
          connected,
          lastDetected: new Date(connected ? t - 15_000 : sim.since).toISOString(),
          hardwareModel: d.model,
          softwareVersion: d.firmware,
          serialNumber: d.serial,
          internalIp: usb ? null : d.ip,
          activeApplicationName: usb ? null : APP_NAMES[room.platform] || null,
          activeApplicationVersion: usb ? null : '6.4.0',
          site: { id: `site-${room.site}`.replace(/\s+/g, '').toLowerCase(), name: room.site },
          room: { id: `room-${room.id}`, name: room.room },
        });
      });
    }
    return out;
  }

  async graphql(query, variables = {}) {
    if (/tenants\s*\{/.test(query) && !/tenant\(id/.test(query)) {
      const c = buildEstate(this.customerId).customer;
      return { tenants: c ? [{ id: this.tenantId, name: `${c.name} (mock)` }] : [] };
    }
    if (/deviceSearch/.test(query)) {
      if (variables.tenantId !== this.tenantId) return { tenant: null };
      const all = this.nodes();
      const size = Math.min(Math.max(variables.params?.pageSize ?? 10, 1), 5000);
      const start = Number(variables.params?.nextToken ?? 0);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return {
        tenant: {
          id: this.tenantId,
          name: 'mock',
          inventory: {
            deviceSearch: {
              edges: page.map((node) => ({ node })),
              pageInfo: { hasNextPage: !!next, totalCount: all.length, countOnPage: page.length, nextToken: next },
            },
          },
        },
      };
    }
    throw new Error('Mock Poly Lens: unsupported query');
  }
}
