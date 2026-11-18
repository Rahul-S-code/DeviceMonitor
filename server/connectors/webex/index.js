// Webex Control Hub connector (meeting-platform side).
//
// Built from the official Webex Devices and Workspaces API references:
//   https://developer.webex.com/docs/api/v1/devices        (List Devices)
//   https://developer.webex.com/docs/api/v1/workspaces     (List Workspaces)
//   https://developer.webex.com/docs/api/v1/locations      (List Locations)
//
// Auth:    Authorization: Bearer <access token> of an admin integration or service app.
//          Scopes: spark-admin:devices_read, spark-admin:workspaces_read (spark-admin:locations_read for site names).
// Data:    GET https://webexapis.com/v1/devices?max=1000[&orgId=]
//            -> { items: [{ id, displayName, workspaceId, orgId, product, type, serial, software,
//                           mac, ip, connectionStatus, errorCodes[], lastSeen, ... }] }
//          connectionStatus: connected | connected_with_issues | disconnected | offline_expired |
//                            offline_deep_sleep | activating | pending | unknown
//          Paging follows the RFC 5988 Link header (rel="next").
//          GET /v1/workspaces -> { items: [{ id, displayName, locationId }] }
//          GET /v1/locations  -> { items: [{ id, name }] }

import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { trackedFetch } from '../../lib/api-calls.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { WebexMockTransport } from './mock.js';

export const WEBEX_DEFAULT_BASE = 'https://webexapis.com/v1';

export class WebexHttpTransport {
  constructor({ baseUrl, accessToken, fetchImpl = trackedFetch }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), accessToken, fetchImpl });
  }

  /** GET a list endpoint and follow Link rel="next" until done. */
  async list(path, query = {}, maxPages = 100) {
    let url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, String(v));
    const items = [];
    for (let page = 0; url && page < maxPages; page++) {
      const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' } });
      if (res.status === 401) throw new Error('Webex returned 401: the access token is invalid or expired.');
      if (res.status === 403) throw new Error('Webex returned 403: the token needs spark-admin:devices_read and spark-admin:workspaces_read.');
      if (res.status === 429) throw new Error('Webex rate limit reached. Will retry next sync.');
      if (!res.ok) throw new Error(`Webex API error (HTTP ${res.status})`);
      const body = await res.json();
      items.push(...(body.items ?? []));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
      url = next ? new URL(next[1]) : null;
    }
    return items;
  }

  /** Run an xAPI command on a device (cloud xAPI). */
  async command(name, deviceId, args) {
    const res = await this.fetchImpl(`${this.baseUrl}/xapi/command/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ deviceId, ...(args ? { arguments: args } : {}) }),
    });
    if (res.status === 401) throw new Error('Webex returned 401: the access token is invalid or expired.');
    if (res.status === 403) throw new Error('Webex returned 403: the token needs the spark:xapi_commands scope, from an admin with device rights.');
    if (res.status === 404) throw new Error('Webex returned 404: the device is not online in Webex or does not support this command.');
    if (!res.ok) throw new Error(`Webex xAPI error (HTTP ${res.status})`);
    return res.json().catch(() => ({}));
  }
}

const STATUS = {
  connected: ['healthy', null],
  connected_with_issues: ['warning', 'Webex reports the device connected with issues'],
  disconnected: ['offline', 'Disconnected from Webex'],
  offline_expired: ['offline', 'Offline for an extended period'],
  offline_deep_sleep: ['offline', 'In deep sleep'],
  activating: ['warning', 'Activating'],
  pending: ['warning', 'Pending activation'],
  unknown: ['warning', 'Webex does not know the connection status'],
};

const STATUS_CODE = { disconnected: 'EM-NET-001', offline_expired: 'EM-NET-002', offline_deep_sleep: 'EM-PWR-001', activating: 'EM-REG-001', pending: 'EM-REG-001', unknown: 'EM-GEN-003' };
function webexIssues(d, source) {
  const st = d.connectionStatus || 'unknown';
  if (st === 'connected' && !d.errorCodes?.length) return [];
  if (STATUS_CODE[st] || !STATUS[st]) return [issue(STATUS_CODE[st] || 'EM-GEN-003', source, `connectionStatus: ${st}`)];
  if (!d.errorCodes?.length) return [issue('EM-GEN-002', source, `connectionStatus: ${st}`)];
  return d.errorCodes.map((c) => issue(classifyFault(c, 'EM-GEN-002'), source, `errorCode: ${c}`));
}

export class WebexConnector extends BaseConnector {
  static oem = 'webex-control-hub';
  static displayName = 'Webex Control Hub';
  static make = 'Cisco';
  static kind = 'platform';
  static platform = 'Cisco Webex';
  static nativeHealth = true;
  static docsUrl = 'https://developer.webex.com/docs/api/v1/devices';
  static apis = [
    { id: 'webex-devices', name: 'Webex List Devices', method: 'GET', url: `${WEBEX_DEFAULT_BASE}/devices`, purpose: 'Devices, software version and connection status', auth: 'Bearer token (spark-admin:devices_read)' },
    { id: 'webex-workspaces', name: 'Webex List Workspaces', method: 'GET', url: `${WEBEX_DEFAULT_BASE}/workspaces`, purpose: 'Room (workspace) names', auth: 'Bearer token (spark-admin:workspaces_read)' },
    { id: 'webex-xapi-command', name: 'Webex xAPI command', method: 'POST', url: `${WEBEX_DEFAULT_BASE}/xapi/command/{command}`, probe: `${WEBEX_DEFAULT_BASE}/xapi/command/Standby.Deactivate`, purpose: 'Device actions: restart, wake, standby', auth: 'Bearer token (spark:xapi_commands)' },
    { id: 'webex-locations', name: 'Webex List Locations', method: 'GET', url: `${WEBEX_DEFAULT_BASE}/locations`, purpose: 'Site names (optional)', auth: 'Bearer token (spark-admin:locations_read)' },
  ];
  static setupSteps = [
    'In developer.webex.com create a Service App (or an admin Integration) for the customer org.',
    'Request the scopes spark-admin:devices_read, spark-admin:workspaces_read and spark-admin:locations_read.',
    'Have a Control Hub full admin authorise it, then generate an access token.',
    'Paste the token below, press Test connection, then switch to Live and save. Service-app tokens expire, so refresh them before they lapse.',
  ];
  static actions = [
    {
      id: 'restart', label: 'Restart device', target: 'device',
      description: 'Restarts the RoomOS device (SystemUnit Boot). A call in progress drops.',
      confirm: 'Restart this device now?',
      api: { set: 'Platform', name: 'Webex xAPI (cloud)', method: 'POST', endpoint: '/v1/xapi/command/SystemUnit.Boot' },
      scope: 'spark:xapi_commands',
    },
    {
      id: 'wake', label: 'Wake from standby', target: 'device',
      description: 'Brings the device out of standby so the screens and camera come on.',
      confirm: 'Wake this device?',
      api: { set: 'Platform', name: 'Webex xAPI (cloud)', method: 'POST', endpoint: '/v1/xapi/command/Standby.Deactivate' },
      scope: 'spark:xapi_commands',
    },
    {
      id: 'standby', label: 'Put into standby', target: 'device',
      description: 'Puts the device into standby (screens off).',
      confirm: 'Put this device into standby?',
      api: { set: 'Platform', name: 'Webex xAPI (cloud)', method: 'POST', endpoint: '/v1/xapi/command/Standby.Activate' },
      scope: 'spark:xapi_commands',
    },
  ];

  /** xAPI commands run on Cisco RoomOS devices only. */
  static actionApplies(_action, device) { return /cisco|webex/i.test(`${device.make} ${device.model}`); }

  static settingFields = [
    { key: 'orgId', label: 'Org ID', placeholder: 'Optional. Only for partner admins managing several orgs' },
    { key: 'baseUrl', label: 'API base URL', default: WEBEX_DEFAULT_BASE },
  ];
  static credentialFields = [
    { key: 'accessToken', label: 'Access token', required: true, help: 'Admin integration or service-app token' },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      this.transport = this.isLive
        ? new WebexHttpTransport({ baseUrl: this.connection.settings?.baseUrl || WEBEX_DEFAULT_BASE, accessToken: this.credentials.accessToken })
        : new WebexMockTransport(this.connection.customerId);
    }
  }

  async performAction(action, source) {
    const cmd = { restart: ['SystemUnit.Boot', { Action: 'Restart' }], wake: ['Standby.Deactivate'], standby: ['Standby.Activate'] }[action.id];
    if (!cmd) throw new Error('Unknown action');
    await this.transport.command(cmd[0], source.sourceId, cmd[1]);
    return { ok: true, message: `Webex ran ${cmd[0]} on the device.` };
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const items = await this.transport.list('/devices', { max: 1, orgId: this.connection.settings?.orgId }, 1);
    return { ok: true, message: `Connected to Webex. ${items.length ? 'Devices found.' : 'No devices returned yet.'}` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const orgId = this.connection.settings?.orgId;
    const devices = await this.transport.list('/devices', { max: 1000, orgId });
    const workspaces = await this.transport.list('/workspaces', { max: 1000, orgId });
    let locations = [];
    try { locations = await this.transport.list('/locations', { max: 1000, orgId }); } catch { /* optional */ }
    return { devices, workspaces, locations };
  }

  mapDevices({ devices, workspaces = [], locations = [] }) {
    const C = this.constructor;
    const ws = new Map(workspaces.map((w) => [w.id, w]));
    const loc = new Map(locations.map((l) => [l.id, l]));
    return devices.map((d) => {
      const w = ws.get(d.workspaceId);
      const site = loc.get(w?.locationId || w?.workspaceLocationId)?.name || 'Unassigned site';
      const [health, reason] = STATUS[d.connectionStatus] || STATUS.unknown;
      const product = d.product || d.displayName || 'Webex device';
      // Third-party devices carry a manufacturer; Cisco products are named "Cisco Room Bar", "Webex Desk", ...
      const make = d.manufacturer || (/^webex\b/i.test(product) ? 'Cisco' : product.split(/\s+/)[0]);
      return makeDevice({
        id: `${C.oem}:${d.id}`,
        customerId: this.connection.customerId,
        site,
        room: w?.displayName || d.displayName || 'Unassigned room',
        deviceType: classifyDeviceType(product),
        make,
        model: product,
        serial: d.serial || null,
        firmware: d.software || null,
        health,
        healthReason: d.errorCodes?.length ? `${reason || 'Issues'}: ${d.errorCodes.join(', ')}` : reason,
        issues: webexIssues(d, C.displayName),
        lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
        platform: C.platform,
        platformSource: 'device',
        mac: d.mac || null,
        ip: d.ip || null,
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: d.id }],
      });
    });
  }
}
