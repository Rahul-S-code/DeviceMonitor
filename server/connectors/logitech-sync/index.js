// Logitech Sync connector.
//
// Built from Logitech's official Sync Cloud API OpenAPI definition (v0.1.4),
// downloadable from Sync Portal > Settings > Sync Cloud API, and the guide:
//   https://hub.sync.logitech.com/syncguides/post/1-8-getting-started---api-quick-start-guide-QOU16rRoLmzBP9F
//
// Server:  https://api.sync.logitech.com/v1  (use the "API Server" value shown in your Sync portal)
// Auth:    mutual TLS with the client certificate + private key generated in Sync. No auth header.
// Data:    GET /org/{orgId}/place?projection=...&limit=...&continuation=...
//          -> { places: [Room|Desk], continuation? }
// Limits:  14,400 requests/day, 1 req/s sustained, 10 req/s burst; 429 on throttle.
//
// The API has no meeting-platform field, so platform comes from the room
// directory or from other devices in the same room (see services/inventory.js).

import https from 'node:https';
import { BaseConnector } from '../base.js';
import { makeDevice, classifyDeviceType, splitPath } from '../../lib/device-model.js';
import { LogitechSyncMockTransport } from './mock.js';

export const LOGI_DEFAULT_BASE = 'https://api.sync.logitech.com/v1';
export const PROJECTION = 'place.info,place.device,place.device.info,place.device.status';
const KNOWN_REGIONS = ['AMER', 'EMEA', 'APAC', 'LATAM', 'NA', 'EU', 'UK', 'MEA', 'ANZ', 'INDIA'];

/** Live transport: HTTPS GET with mTLS client certificate. */
export class LogitechSyncHttpTransport {
  constructor({ baseUrl, certPem, keyPem, caPem, requestImpl = https.request }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), certPem, keyPem, caPem, requestImpl });
  }

  get(path, query = {}, attempt = 0) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return new Promise((resolve, reject) => {
      const req = this.requestImpl(url, {
        method: 'GET',
        cert: this.certPem,
        key: this.keyPem,
        ...(this.caPem ? { ca: this.caPem } : {}),
        headers: { accept: 'application/json' },
        timeout: 30_000,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 429 && attempt < 3) {
            const wait = Math.min(Number(res.headers['retry-after'] || 2 ** attempt) * 1000, 30_000);
            setTimeout(() => this.get(path, query, attempt + 1).then(resolve, reject), wait);
            return;
          }
          if (res.statusCode === 403) return reject(new Error('Logitech Sync returned 403: the org is not licensed for the API, or the certificate is expired or deactivated.'));
          if (res.statusCode === 400) return reject(new Error('Logitech Sync returned 400: check the Org ID.'));
          if (res.statusCode !== 200) return reject(new Error(`Logitech Sync API error (HTTP ${res.statusCode})`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Logitech Sync returned invalid JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Logitech Sync request timed out')));
      req.on('error', reject);
      req.end();
    });
  }
}

export class LogitechSyncConnector extends BaseConnector {
  static oem = 'logitech-sync';
  static displayName = 'Logitech Sync';
  static make = 'Logitech';
  static nativeHealth = true;
  static docsUrl = 'https://hub.sync.logitech.com/syncguides/post/1-8-getting-started---api-quick-start-guide-QOU16rRoLmzBP9F';
  static settingFields = [
    { key: 'orgId', label: 'Organization ID', required: true, help: 'Sync Portal > Settings > Sync Cloud API' },
    { key: 'baseUrl', label: 'API server', default: LOGI_DEFAULT_BASE, help: 'The API Server value shown in your Sync portal' },
    { key: 'includeDesks', label: 'Include desks (true/false)', default: 'false' },
  ];
  static credentialFields = [
    { key: 'certPem', label: 'Client certificate (PEM)', multiline: true, required: true, help: 'certificate.pem generated in Sync' },
    { key: 'keyPem', label: 'Private key (PEM)', multiline: true, required: true, help: 'privateKey.pem generated in Sync' },
    { key: 'caPem', label: 'CA bundle (PEM, optional)', multiline: true },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      const s = this.connection.settings || {};
      this.transport = this.isLive
        ? new LogitechSyncHttpTransport({
          baseUrl: s.baseUrl || LOGI_DEFAULT_BASE,
          certPem: this.credentials.certPem,
          keyPem: this.credentials.keyPem,
          caPem: this.credentials.caPem,
        })
        : new LogitechSyncMockTransport(this.connection.customerId);
    }
  }

  get orgId() {
    return this.connection.settings?.orgId || (this.isLive ? null : `mock-org-${this.connection.customerId}`);
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    // Smallest possible call: one place, id only.
    const res = await this.transport.get(`/org/${encodeURIComponent(this.orgId)}/place`, { limit: 1, projection: '' });
    return { ok: true, message: `Connected to Sync org ${this.orgId}. ${res.places?.length ? 'Places found.' : 'No licensed places returned yet.'}` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const desks = String(this.connection.settings?.includeDesks) === 'true';
    const places = [];
    let continuation;
    let guard = 0;
    do {
      const res = await this.transport.get(`/org/${encodeURIComponent(this.orgId)}/place`, {
        projection: PROJECTION, limit: 1000, rooms: true, desks, continuation,
      });
      places.push(...(res.places ?? []));
      continuation = res.continuation;
    } while (continuation && ++guard < 200);
    return places;
  }

  mapDevices(places, now = Date.now()) {
    const C = this.constructor;
    const out = [];
    for (const p of places) {
      const group = splitPath(p.group);
      const loc = splitPath(p.location);
      const site = group.length ? group[group.length - 1] : (loc[0] || 'Unassigned site');
      const region = group.length && KNOWN_REGIONS.includes(group[0].toUpperCase()) ? group[0].toUpperCase() : 'Unassigned';
      for (const d of p.devices ?? []) {
        const { health, reason } = mapHealth(d);
        const isGeneric = d.type === 'Generic';
        const genericMake = isGeneric ? guessMake(d.name) : null;
        out.push(makeDevice({
          id: `${C.oem}:${d.id}`,
          customerId: this.connection.customerId,
          region,
          site,
          room: p.name || 'Unassigned room',
          deviceType: classifyDeviceType(d.name, d.type),
          make: d.type === 'Computer' ? 'PC' : (genericMake || C.make),
          model: d.type === 'Computer' ? 'Room PC (Logi Sync app)' : (d.name || 'Unknown'),
          hostName: d.type === 'Computer' ? d.name : (d.network?.hostName || null),
          serial: d.serial || null,
          firmware: d.version || null,
          health,
          healthReason: reason,
          // Sync's lastSeen is the last disconnection event; a device that is
          // online now was last seen at sync time.
          lastSeen: d.status === 'Offline' ? (d.lastSeen ? new Date(d.lastSeen).toISOString() : null) : new Date(now).toISOString(),
          inUse: d.status === 'InUse',
          platform: 'Unassigned',
          platformSource: null,
          mac: d.network?.mac || null,
          ip: d.network?.ip || null,
          sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: d.id }],
          weakIdentity: isGeneric, // generic peripherals have no serial; dedupe matches them by room + model
        }));
      }
    }
    return out;
  }
}

function mapHealth(d) {
  if (d.status === 'Offline') return { health: 'offline', reason: 'Lost connection to Logitech Sync or unplugged' };
  const missing = peripheralGaps(d.peripherals);
  if (d.healthStatus === 'Error') return { health: 'critical', reason: missing || 'Logitech Sync reports an error' };
  if (d.healthStatus === 'Warning') return { health: 'warning', reason: missing || 'Logitech Sync reports a warning' };
  return { health: 'healthy', reason: null };
}

const PERIPHERAL_NAMES = { camera: 'Camera', speaker: 'Speaker', displayHub: 'Display Hub', tableHub: 'Table Hub', micPod: 'Mic Pod', micPodHub: 'Mic Pod Hub' };
function peripheralGaps(peripherals) {
  if (!peripherals) return null;
  const gaps = Object.entries(peripherals)
    .filter(([, v]) => v?.count && v.count.actual < v.count.expected)
    .map(([k, v]) => `${PERIPHERAL_NAMES[k] || k}: ${v.count.actual} of ${v.count.expected} connected`);
  return gaps.length ? gaps.join('; ') : null;
}

function guessMake(name = '') {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase();
  const map = { poly: 'Poly', polycom: 'Poly', jabra: 'Jabra', yealink: 'Yealink', cisco: 'Cisco', lenovo: 'Lenovo', microsoft: 'Microsoft', huddly: 'Huddly', neat: 'Neat', samsung: 'Samsung', lg: 'LG', sony: 'Sony' };
  return map[first] || 'Third-party';
}
