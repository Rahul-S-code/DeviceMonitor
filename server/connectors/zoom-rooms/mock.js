// Mock transport answering the same Zoom Rooms API paths, in the same shape.
import { platformRooms, simulatedState, hash } from '../../mock/estate.js';

export class ZoomRoomsMockTransport {
  constructor(customerId, { now = () => Date.now() } = {}) {
    this.customerId = customerId;
    this.now = now;
  }

  data() {
    const t = this.now();
    const locations = new Map();
    const rooms = platformRooms(this.customerId, 'Zoom').map(({ room, device, make, model }) => {
      const locId = `loc-${room.site}`.replace(/\s+/g, '').toLowerCase();
      locations.set(locId, { id: locId, name: room.site, parent_location_id: null, type: 'building' });
      const offline = simulatedState(device.key, t).state === 'offline';
      const id = `zr-${room.id}`.slice(0, 40);
      return {
        id, room_id: id, name: room.room, activation_code: '', location_id: locId, tag_ids: [],
        status: offline ? 'Offline' : hash(room.id + Math.floor(t / 300_000)) < 0.25 ? 'InMeeting' : 'Available',
        _devices: [{
          id: `zd-${device.key.replace(/[^a-z0-9]/gi, '').slice(-24)}`,
          room_name: room.room,
          device_type: device.kind === 'Computer' ? 'Zoom Rooms Computer' : 'Zoom Rooms Appliance',
          app_version: '6.3.5 (5880)',
          device_system: device.kind === 'Computer' ? 'Win 11' : 'Android 10',
          status: offline ? 'Offline' : 'Online',
          device_mac_addresses: device.mac ? [device.mac] : [],
          device_hostname: `ZR-${room.room.replace(/[^a-z0-9]/gi, '').toUpperCase()}`,
          device_manufacturer: make,
          device_model: model,
          device_firmware: device.firmware,
          ip_address: device.ip,
          serial_number: device.serial,
        }],
      };
    });
    return { rooms, locations: [...locations.values()] };
  }

  async get(path, query = {}) {
    const { rooms, locations } = this.data();
    if (path === '/rooms') {
      const size = Math.min(Number(query.page_size) || 30, 300);
      const start = Number(query.next_page_token || 0);
      const page = rooms.slice(start, start + size).map(({ _devices, ...r }) => r);
      return { page_size: size, rooms: page, next_page_token: start + size < rooms.length ? String(start + size) : '' };
    }
    if (path === '/rooms/locations') return { locations, next_page_token: '' };
    const m = path.match(/^\/rooms\/([^/]+)\/devices$/);
    if (m) return { devices: rooms.find((r) => r.id === decodeURIComponent(m[1]))?._devices ?? [] };
    throw new Error(`Mock Zoom: unsupported path ${path}`);
  }
}
