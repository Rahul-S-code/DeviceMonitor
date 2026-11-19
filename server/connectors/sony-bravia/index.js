// Sony BRAVIA Professional Displays connector (BRAVIA Cloud API).
//
// Built from Sony's Cloud API "Control & Monitoring API Reference":
//   https://pro-bravia.sony.net/remote-display-control/cloud-api/control-monitoring-api-reference
//
// Server:  https://api.apps.rdm.sony.net/rms/v1
// Auth:    API key plus the access key for the display group, both issued by Sony when the
//          Cloud API is enabled ("ApiKeyAuth" and "AccessKeyAuth"). The header names come
//          from Sony's onboarding pack, so both are settings here.
// Data:    GET /devices -> { devices: [{ deviceId, deviceName, modelName, serial, braviaId,
//               softwareVersion, osVersion, networkInterfaces: [{ type, macAddress, ipv4Address }] }] }
//          GET /devices/{deviceId}/online-status -> { online: true|false }
// Actions: POST /devices/{deviceId}/reboot/requests        (201, queued)
//          POST /devices/{deviceId}/screen/requests { screen: "ON"|"OFF" }
// Supported displays: BZ40P, BZ35P, BZ30P, BZ53L, BZ50L, BZ40L, BZ35L, BZ30L, BZ40J, BZ35J, BZ30J, BZ40H
// on firmware PKG 6.7283 or later.
import { BaseConnector } from '../base.js';
import { issue } from '../../lib/issues.js';
import { makeDevice } from '../../lib/device-model.js';
import { requestJson, pick, listOf } from '../http.js';
import { SonyBraviaMockTransport } from './mock.js';

export const SONY_BASE = 'https://api.apps.rdm.sony.net/rms/v1';
const V = 'Sony BRAVIA Cloud API';

export class SonyBraviaHttpTransport {
  constructor({ baseUrl = SONY_BASE, apiKey, accessKey, apiKeyHeader = 'x-api-key', accessKeyHeader = 'x-access-key', fetchImpl }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), fetchImpl });
    this.headers = { [apiKeyHeader]: apiKey, ...(accessKey ? { [accessKeyHeader]: accessKey } : {}) };
  }
  call(method, path, body) {
    return requestJson(this.baseUrl + path, { method, body, vendor: V, fetchImpl: this.fetchImpl, headers: this.headers, hint401: 'the API key or access key is wrong.', hint403: 'the access key does not cover this display group.' });
  }
  get(path) { return this.call('GET', path); }
  post(path, body = {}) { return this.call('POST', path, body); }
}

export class SonyBraviaConnector extends BaseConnector {
  static oem = 'sony-bravia';
  static short = 'SY';
  static displayName = 'Sony BRAVIA Cloud';
  static make = 'Sony';
  static nativeHealth = false;
  static docsUrl = 'https://pro-bravia.sony.net/remote-display-control/cloud-api/';
  static guide = {
    summary: 'Sony\'s BRAVIA Cloud API monitors and controls BRAVIA Professional Displays used as room screens and signage.',
    needs: ['Sony Cloud API registration (Sony issues the API key and access keys)', 'Supported BRAVIA models on firmware PKG 6.7283 or later'],
    health: 'Online is healthy and offline is offline. The API has no fault states.',
    location: 'Name displays "Site / Room / Display" in Sony\'s portal to place them; otherwise they go under the default site below.',
  };
  static apis = [
    { id: 'sony-devices', name: 'BRAVIA Cloud devices', method: 'GET', url: `${SONY_BASE}/devices`, purpose: 'Displays with model, serial, software version and network', auth: 'API key + access key' },
    { id: 'sony-online', name: 'BRAVIA Cloud online status', method: 'GET', url: `${SONY_BASE}/devices/{deviceId}/online-status`, probe: `${SONY_BASE}/devices/0/online-status`, purpose: 'Whether each display is connected', auth: 'API key + access key' },
    { id: 'sony-reboot', name: 'BRAVIA Cloud reboot', method: 'POST', url: `${SONY_BASE}/devices/{deviceId}/reboot/requests`, probe: `${SONY_BASE}/devices/0/reboot/requests`, purpose: 'Device action: reboot', auth: 'API key + access key' },
    { id: 'sony-screen', name: 'BRAVIA Cloud screen on/off', method: 'POST', url: `${SONY_BASE}/devices/{deviceId}/screen/requests`, probe: `${SONY_BASE}/devices/0/screen/requests`, purpose: 'Device actions: screen on and off', auth: 'API key + access key' },
  ];
  static actions = [
    { id: 'reboot', label: 'Reboot display', target: 'device', description: 'Reboots the BRAVIA display. Sony queues the request and the display restarts within a minute.', confirm: 'Reboot this display now?', api: { set: 'OEM', name: 'Sony BRAVIA Cloud API', method: 'POST', endpoint: '/devices/{deviceId}/reboot/requests' }, scope: 'Access key for the display group' },
    { id: 'screen-on', label: 'Screen on', target: 'device', description: 'Turns the picture on.', confirm: 'Turn this display\'s screen on?', api: { set: 'OEM', name: 'Sony BRAVIA Cloud API', method: 'POST', endpoint: '/devices/{deviceId}/screen/requests (ON)' }, scope: 'Access key for the display group' },
    { id: 'screen-off', label: 'Screen off', target: 'device', description: 'Turns the picture off (the display stays connected).', confirm: 'Turn this display\'s screen off?', api: { set: 'OEM', name: 'Sony BRAVIA Cloud API', method: 'POST', endpoint: '/devices/{deviceId}/screen/requests (OFF)' }, scope: 'Access key for the display group' },
  ];
  static setupSteps = [
    'Register for the BRAVIA Cloud API with Sony (pro-bravia.sony.net). Sony provides the API key and the access key for your displays.',
    'Register each display with the Provisioning API or Sony\'s tools so it appears under your access key.',
    'Paste the keys below. Leave the header names as they are unless Sony\'s onboarding pack names different ones.',
    'Press Test connection, then switch to Live and save.',
  ];
  static settingFields = [
    { key: 'defaultSite', label: 'Default site', default: 'Unassigned site', help: 'Used for displays whose name does not start with "Site / Room"' },
    { key: 'apiKeyHeader', label: 'API key header', default: 'x-api-key' },
    { key: 'accessKeyHeader', label: 'Access key header', default: 'x-access-key' },
  ];
  static credentialFields = [
    { key: 'apiKey', label: 'API key', required: true },
    { key: 'accessKey', label: 'Access key', required: true },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      const s = this.connection.settings || {};
      this.transport = this.isLive
        ? new SonyBraviaHttpTransport({ ...this.credentials, apiKeyHeader: s.apiKeyHeader || undefined, accessKeyHeader: s.accessKeyHeader || undefined })
        : new SonyBraviaMockTransport(this.connection.customerId);
    }
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const list = listOf(await this.transport.get('/devices'));
    return { ok: true, message: `Connected to the BRAVIA Cloud API. ${list.length} displays.` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const devices = listOf(await this.transport.get('/devices'));
    const out = [];
    // Online status is one call per display; 8 at a time.
    for (let i = 0; i < devices.length; i += 8) {
      out.push(...await Promise.all(devices.slice(i, i + 8).map(async (d) => {
        const st = await this.transport.get(`/devices/${encodeURIComponent(d.deviceId)}/online-status`).catch(() => ({ online: null }));
        return { ...d, online: st.online };
      })));
    }
    return out;
  }

  mapDevices(devices = [], now = Date.now()) {
    const C = this.constructor;
    const def = this.connection.settings?.defaultSite || 'Unassigned site';
    return devices.map((d) => {
      const parts = String(d.deviceName || '').split('/').map((x) => x.trim()).filter(Boolean);
      const nic = (d.networkInterfaces || []).find((n) => n.type === 'wired') || (d.networkInterfaces || [])[0] || {};
      const offline = d.online === false;
      return makeDevice({
        id: `${C.oem}:${d.deviceId}`,
        customerId: this.connection.customerId,
        site: parts.length >= 2 ? parts[0] : def,
        room: parts.length >= 2 ? parts[1] : pick(parts[0], d.serial, 'Unassigned room'),
        deviceType: 'Display',
        make: C.make, model: /^bravia/i.test(d.modelName || '') ? d.modelName : `BRAVIA ${pick(d.modelName, 'display')}`,
        hostName: d.deviceName || null,
        serial: d.serial || null, firmware: pick(d.softwareVersion, d.osVersion),
        mac: nic.macAddress || null, ip: nic.ipv4Address || null,
        health: offline ? 'offline' : 'healthy',
        healthReason: offline ? 'The BRAVIA Cloud API reports the display offline' : null,
        issues: offline ? [issue('EM-NET-001', V, 'online: false')] : [],
        lastSeen: offline ? null : new Date(now).toISOString(),
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: String(d.deviceId) }],
      });
    });
  }

  async performAction(action, source) {
    const id = encodeURIComponent(source.sourceId);
    if (action.id === 'reboot') await this.transport.post(`/devices/${id}/reboot/requests`);
    else await this.transport.post(`/devices/${id}/screen/requests`, { screen: action.id === 'screen-on' ? 'ON' : 'OFF' });
    return { ok: true, message: action.id === 'reboot' ? 'Sony queued the reboot. The display restarts within a minute.' : `Sony queued screen ${action.id === 'screen-on' ? 'on' : 'off'}.` };
  }
}
