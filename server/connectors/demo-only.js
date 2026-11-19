// Shared parts of the connectors whose vendor has no public API that a hosted
// service can call yet (Biamp Workplace, ShureCloud, NETGEAR Insight). They run
// on demo data so rooms with that kit look complete; their real devices can be
// covered by adding them by hand (or by CSV), or through Domotz for network gear.
import { simulatedState } from '../mock/estate.js';
import { avRooms } from '../mock/av-estate.js';
import { issue } from '../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../lib/device-model.js';

export class DemoKitTransport {
  constructor(customerId, vendor, { now = () => Date.now() } = {}) { Object.assign(this, { customerId, vendor, now }); }
  async list() {
    const t = this.now();
    return avRooms(this.customerId, this.vendor).flatMap(({ room, devices }) => devices.map((d) => ({ ...d, site: room.site, room: room.room, state: simulatedState(d.key, t).state })));
  }
}

const FAULT = { warning: ['EM-GEN-002', 'reports a warning'], critical: ['EM-GEN-001', 'reports an error'] };

/** Demo devices for one of these connectors, with health from the shared simulation. */
export function mapDemoKit(connector, rows, { now = Date.now(), faultCode } = {}) {
  const C = connector.constructor;
  return rows.map((d) => {
    const [code, text] = d.state === 'offline' ? ['EM-NET-001', 'reports the device offline'] : FAULT[d.state] || [];
    return makeDevice({
      id: `${C.oem}:${d.key.replace(/[^a-z0-9]/gi, '').slice(-24)}`,
      customerId: connector.connection.customerId, site: d.site, room: d.room,
      deviceType: classifyDeviceType(d.model), make: C.make, model: d.model.startsWith(C.make) ? d.model : `${C.make} ${d.model}`,
      serial: d.serial, firmware: d.firmware, mac: d.mac, ip: d.ip,
      health: d.state, healthReason: code ? `${C.displayName} ${text}` : null,
      issues: code ? [issue(d.state === 'critical' && faultCode ? faultCode : code, C.displayName, `demo state: ${d.state}`)] : [],
      lastSeen: d.state === 'offline' ? null : new Date(now).toISOString(),
      sources: [{ oem: C.oem, connectionId: connector.connection.id, sourceId: d.key }],
    });
  });
}
