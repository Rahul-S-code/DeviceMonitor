// Microsoft Teams Rooms connector (meeting-platform side). MOCK ONLY.
//
// Microsoft exposed Teams Rooms and Teams Android devices through the Graph
// beta teamworkDevice API (GET /beta/teamwork/devices), but retired it
// (Message Center MC1183294, deprecation by November 2025). As of this build
// Microsoft has not published a replacement API:
//   https://learn.microsoft.com/en-us/answers/questions/5569164/what-is-replacing-the-teamworkdevice-endpoint-on-g
// Health for Teams Rooms is otherwise only in the Teams admin center and the
// Teams Rooms Pro Management portal, neither of which has a public API.
//
// So this connector runs on mock data only. The mock keeps the field names of
// the retired teamworkDevice resource (deviceType, hardwareDetail,
// healthStatus: healthy|nonUrgent|critical|offline|unknown, activityState,
// currentUser) so a future Microsoft API can be mapped with little change.
// Teams Rooms devices are still monitored live through their OEM cloud
// (Poly Lens, Logitech Sync), which also reports Teams as the platform.

import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { platformRooms, simulatedState } from '../../mock/estate.js';

const HEALTH = {
  healthy: ['healthy', null], nonUrgent: ['warning', 'Teams reports a non-urgent issue'],
  critical: ['critical', 'Teams reports a critical issue'], offline: ['offline', 'Teams reports the device offline'],
  unknown: ['warning', 'Teams health unknown'],
};

const TEAMS_CODE = { critical: 'EM-SW-001', nonUrgent: 'EM-SW-002', offline: 'EM-NET-001' };

export class TeamsRoomsConnector extends BaseConnector {
  static oem = 'teams-rooms';
  static displayName = 'Teams Rooms';
  static make = 'Microsoft';
  static kind = 'platform';
  static platform = 'Microsoft Teams';
  static nativeHealth = true;
  static liveSupported = false;
  static liveNote = 'Microsoft retired the Graph teamworkDevice API (MC1183294) and has not published a replacement, so there is no supported API to read Teams Rooms health. This connection runs on mock data. Teams Rooms devices are still monitored live through Poly Lens and Logitech Sync.';
  static docsUrl = 'https://learn.microsoft.com/en-us/answers/questions/5569164/what-is-replacing-the-teamworkdevice-endpoint-on-g';
  static actionsNote = 'No supported Microsoft API: the Graph teamworkDevice API (which had restart) was retired. Use the Teams Rooms Pro portal or Teams admin center.';
  static apis = [
    { id: 'graph-teamwork-devices', name: 'Microsoft Graph teamworkDevice', method: 'GET', url: 'https://graph.microsoft.com/beta/teamwork/devices', availability: 'retired', purpose: 'Teams Rooms device health (retired by Microsoft, MC1183294)', auth: 'Entra app (TeamworkDevice.Read.All)' },
  ];

  async testConnection() {
    if (this.isLive) return { ok: false, message: this.constructor.liveNote };
    return { ok: true, message: 'Mock Teams Rooms data is available.' };
  }

  async fetchRaw() {
    if (this.isLive) throw new Error('Live Teams Rooms monitoring is not available: Microsoft retired the Graph teamworkDevice API.');
    const t = Date.now();
    return platformRooms(this.connection.customerId, 'Microsoft Teams').map(({ room, device, make, model }) => {
      const state = simulatedState(device.key, t).state;
      return {
        id: `tr-${device.key.replace(/[^a-z0-9]/gi, '').slice(-24)}`,
        deviceType: device.kind === 'Computer' ? 'teamsRoom' : 'collaborationBar',
        hardwareDetail: { serialNumber: device.serial, manufacturer: make, model, macAddresses: device.mac ? [device.mac] : [] },
        notes: null,
        companyAssetTag: null,
        healthStatus: { healthy: 'healthy', warning: 'nonUrgent', critical: 'critical', offline: 'offline' }[state],
        activityState: state === 'offline' ? 'unknown' : 'idle',
        currentUser: { displayName: room.room, userIdentityType: 'aadUser' },
        lastModifiedDateTime: new Date(t).toISOString(),
        softwareVersion: device.firmware,
      };
    });
  }

  mapDevices(items) {
    const C = this.constructor;
    return items.map((d) => {
      const [health, reason] = HEALTH[d.healthStatus] || HEALTH.unknown;
      const model = d.hardwareDetail?.model || 'Teams Rooms device';
      return makeDevice({
        id: `${C.oem}:${d.id}`,
        customerId: this.connection.customerId,
        // The resource account name is the room; Teams has no site field.
        site: 'Unassigned site',
        room: d.currentUser?.displayName || 'Unassigned room',
        deviceType: d.deviceType === 'teamsRoom' ? 'Room PC' : classifyDeviceType(model),
        make: d.hardwareDetail?.manufacturer || 'Unknown',
        model,
        serial: d.hardwareDetail?.serialNumber || null,
        firmware: d.softwareVersion || null,
        health,
        healthReason: reason,
        issues: TEAMS_CODE[d.healthStatus] ? [issue(TEAMS_CODE[d.healthStatus], C.displayName, `healthStatus: ${d.healthStatus}`)] : d.healthStatus === 'healthy' ? [] : [issue('EM-GEN-003', C.displayName, `healthStatus: ${d.healthStatus}`)],
        lastSeen: health === 'offline' ? null : d.lastModifiedDateTime,
        platform: C.platform,
        platformSource: 'device',
        mac: d.hardwareDetail?.macAddresses?.[0] || null,
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: d.id }],
      });
    });
  }
}
