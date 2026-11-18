// Zoom Rooms connector (meeting-platform side).
//
// Built from the official Zoom Rooms API reference:
//   https://developers.zoom.us/docs/api/rooms/
//   https://developers.zoom.us/docs/internal-apps/s2s-oauth/
//
// Auth:    Server-to-Server OAuth app.
//          POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id={accountId}
//          header Authorization: Basic base64(clientId:clientSecret) -> access_token
// API:     https://api.zoom.us/v2, header Authorization: Bearer <token>
// Data:    GET /rooms?page_size=300&next_page_token=...
//            -> { rooms: [{ id, room_id, name, location_id, status: Offline|Available|InMeeting|UnderConstruction }], next_page_token }
//          GET /rooms/{id}/devices
//            -> { devices: [{ id, room_name, device_type, app_version, device_system, status,
//                             device_mac_addresses[], device_hostname, device_manufacturer,
//                             device_model, device_firmware, ip_address, serial_number }] }
//          GET /rooms/locations (best effort) -> building names for the site.
// Scopes:  room:read:admin (and zoom_rooms:read:list_rooms:admin / ...:list_devices:admin on granular apps).
//
// Zoom reports online/offline only, so health is healthy or offline here.

import { BaseConnector } from '../base.js';
import { trackedFetch } from '../../lib/api-calls.js';
import { makeDevice, classifyDeviceType } from '../../lib/device-model.js';
import { ZoomRoomsMockTransport } from './mock.js';

export const ZOOM_DEFAULTS = { authUrl: 'https://zoom.us/oauth/token', apiUrl: 'https://api.zoom.us/v2' };

export class ZoomHttpTransport {
  constructor({ accountId, clientId, clientSecret, authUrl, apiUrl, fetchImpl = trackedFetch }) {
    Object.assign(this, { accountId, clientId, clientSecret, authUrl, apiUrl: apiUrl.replace(/\/$/, ''), fetchImpl });
    this.token = null;
    this.tokenExpires = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    const url = `${this.authUrl}?grant_type=account_credentials&account_id=${encodeURIComponent(this.accountId)}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}` },
    });
    if (!res.ok) throw new Error(`Zoom auth failed (HTTP ${res.status}). Check the account ID, client ID and secret.`);
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpires = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async get(path, query = {}) {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.getToken()}`, accept: 'application/json' } });
    if (res.status === 429) throw new Error('Zoom rate limit reached. Will retry next sync.');
    if (res.status === 401 || res.status === 403) throw new Error(`Zoom returned ${res.status}: the app needs the room:read:admin scope.`);
    if (!res.ok) throw new Error(`Zoom API error (HTTP ${res.status})`);
    return res.json();
  }
}

export class ZoomRoomsConnector extends BaseConnector {
  static oem = 'zoom-rooms';
  static displayName = 'Zoom Rooms';
  static make = 'Zoom';
  static kind = 'platform';
  static platform = 'Zoom';
  static nativeHealth = false;
  static docsUrl = 'https://developers.zoom.us/docs/api/rooms/';
  static apis = [
    { id: 'zoom-auth', name: 'Zoom OAuth token', method: 'POST', url: ZOOM_DEFAULTS.authUrl, purpose: 'Gets an access token (Server-to-Server OAuth)', auth: 'Account ID, client ID and secret' },
    { id: 'zoom-rooms-list', name: 'List Zoom Rooms', method: 'GET', url: `${ZOOM_DEFAULTS.apiUrl}/rooms`, purpose: 'Rooms and their online status', auth: 'Bearer token (room:read:admin)' },
    { id: 'zoom-room-devices', name: 'List Zoom Room devices', method: 'GET', url: `${ZOOM_DEFAULTS.apiUrl}/rooms/{roomId}/devices`, probe: `${ZOOM_DEFAULTS.apiUrl}/rooms/0/devices`, purpose: 'Devices in each room, with app version and status', auth: 'Bearer token (room:read:admin)' },
    { id: 'zoom-room-locations', name: 'List Zoom Room locations', method: 'GET', url: `${ZOOM_DEFAULTS.apiUrl}/rooms/locations`, purpose: 'Location names for sites (optional)', auth: 'Bearer token' },
  ];
  static setupSteps = [
    'In the Zoom App Marketplace, choose Develop › Build App › Server-to-Server OAuth.',
    'Add the scope room:read:admin (List Zoom Rooms and List Zoom Room devices) and activate the app.',
    'Copy the Account ID, Client ID and Client secret from App Credentials.',
    'Paste them below, press Test connection, then switch to Live and save.',
  ];
  static settingFields = [
    { key: 'accountId', label: 'Account ID', required: true, help: 'App Credentials page of the Server-to-Server OAuth app' },
    { key: 'apiUrl', label: 'API base URL', default: ZOOM_DEFAULTS.apiUrl },
  ];
  static credentialFields = [
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client secret', required: true },
  ];

  constructor(opts) {
    super(opts);
    if (!this.transport) {
      const s = this.connection.settings || {};
      this.transport = this.isLive
        ? new ZoomHttpTransport({ accountId: s.accountId, clientId: this.credentials.clientId, clientSecret: this.credentials.clientSecret, authUrl: ZOOM_DEFAULTS.authUrl, apiUrl: s.apiUrl || ZOOM_DEFAULTS.apiUrl })
        : new ZoomRoomsMockTransport(this.connection.customerId);
    }
  }

  async testConnection() {
    if (this.isLive) this.assertLiveConfig();
    const res = await this.transport.get('/rooms', { page_size: 1 });
    return { ok: true, message: `Connected to Zoom. ${res.rooms?.length ? 'Zoom Rooms found.' : 'No Zoom Rooms returned yet.'}` };
  }

  async fetchRaw() {
    if (this.isLive) this.assertLiveConfig();
    const rooms = [];
    let token = null;
    let guard = 0;
    do {
      const res = await this.transport.get('/rooms', { page_size: 300, next_page_token: token });
      rooms.push(...(res.rooms ?? []));
      token = res.next_page_token || null;
    } while (token && ++guard < 100);
    // Building names are optional; a missing locations scope must not break the sync.
    const locations = new Map();
    try {
      let lt = null; let g = 0;
      do {
        const res = await this.transport.get('/rooms/locations', { page_size: 300, next_page_token: lt });
        for (const l of res.locations ?? []) locations.set(l.id, l);
        lt = res.next_page_token || null;
      } while (lt && ++g < 50);
    } catch { /* site falls back to "Unassigned site" */ }
    for (const r of rooms) r._devices = (await this.transport.get(`/rooms/${encodeURIComponent(r.id)}/devices`)).devices ?? [];
    return { rooms, locations: [...locations.values()] };
  }

  mapDevices({ rooms, locations = [] }) {
    const C = this.constructor;
    const locById = new Map(locations.map((l) => [l.id, l]));
    const siteFor = (id) => {
      // Walk up the location tree to the building (or campus) level.
      let l = locById.get(id); let guard = 0;
      while (l && !['building', 'campus'].includes(String(l.type).toLowerCase()) && l.parent_location_id && guard++ < 6) l = locById.get(l.parent_location_id);
      return l?.name || null;
    };
    const out = [];
    for (const r of rooms) {
      for (const d of r._devices ?? []) {
        const offline = String(d.status).toLowerCase() === 'offline';
        const make = d.device_manufacturer || 'Unknown';
        const model = d.device_model || d.device_type || 'Zoom Rooms device';
        out.push(makeDevice({
          id: `${C.oem}:${d.id}`,
          customerId: this.connection.customerId,
          site: siteFor(r.location_id) || 'Unassigned site',
          room: r.name || d.room_name || 'Unassigned room',
          deviceType: /computer/i.test(d.device_type || '') ? 'Room PC' : classifyDeviceType(model),
          make,
          model,
          serial: d.serial_number || null,
          firmware: d.device_firmware || d.app_version || null,
          health: offline ? 'offline' : 'healthy',
          healthReason: offline ? `Zoom reports the ${d.device_type || 'device'} offline` : null,
          lastSeen: offline ? null : new Date().toISOString(),
          platform: C.platform,
          platformSource: 'device',
          hostName: d.device_hostname || null,
          mac: d.device_mac_addresses?.[0] || null,
          ip: d.ip_address || null,
          inUse: r.status === 'InMeeting',
          sources: [{ oem: C.oem, connectionId: this.connection.id, sourceId: d.id }],
        }));
      }
    }
    return out;
  }
}
