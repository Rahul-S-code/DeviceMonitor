// Yealink Management Cloud Service (YMCS) connector.
//
// Built from the YMCS Open API (V4X) as used by the open-source yealink-lib client
// (https://github.com/dszp/yealink-lib) and Yealink's YMCS admin guide.
//
// Server:  https://{region}-api.ymcs.yealink.com  (region us | eu | au)
// Auth:    POST /v2/token, Authorization: Basic base64(AccessKey ID:AccessKey Secret),
//          body {"grant_type":"client_credentials"} -> { access_token, expires_in }
//          Every request (token included) carries a `timestamp` header (epoch ms) and a
//          unique `nonce` header; YMCS rejects a reused nonce with 403 code 500403.
// Data:    POST /v2/dm/listSites   { skip, limit, autoCount } -> { total, data: [{ id, name, parentId }] }
//          POST /v2/dm/listDevices { skip, limit<=100, autoCount, filter:{ deviceType:0 } }
//            -> { total, data: [{ id, mac, sn, name, modelId, siteId, programVersion, deviceStatus: online|offline|pending, ip }] }
//          GET  /v2/dm/models?deviceType=1|3 -> [{ id, name }]
//          POST /v2/dm/listAlarms -> { data: [{ id, event, level, mac, model, siteName, status }] }
// Action:  POST /v2/dm/device/reboot { deviceIds:[id], deviceType: 1 phone | 3 room device }
import crypto from 'node:crypto';
import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { requestJson, TokenCache, basic, pick, listOf } from '../http.js';
import { YealinkMockTransport } from './mock.js';

export const YEALINK_REGIONS = { us: 'https://us-api.ymcs.yealink.com', eu: 'https://eu-api.ymcs.yealink.com', au: 'https://au-api.ymcs.yealink.com' };
const V = 'Yealink YMCS';
const replay = () => ({ timestamp: String(Date.now()), nonce: crypto.randomBytes(16).toString('hex') });

export class YealinkHttpTransport {
  constructor({ baseUrl, accessKeyId, accessKeySecret, fetchImpl }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), fetchImpl });
    this.tokens = new TokenCache(async () => {
      const b = await requestJson(`${this.baseUrl}/v2/token`, {
        method: 'POST', vendor: V, fetchImpl, body: { grant_type: 'client_credentials' },
        headers: { authorization: basic(accessKeyId, accessKeySecret), ...replay() },
        hint401: 'check the AccessKey ID and Secret (YMCS > Enterprise Settings > API Service).',
      });
      if (!b.access_token) throw new Error('Yealink YMCS did not return an access token');
      return { token: b.access_token, expiresIn: b.expires_in };
    });
  }

  async call(method, path, body) {
    const headers = { authorization: `Bearer ${await this.tokens.get()}`, ...replay() };
    return requestJson(this.baseUrl + path, { method, body, headers, vendor: V, fetchImpl: this.fetchImpl, hint403: 'the AccessKey needs the device management permission, or a nonce was reused.' });
  }

  post(path, body = {}) { return this.call('POST', path, body); }
  get(path) { return this.call('GET', path); }
}

/** Walk a YMCS list endpoint ({skip, limit, autoCount} in, {total, data} out). */
async function listAll(t, path, filter, pageSize = 100) {
  const out = [];
  for (let skip = 0, guard = 0; guard < 500; guard++, skip += pageSize) {
    const page = await t.post(path, { skip, limit: pageSize, autoCount: skip === 0, ...(filter ? { filter } : {}) });
    const data = listOf(page);
    out.push(...data);
    if (data.length < pageSize || (page.total !== undefined && out.length >= page.total)) break;
  }
  return out;
}

export class YealinkYmcsConnector extends BaseConnector {
  static oem = 'yealink-ymcs';
  static short = 'YL';
  static displayName = 'Yealink YMCS';
  static make = 'Yealink';
  static nativeHealth = true;
  static docsUrl = 'https://www.yealink.com/en/product-detail/management-cloud-service';
  static guide = {
    summary: 'Yealink Management Cloud Service holds every Yealink phone, MeetingBar, room panel and touch console in your enterprise, with online status, firmware and alarms.',
    needs: ['A YMCS enterprise account with the API Service enabled', 'An AccessKey ID and AccessKey Secret'],
    health: 'Online is healthy, offline is offline, and a device with an open YMCS alarm is amber. Devices that have never reported (pending) show as activation pending.',
    location: 'YMCS sites become rooms; a site\'s parent site becomes the Estate Monitor site.',
  };
  static apis = [
    { id: 'yealink-token', name: 'YMCS access token', method: 'POST', url: `${YEALINK_REGIONS.us}/v2/token`, purpose: 'Gets an access token with the AccessKey', auth: 'Basic (AccessKey ID and Secret)' },
    { id: 'yealink-devices', name: 'YMCS list devices', method: 'POST', url: `${YEALINK_REGIONS.us}/v2/dm/listDevices`, purpose: 'Devices with status, firmware, MAC and site', auth: 'Bearer token' },
    { id: 'yealink-sites', name: 'YMCS list sites', method: 'POST', url: `${YEALINK_REGIONS.us}/v2/dm/listSites`, purpose: 'Site tree for site and room names', auth: 'Bearer token' },
    { id: 'yealink-alarms', name: 'YMCS list alarms', method: 'POST', url: `${YEALINK_REGIONS.us}/v2/dm/listAlarms`, purpose: 'Open alarms for amber health', auth: 'Bearer token' },
    { id: 'yealink-reboot', name: 'YMCS reboot device', method: 'POST', url: `${YEALINK_REGIONS.us}/v2/dm/device/reboot`, purpose: 'Device action: reboot', auth: 'Bearer token' },
  ];
  static actions = [{
    id: 'reboot', label: 'Reboot device', target: 'device',
    description: 'Reboots the Yealink device through YMCS. A call or meeting on it ends. An offline device reboots when it next connects.',
    confirm: 'Reboot this Yealink device now?',
    api: { set: 'OEM', name: 'Yealink YMCS Open API', method: 'POST', endpoint: '/v2/dm/device/reboot' },
    scope: 'AccessKey with device management permission',
  }];
  static setupSteps = [
    'Sign in to your regional YMCS portal (for example us.ymcs.yealink.com) as an enterprise administrator.',
    'Open Enterprise Settings › API Service and create an AccessKey. Copy the AccessKey ID and Secret.',
    'Pick the same region below (us, eu or au).',
    'Paste the AccessKey below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [
    { key: 'region', label: 'Region (us, eu or au)', required: true, default: 'us', help: 'The region of your YMCS portal' },
    { key: 'baseUrl', label: 'API server (optional)', placeholder: 'https://us-api.ymcs.yealink.com', help: 'Only if Yealink gave you a different server' },
  ];
  static credentialFields = [
    { key: 'accessKeyId', label: 'AccessKey ID', required: true },
    { key: 'accessKeySecret', label: 'AccessKey Secret', required: true },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      const s = this.connection.settings || {};
      this.transport = this.isLive
        ? new YealinkHttpTransport({ baseUrl: s.baseUrl || YEALINK_REGIONS[String(s.region || 'us').toLowerCase()] || YEALINK_REGIONS.us, ...this.credentials })
        : new YealinkMockTransport(this.connection.customerId);
    }
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const page = await this.transport.post('/v2/dm/listDevices', { skip: 0, limit: 1, autoCount: true, filter: { deviceType: 0 } });
    return { ok: true, message: `Connected to YMCS. ${page.total ?? listOf(page).length} devices in the enterprise.` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const t = this.transport;
    const [sites, devices, phones, rooms] = await Promise.all([
      listAll(t, '/v2/dm/listSites'),
      listAll(t, '/v2/dm/listDevices', { deviceType: 0 }),
      t.get('/v2/dm/models?deviceType=1').catch(() => []),
      t.get('/v2/dm/models?deviceType=3').catch(() => []),
    ]);
    const alarms = await listAll(t, '/v2/dm/listAlarms').catch(() => []);
    const models = [...listOf(phones).map((m) => ({ ...m, deviceType: 1 })), ...listOf(rooms).map((m) => ({ ...m, deviceType: 3 }))];
    return { sites, devices, models, alarms };
  }

  mapDevices({ sites = [], devices = [], models = [], alarms = [] }, now = Date.now()) {
    const C = this.constructor;
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const modelById = new Map(models.map((m) => [m.id, m]));
    const alarmsByMac = new Map();
    for (const a of alarms) { const k = String(a.mac || '').replace(/[^a-f0-9]/gi, '').toLowerCase(); if (k) alarmsByMac.set(k, [...(alarmsByMac.get(k) || []), a]); }
    return devices.map((d) => {
      const site = siteById.get(d.siteId);
      const parent = site?.parentId ? siteById.get(site.parentId) : null;
      const model = modelById.get(d.modelId);
      const modelName = pick(d.modelName, model?.name, d.model, 'Yealink device');
      const open = alarmsByMac.get(String(d.mac || '').replace(/[^a-f0-9]/gi, '').toLowerCase()) || [];
      const status = String(d.deviceStatus ?? '').toLowerCase();
      let health = 'healthy'; let reason = null; let issues = [];
      if (status === 'offline' || status === '0') { health = 'offline'; reason = 'YMCS reports the device offline'; issues = [issue('EM-NET-001', V, `deviceStatus: ${d.deviceStatus}`)]; }
      else if (status === 'pending' || status === '-1') { health = 'warning'; reason = 'Never reported to YMCS'; issues = [issue('EM-REG-001', V, `deviceStatus: ${d.deviceStatus}`)]; }
      else if (open.length) { health = 'warning'; reason = open.map((a) => a.event).filter(Boolean).join('; ') || 'YMCS alarm open'; issues = open.map((a) => issue(classifyFault(a.event, 'EM-GEN-002'), V, `alarm: ${a.event || a.id}`)); }
      const deviceType = model?.deviceType ?? (/^(T|MP|CP|W)\d/i.test(modelName.replace(/^Yealink\s+/i, '')) ? 1 : 3);
      return makeDevice({
        id: `${C.oem}:${d.id}`,
        customerId: this.connection.customerId,
        site: pick(parent?.name, site?.name, 'Unassigned site'),
        room: pick(parent ? site?.name : null, d.name, 'Unassigned room'),
        deviceType: classifyDeviceType(modelName),
        make: C.make,
        model: /^yealink/i.test(modelName) ? modelName : `Yealink ${modelName}`,
        serial: d.sn || null, firmware: d.programVersion || null, mac: d.mac || null, ip: d.ip || null,
        health, healthReason: reason, issues,
        lastSeen: health === 'offline' ? null : new Date(now).toISOString(),
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: d.id, deviceType }],
      });
    });
  }

  async performAction(action, source) {
    await this.transport.post('/v2/dm/device/reboot', { deviceIds: [source.sourceId], deviceType: source.deviceType || 3 });
    return { ok: true, message: 'YMCS accepted the reboot. The device is back in two or three minutes.' };
  }
}
