// Q-SYS Reflect Enterprise Manager connector.
//
// Built from the Reflect public API definition (qrem-public-api.yaml, served at
// https://reflect.qsc.com/static/qrem-public-api.yaml) and the Q-SYS help page
// "API Requests" (help.qsys.com/Content/Reflect/API_Example.htm).
//
// Server:  https://reflect.qsc.com/api/public/v0   (regional: https://{emea|apac}.reflect.qsc.com/api/public/v0)
// Auth:    Authorization: Bearer <64-character API token> (Reflect > Organizations > API Tokens)
// Data:    GET /systems -> [{ id, code, name, design: {...}, status: { code, message, details }, core: { id, name } }]
//          GET /systems/{systemId}/items -> [{ id, name, type, model, manufacturer, location, site,
//               serialNumber, status: { code, message }, isOnline, networkConfig, ... }]
//          status.code 0 means OK / Running. The API is read-only (no reboot).
import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { requestJson, pick, listOf } from '../http.js';
import { QsysReflectMockTransport } from './mock.js';

export const REFLECT_BASE = 'https://reflect.qsc.com/api/public/v0';
const V = 'Q-SYS Reflect';
const nameOf = (x) => (x && typeof x === 'object' ? pick(x.name, x.Name) : x) || null;

/** Reflect status (code + message) to Estate Monitor health. */
export function reflectHealth(item) {
  const code = Number(item.status?.code ?? 0);
  const msg = String(item.status?.message || '');
  if (item.isOnline === false || /offline|not present|missing|unreachable/i.test(msg)) return 'offline';
  if (code === 0 || /^(ok|running|normal)$/i.test(msg)) return 'healthy';
  if (/fault|error|fail/i.test(msg) || code >= 3) return 'critical';
  return 'warning';
}

export class QsysReflectHttpTransport {
  constructor({ baseUrl = REFLECT_BASE, token, fetchImpl }) { Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), token, fetchImpl }); }
  get(path) {
    return requestJson(this.baseUrl + path, { vendor: V, fetchImpl: this.fetchImpl, headers: { authorization: `Bearer ${this.token}` }, hint401: 'the API token is wrong or expired. Tokens are 64 characters.', hint403: 'the token has no access to this organisation.' });
  }
}

export class QsysReflectConnector extends BaseConnector {
  static oem = 'qsys-reflect';
  static short = 'QS';
  static displayName = 'Q-SYS Reflect';
  static make = 'Q-SYS';
  static nativeHealth = true;
  static docsUrl = 'https://help.qsys.com/Content/Reflect/API_Example.htm';
  static actionsNote = 'The Reflect public API is read-only. Restart Cores and peripherals in Reflect or Q-SYS Designer.';
  static guide = {
    summary: 'Q-SYS Reflect Enterprise Manager monitors Q-SYS Cores and every item in their designs: amplifiers, network video, cameras, touch screens and third-party plug-ins.',
    needs: ['A Reflect organisation (Enterprise Manager)', 'An API token created by an organisation owner'],
    health: 'Status OK or Running is healthy, a fault is red, other non-zero states are amber, and an item that is not online is offline.',
    location: 'Reflect sites become sites; the item\'s location (or the system name) becomes the room.',
  };
  static apis = [
    { id: 'reflect-systems', name: 'Reflect systems', method: 'GET', url: `${REFLECT_BASE}/systems`, purpose: 'Q-SYS systems and their status', auth: 'Bearer API token' },
    { id: 'reflect-items', name: 'Reflect system items', method: 'GET', url: `${REFLECT_BASE}/systems/{systemId}/items`, probe: `${REFLECT_BASE}/systems/0/items`, purpose: 'Every Core and peripheral with status, model and serial', auth: 'Bearer API token' },
  ];
  static setupSteps = [
    'Sign in to Reflect (reflect.qsc.com) as an organisation owner.',
    'Open Organizations › API Tokens and press New Token. Copy the full 64-character token.',
    'If your organisation is on the EMEA or APAC instance, set the region below.',
    'Paste the token below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [{ key: 'region', label: 'Region (blank for US, or emea, apac)', help: 'Matches the address of your Reflect site' }];
  static credentialFields = [{ key: 'token', label: 'API token', required: true }];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      const r = String(this.connection.settings?.region || '').trim().toLowerCase();
      this.transport = this.isLive
        ? new QsysReflectHttpTransport({ token: this.credentials.token, baseUrl: /^(emea|apac)$/.test(r) ? `https://${r}.reflect.qsc.com/api/public/v0` : REFLECT_BASE })
        : new QsysReflectMockTransport(this.connection.customerId);
    }
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const systems = listOf(await this.transport.get('/systems'));
    return { ok: true, message: `Connected to Reflect. ${systems.length} Q-SYS systems in the organisation.` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const systems = listOf(await this.transport.get('/systems'));
    const out = [];
    for (const s of systems) out.push({ system: s, items: listOf(await this.transport.get(`/systems/${encodeURIComponent(s.id)}/items`)) });
    return out;
  }

  mapDevices(systems = [], now = Date.now()) {
    const C = this.constructor;
    return systems.flatMap(({ system, items }) => items.map((it) => {
      const health = reflectHealth(it);
      const msg = it.status?.message || null;
      const model = String(pick(it.model, it.type, 'Q-SYS item'));
      const make = pick(it.manufacturer, C.make);
      return makeDevice({
        id: `${C.oem}:${it.id}`,
        customerId: this.connection.customerId,
        site: pick(nameOf(it.site), 'Unassigned site'),
        room: pick(nameOf(it.location), system.name, 'Unassigned room'),
        deviceType: classifyDeviceType(`${model} ${it.type || ''}`),
        make: /^(qsc|q-sys)$/i.test(make) ? 'Q-SYS' : make,
        model,
        hostName: it.name || null,
        serial: pick(it.serialNumber, it.serial), firmware: pick(it.firmware, system.design?.firmware),
        ip: pick(it.networkConfig?.ipAddress, it.networkConfig?.ip, it.networkConfig?.interfaces?.[0]?.ipAddress),
        mac: pick(it.networkConfig?.macAddress, it.networkConfig?.interfaces?.[0]?.macAddress),
        health,
        healthReason: health === 'healthy' ? null : `Reflect: ${msg || `status ${it.status?.code}`}`,
        issues: health === 'healthy' ? [] : [issue(health === 'offline' ? 'EM-NET-001' : classifyFault(`${msg} ${model}`, health === 'critical' ? 'EM-GEN-001' : 'EM-GEN-002'), V, `status: ${it.status?.code} ${msg || ''}`.trim())],
        lastSeen: health === 'offline' ? null : new Date(now).toISOString(),
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: String(it.id), systemId: system.id }],
      });
    }));
  }
}
