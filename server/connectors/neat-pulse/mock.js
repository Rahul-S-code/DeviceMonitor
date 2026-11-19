// Mock Neat Pulse answering the endpoints, rooms, locations and apps lists.
import { simulatedState } from '../../mock/estate.js';
import { avRooms } from '../../mock/av-estate.js';

export class NeatPulseMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) { this.customerId = customerId; this.now = now; }

  async get(path) {
    const t = this.now();
    const rooms = avRooms(this.customerId, 'neat');
    const locId = (s) => `loc-${s}`.replace(/\s+/g, '').toLowerCase();
    if (/\/locations$/.test(path)) return [...new Set(rooms.map((r) => r.room.site))].map((s) => ({ id: locId(s), name: s }));
    if (/\/rooms$/.test(path)) return rooms.map(({ room }) => ({ id: `r-${room.id}`, name: room.room, locationId: locId(room.site) }));
    const endpoints = rooms.flatMap(({ room, devices }) => devices.map((d) => {
      const sim = simulatedState(d.key, t);
      return { id: `ep-${d.key.replace(/[^a-z0-9]/gi, '').slice(-20)}`, name: `${room.room} Pad`, model: d.model, serial: d.serial, roomId: `r-${room.id}`, status: sim.state === 'offline' ? 'OFFLINE' : 'ONLINE', firmwareVersion: d.firmware, macAddress: d.mac, ipAddress: d.ip, sim: sim.state };
    }));
    if (/\/endpoints\/apps$/.test(path)) return endpoints.map((e) => ({ endpointId: e.id, needs_firmware_update: e.sim === 'warning' || e.sim === 'critical' }));
    if (/\/endpoints$/.test(path)) return endpoints.map(({ sim, ...e }) => e);
    throw new Error(`Mock Neat Pulse: unsupported GET ${path}`);
  }

  async post(path) {
    if (/\/endpoints\/[^/]+\/reboot$/.test(path)) return {};
    throw new Error(`Mock Neat Pulse: unsupported POST ${path}`);
  }
}
