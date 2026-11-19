// Poly Lens connector (HP Poly).
//
// Built from the official Poly Lens API documentation:
//   https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/how-to-get-started
//   https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/getting-started
//   https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/Example%20Queries/inventory-reporting
//
// Auth:    POST https://login.silica-prod01.io.lens.poly.com/oauth/token
//          {client_id, client_secret, grant_type:"client_credentials"} -> access_token
// API:     POST https://api.silica-prod01.io.lens.poly.com/graphql
//          header  authorization: Bearer <access_token>
// Data:    tenants { id name }  then  tenant(id){ inventory { deviceSearch(params) } }
//          paginated with params.nextToken / pageInfo.nextToken (pageSize 1-5000).
//
// Poly Lens reports `connected` but no warning/critical health, so devices are
// healthy or offline here; the inventory service adds a "firmware behind fleet"
// warning for connectors that do not report native health.

import { BaseConnector } from '../base.js';
import { issue, classifyFault } from '../../lib/issues.js';
import { trackedFetch } from '../../lib/api-calls.js';
import { makeDevice, classifyDeviceType, normalisePlatform } from '../../lib/device-model.js';
import { PolyLensMockTransport } from './mock.js';

export const POLY_DEFAULTS = {
  authUrl: 'https://login.silica-prod01.io.lens.poly.com/oauth/token',
  apiUrl: 'https://api.silica-prod01.io.lens.poly.com/graphql',
};

export const TENANTS_QUERY = `query TenantsICanAccess {
  tenants { id name }
}`;

export const INVENTORY_QUERY = `query Inventory($params: DeviceFindArgs, $tenantId: ID!) {
  tenant(id: $tenantId) {
    id
    name
    inventory {
      deviceSearch(params: $params) {
        edges {
          node {
            id
            name
            connected
            lastDetected
            hardwareModel
            softwareVersion
            serialNumber
            internalIp
            activeApplicationName
            activeApplicationVersion
            site { id name }
            room { id name }
          }
        }
        pageInfo { hasNextPage totalCount countOnPage nextToken }
      }
    }
  }
}`;

/** Builds an auth error that carries Poly's own reason (OAuth error / error_description). */
export function polyAuthError(status, body = {}, text = '', authUrl = '') {
  const code = body.error || body.code || '';
  const reason = body.error_description || body.message || body.detail || (!code && text && !/^\s*</.test(text) ? text.slice(0, 200) : '');
  const said = [code, reason].filter(Boolean).join(': ');
  let fix;
  if (status === 400 && /invalid_client|unauthorized_client/i.test(code)) fix = 'The client ID is not recognised or this credential is not allowed to use client credentials. Copy the client ID again from Poly Lens > Integrations > API Credentials.';
  else if (status === 400 && /invalid_grant|invalid_request/i.test(code)) fix = 'Poly rejected the request. Re-enter the client ID and secret with no spaces or line breaks.';
  else if (status === 400) fix = 'Poly rejected the request. Check that the Token URL is exactly https://login.silica-prod01.io.lens.poly.com/oauth/token, then re-enter the client ID and secret.';
  else if (status === 401 || status === 403) fix = 'The client ID or secret is wrong, or the credential was deleted. Create a new API credential in Poly Lens and paste both values again.';
  else if (status === 404) fix = `Nothing answers at ${authUrl}. Reset the Token URL to the default.`;
  else if (status === 429) fix = 'Too many token requests. Wait a minute and try again.';
  else fix = 'Poly Lens may be having problems. Try again shortly.';
  return `Poly Lens auth failed (HTTP ${status}${said ? `, Poly says "${said}"` : ''}). ${fix}`;
}

/** Poly documents { access_token, token_type, expires_in }; accept common variants too. */
export function tokenFrom(body) {
  if (!body || typeof body !== 'object') return null;
  for (const b of [body, body.data, body.result]) {
    const t = b && (b.access_token || b.accessToken || b.token);
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return null;
}

/** Explains a 2xx token reply with no token, without echoing any secret values. */
export function polyNoTokenError(res, body, text, authUrl) {
  const ct = (res.headers?.get?.('content-type') || '').split(';')[0].trim() || 'unknown';
  const isHtml = /html/i.test(ct) || /^\s*</.test(text || '');
  const keys = body && typeof body === 'object' ? Object.keys(body).slice(0, 10) : [];
  const said = body?.error_description || body?.error || body?.message;
  let what;
  if (isHtml) what = 'it returned a web page, not a token. The Token URL is pointing at a sign-in or web page instead of the token endpoint';
  else if (!text) what = 'the reply was empty';
  else if (keys.length) what = `the reply had the fields ${keys.join(', ')}${said ? ` and said "${String(said).slice(0, 160)}"` : ''}`;
  else what = 'the reply was not JSON';
  return `Poly Lens did not return an access token from ${authUrl} (HTTP ${res.status}, ${ct}): ${what}. Clear the Token URL field so it uses the default https://login.silica-prod01.io.lens.poly.com/oauth/token, save, and test again.`;
}

/** A setting that must be an https URL; anything else falls back to the default. */
export function safeUrl(value, fallback) {
  try { const u = new URL(String(value || '').trim()); return u.protocol === 'https:' ? u.toString().replace(/\/$/, '') : fallback; } catch { return fallback; }
}

/** Live HTTP transport: OAuth client-credentials + GraphQL over fetch. */
export class PolyLensHttpTransport {
  constructor({ clientId, clientSecret, authUrl, apiUrl, fetchImpl = trackedFetch }) {
    Object.assign(this, { clientId, clientSecret, authUrl, apiUrl, fetchImpl });
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const clientId = String(this.clientId || '').trim();
    const clientSecret = String(this.clientSecret || '').trim();
    if (!clientId || !clientSecret) throw new Error('Poly Lens auth needs both a client ID and a client secret.');
    // Exactly the request in Poly's "How to get started" guide: JSON body, no audience or scope.
    let res;
    try {
      res = await this.fetchImpl(this.authUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      });
    } catch (e) {
      throw new Error(`Could not reach the Poly Lens token URL (${this.authUrl}): ${e.message}`);
    }
    const text = await res.text().catch(() => '');
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) throw new Error(polyAuthError(res.status, body, text, this.authUrl));
    const token = tokenFrom(body);
    if (!token) throw new Error(polyNoTokenError(res, body, text, this.authUrl));
    this.token = token;
    body.expires_in = body.expires_in ?? body.expiresIn ?? body.data?.expires_in;
    this.tokenExpires = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async graphql(query, variables = {}) {
    const token = await this.getToken();
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) throw new Error('Poly Lens rate limit reached (query cost budget). Will retry next sync.');
    if (!res.ok) throw new Error(`Poly Lens API error (HTTP ${res.status})`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`Poly Lens GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  }
}

export class PolyLensConnector extends BaseConnector {
  static oem = 'poly-lens';
  static displayName = 'Poly Lens';
  static short = 'PL';
  static guide = {
    summary: "Poly Lens is HP Poly's device cloud for Studio video bars, G7500, TC8/TC10 controllers, Trio and CCX phones.",
    needs: [
      "A Poly Lens tenant admin account",
      "An API credential (client ID and secret) from Integrations > API Credentials"
    ],
    health: "Poly Lens reports connected or disconnected. Firmware older than the newest in your estate (or the approved baseline) shows amber.",
    location: "Poly Lens sites become sites and rooms become rooms. The meeting platform comes from the device's active application."
  };
  static setupSteps = ["Sign in to Poly Lens as a tenant admin.", "Open Integrations › API Credentials and create a new credential.", "Copy the client ID and client secret (the secret is shown once).", "Paste them below, press Test connection, then switch to Live and save."];
  static make = 'Poly';
  static nativeHealth = false;
  static docsUrl = 'https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/how-to-get-started';
  static apis = [
    { id: 'poly-lens-auth', name: 'Poly Lens token', method: 'POST', url: POLY_DEFAULTS.authUrl, purpose: 'Gets an access token (OAuth client credentials)', auth: 'Client ID and secret' },
    { id: 'poly-lens-graphql', name: 'Poly Lens GraphQL', method: 'POST', url: POLY_DEFAULTS.apiUrl, purpose: 'Tenants, sites, rooms, devices, firmware and connection state', auth: 'Bearer token' },
  ];
  static actions = [
    {
      id: 'reboot', label: 'Reboot device', target: 'device',
      description: 'Restarts the device. A call in progress drops, and the device is back in a few minutes.',
      confirm: 'Reboot this device now?',
      api: { set: 'OEM', name: 'Poly Lens GraphQL API', method: 'POST', endpoint: 'GraphQL mutation rebootDevice(deviceId)' },
      scope: 'A Poly Lens API client allowed to control devices',
    },
  ];

  static settingFields = [
    { key: 'tenantId', label: 'Tenant ID', placeholder: 'Leave blank to sync every tenant the API client can access', help: 'Optional. Found in Poly Lens under Account > Tenant.' },
    { key: 'authUrl', label: 'Token URL', default: POLY_DEFAULTS.authUrl },
    { key: 'apiUrl', label: 'GraphQL URL', default: POLY_DEFAULTS.apiUrl },
  ];
  static credentialFields = [
    { key: 'clientId', label: 'Client ID', required: true, help: 'Poly Lens > Integrations > API Credentials' },
    { key: 'clientSecret', label: 'Client secret', required: true },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      const s = this.connection.settings || {};
      this.transport = this.isLive
        ? new PolyLensHttpTransport({
          clientId: this.credentials.clientId,
          clientSecret: this.credentials.clientSecret,
          authUrl: safeUrl(s.authUrl, POLY_DEFAULTS.authUrl),
          apiUrl: safeUrl(s.apiUrl, POLY_DEFAULTS.apiUrl),
        })
        : new PolyLensMockTransport(this.connection.customerId);
    }
  }

  async performAction(action, source) {
    if (action.id !== 'reboot') throw new Error('Unknown action');
    const data = await this.transport.graphql('mutation reboot($deviceId: String!) { rebootDevice(deviceId: $deviceId) { error success } }', { deviceId: source.sourceId });
    const r = data?.rebootDevice;
    if (!r?.success) throw new Error(`Poly Lens did not reboot the device${r?.error ? `: ${r.error}` : ''}`);
    return { ok: true, message: 'Poly Lens accepted the reboot. The device will be back in a few minutes.' };
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const data = await this.transport.graphql(TENANTS_QUERY);
    const tenants = data?.tenants ?? [];
    const wanted = this.connection.settings?.tenantId;
    if (wanted && !tenants.some((t) => t.id === wanted)) {
      return { ok: false, message: `Credentials work, but tenant ${wanted} is not visible to this API client.` };
    }
    return { ok: true, message: `Connected. ${tenants.length} tenant(s) visible: ${tenants.map((t) => t.name || t.id).join(', ')}` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    let tenantIds = this.connection.settings?.tenantId ? [this.connection.settings.tenantId] : null;
    if (!tenantIds) tenantIds = ((await this.transport.graphql(TENANTS_QUERY))?.tenants ?? []).map((t) => t.id);
    const nodes = [];
    for (const tenantId of tenantIds) {
      let nextToken = null;
      let guard = 0;
      do {
        const data = await this.transport.graphql(INVENTORY_QUERY, { tenantId, params: { pageSize: 200, nextToken } });
        const search = data?.tenant?.inventory?.deviceSearch;
        for (const e of search?.edges ?? []) nodes.push({ ...e.node, _tenantId: tenantId });
        nextToken = search?.pageInfo?.nextToken ?? null;
      } while (nextToken && ++guard < 500);
    }
    return nodes;
  }

  mapDevices(nodes) {
    const C = this.constructor;
    return nodes.map((n) => makeDevice({
      id: `${C.oem}:${n.id}`,
      customerId: this.connection.customerId,
      site: n.site?.name || 'Unassigned site',
      room: n.room?.name || 'Unassigned room',
      deviceType: classifyDeviceType(n.hardwareModel),
      make: C.make,
      model: n.hardwareModel || n.name || 'Unknown',
      serial: n.serialNumber || null,
      firmware: n.softwareVersion || null,
      health: n.connected ? 'healthy' : 'offline',
      healthReason: n.connected ? null : 'Disconnected from Poly Lens cloud',
      issues: n.connected ? [] : [issue('EM-NET-001', C.displayName, 'connected: false')],
      lastSeen: n.lastDetected ? new Date(n.lastDetected).toISOString() : null,
      platform: normalisePlatform(n.activeApplicationName),
      platformSource: n.activeApplicationName ? 'device' : null,
      ip: n.internalIp || null,
      sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: n.id }],
    }));
  }
}
