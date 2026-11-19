// Mock BSN.cloud answering GET /Devices/ with marker paging.
import { simulatedState, hash } from '../../mock/estate.js';
import { avRooms } from '../../mock/av-estate.js';

export class BrightSignMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  async get(path) {
    if (!path.startsWith('/Devices/')) throw new Error(`Mock BSN.cloud: unsupported GET ${path}`);
    const q = new URL(`http://x${path}`).searchParams;
    const t = this.now();
    const all = avRooms(this.customerId, 'brightsign').flatMap(({ room, devices }) => devices.map((d) => {
      const st = simulatedState(d.key, t).state;
      return {
        id: 100000000 + Math.floor(hash(d.key) * 899999999), serial: d.serial, model: d.model, family: 'Cobra',
        settings: { name: `${room.room} door sign`, description: `${room.site} / ${room.room}`, group: { name: room.site } },
        status: { health: st === 'critical' ? 'Error' : st === 'warning' ? 'Warning' : 'Normal', lastModifiedDate: new Date(st === 'offline' ? t - 6 * 3_600_000 : t - 120_000).toISOString(), firmware: { version: d.firmware }, network: { interfaces: [{ mac: d.mac, ip: d.ip }] } },
      };
    }));
    const size = Number(q.get('pageSize') || 100);
    const start = Number(q.get('marker') || 0);
    const items = all.slice(start, start + size);
    return { items, isTruncated: start + size < all.length, nextMarker: start + size < all.length ? String(start + size) : null };
  }
}
