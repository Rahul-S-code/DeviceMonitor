// Neat Pulse connector.
//
// Built from the Neat Pulse API reference (https://api.pulse.neat.no/docs/, v0.1.x)
// and Neat's "Managing API keys on Neat Pulse" article.
//
// Server:  https://api.pulse.neat.no
// Auth:    Authorization: Bearer <API key> (Pulse > Settings > API keys, Read scope; paid Pulse plan)
// Data:    GET /v1/orgs/{orgId}/endpoints          basic details for every device (endpointsBasicList)
//          GET /v1/orgs/{orgId}/rooms              rooms (roomsList)
//          GET /v1/orgs/{orgId}/locations          locations, used as sites (best effort)
//          GET /v1/orgs/{orgId}/endpoints/apps     app/firmware update status (needs_firmware_update)
// Action:  POST /v1/orgs/{orgId}/endpoints/{id}/reboot (endpointsReboot, Write scope)
//
// The published reference names the operations but its response schemas are
// thin, so the mapping accepts the common spellings of each field
// (serial / serialNumber, connected / online / status, and so on).
import { BaseConnector } from '../base.js';
import { issue } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { requestJson, pick, listOf } from '../http.js';
import { NeatPulseMockTransport } from './mock.js';

export const NEAT_BASE = 'https://api.pulse.neat.no';
const V = 'Neat Pulse';

export class NeatPulseHttpTransport {
  constructor({ baseUrl = NEAT_BASE, apiKey, fetchImpl }) { Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, fetchImpl }); }
  call(method, path, body) {
    return requestJson(this.baseUrl + path, { method, body, vendor: V, fetchImpl: this.fetchImpl, headers: { authorization: `Bearer ${this.apiKey}` }, hint401: 'the API key is wrong or was deleted.', hint403: 'the API key needs the Read scope (and Write for reboot), and the org needs a paid Pulse plan.' });
  }
  get(path) { return this.call('GET', path); }
  post(path, body = {}) { return this.call('POST', path, body); }
}

const isOnline = (e) => {
  const v = pick(e.connected, e.online, e.isOnline, e.status, e.connectionStatus);
  if (typeof v === 'boolean') return v;
  return /^(online|connected|true|ok)$/i.test(String(v ?? ''));
};

export class NeatPulseConnector extends BaseConnector {
  static oem = 'neat-pulse';
  static short = 'NT';
  static displayName = 'Neat Pulse';
  static make = 'Neat';
  static nativeHealth = true;
  static docsUrl = 'https://api.pulse.neat.no/docs/';
  static guide = {
    summary: 'Neat Pulse is Neat\'s device management cloud for Neat Bar, Bar Pro, Board, Frame, Center and Pad.',
    needs: ['A paid Neat Pulse plan', 'An API key with the Read scope (Write as well for reboot)', 'Your Pulse organisation ID'],
    health: 'Connected is healthy, disconnected is offline, and a device Pulse says needs a firmware update is amber.',
    location: 'Pulse locations become sites and Pulse rooms become rooms.',
  };
  static apis = [
    { id: 'neat-endpoints', name: 'Neat Pulse endpoints', method: 'GET', url: `${NEAT_BASE}/v1/orgs/{orgId}/endpoints`, probe: `${NEAT_BASE}/v1/orgs/0/endpoints`, purpose: 'Devices with status, model, serial and firmware', auth: 'Bearer API key' },
    { id: 'neat-rooms', name: 'Neat Pulse rooms', method: 'GET', url: `${NEAT_BASE}/v1/orgs/{orgId}/rooms`, probe: `${NEAT_BASE}/v1/orgs/0/rooms`, purpose: 'Room names', auth: 'Bearer API key' },
    { id: 'neat-reboot', name: 'Neat Pulse reboot', method: 'POST', url: `${NEAT_BASE}/v1/orgs/{orgId}/endpoints/{id}/reboot`, probe: `${NEAT_BASE}/v1/orgs/0/endpoints/0/reboot`, purpose: 'Device action: reboot', auth: 'Bearer API key (Write scope)' },
  ];
  static actions = [{
    id: 'reboot', label: 'Reboot device', target: 'device',
    description: 'Reboots the Neat device through Neat Pulse. A meeting on it ends.',
    confirm: 'Reboot this Neat device now?',
    api: { set: 'OEM', name: 'Neat Pulse API', method: 'POST', endpoint: '/v1/orgs/{orgId}/endpoints/{id}/reboot' },
    scope: 'API key with the Write scope',
  }];
  static setupSteps = [
    'Sign in to Neat Pulse (pulse.neat.no) as an organisation owner or admin.',
    'Open Settings › API keys › Create API key. Pick the Read scope, and Write too if you want remote reboot.',
    'Copy the key straight away (Pulse shows it once). Copy the organisation ID from Settings or from the Pulse URL.',
    'Paste both below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [{ key: 'orgId', label: 'Organisation ID', required: true, help: 'Pulse > Settings, or the ID in the Pulse URL' }];
  static credentialFields = [{ key: 'apiKey', label: 'API key', required: true }];

  constructor(opts) {
    super(opts);
    if (!this.transport) this.transport = this.isLive ? new NeatPulseHttpTransport({ apiKey: this.credentials.apiKey }) : new NeatPulseMockTransport(this.connection.customerId);
  }

  get orgPath() { return `/v1/orgs/${encodeURIComponent(this.connection.settings?.orgId || `mock-${this.connection.customerId}`)}`; }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const list = listOf(await this.transport.get(`${this.orgPath}/endpoints`));
    return { ok: true, message: `Connected to Neat Pulse. ${list.length} devices in the organisation.` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const [endpoints, rooms, locations, apps] = await Promise.all([
      this.transport.get(`${this.orgPath}/endpoints`),
      this.transport.get(`${this.orgPath}/rooms`).catch(() => []),
      this.transport.get(`${this.orgPath}/locations`).catch(() => []),
      this.transport.get(`${this.orgPath}/endpoints/apps`).catch(() => []),
    ]);
    return { endpoints: listOf(endpoints), rooms: listOf(rooms), locations: listOf(locations, 'locations'), apps: listOf(apps, 'apps') };
  }

  mapDevices({ endpoints = [], rooms = [], locations = [], apps = [] }, now = Date.now()) {
    const C = this.constructor;
    const roomById = new Map(rooms.map((r) => [String(r.id), r]));
    const locById = new Map(locations.map((l) => [String(l.id), l]));
    const needsUpdate = new Set(apps.filter((a) => a.needs_firmware_update || a.needsFirmwareUpdate).map((a) => String(pick(a.endpointId, a.endpoint_id, a.id))));
    return endpoints.map((e) => {
      const room = roomById.get(String(pick(e.roomId, e.room_id, e.room?.id)));
      const loc = locById.get(String(pick(room?.locationId, room?.location_id, e.locationId)));
      const raw = String(pick(e.model, e.deviceModel, e.product, e.type, 'device'));
      const model = /^neat/i.test(raw) ? raw : `Neat ${raw}`;
      const online = isOnline(e);
      const outdated = needsUpdate.has(String(e.id));
      const health = !online ? 'offline' : outdated ? 'warning' : 'healthy';
      return makeDevice({
        id: `${C.oem}:${e.id}`,
        customerId: this.connection.customerId,
        site: pick(loc?.name, e.locationName, room?.locationName, 'Unassigned site'),
        room: pick(room?.name, e.roomName, e.room?.name, e.name, 'Unassigned room'),
        deviceType: classifyDeviceType(model),
        make: C.make,
        model,
        serial: pick(e.serial, e.serialNumber, e.serial_number), firmware: pick(e.firmwareVersion, e.firmware, e.version, e.softwareVersion),
        mac: pick(e.macAddress, e.mac), ip: pick(e.ipAddress, e.ip),
        health,
        healthReason: health === 'offline' ? 'Neat Pulse reports the device disconnected' : health === 'warning' ? 'Neat Pulse says a firmware update is needed' : null,
        issues: health === 'offline' ? [issue('EM-NET-001', V, `status: ${pick(e.status, e.connected, e.online)}`)] : health === 'warning' ? [issue('EM-FW-001', V, 'needs_firmware_update: true')] : [],
        lastSeen: online ? new Date(now).toISOString() : pick(e.lastSeen, e.last_seen),
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: String(e.id) }],
      });
    });
  }

  async performAction(_action, source) {
    await this.transport.post(`${this.orgPath}/endpoints/${encodeURIComponent(source.sourceId)}/reboot`);
    return { ok: true, message: 'Neat Pulse accepted the reboot. The device is back in about two minutes.' };
  }
}
