// Synthetic large estate for load tests: N devices spread over customers,
// sites and rooms, reported by OEM and platform connections with realistic
// overlap (about 1 in 10 devices is also reported by a platform portal, so
// de-duplication is exercised at scale).
import crypto from 'node:crypto';
import { makeDevice } from '../../server/lib/device-model.js';

const REGIONS = [
  ['EMEA', 'United Kingdom', 51.5, -0.12], ['EMEA', 'Germany', 50.1, 8.68], ['EMEA', 'France', 48.85, 2.35],
  ['AMER', 'United States', 40.75, -73.98], ['AMER', 'United States', 37.77, -122.42], ['AMER', 'Canada', 43.65, -79.38],
  ['APAC', 'Singapore', 1.28, 103.86], ['APAC', 'Japan', 35.68, 139.69], ['APAC', 'Australia', -33.87, 151.21],
];
const KITS = [
  [['poly-lens', 'Poly', 'Poly Studio X50', 'Video bar'], ['poly-lens', 'Poly', 'Poly TC8', 'Touch controller']],
  [['logitech-sync', 'Logitech', 'Rally Bar', 'Video bar'], ['logitech-sync', 'Logitech', 'Tap IP', 'Touch controller'], ['logitech-sync', 'Logitech', 'Sight', 'Camera']],
  [['poly-lens', 'Poly', 'Poly G7500', 'Video system'], ['poly-lens', 'Poly', 'Poly Studio E70', 'Camera'], ['poly-lens', 'Poly', 'Poly TC10', 'Touch controller'], ['poly-lens', 'Poly', 'Poly Trio C60', 'Conference phone']],
  [['logitech-sync', 'Logitech', 'Rally Bar Mini', 'Video bar'], ['logitech-sync', 'Logitech', 'Tap IP', 'Touch controller'], ['logitech-sync', 'Logitech', 'Spot', 'Room sensor']],
  [['yealink-ymcs', 'Yealink', 'MeetingBar A30', 'Video bar'], ['yealink-ymcs', 'Yealink', 'CTP18', 'Touch controller']],
];
const FW = ['4.2.0', '4.1.1', '4.0.2'];
const HEALTH = (r) => (r < 0.9 ? 'healthy' : r < 0.95 ? 'warning' : r < 0.98 ? 'offline' : 'critical');

function rand(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Build an estate of about `devices` devices.
 * Returns { customers:[{id,name,sites}], connections:[{id,customerId,oem}], snapshots: Map(connectionId -> CommonDevice[]) }.
 */
export function syntheticEstate({ devices = 50_000, customers = 100, sitesPerCustomer = 10, seed = 42, epoch = 0 } = {}) {
  const r = rand(seed);
  const perCustomer = Math.ceil(devices / customers);
  const out = { customers: [], connections: [], snapshots: new Map(), total: 0 };
  for (let c = 0; c < customers; c++) {
    const cid = `cust-load-${c}`;
    const conns = {};
    for (const oem of ['poly-lens', 'logitech-sync', 'yealink-ymcs', 'zoom-rooms']) {
      const id = `${cid}-${oem}`;
      conns[oem] = id;
      out.connections.push({ id, customerId: cid, oem });
      out.snapshots.set(id, []);
    }
    const sites = [];
    for (let s = 0; s < sitesPerCustomer; s++) {
      const [region, country, lat, lng] = REGIONS[(c + s) % REGIONS.length];
      sites.push({ name: `Site ${c}-${s}`, region, country, lat: lat + (r() - 0.5) * 4, lng: lng + (r() - 0.5) * 4 });
    }
    out.customers.push({ id: cid, name: `Load Customer ${c}`, sites });
    let made = 0;
    let room = 0;
    while (made < perCustomer && out.total < devices) {
      const site = sites[room % sites.length];
      const kit = KITS[Math.floor(r() * KITS.length)];
      const roomName = `Room ${room}`;
      for (const [oem, make, model, type] of kit) {
        if (made >= perCustomer || out.total >= devices) break;
        const serial = `${make.slice(0, 2).toUpperCase()}${c}X${room}X${made}`;
        const h = HEALTH(rand(seed + made * 7919 + c * 104729 + epoch)());
        const d = makeDevice({
          id: `${oem}:${serial}`, customerId: cid, region: site.region, site: site.name, room: roomName,
          deviceType: type, make, model, serial, firmware: FW[Math.floor(r() * FW.length)], health: h,
          healthReason: h === 'healthy' ? null : `Synthetic ${h}`, lastSeen: new Date(Date.now() - Math.floor(r() * 3_600_000)).toISOString(),
          platform: 'Microsoft Teams', platformSource: 'device', mac: null, ip: `10.${c % 255}.${room % 255}.${made % 255}`,
          sources: [{ oem, connectionId: conns[oem], sourceId: serial }],
        });
        out.snapshots.get(conns[oem]).push(d);
        // About 1 in 10 video bars is also reported by the meeting platform (merged by serial).
        if (type === 'Video bar' && r() < 0.5) {
          out.snapshots.get(conns['zoom-rooms']).push({ ...d, id: `zoom-rooms:${serial}`, platform: 'Zoom', sources: [{ oem: 'zoom-rooms', connectionId: conns['zoom-rooms'], sourceId: crypto.createHash('md5').update(serial).digest('hex').slice(0, 12) }] });
        }
        made++; out.total++;
      }
      room++;
    }
  }
  return out;
}

/** Load the synthetic estate into an app context created with autoStart:false. */
export function loadIntoApp(ctx, estate) {
  const { store, inventory } = ctx;
  for (const c of estate.customers) {
    store.customers.push({ id: c.id, name: c.name, platforms: ['Microsoft Teams'], slaTarget: 99.5, mockData: false });
    store.data.siteDirectory[c.id] = Object.fromEntries(c.sites.map((s) => [s.name, { region: s.region, country: s.country, lat: s.lat, lng: s.lng }]));
  }
  for (const k of estate.connections) store.connections.push({ id: k.id, customerId: k.customerId, oem: k.oem, mode: 'live', name: `${k.customerId} ${k.oem}`, settings: {}, secret: null });
  for (const [id, devs] of estate.snapshots) inventory.setConnectionDevices(id, devs);
}
