// A deterministic fictional estate shared by every mock connector, so that
// Poly and Logitech mock data describe the same customers, sites and rooms
// (which is what lets the de-duplication logic be demonstrated).
//
// Device health drifts over time using a seeded hash of (device, time window),
// so the dashboard and alert feed change without any stored state.

export const MOCK_CUSTOMERS = [
  {
    id: 'cust-helix', name: 'Helix Financial',
    sites: [
      { name: 'London HQ', region: 'EMEA', country: 'United Kingdom', lat: 51.5154, lng: -0.0922, city: 'London', rooms: 7 },
      { name: 'Frankfurt', region: 'EMEA', country: 'Germany', lat: 50.1109, lng: 8.6821, city: 'Frankfurt', rooms: 4 },
      { name: 'New York', region: 'AMER', country: 'United States', lat: 40.7549, lng: -73.984, city: 'New York', rooms: 6 },
      { name: 'Singapore', region: 'APAC', country: 'Singapore', lat: 1.2834, lng: 103.8607, city: 'Singapore', rooms: 4 },
    ],
    platforms: ['Microsoft Teams', 'Microsoft Teams', 'Microsoft Teams', 'Zoom'],
  },
  {
    id: 'cust-northwind', name: 'Northwind Retail',
    sites: [
      { name: 'Chicago', region: 'AMER', country: 'United States', lat: 41.8826, lng: -87.6233, city: 'Chicago', rooms: 6 },
      { name: 'Toronto', region: 'AMER', country: 'Canada', lat: 43.6481, lng: -79.3815, city: 'Toronto', rooms: 4 },
      { name: 'Manchester', region: 'EMEA', country: 'United Kingdom', lat: 53.4794, lng: -2.2453, city: 'Manchester', rooms: 5 },
    ],
    platforms: ['Zoom', 'Zoom', 'Google Meet'],
  },
  {
    id: 'cust-meridian', name: 'Meridian Health',
    sites: [
      { name: 'Mumbai', region: 'APAC', country: 'India', lat: 19.0596, lng: 72.8656, city: 'Mumbai', rooms: 6 },
      { name: 'Sydney', region: 'APAC', country: 'Australia', lat: -33.8651, lng: 151.2099, city: 'Sydney', rooms: 4 },
      { name: 'Boston', region: 'AMER', country: 'United States', lat: 42.3554, lng: -71.0605, city: 'Boston', rooms: 5 },
    ],
    platforms: ['Cisco Webex', 'Cisco Webex', 'Microsoft Teams'],
  },
];

const ROOM_NAMES = ['Boardroom', 'Atlas', 'Orion', 'Harbour', 'Summit', 'Cedar', 'Willow', 'Lumen', 'Nova', 'Quartz', 'Delta', 'Aurora'];

// Kits: which devices each OEM reports for a room.
// `generic` = a non-Logitech peripheral that Logitech Sync also reports (no serial).
const POLY_KITS = [
  [{ model: 'Poly Studio X50' }, { model: 'Poly TC8' }],
  [{ model: 'Poly Studio X30' }, { model: 'Poly TC8' }],
  [{ model: 'Poly G7500' }, { model: 'Poly Studio E70' }, { model: 'Poly TC10' }, { model: 'Poly Trio C60' }],
  [{ model: 'Poly Studio X70' }, { model: 'Poly TC10' }, { model: 'Poly CCX 600' }],
];
const LOGI_KITS = [
  [{ type: 'Logitech', model: 'Rally Bar' }, { type: 'Logitech', model: 'Tap IP' }],
  [{ type: 'Logitech', model: 'Rally Bar Mini' }, { type: 'Logitech', model: 'Tap IP' }, { type: 'Logitech', model: 'Spot' }],
  [{ type: 'Computer', model: 'DESKTOP' }, { type: 'Logitech', model: 'Tap' }, { type: 'Logitech', model: 'Rally' }, { type: 'Logitech', model: 'Scribe' }],
  [{ type: 'Logitech', model: 'Rally Bar' }, { type: 'Logitech', model: 'Tap IP' }, { type: 'Logitech', model: 'Sight' }],
];
// Mixed room: Logitech PC + Tap, with a Poly Studio USB bar plugged into the PC.
// Poly Lens reports the bar (with serial); Logitech Sync reports it as Generic.
const MIXED_KIT = {
  logi: [{ type: 'Computer', model: 'DESKTOP' }, { type: 'Logitech', model: 'Tap' }, { type: 'Generic', model: 'Poly Studio' }],
  poly: [{ model: 'Poly Studio' }],
};

const FIRMWARE = {
  'Poly Studio X50': ['4.2.0', '4.1.1'], 'Poly Studio X30': ['4.2.0', '4.1.1'], 'Poly Studio X70': ['4.2.0'],
  'Poly G7500': ['4.2.0', '4.0.2'], 'Poly Studio E70': ['4.2.0'], 'Poly TC8': ['4.2.0', '4.1.1'], 'Poly TC10': ['4.2.0'],
  'Poly Trio C60': ['8.1.3', '7.2.4'], 'Poly CCX 600': ['8.1.3'], 'Poly Studio': ['1.4.1', '1.3.0'],
  'Rally Bar': ['1.12.252', '1.11.180'], 'Rally Bar Mini': ['1.12.252'], 'Tap IP': ['1.12.252'], 'Tap': ['1.0.10'],
  Rally: ['1.2.69'], Scribe: ['1.3.12'], Sight: ['1.12.252'], Spot: ['1.0.5'], DESKTOP: ['3.3.176', '3.2.150'],
};

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// Most devices run the newest firmware; about 1 in 8 lags behind.
function firmwareFor(model, seed) {
  const list = FIRMWARE[model] || ['1.0.0'];
  return hash(seed + 'fw') < 0.88 || list.length === 1 ? list[0] : list[1 + Math.floor(hash(seed + 'fw2') * (list.length - 1))];
}

function pick(arr, seed) { return arr[Math.floor(hash(seed) * arr.length) % arr.length]; }

function serialFor(seed, prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let s = prefix;
  for (let i = 0; i < 10; i++) s += chars[Math.floor(hash(`${i}#${seed}#${i * 7919}`) * chars.length) % chars.length];
  return s;
}

function macFor(seed, oui) {
  const hex = [];
  for (let i = 0; i < 3; i++) hex.push(Math.floor(hash(`m${i}#${seed}#${i * 104729}`) * 256).toString(16).padStart(2, '0'));
  return `${oui}:${hex.join(':')}`;
}

/** Build the static estate (rooms + kits) for one customer. */
const EXTRA = new Map();
/**
 * Let customers onboarded through the UI get mock devices too, generated from
 * the sites entered during onboarding. Called by the store on load and on change.
 */
export function registerMockCustomer(def) {
  if (MOCK_CUSTOMERS.some((c) => c.id === def.id)) return;
  EXTRA.set(def.id, {
    id: def.id,
    name: def.name,
    platforms: def.platforms?.length ? def.platforms : ['Microsoft Teams', 'Zoom', 'Google Meet', 'Cisco Webex'],
    sites: (def.sites || []).map((s) => ({ ...s, rooms: Math.max(1, Math.min(Number(s.mockRooms) || 4, 30)) })),
  });
}
export function unregisterMockCustomer(id) { EXTRA.delete(id); }

export function buildEstate(customerId) {
  const c = MOCK_CUSTOMERS.find((x) => x.id === customerId) || EXTRA.get(customerId);
  if (!c) return { rooms: [] };
  const rooms = [];
  for (const site of c.sites) {
    for (let r = 0; r < site.rooms; r++) {
      const seed = `${c.id}/${site.name}/${r}`;
      const floor = 1 + Math.floor(hash(seed + 'f') * 12);
      const roomName = `${ROOM_NAMES[(r + site.name.length) % ROOM_NAMES.length]} ${floor}.${String(r + 1).padStart(2, '0')}`;
      const platform = pick(c.platforms, seed + 'p');
      const roll = hash(seed + 'kit');
      let oem; let polyKit = []; let logiKit = [];
      if (roll < 0.15) { oem = 'mixed'; polyKit = MIXED_KIT.poly; logiKit = MIXED_KIT.logi; }
      else if (roll < 0.55) { oem = 'poly'; polyKit = pick(POLY_KITS, seed + 'pk'); }
      else { oem = 'logitech'; logiKit = pick(LOGI_KITS, seed + 'lk'); }
      const roomId = `${c.id}-${site.name}-${r}`.replace(/\s+/g, '').toLowerCase();
      const devices = [];
      const add = (oemKey, d, i) => {
        const dseed = `${roomId}/${oemKey}/${i}`;
        const shared = d.model === 'Poly Studio'; // same physical device seen by both OEMs
        const sseed = shared ? `${roomId}/studio-usb` : dseed;
        devices.push({
          oem: oemKey, kind: d.type || 'Poly', model: d.model, key: dseed,
          serial: d.type === 'Generic' ? null : serialFor(sseed, oemKey === 'poly' || shared ? '8L' : '26'),
          mac: d.type === 'Generic' ? null : macFor(sseed, oemKey === 'poly' || shared ? '00:e0:db' : '44:73:d6'),
          firmware: firmwareFor(d.model, dseed),
          ip: `10.${20 + Math.floor(hash(c.id) * 200)}.${floor}.${10 + rooms.length + i}`,
        });
      };
      polyKit.forEach((d, i) => add('poly', d, i));
      logiKit.forEach((d, i) => add('logitech', d, i));
      rooms.push({ id: roomId, site: site.name, region: site.region || 'Unassigned', country: site.country, room: roomName, floor, platform, oem, devices });
    }
  }
  return { customer: c, rooms };
}

/**
 * Simulated live state for a device at time `now`.
 * Most devices are healthy; a few drift into warning/critical/offline for a
 * window or two, and a handful are persistently broken.
 */
export function simulatedState(key, now = Date.now(), windowMs = 90_000) {
  const w = Math.floor(now / windowMs);
  const chronic = hash(key + 'chronic');
  if (chronic < 0.025) return { state: 'offline', since: (w - 400) * windowMs };
  if (chronic < 0.04) return { state: 'critical', since: (w - 120) * windowMs };
  const r = hash(`${key}@${w}`);
  if (r < 0.035) return { state: 'offline', since: w * windowMs };
  if (r < 0.06) return { state: 'critical', since: w * windowMs };
  if (r < 0.13) return { state: 'warning', since: w * windowMs };
  return { state: 'healthy', since: null };
}
