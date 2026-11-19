// Mock Reflect answering /systems and /systems/{id}/items in the API's shape.
import { simulatedState } from '../../mock/estate.js';
import { avRooms } from '../../mock/av-estate.js';

const STATUS = { healthy: { code: 0, message: 'OK' }, warning: { code: 2, message: 'Compromised: redundant network link down' }, critical: { code: 4, message: 'Fault: camera not streaming' }, offline: { code: 7, message: 'Offline' } };

export class QsysReflectMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  async get(path) {
    const t = this.now();
    const rooms = avRooms(this.customerId, 'qsys');
    if (path === '/systems') {
      return rooms.map(({ room, devices }) => {
        const worst = devices.map((d) => simulatedState(d.key, t).state).sort((a, b) => STATUS[b].code - STATUS[a].code)[0];
        return { id: `sys-${room.id}`, code: room.id.slice(-6), name: `${room.room} (${room.site})`, design: { name: `${room.room} design`, platform: 'Core Nano', isRedundant: false }, status: STATUS[worst], core: { id: `core-${room.id}`, name: `${room.room} Core` } };
      });
    }
    const m = path.match(/^\/systems\/([^/]+)\/items$/);
    if (m) {
      const r = rooms.find(({ room }) => `sys-${room.id}` === decodeURIComponent(m[1]));
      if (!r) throw new Error('Q-SYS Reflect returned 404: check the account, organisation or ID in the settings.');
      return r.devices.map((d) => {
        const st = simulatedState(d.key, t).state;
        return {
          id: `item-${d.key.replace(/[^a-z0-9]/gi, '').slice(-20)}`, name: `${d.type === 'core' ? 'Core' : d.type === 'camera' ? 'Cam' : 'NV'}-${r.room.room.replace(/\W+/g, '')}`,
          type: d.type, model: d.model, manufacturer: 'QSC', location: { name: r.room.room }, site: { name: r.room.site },
          serialNumber: d.serial, firmware: d.firmware, status: STATUS[st], isOnline: st !== 'offline',
          networkConfig: { ipAddress: d.ip, macAddress: d.mac },
        };
      });
    }
    throw new Error(`Mock Reflect: unsupported GET ${path}`);
  }
}
