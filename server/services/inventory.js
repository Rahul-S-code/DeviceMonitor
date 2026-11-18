// Builds the unified inventory from every connection's latest sync, then
// answers filtered queries and aggregates for the dashboard.
import { dedupeDevices } from './dedupe.js';
import { HEALTH_ORDER } from '../lib/device-model.js';
import { getConnectorClass } from '../connectors/registry.js';

export function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export class Inventory {
  constructor(store) {
    this.store = store;
    this.byConnection = new Map(); // connectionId -> CommonDevice[]
    this.devices = [];
    this.builtAt = null;
  }

  setConnectionDevices(connectionId, devices) {
    this.byConnection.set(connectionId, devices);
  }

  removeConnection(connectionId) {
    this.byConnection.delete(connectionId);
  }

  rebuild() {
    const live = new Set(this.store.connections.map((c) => c.id));
    for (const id of this.byConnection.keys()) if (!live.has(id)) this.byConnection.delete(id);
    const merged = dedupeDevices([...this.byConnection.values()].flat());
    this.enrich(merged);
    this.devices = merged.sort((a, b) => (a.customerId + a.site + a.room + a.model).localeCompare(b.customerId + b.site + b.room + b.model));
    this.builtAt = new Date().toISOString();
    return this.devices;
  }

  enrich(devices) {
    const s = this.store;
    // Region and customer name from the site directory.
    for (const d of devices) {
      const info = s.siteInfo(d.customerId, d.site);
      if (info?.region) d.region = info.region;
      if (info?.country) d.country = info.country;
      d.customerName = s.customerName(d.customerId);
      d.oems = [...new Set(d.sources.map((x) => x.oem))];
    }
    // Platform: device-reported > room directory > inferred from the room's other devices.
    const roomPlatforms = new Map();
    for (const d of devices) {
      if (d.platformSource === 'device' && d.platform !== 'Unassigned') {
        const k = `${d.customerId}|${d.site}|${d.room}`;
        roomPlatforms.set(k, d.platform);
      }
    }
    for (const d of devices) {
      if (d.platformSource === 'device' && d.platform !== 'Unassigned') continue;
      const dir = s.roomPlatform(d.customerId, d.site, d.room);
      const inferred = roomPlatforms.get(`${d.customerId}|${d.site}|${d.room}`);
      if (dir) { d.platform = dir; d.platformSource = 'room directory'; }
      else if (inferred) { d.platform = inferred; d.platformSource = 'inferred from room'; }
      else { d.platform = 'Unassigned'; d.platformSource = null; }
    }
    // Derived health for sources without native health (Poly Lens):
    // firmware older than the newest version seen for that model in the estate.
    const newest = new Map();
    for (const d of devices) {
      if (!d.firmware) continue;
      const cur = newest.get(d.model);
      if (!cur || compareVersions(d.firmware, cur) > 0) newest.set(d.model, d.firmware);
    }
    for (const d of devices) {
      const noNative = d.sources.every((x) => getConnectorClass(x.oem).nativeHealth === false);
      if (!noNative || d.health !== 'healthy' || !d.firmware) continue;
      const latest = newest.get(d.model);
      if (latest && compareVersions(d.firmware, latest) < 0) {
        d.health = 'warning';
        d.healthReason = `Firmware ${d.firmware} is behind ${latest}, the newest version seen in the estate for this model`;
      }
    }
  }

  /** Devices visible to the given customers, after applying filters. */
  query(allowed, f = {}) {
    const set = new Set(allowed);
    const list = (v) => (v ? String(v).split(',').filter(Boolean) : null);
    const filters = {
      customerId: list(f.customer), region: list(f.region), site: list(f.site), platform: list(f.platform),
      deviceType: list(f.deviceType), health: list(f.health),
    };
    const oems = list(f.oem);
    const q = f.q ? String(f.q).toLowerCase() : null;
    return this.devices.filter((d) => {
      if (!set.has(d.customerId)) return false;
      for (const [k, vals] of Object.entries(filters)) if (vals && !vals.includes(d[k])) return false;
      if (oems && !d.oems.some((o) => oems.includes(o))) return false;
      if (f.room && d.room !== f.room) return false;
      if (q && ![d.model, d.room, d.site, d.serial, d.make, d.customerName, d.hostName].some((x) => x && String(x).toLowerCase().includes(q))) return false;
      return true;
    });
  }

  static healthCounts(devs) {
    const c = Object.fromEntries(HEALTH_ORDER.map((h) => [h, 0]));
    for (const d of devs) c[d.health]++;
    c.total = devs.length;
    return c;
  }

  static groupCounts(devs, keyFn) {
    const m = new Map();
    for (const d of devs) for (const k of [].concat(keyFn(d))) {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    }
    return [...m.entries()].map(([key, ds]) => ({ key, ...Inventory.healthCounts(ds) })).sort((a, b) => b.total - a.total);
  }

  summary(devs) {
    return {
      totals: Inventory.healthCounts(devs),
      byOem: Inventory.groupCounts(devs, (d) => d.oems),
      byMake: Inventory.groupCounts(devs, (d) => d.make),
      byPlatform: Inventory.groupCounts(devs, (d) => d.platform),
      byCustomer: Inventory.groupCounts(devs, (d) => d.customerName),
      bySite: Inventory.groupCounts(devs, (d) => `${d.site}`).map((s) => ({ ...s, region: devs.find((d) => d.site === s.key)?.region })),
      byType: Inventory.groupCounts(devs, (d) => d.deviceType),
      rooms: new Set(devs.map((d) => `${d.customerId}|${d.site}|${d.room}`)).size,
      sites: new Set(devs.map((d) => `${d.customerId}|${d.site}`)).size,
      mergedDuplicates: devs.filter((d) => d.duplicateOf?.length).length,
      builtAt: this.builtAt,
    };
  }

  /** Site -> room -> devices hierarchy for drill-down. */
  tree(devs) {
    const sites = new Map();
    for (const d of devs) {
      const sk = `${d.customerId}|${d.site}`;
      if (!sites.has(sk)) sites.set(sk, { customerId: d.customerId, customerName: d.customerName, site: d.site, region: d.region, country: d.country, rooms: new Map() });
      const s = sites.get(sk);
      if (!s.rooms.has(d.room)) s.rooms.set(d.room, { room: d.room, platform: d.platform, devices: [] });
      s.rooms.get(d.room).devices.push(d);
    }
    return [...sites.values()].map((s) => {
      const rooms = [...s.rooms.values()].map((r) => ({ ...r, health: Inventory.healthCounts(r.devices), worst: worst(r.devices) }));
      const all = rooms.flatMap((r) => r.devices);
      return { ...s, rooms: rooms.sort((a, b) => a.room.localeCompare(b.room)), health: Inventory.healthCounts(all), worst: worst(all) };
    }).sort((a, b) => (a.customerName + a.site).localeCompare(b.customerName + b.site));
  }

  filterOptions(allowed) {
    const devs = this.query(allowed);
    const uniq = (fn) => [...new Set(devs.map(fn).filter(Boolean))].sort();
    return {
      customer: this.store.customers.filter((c) => allowed.includes(c.id)).map((c) => ({ value: c.id, label: c.name })),
      region: uniq((d) => d.region),
      site: uniq((d) => d.site),
      platform: uniq((d) => d.platform),
      oem: [...new Set(devs.flatMap((d) => d.oems))].sort().map((o) => ({ value: o, label: getConnectorClass(o).displayName })),
      deviceType: uniq((d) => d.deviceType),
      health: HEALTH_ORDER,
    };
  }
}

const RANK = { healthy: 0, warning: 1, offline: 2, critical: 3 };
function worst(devs) {
  return devs.reduce((w, d) => (RANK[d.health] > RANK[w] ? d.health : w), 'healthy');
}
