// The common device format every connector must produce.
// Connectors convert raw OEM payloads into this shape; nothing downstream
// (dedupe, alerts, dashboard) ever sees vendor-specific fields.

export const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  OFFLINE: 'offline',
});

export const HEALTH_ORDER = [HEALTH.HEALTHY, HEALTH.WARNING, HEALTH.CRITICAL, HEALTH.OFFLINE];

// Severity rank used when two sources disagree about one device.
export const HEALTH_RANK = { healthy: 0, warning: 1, offline: 2, critical: 3 };

export const PLATFORMS = Object.freeze(['Microsoft Teams', 'Zoom', 'Cisco Webex', 'Google Meet', 'Unassigned']);

/**
 * @typedef {Object} CommonDevice
 * @property {string} id            Stable id inside this app (oem:sourceId)
 * @property {string} customerId    Owning customer (tenant isolation key)
 * @property {string} region
 * @property {string} site
 * @property {string} room
 * @property {string} deviceType    e.g. "Video bar", "Touch controller"
 * @property {string} make          Manufacturer, e.g. "Poly", "Logitech"
 * @property {string} model
 * @property {string|null} serial
 * @property {string|null} firmware
 * @property {'healthy'|'warning'|'critical'|'offline'} health
 * @property {string|null} healthReason  Human-readable reason for non-healthy states
 * @property {string|null} lastSeen ISO timestamp
 * @property {string} platform      One of PLATFORMS
 * @property {string|null} mac
 * @property {string|null} ip
 * @property {Array<{oem:string, connectionId:string, sourceId:string}>} sources
 */

const REQUIRED = ['id', 'customerId', 'site', 'room', 'deviceType', 'make', 'model', 'health'];

export function validateDevice(d) {
  const missing = REQUIRED.filter((k) => d[k] === undefined || d[k] === null || d[k] === '');
  if (missing.length) throw new Error(`Device ${d.id ?? '?'} missing fields: ${missing.join(', ')}`);
  if (!HEALTH_ORDER.includes(d.health)) throw new Error(`Device ${d.id} has invalid health "${d.health}"`);
  if (!PLATFORMS.includes(d.platform)) throw new Error(`Device ${d.id} has invalid platform "${d.platform}"`);
  return d;
}

export function makeDevice(fields) {
  return validateDevice({
    region: 'Unassigned',
    serial: null,
    firmware: null,
    healthReason: null,
    lastSeen: null,
    platform: 'Unassigned',
    mac: null,
    ip: null,
    sources: [],
    ...fields,
  });
}

/** Normalise free-text platform names reported by devices (e.g. Poly activeApplicationName). */
export function normalisePlatform(name) {
  if (!name) return 'Unassigned';
  const n = String(name).toLowerCase();
  if (n.includes('teams') || n.includes('microsoft') || n.includes('skype')) return 'Microsoft Teams';
  if (n.includes('zoom')) return 'Zoom';
  if (n.includes('webex') || n.includes('cisco')) return 'Cisco Webex';
  if (n.includes('google') || n.includes('meet')) return 'Google Meet';
  return 'Unassigned';
}

// Model-name → device type catalogue. Neither OEM API returns a device
// category field, so we classify by product name.
const TYPE_RULES = [
  [/tap|tc8|tc10|controller/i, 'Touch controller'],
  [/scribe/i, 'Whiteboard camera'],
  [/spot|sensor/i, 'Room sensor'],
  [/sight|e70|e60|eagleeye|camera|brio/i, 'Camera'],
  [/rally bar|studio x|meetup|roommate|studio r30|studio a2|studio usb|^poly studio$|video bar/i, 'Video bar'],
  [/g7500|codec|rally$|^rally\b(?! bar)/i, 'Video system'],
  [/trio|conference phone|c60/i, 'Conference phone'],
  [/ccx|vvx|desk phone/i, 'Desk phone'],
  [/dock/i, 'Desk dock'],
  [/voyager|zone|headset/i, 'Headset'],
  [/tv|display|board/i, 'Display'],
  [/desktop-|nuc|pc|computer/i, 'Room PC'],
];

export function classifyDeviceType(model, hint) {
  if (hint === 'Computer') return 'Room PC';
  for (const [re, type] of TYPE_RULES) if (re.test(model || '')) return type;
  return 'Peripheral';
}

/** Split a Logitech-style group path "/US/California/San Francisco/HQ/" into parts. */
export function splitPath(p) {
  return String(p || '').split('/').map((s) => s.trim()).filter(Boolean);
}

export function normaliseSerial(s) {
  if (!s) return null;
  const v = String(s).replace(/[^a-z0-9]/gi, '').toUpperCase();
  return v.length >= 4 ? v : null;
}

export function normaliseMac(m) {
  if (!m) return null;
  const v = String(m).replace(/[^a-f0-9]/gi, '').toUpperCase();
  return v.length === 12 ? v : null;
}
