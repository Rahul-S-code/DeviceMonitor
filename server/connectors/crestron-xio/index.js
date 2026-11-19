// Crestron XiO Cloud connector.
//
// Built from Crestron's XiO Cloud API Postman collection (as published in
// github.com/alvaroyurrita/XioApiExample) and "Enable API Access" in the XiO Cloud
// user guide (docs.crestron.com/en-us/8214/Content/Topics/Enable-API.htm).
//
// Server:  https://api.crestron.io/api
// Auth:    header XiO-subscription-key: <Api Subscription Key> (Account Settings > Profile >
//          Details > Enable API Access, Global Administrator only). Needs the account ID too.
// Data:    GET /v2/device/accountid/{accountId}/pageno/{n}/pagesize/{size}/status
//            -> { Pagination: { TotalPages }, DeviceList: [{ device: { device-cid, device-name,
//                 device-model, device-category, device-manufacturer, device-status: Online|Offline,
//                 device-groupid, serial-number, firmware-version, ... }, ... }] }
//          GET /v1/group/accountid/{accountId}/groups -> [{ id, Name, ParentGroupId, IsRoom }]
// Viewing current device status through the API needs XiO Cloud Premium licensing.
// The public API has no reboot command, so there are no actions.
import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { requestJson, pick, macFrom } from '../http.js';
import { CrestronXioMockTransport } from './mock.js';

export const XIO_BASE = 'https://api.crestron.io/api';
const V = 'Crestron XiO Cloud';

export class CrestronXioHttpTransport {
  constructor({ baseUrl = XIO_BASE, subscriptionKey, fetchImpl }) { Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), subscriptionKey, fetchImpl }); }
  get(path) {
    return requestJson(this.baseUrl + path, { vendor: V, fetchImpl: this.fetchImpl, headers: { 'XiO-subscription-key': this.subscriptionKey }, hint401: 'the Api Subscription Key is wrong. Copy it again from Account Settings.', hint403: 'API access is not enabled, or device status needs XiO Cloud Premium.' });
  }
}

const field = (d, k) => d?.[k] ?? null;

export class CrestronXioConnector extends BaseConnector {
  static oem = 'crestron-xio';
  static short = 'CX';
  static displayName = 'Crestron XiO Cloud';
  static make = 'Crestron';
  static nativeHealth = true;
  static docsUrl = 'https://docs.crestron.com/en-us/8214/Content/Topics/Enable-API.htm';
  static actionsNote = 'The XiO Cloud public API reads devices, rooms and status. Reboots and firmware updates are done in the XiO Cloud portal.';
  static guide = {
    summary: 'Crestron XiO Cloud manages Crestron control processors, touch panels, AV switchers, Flex systems and claimed third-party devices.',
    needs: ['XiO Cloud with API access enabled by a Global Administrator', 'The account ID and Api Subscription Key', 'XiO Cloud Premium (or the SW-XIOC-API licence) to read device status'],
    health: 'Online is healthy and anything else is offline. Status groups that report a fault (for example an HDMI input with no sync) add an amber issue.',
    location: 'XiO room groups become rooms and their parent group becomes the site.',
  };
  static apis = [
    { id: 'xio-status', name: 'XiO Cloud device status (paged)', method: 'GET', url: `${XIO_BASE}/v2/device/accountid/{accountId}/pageno/{n}/pagesize/{size}/status`, probe: `${XIO_BASE}/v2/device/accountid/0/pageno/1/pagesize/1/status`, purpose: 'Devices with status, model, serial and firmware', auth: 'XiO-subscription-key header' },
    { id: 'xio-groups', name: 'XiO Cloud groups', method: 'GET', url: `${XIO_BASE}/v1/group/accountid/{accountId}/groups`, probe: `${XIO_BASE}/v1/group/accountid/0/groups`, purpose: 'Rooms and their parent groups (sites)', auth: 'XiO-subscription-key header' },
  ];
  static setupSteps = [
    'Sign in to XiO Cloud as a Global Administrator.',
    'Open Account Settings › Profile › Details and turn on Enable API Access. Enter the administrator name and email, then save.',
    'Copy the Account ID and the Api Subscription Key shown next to it.',
    'Paste them below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [{ key: 'accountId', label: 'Account ID', required: true, help: 'Shown with the Api Subscription Key in Account Settings' }];
  static credentialFields = [{ key: 'subscriptionKey', label: 'Api Subscription Key', required: true }];

  constructor(opts) {
    super(opts);
    if (!this.transport) this.transport = this.isLive ? new CrestronXioHttpTransport({ subscriptionKey: this.credentials.subscriptionKey }) : new CrestronXioMockTransport(this.connection.customerId);
  }

  get acct() { return encodeURIComponent(this.connection.settings?.accountId || `mock-${this.connection.customerId}`); }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const p = await this.transport.get(`/v2/device/accountid/${this.acct}/pageno/1/pagesize/1/status`);
    return { ok: true, message: `Connected to XiO Cloud. ${p.Pagination?.TotalDevices ?? (p.DeviceList || []).length} devices in the account.` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const devices = [];
    for (let n = 1, pages = 1; n <= pages && n <= 200; n++) {
      const p = await this.transport.get(`/v2/device/accountid/${this.acct}/pageno/${n}/pagesize/100/status`);
      devices.push(...(p.DeviceList || []));
      pages = p.Pagination?.TotalPages || 1;
    }
    const groups = await this.transport.get(`/v1/group/accountid/${this.acct}/groups`).catch(() => []);
    return { devices, groups: Array.isArray(groups) ? groups : [] };
  }

  mapDevices({ devices = [], groups = [] }, now = Date.now()) {
    const C = this.constructor;
    const gById = new Map(groups.map((g) => [g.id, g]));
    return devices.map((entry) => {
      const d = entry.device || entry;
      const g = gById.get(field(d, 'device-groupid'));
      const parent = g?.ParentGroupId ? gById.get(g.ParentGroupId) : null;
      const status = String(field(d, 'device-status') || '');
      const online = /^online$/i.test(status);
      // Any status group reporting a fault, e.g. { "hdmi-input": { "hdmi-input-sync-detected": "false" } }.
      const faults = Object.entries(entry).filter(([k, v]) => k !== 'device' && v && typeof v === 'object' && Object.entries(v).some(([fk, fv]) => /fault|error/i.test(fk) && fv && !/^(false|none|0|ok)$/i.test(String(fv))));
      const model = String(pick(field(d, 'device-model'), 'Crestron device'));
      const make = pick(field(d, 'device-manufacturer'), C.make);
      const health = !online ? 'offline' : faults.length ? 'warning' : 'healthy';
      return makeDevice({
        id: `${C.oem}:${field(d, 'device-cid')}`,
        customerId: this.connection.customerId,
        site: pick(parent?.Name, 'Unassigned site'),
        room: pick(g?.Name, field(d, 'user-device-name'), field(d, 'device-name'), 'Unassigned room'),
        deviceType: classifyDeviceType(`${model} ${field(d, 'device-category') || ''}`),
        make, model: make === 'Crestron' ? `Crestron ${model}` : model,
        hostName: field(d, 'device-name'),
        serial: field(d, 'serial-number'), firmware: field(d, 'firmware-version'),
        mac: macFrom(field(d, 'device-cid')), ip: pick(field(d, 'ip-address'), entry.network?.['ip-address']),
        health,
        healthReason: !online ? `XiO Cloud reports the device ${status || 'not online'}` : faults.length ? `XiO Cloud reports a fault in ${faults.map(([k]) => k).join(', ')}` : null,
        issues: !online ? [issue('EM-NET-001', V, `device-status: ${status || 'unknown'}`)] : faults.map(([k]) => issue(classifyFault(k, 'EM-GEN-002'), V, `${k}: fault`)),
        lastSeen: online ? new Date(now).toISOString() : null,
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: field(d, 'device-cid') }],
      });
    });
  }
}
