// Mock YMCS answering listSites, listDevices, models and listAlarms in the API's shape.
import { simulatedState } from '../../mock/estate.js';
import { avRooms } from '../../mock/av-estate.js';

const page = (all, { skip = 0, limit = 100, autoCount }) => ({ skip, limit, ...(autoCount ? { total: all.length } : {}), data: all.slice(skip, skip + limit) });

export class YealinkMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  estate() {
    const rooms = avRooms(this.customerId, 'yealink');
    const t = this.now();
    const sid = (s) => `site-${s}`.replace(/\s+/g, '').toLowerCase();
    const sites = new Map();
    const devices = [];
    const alarms = [];
    for (const { room, devices: kit } of rooms) {
      sites.set(sid(room.site), { id: sid(room.site), name: room.site, parentId: null, level: 1 });
      sites.set(`room-${room.id}`, { id: `room-${room.id}`, name: room.room, parentId: sid(room.site), level: 2 });
      for (const d of kit) {
        const sim = simulatedState(d.key, t);
        const id = `yl-${d.key.replace(/[^a-z0-9]/gi, '').slice(-20)}`;
        devices.push({ id, mac: d.mac.replace(/:/g, ''), sn: d.serial, name: `${room.room} ${d.model.replace('Yealink ', '')}`, modelId: `m-${d.model}`, siteId: `room-${room.id}`, programVersion: d.firmware, deviceStatus: sim.state === 'offline' ? 'offline' : 'online', ip: d.ip });
        if (sim.state === 'warning' || sim.state === 'critical') alarms.push({ id: `al-${id}`, event: sim.state === 'critical' ? 'Camera disconnected' : 'Firmware update failed', level: sim.state === 'critical' ? 1 : 2, mac: d.mac.replace(/:/g, ''), model: d.model, siteName: room.room, status: 1 });
      }
    }
    return { sites: [...sites.values()], devices, alarms };
  }

  async get(path) {
    if (path.startsWith('/v2/dm/models')) {
      const type = Number(new URL(`http://x${path}`).searchParams.get('deviceType'));
      return type === 3 ? [{ id: 'm-Yealink CP965', name: 'CP965' }, { id: 'm-Yealink RoomPanel', name: 'RoomPanel' }] : [];
    }
    throw new Error(`Mock YMCS: unsupported GET ${path}`);
  }

  async post(path, body = {}) {
    const e = this.estate();
    if (path === '/v2/dm/listSites') return page(e.sites, body);
    if (path === '/v2/dm/listDevices') return page(e.devices, body);
    if (path === '/v2/dm/listAlarms') return page(e.alarms, body);
    if (path === '/v2/dm/device/reboot') return { successCount: body.deviceIds?.length || 0 };
    throw new Error(`Mock YMCS: unsupported POST ${path}`);
  }
}
