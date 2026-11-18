// Mock transport answering the Webex list endpoints in the same shape.
import { platformRooms, simulatedState } from '../../mock/estate.js';

const STATUS = { healthy: 'connected', warning: 'connected_with_issues', critical: 'connected_with_issues', offline: 'disconnected' };
const ERRORS = { warning: ['peripheralMissing'], critical: ['cameraNotDetected', 'temperatureCheck'] };

export class WebexMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) {
    this.customerId = customerId;
    this.now = now;
  }

  async list(path) {
    const t = this.now();
    const rows = platformRooms(this.customerId, 'Cisco Webex');
    const locId = (site) => `loc-${site}`.replace(/\s+/g, '').toLowerCase();
    if (path === '/locations') return [...new Set(rows.map((r) => r.room.site))].map((s) => ({ id: locId(s), name: s }));
    if (path === '/workspaces') return rows.map(({ room }) => ({ id: `ws-${room.id}`, displayName: room.room, locationId: locId(room.site), type: 'meetingRoom' }));
    if (path === '/devices') {
      return rows.map(({ room, device, make, model }) => {
        const sim = simulatedState(device.key, t);
        return {
          id: `wx-${device.key.replace(/[^a-z0-9]/gi, '').slice(-24)}`,
          displayName: room.room,
          workspaceId: `ws-${room.id}`,
          orgId: `mock-org-${this.customerId}`,
          product: `${make} ${model}`,
          type: 'roomdesk',
          serial: device.serial,
          software: device.firmware,
          mac: device.mac,
          ip: device.ip,
          connectionStatus: STATUS[sim.state],
          errorCodes: ERRORS[sim.state] || [],
          lastSeen: new Date(sim.state === 'offline' ? sim.since : t).toISOString(),
          managedBy: 'CISCO',
        };
      });
    }
    throw new Error(`Mock Webex: unsupported path ${path}`);
  }
}
