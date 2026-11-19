// Domotz connector (network monitoring).
//
// Built from the Domotz Public API OpenAPI definition
// (https://api-us-east-1-cell-1.domotz.com/public-api/v1/meta/open-api-definition)
// and the developer portal (portal.domotz.com/developers).
//
// Server:  https://api-{region}-cell-1.domotz.com/public-api/v1   (region us-east-1 | eu-central-1;
//          use the exact "API endpoint" shown with your key in the Domotz portal)
// Auth:    header X-Api-Key: <API key> (Domotz portal > Settings > API keys)
// Data:    GET /agent -> [{ id, display_name, status: { value: ONLINE|OFFLINE }, location }]
//          GET /agent/{agent_id}/device -> [{ id, display_name, status: ONLINE|OFFLINE|DOWN|HIDDEN,
//               importance: VITAL|FLOATING, hw_address, ip_addresses[], vendor, model,
//               user_data: { name, vendor, model, type }, details: { room, zone, serial, firmware_version } }]
// Action:  POST /agent/{agent_id}/device/{device_id}/action/power/software-reboot
//
// Domotz sees everything on the network, so by default only devices with a Room
// set in Domotz (details.room) are imported. Network kit that another connector
// also reports (same MAC or serial) merges into one device.
import { BaseConnector } from '../base.js';
import { issue } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { requestJson, pick, listOf } from '../http.js';
import { DomotzMockTransport } from './mock.js';

export const DOMOTZ_BASE = 'https://api-us-east-1-cell-1.domotz.com/public-api/v1';
const V = 'Domotz';

export class DomotzHttpTransport {
  constructor({ baseUrl = DOMOTZ_BASE, apiKey, fetchImpl }) { Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, fetchImpl }); }
  call(method, path) {
    return requestJson(this.baseUrl + path, { method, vendor: V, fetchImpl: this.fetchImpl, headers: { 'x-api-key': this.apiKey }, hint401: 'the API key is wrong, expired, or for another region\'s endpoint.', hint403: 'the API key has no access to this collector.' });
  }
  get(path) { return this.call('GET', path); }
  post(path) { return this.call('POST', path); }
}

export class DomotzConnector extends BaseConnector {
  static oem = 'domotz';
  static short = 'DZ';
  static displayName = 'Domotz';
  static make = 'Network device';
  static nativeHealth = true;
  static apiSetLabel = 'Network monitoring API';
  static docsUrl = 'https://portal.domotz.com/developers';
  static guide = {
    summary: 'Domotz is a network monitor. A Domotz collector at each site finds and pings everything on the LAN, so it covers kit with no cloud of its own: switches (including NETGEAR AV), displays, signage players, amplifiers and PDUs.',
    needs: ['A Domotz collector (agent) at each site', 'A Domotz API key and the API endpoint shown with it'],
    health: 'Online is healthy. Down (stopped answering on the network) and offline are offline. A collector that is offline marks its whole site offline.',
    location: 'Each collector is a site. Set the Room field on a device in Domotz to place it in a room; the default filter only imports devices that have a room.',
  };
  static apis = [
    { id: 'domotz-agents', name: 'Domotz collectors', method: 'GET', url: `${DOMOTZ_BASE}/agent`, purpose: 'Collectors (one per site) and their status', auth: 'X-Api-Key header' },
    { id: 'domotz-devices', name: 'Domotz devices', method: 'GET', url: `${DOMOTZ_BASE}/agent/{agentId}/device`, probe: `${DOMOTZ_BASE}/agent/0/device`, purpose: 'Every device a collector sees, with status, MAC, IP and room', auth: 'X-Api-Key header' },
    { id: 'domotz-power', name: 'Domotz power action', method: 'POST', url: `${DOMOTZ_BASE}/agent/{agentId}/device/{deviceId}/action/power/{action}`, probe: `${DOMOTZ_BASE}/agent/0/device/0/action/power/software-reboot`, purpose: 'Device action: software reboot or PoE power cycle', auth: 'X-Api-Key header' },
  ];
  static actions = [
    {
      id: 'software-reboot', label: 'Reboot (software)', target: 'device',
      description: 'Asks Domotz to reboot the device through its management interface. Works only where Domotz has power control for the device.',
      confirm: 'Reboot this device through Domotz now?',
      api: { set: 'Monitoring', name: 'Domotz Public API', method: 'POST', endpoint: '/agent/{agentId}/device/{deviceId}/action/power/software-reboot' },
      scope: 'API key',
    },
    {
      id: 'cycle', label: 'Power-cycle (PoE or PDU)', target: 'device',
      description: 'Turns the device\'s switch port or PDU outlet off and on again. Use when the device does not answer at all.',
      confirm: 'Power-cycle this device through Domotz now? It loses power for a few seconds.',
      api: { set: 'Monitoring', name: 'Domotz Public API', method: 'POST', endpoint: '/agent/{agentId}/device/{deviceId}/action/power/cycle' },
      scope: 'API key',
    },
  ];
  static setupSteps = [
    'In the Domotz portal open Settings › API keys and create a key. Note the API endpoint shown with it (it depends on your region).',
    'In Domotz, set the Room (and Zone) on the devices you want to monitor, or set Import to "all" below.',
    'Paste the endpoint and key below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [
    { key: 'baseUrl', label: 'API endpoint', default: DOMOTZ_BASE, required: true, help: 'Shown with your API key, for example https://api-eu-central-1-cell-1.domotz.com/public-api/v1' },
    { key: 'filter', label: 'Import (room, vital or all)', default: 'room', help: 'room = devices with a Room set; vital = devices marked Vital; all = everything' },
  ];
  static credentialFields = [{ key: 'apiKey', label: 'API key', required: true }];

  constructor(opts) {
    super(opts);
    if (!this.transport) this.transport = this.isLive ? new DomotzHttpTransport({ apiKey: this.credentials.apiKey, baseUrl: this.connection.settings?.baseUrl || DOMOTZ_BASE }) : new DomotzMockTransport(this.connection.customerId);
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const agents = listOf(await this.transport.get('/agent'));
    return { ok: true, message: `Connected to Domotz. ${agents.length} collectors.` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const agents = listOf(await this.transport.get('/agent'));
    const out = [];
    for (const a of agents) out.push({ agent: a, devices: listOf(await this.transport.get(`/agent/${encodeURIComponent(a.id)}/device`)) });
    return out;
  }

  mapDevices(agents = [], now = Date.now()) {
    const C = this.constructor;
    const filter = String(this.connection.settings?.filter || 'room').toLowerCase();
    return agents.flatMap(({ agent, devices }) => {
      const agentDown = String(agent.status?.value || agent.status || '').toUpperCase() === 'OFFLINE';
      return devices
        .filter((d) => String(d.status).toUpperCase() !== 'HIDDEN')
        .filter((d) => (filter === 'all' ? true : filter === 'vital' ? d.importance === 'VITAL' : !!d.details?.room))
        .map((d) => {
          const st = String(d.status || '').toUpperCase();
          const offline = agentDown || st === 'OFFLINE' || st === 'DOWN';
          const model = String(pick(d.user_data?.model, d.model, d.type?.label, 'Network device'));
          const make = String(pick(d.user_data?.vendor, d.vendor, 'Unknown'));
          return makeDevice({
            id: `${C.oem}:${agent.id}:${d.id}`,
            customerId: this.connection.customerId,
            site: pick(agent.display_name, 'Unassigned site'),
            room: pick(d.details?.room, d.details?.zone, 'Unassigned room'),
            deviceType: classifyDeviceType(`${model} ${d.type?.label || ''}`),
            make, model,
            hostName: pick(d.user_data?.name, d.display_name),
            serial: pick(d.details?.serial), firmware: pick(d.details?.firmware_version),
            mac: d.hw_address || null, ip: (d.ip_addresses || [])[0] || null,
            health: offline ? 'offline' : 'healthy',
            healthReason: agentDown ? 'The Domotz collector for this site is offline' : st === 'DOWN' ? 'Stopped answering on the network (Domotz: DOWN)' : st === 'OFFLINE' ? 'Domotz reports the device offline' : null,
            issues: !offline ? [] : [issue(st === 'DOWN' ? 'EM-NET-003' : 'EM-NET-001', V, agentDown ? 'collector status: OFFLINE' : `status: ${st}`)],
            lastSeen: offline ? pick(d.last_status_change) : new Date(now).toISOString(),
            weakIdentity: !d.hw_address && !d.details?.serial,
            sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: String(d.id), agentId: agent.id }],
          });
        });
    });
  }

  async performAction(action, source) {
    await this.transport.post(`/agent/${encodeURIComponent(source.agentId)}/device/${encodeURIComponent(source.sourceId)}/action/power/${action.id}`);
    return { ok: true, message: action.id === 'cycle' ? 'Domotz is power-cycling the port or outlet.' : 'Domotz sent the reboot.' };
  }
}
