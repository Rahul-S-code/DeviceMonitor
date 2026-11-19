// Google Meet hardware connector (meeting-platform side). MOCK ONLY.
//
// Google shows Meet hardware connection status, peripheral issues and issue
// history only in the Admin console (Devices › Google Meet hardware):
//   https://knowledge.workspace.google.com/admin/meet-hardware/check-for-offline-meet-hardware
// No public API returns Meet hardware health. The Chrome Management Telemetry
// API (customers.telemetry.devices) covers ChromeOS devices in general but
// Google does not document it for Meet hardware, so it is not used here.
//
// This connector runs on mock data so Meet rooms appear in the dashboard;
// live mode is disabled until Google publishes an API.

import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { platformRooms, simulatedState } from '../../mock/estate.js';

export class GoogleMeetConnector extends BaseConnector {
  static oem = 'google-meet-hardware';
  static displayName = 'Google Meet hardware';
  static short = 'GM';
  static guide = {
    summary: "Google Meet hardware (Series One and certified Logitech, Poly and ASUS kits).",
    needs: [
      "Nothing: demo data only"
    ],
    health: "Demo data only. Meet hardware is monitored live through its maker's cloud.",
    location: "Demo rooms."
  };
  static make = 'Google';
  static kind = 'platform';
  static platform = 'Google Meet';
  static nativeHealth = true;
  static liveSupported = false;
  static liveNote = 'Google shows Meet hardware status only in the Admin console and has no public API for it, so this connection runs on mock data. Meet devices made by Logitech or Poly are still monitored live through their OEM cloud.';
  static docsUrl = 'https://knowledge.workspace.google.com/admin/meet-hardware/check-for-offline-meet-hardware';
  static actionsNote = 'Google has no public API for Meet hardware. Use the Google Admin console.';
  static apis = [
    { id: 'google-meet-hardware', name: 'Google Meet hardware status', method: null, url: null, availability: 'none', purpose: 'No public API: status is only in the Google Admin console', auth: null },
  ];

  async testConnection() {
    if (this.isLive) return { ok: false, message: this.constructor.liveNote };
    return { ok: true, message: 'Mock Meet hardware data is available.' };
  }

  async fetchRaw() {
    if (this.isLive) throw new Error('Live Google Meet hardware monitoring is not available: Google has no public API for it.');
    const t = Date.now();
    return platformRooms(this.connection.customerId, 'Google Meet').map(({ room, device, make, model }) => {
      const state = simulatedState(device.key, t).state;
      return {
        deviceId: `gm-${device.key.replace(/[^a-z0-9]/gi, '').slice(-24)}`,
        serialNumber: device.serial, manufacturer: make, model, osVersion: device.firmware,
        connectionStatus: state === 'offline' ? 'OFFLINE' : 'ONLINE',
        issues: state === 'warning' ? ['Peripheral disconnected'] : state === 'critical' ? ['Camera not detected'] : [],
        building: room.site, roomName: room.room, macAddress: device.mac,
      };
    });
  }

  mapDevices(items) {
    const C = this.constructor;
    return items.map((d) => {
      const offline = d.connectionStatus === 'OFFLINE';
      const health = offline ? 'offline' : d.issues?.length ? (/camera|display/i.test(d.issues.join()) ? 'critical' : 'warning') : 'healthy';
      return makeDevice({
        id: `${C.oem}:${d.deviceId}`,
        customerId: this.connection.customerId,
        site: d.building || 'Unassigned site',
        room: d.roomName || 'Unassigned room',
        deviceType: classifyDeviceType(d.model),
        make: d.manufacturer || 'Unknown',
        model: d.model || 'Meet hardware',
        serial: d.serialNumber || null,
        firmware: d.osVersion || null,
        health,
        healthReason: offline ? 'Meet hardware is offline' : d.issues?.join('; ') || null,
        issues: offline ? [issue('EM-NET-001', C.displayName, 'connectionStatus: OFFLINE')] : (d.issues || []).map((x) => issue(classifyFault(x, 'EM-GEN-002'), C.displayName, x)),
        lastSeen: offline ? null : new Date().toISOString(),
        platform: C.platform,
        platformSource: 'device',
        mac: d.macAddress || null,
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: d.deviceId }],
      });
    });
  }
}
