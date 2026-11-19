// Mock BRAVIA Cloud API answering /devices and /devices/{id}/online-status.
import { simulatedState } from '../../mock/estate.js';
import { avRooms } from '../../mock/av-estate.js';

export class SonyBraviaMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  list() {
    return avRooms(this.customerId, 'sony').flatMap(({ room, devices }) => devices.map((d) => ({
      key: d.key,
      deviceId: `sony-${d.key.replace(/[^a-z0-9]/gi, '').slice(-20)}`, deviceName: `${room.site} / ${room.room} / Display`, modelName: d.model.replace('BRAVIA ', 'FW-85'),
      serial: d.serial, braviaId: `B${d.serial}`, softwareVersion: d.firmware, osVersion: 'Android 12',
      displayResolution: { width: 3840, height: 2160 }, networkInterfaces: [{ type: 'wired', macAddress: d.mac, ipv4Address: d.ip, ipv6Address: null }],
    })));
  }

  async get(path) {
    const all = this.list();
    if (path === '/devices') return { devices: all.map(({ key, ...d }) => d) };
    const m = path.match(/^\/devices\/([^/]+)\/online-status$/);
    if (m) {
      const d = all.find((x) => x.deviceId === decodeURIComponent(m[1]));
      if (!d) throw new Error('Sony BRAVIA Cloud API returned 404: check the account, organisation or ID in the settings.');
      return { online: simulatedState(d.key, this.now()).state !== 'offline' };
    }
    throw new Error(`Mock BRAVIA Cloud: unsupported GET ${path}`);
  }

  async post() { return { requestId: 'mock-request' }; }
}
