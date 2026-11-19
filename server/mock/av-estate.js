// Demo AV and network kit for the mock estate: the extra vendors (Yealink,
// Neat, Crestron, Biamp, Shure, Q-SYS, BrightSign, Sony, NETGEAR) that sit in
// the same rooms as the Poly and Logitech kit in estate.js.
//
// Each vendor's mock transport turns these records into that vendor's own API
// shape. Domotz (a network monitor) reports the network-attached kit again by
// MAC address, which shows the de-duplication merging two views of one device.
import { buildEstate, hash } from './estate.js';

// vendor -> chance a room has the kit, and the models in the kit
export const AV_KITS = {
  yealink: { p: 0.3, kit: [{ model: 'Yealink CP965', type: 3 }, { model: 'Yealink RoomPanel', type: 3 }], oui: '80:5e:c0', sn: '8053', fw: { 'Yealink CP965': ['143.15.0.42', '143.15.0.31'], 'Yealink RoomPanel': ['148.15.0.20'] } },
  neat: { p: 0.2, kit: [{ model: 'Neat Pad' }], oui: 'e4:5f:01', sn: 'NF', fw: { 'Neat Pad': ['NFC1.20260915.0812', 'NFC1.20260601.1004'] } },
  crestron: { p: 0.4, kit: [{ model: 'TSW-1070', category: 'TouchPanel' }, { model: 'CP4N', category: 'Control System' }, { model: 'HD-MD-400-C-E', category: 'Video Switcher' }], oui: '00:10:7f', sn: '2219', fw: { 'TSW-1070': ['3.003.0021', '3.002.0034'], CP4N: ['2.8006.00322'], 'HD-MD-400-C-E': ['1.4291.00011'] } },
  biamp: { p: 0.25, kit: [{ model: 'Tesira FORTE X 1600' }, { model: 'Parlé TCM-X' }], oui: '00:90:5e', sn: 'BIA', fw: { 'Tesira FORTE X 1600': ['5.2.0.22', '5.1.0.18'], 'Parlé TCM-X': ['5.2.0.22'] } },
  shure: { p: 0.3, kit: [{ model: 'Shure MXA920' }, { model: 'Shure IntelliMix P300' }], oui: '00:0e:dd', sn: '3S', fw: { 'Shure MXA920': ['6.1.21.0', '5.6.24.0'], 'Shure IntelliMix P300': ['5.1.31.0'] } },
  qsys: { p: 0.2, kit: [{ model: 'Core Nano', type: 'core' }, { model: 'NV-32-H (Core Capable)', type: 'peripheral' }, { model: 'PTZ-12x72', type: 'camera' }], oui: '00:60:74', sn: '3-', fw: { 'Core Nano': ['10.0.1'], 'NV-32-H (Core Capable)': ['10.0.1'], 'PTZ-12x72': ['10.0.1'] } },
  brightsign: { p: 0.15, kit: [{ model: 'XT1144' }], oui: '90:ac:3f', sn: 'XTD', fw: { XT1144: ['9.0.189', '8.5.53'] } },
  sony: { p: 0.55, kit: [{ model: 'BRAVIA BZ40L' }], oui: '04:5d:4b', sn: '5', fw: { 'BRAVIA BZ40L': ['6.7381', '6.7283'] } },
  netgear: { p: 0.35, kit: [{ model: 'M4250-10G2XF-PoE+' }], oui: '9c:c9:eb', sn: '6TG', fw: { 'M4250-10G2XF-PoE+': ['13.0.4.26', '13.0.3.10'] } },
};

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const serial = (seed, prefix) => prefix + Array.from({ length: 10 - Math.min(prefix.length, 4) }, (_, i) => ALNUM[Math.floor(hash(`${i}#${seed}#${i * 7919}`) * ALNUM.length) % ALNUM.length]).join('');
const mac = (seed, oui) => `${oui}:${[0, 1, 2].map((i) => Math.floor(hash(`m${i}#${seed}#${i * 104729}`) * 256).toString(16).padStart(2, '0')).join(':')}`;
const firmware = (list, seed) => (hash(`${seed}fw`) < 0.85 || list.length === 1 ? list[0] : list[1]);

/** Rooms and the vendor's kit in each, for one customer. Rooms without the vendor are left out. */
export function avRooms(customerId, vendor) {
  const k = AV_KITS[vendor];
  if (!k) throw new Error(`Unknown AV vendor ${vendor}`);
  const out = [];
  buildEstate(customerId).rooms.forEach((room, ri) => {
    // Biamp and Shure are alternatives for the room's audio, as are Crestron and Q-SYS for control.
    if (vendor === 'shure' && hash(`${room.id}/biamp`) < AV_KITS.biamp.p) return;
    if (vendor === 'qsys' && hash(`${room.id}/crestron`) < AV_KITS.crestron.p) return;
    if (hash(`${room.id}/${vendor}`) >= k.p) return;
    const devices = k.kit.map((d, i) => {
      const key = `${room.id}/av/${vendor}/${i}`;
      return {
        ...d, vendor, key,
        serial: serial(key, k.sn), mac: mac(key, k.oui), firmware: firmware(k.fw[d.model] || ['1.0.0'], key),
        ip: `10.${100 + (ri % 100)}.${room.floor}.${50 + i}`,
      };
    });
    out.push({ room, devices });
  });
  return out;
}

/** Network-attached kit a Domotz collector at each site would discover. */
export function networkedKit(customerId) {
  return ['netgear', 'sony', 'brightsign', 'crestron'].flatMap((v) => avRooms(customerId, v).flatMap(({ room, devices }) => devices.map((d) => ({ room, d }))));
}

// How each vendor's connector names its make and model, for the demo model master.
const VENDOR_MODEL = {
  yealink: { make: 'Yealink', oem: 'yealink-ymcs', name: (m) => m },
  neat: { make: 'Neat', oem: 'neat-pulse', name: (m) => m },
  crestron: { make: 'Crestron', oem: 'crestron-xio', name: (m) => `Crestron ${m}` },
  biamp: { make: 'Biamp', oem: 'biamp-workplace', name: (m) => `Biamp ${m}` },
  shure: { make: 'Shure', oem: 'shure-cloud', name: (m) => m },
  qsys: { make: 'Q-SYS', oem: 'qsys-reflect', name: (m) => m },
  brightsign: { make: 'BrightSign', oem: 'brightsign-bsn', name: (m) => `BrightSign ${m}` },
  sony: { make: 'Sony', oem: 'sony-bravia', name: (m) => m.replace('BRAVIA ', 'BRAVIA FW-85') },
  netgear: { make: 'NETGEAR', oem: 'netgear-insight', name: (m) => `NETGEAR ${m}` },
};

/** Demo model-master entries for the AV kit. NETGEAR, Sony, BrightSign and Crestron can also be seen by Domotz. */
export function avDemoModels() {
  return Object.entries(AV_KITS).flatMap(([vendor, k]) => k.kit.map((d) => {
    const v = VENDOR_MODEL[vendor];
    return { make: v.make, model: v.name(d.model), versions: k.fw[d.model] || ['1.0.0'], monitoredBy: ['netgear', 'sony', 'brightsign', 'crestron'].includes(vendor) ? [v.oem, 'domotz'] : [v.oem] };
  }));
}
