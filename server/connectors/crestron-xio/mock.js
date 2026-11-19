// Mock XiO Cloud answering the paged status and groups calls in the API's shape.
import { simulatedState } from '../../mock/estate.js';
import { avRooms } from '../../mock/av-estate.js';

export class CrestronXioMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  data() {
    const t = this.now();
    const rooms = avRooms(this.customerId, 'crestron');
    const siteId = (s) => `g-${s}`.replace(/\s+/g, '').toLowerCase();
    const groups = [];
    const seen = new Set();
    const devices = [];
    for (const { room, devices: kit } of rooms) {
      if (!seen.has(room.site)) { seen.add(room.site); groups.push({ IsRoom: false, id: siteId(room.site), Name: room.site, ParentGroupId: null }); }
      groups.push({ IsRoom: true, id: `g-${room.id}`, Name: room.room, ParentGroupId: siteId(room.site) });
      for (const d of kit) {
        const sim = simulatedState(d.key, t);
        const entry = {
          device: {
            'device-cid': `${d.mac.replace(/:/g, '-')}_-1`, 'device-accountid': `mock-${this.customerId}`, 'device-groupid': `g-${room.id}`,
            'device-model': d.model, 'device-category': d.category, 'device-manufacturer': 'Crestron', 'device-id': `@E-${d.mac.replace(/:/g, '')}`,
            'device-name': `${d.model.toLowerCase()}-${room.room.replace(/\W+/g, '').toLowerCase()}`, 'user-device-name': `${room.room} ${d.category}`,
            'serial-number': d.serial, 'firmware-version': d.firmware, 'device-status': sim.state === 'offline' ? 'Offline' : 'Online',
          },
        };
        if (d.category === 'Video Switcher') entry['hdmi-input'] = { 'hdmi-input-sync-detected': sim.state === 'healthy' ? 'true' : 'false', 'hdmi-input-fault': sim.state === 'critical' || sim.state === 'warning' ? 'No sync on input 1' : 'none' };
        devices.push(entry);
      }
    }
    return { groups, devices };
  }

  async get(path) {
    const { groups, devices } = this.data();
    if (/\/groups$/.test(path)) return groups;
    const m = path.match(/\/pageno\/(\d+)\/pagesize\/(\d+)\/status$/);
    if (m) {
      const [n, size] = [Number(m[1]), Number(m[2])];
      return { Pagination: { TotalDevices: devices.length, TotalPages: Math.max(1, Math.ceil(devices.length / size)), PageSize: size, CurrentPageNumber: n }, DeviceList: devices.slice((n - 1) * size, n * size) };
    }
    throw new Error(`Mock XiO Cloud: unsupported GET ${path}`);
  }
}
