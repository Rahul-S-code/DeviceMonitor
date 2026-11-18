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

/** Live HTTP transport: OAuth client-credentials + GraphQL over fetch. */
export class PolyLensHttpTransport {
  constructor({ clientId, clientSecret, authUrl, apiUrl, fetchImpl = fetch }) {
    Object.assign(this, { clientId, clientSecret, authUrl, apiUrl, fetchImpl });
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const res = await this.fetchImpl(this.authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`Poly Lens auth failed (HTTP ${res.status}). Check the client ID and secret.`);
    const body = await res.json();
    this.token = body.access_token;
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
  static make = 'Poly';
  static nativeHealth = false;
  static docsUrl = 'https://lensapidocsdev.z19.web.core.windows.net/docs/graphql/how-to-get-started';
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
          authUrl: s.authUrl || POLY_DEFAULTS.authUrl,
          apiUrl: s.apiUrl || POLY_DEFAULTS.apiUrl,
        })
        : new PolyLensMockTransport(this.connection.customerId);
    }
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
      lastSeen: n.lastDetected ? new Date(n.lastDetected).toISOString() : null,
      platform: normalisePlatform(n.activeApplicationName),
      platformSource: n.activeApplicationName ? 'device' : null,
      ip: n.internalIp || null,
      sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: n.id }],
    }));
  }
}
