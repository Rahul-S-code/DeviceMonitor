// BrightSign BSN.cloud connector (digital signage players).
//
// Built from BrightSign's developer documentation:
//   Authentication  https://docs.brightsign.biz/develop/authentication
//   Main API 2022/06 https://docs.brightsign.biz/develop/main-api-version-202206
//
// Auth:    POST https://auth.bsn.cloud/realms/bsncloud/protocol/openid-connect/token
//          Authorization: Basic base64(client_id:client_secret), body grant_type=client_credentials
//          -> { access_token, expires_in }. Then select the network:
//          PUT https://api.bsn.cloud/2022/06/REST/Self/Session/Network  { "name": "<network>" }
// Data:    GET https://api.bsn.cloud/2022/06/REST/Devices/?pageSize=100&marker=...
//            -> { items: [{ id, serial, model, family, settings: { name, description, group },
//                 status: { health, lastModifiedDate, firmware/software version, group } }], nextMarker, isTruncated }
// A player that has not checked in for longer than the stale limit (default 30
// minutes) counts as offline, since BSN.cloud keeps the last status it saw.
import { BaseConnector } from '../base.js';
import { issue } from '../../lib/issues.js';
import { makeDevice } from '../../lib/device-model.js';
import { requestJson, TokenCache, basic, pick, listOf } from '../http.js';
import { BrightSignMockTransport } from './mock.js';

export const BSN = { authUrl: 'https://auth.bsn.cloud/realms/bsncloud/protocol/openid-connect/token', apiUrl: 'https://api.bsn.cloud/2022/06/REST' };
const V = 'BrightSign BSN.cloud';

export class BrightSignHttpTransport {
  constructor({ clientId, clientSecret, network, apiUrl = BSN.apiUrl, authUrl = BSN.authUrl, fetchImpl }) {
    Object.assign(this, { apiUrl: apiUrl.replace(/\/$/, ''), network, fetchImpl });
    this.networkSet = false;
    this.tokens = new TokenCache(async () => {
      const b = await requestJson(authUrl, { method: 'POST', form: true, body: { grant_type: 'client_credentials' }, headers: { authorization: basic(clientId, clientSecret) }, vendor: V, fetchImpl, hint401: 'check the client ID and secret of the BSN.cloud API application.' });
      this.networkSet = false;
      return { token: b.access_token, expiresIn: b.expires_in };
    });
  }

  async call(method, path, body) {
    const headers = { authorization: `Bearer ${await this.tokens.get()}` };
    if (!this.networkSet && this.network) {
      await requestJson(`${this.apiUrl}/Self/Session/Network`, { method: 'PUT', body: { name: this.network }, headers, vendor: V, fetchImpl: this.fetchImpl, hint403: `the API application has no access to the network "${this.network}".` });
      this.networkSet = true;
    }
    return requestJson(this.apiUrl + path, { method, body, headers, vendor: V, fetchImpl: this.fetchImpl });
  }
  get(path) { return this.call('GET', path); }
}

export class BrightSignBsnConnector extends BaseConnector {
  static oem = 'brightsign-bsn';
  static short = 'BS';
  static displayName = 'BrightSign BSN.cloud';
  static make = 'BrightSign';
  static nativeHealth = true;
  static docsUrl = 'https://docs.brightsign.biz/develop/authentication';
  static actionsNote = 'Reboots go through BrightSign\'s remote diagnostic web server (rDWS), which is not wired in yet. Reboot players from BSN.cloud.';
  static guide = {
    summary: 'BSN.cloud manages BrightSign signage players: room-booking screens, wayfinding and lobby displays.',
    needs: ['A BSN.cloud network', 'A BSN.cloud API application (client ID and secret) with access to that network'],
    health: 'A player BSN.cloud reports as normal and that checked in recently is healthy. Warning and error health show amber and red. A player silent for longer than the stale limit is offline.',
    location: 'The player\'s group becomes the site and the player name becomes the room, unless the player description is "Site / Room".',
  };
  static apis = [
    { id: 'bsn-token', name: 'BSN.cloud token', method: 'POST', url: BSN.authUrl, purpose: 'Gets an access token (client credentials)', auth: 'Client ID and secret' },
    { id: 'bsn-network', name: 'BSN.cloud select network', method: 'PUT', url: `${BSN.apiUrl}/Self/Session/Network`, purpose: 'Chooses which BSN.cloud network to read', auth: 'Bearer token' },
    { id: 'bsn-devices', name: 'BSN.cloud devices', method: 'GET', url: `${BSN.apiUrl}/Devices/`, purpose: 'Players with health, model, serial and firmware', auth: 'Bearer token' },
  ];
  static setupSteps = [
    'Ask BrightSign (or your BSN.cloud admin) for an API application, and note its client ID and secret.',
    'Give the application access to your BSN.cloud network and note the network name.',
    'Paste them below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [
    { key: 'network', label: 'BSN.cloud network name', required: true },
    { key: 'staleMinutes', label: 'Offline after (minutes without a check-in)', default: '30' },
  ];
  static credentialFields = [
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client secret', required: true },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) this.transport = this.isLive ? new BrightSignHttpTransport({ ...this.credentials, network: this.connection.settings?.network }) : new BrightSignMockTransport(this.connection.customerId);
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const page = await this.transport.get('/Devices/?pageSize=1');
    return { ok: true, message: `Connected to BSN.cloud network ${this.connection.settings?.network || '(demo)'}. ${listOf(page).length ? 'Players found.' : 'No players yet.'}` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const out = [];
    let marker = null;
    for (let guard = 0; guard < 200; guard++) {
      const page = await this.transport.get(`/Devices/?pageSize=100${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`);
      out.push(...listOf(page));
      if (!page.isTruncated || !page.nextMarker) break;
      marker = page.nextMarker;
    }
    return out;
  }

  mapDevices(players = [], now = Date.now()) {
    const C = this.constructor;
    const staleMs = (Number(this.connection.settings?.staleMinutes) || 30) * 60_000;
    return players.map((p) => {
      const s = p.status || {};
      const name = String(pick(p.settings?.name, p.name, p.serial, 'Player'));
      const desc = String(pick(p.settings?.description, p.description, ''));
      const [dSite, dRoom] = desc.includes('/') ? desc.split('/').map((x) => x.trim()) : [];
      const seen = pick(s.lastModifiedDate, p.lastModifiedDate);
      const stale = !seen || now - Date.parse(seen) > staleMs;
      const h = String(pick(s.health, p.health, 'Normal')).toLowerCase();
      const health = stale ? 'offline' : /error|critical/.test(h) ? 'critical' : /warn/.test(h) ? 'warning' : 'healthy';
      return makeDevice({
        id: `${C.oem}:${p.id ?? p.serial}`,
        customerId: this.connection.customerId,
        site: pick(dSite, s.group?.name, p.settings?.group?.name, 'Unassigned site'),
        room: pick(dRoom, name),
        deviceType: 'Signage player',
        make: C.make, model: `BrightSign ${pick(p.model, 'player')}`,
        hostName: name,
        serial: p.serial || null, firmware: pick(s.firmware?.version, s.firmwareVersion, s.software?.version, p.firmware),
        mac: pick(s.network?.interfaces?.[0]?.mac, p.mac), ip: pick(s.network?.interfaces?.[0]?.ip, p.ip),
        health,
        healthReason: stale ? `No check-in with BSN.cloud for over ${Math.round(staleMs / 60_000)} minutes` : health === 'healthy' ? null : `BSN.cloud health: ${pick(s.health, p.health)}`,
        issues: stale ? [issue('EM-NET-001', V, `lastModifiedDate: ${seen || 'never'}`)] : health === 'healthy' ? [] : [issue(health === 'critical' ? 'EM-GEN-001' : 'EM-GEN-002', V, `health: ${pick(s.health, p.health)}`)],
        lastSeen: seen ? new Date(seen).toISOString() : null,
        sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: String(p.id ?? p.serial) }],
      });
    });
  }
}
