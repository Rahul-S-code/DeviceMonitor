// Builds the unified inventory from every connection's latest sync, then
// answers filtered queries and aggregates for the dashboard.
import { dedupeDevices } from './dedupe.js';
import { HEALTH_ORDER } from '../lib/device-model.js';
import { getConnectorClass } from '../connectors/registry.js';
import { compareVersions, modelKey, lifecycleStage, warrantyStatus } from '../lib/models.js';
import { makeDevice, PLATFORMS } from '../lib/device-model.js';
import { issue, explain } from '../lib/issues.js';

export { compareVersions };

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
    const merged = dedupeDevices([...[...this.byConnection.values()].flat(), ...this.manualRecords()]);
    this.enrich(merged);
    this.devices = merged.sort((a, b) => (a.customerId + a.site + a.room + a.model).localeCompare(b.customerId + b.site + b.room + b.model));
    this.builtAt = new Date().toISOString();
    return this.devices;
  }

  /** Devices added by hand, as common device records with health "unmonitored". */
  manualRecords() {
    return this.store.manualDevices.flatMap((m) => {
      const model = m.modelId ? this.store.models.find((x) => x.id === m.modelId) : null;
      const make = model?.make ?? m.make;
      if (!make) return [];
      // No API connector can report this model (or it was typed in under "Other").
      const noApi = !model?.monitoredBy?.length;
      return [makeDevice({
        id: m.id, customerId: m.customerId, site: m.site, room: m.room,
        deviceType: model?.deviceType ?? m.deviceType ?? 'Peripheral', make, model: model?.model ?? m.model,
        serial: m.serial, mac: m.mac, firmware: m.firmware,
        health: 'unmonitored',
        healthReason: noApi ? 'Added manually. There is no API connector for this model.' : `Added manually. Waiting for ${model.monitoredBy.map((o) => getConnectorClass(o).displayName).join(' or ')} to report it.`,
        noApi, autoTags: noApi ? ['Not monitored'] : [], tags: noApi ? ['Not monitored'] : undefined,
        platform: PLATFORMS.includes(m.platform) ? m.platform : 'Unassigned', platformSource: PLATFORMS.includes(m.platform) && m.platform !== 'Unassigned' ? 'manual' : null,
        assetTag: m.assetTag, notes: m.notes,
        warrantyExpires: m.warrantyExpires, warrantyType: m.warrantyType, warrantySource: m.warrantyExpires ? 'manual' : null,
        manualId: m.id,
        sources: [{ oem: 'manual', connectionId: null, sourceId: m.id }],
      })];
    });
  }

  enrich(devices) {
    const s = this.store;
    // A manual record merged with a live source is monitored after all.
    for (const d of devices) {
      if (d.autoTags?.length && d.sources.some((x) => x.oem !== 'manual')) {
        d.tags = (d.tags || []).filter((t) => !d.autoTags.includes(t));
        if (!d.tags.length) delete d.tags;
        d.autoTags = []; d.noApi = false;
      }
    }
    // Manual overrides (room grouping and bulk edits) win over OEM data.
    for (const d of devices) {
      const o = s.override(d.id);
      d.reportedSite = d.site;
      d.reportedRoom = d.room;
      if (!o) continue;
      d.overridden = Object.keys(o);
      if (o.site) d.site = o.site;
      if (o.room) d.room = o.room;
      if (o.platform) { d.platform = o.platform; d.platformSource = 'manual'; }
      if (o.tags) d.tags = [...new Set([...(d.autoTags || []), ...o.tags])];
      if (o.notes) d.notes = o.notes;
      if (o.assetTag) d.assetTag = o.assetTag;
      if (o.warrantyExpires) { d.warrantyExpires = o.warrantyExpires; d.warrantySource = 'manual'; }
      if (o.warrantyType) d.warrantyType = o.warrantyType;
      if (o.contractRef) d.contractRef = o.contractRef;
      if (o.purchaseDate) d.purchaseDate = o.purchaseDate;
    }
    const modeOf = new Map(s.connections.map((c) => [c.id, c.mode]));
    // Region and customer name from the site directory.
    for (const d of devices) {
      const info = s.siteInfo(d.customerId, d.site);
      if (info?.region) d.region = info.region;
      if (info?.country) d.country = info.country;
      d.customerName = s.customerName(d.customerId);
      d.oems = [...new Set(d.sources.map((x) => x.oem))];
      // Mock: every API source is a demo (mock) connection and nobody added it by hand.
      const api = d.sources.filter((x) => x.oem !== 'manual');
      d.mock = api.length > 0 && api.length === d.sources.length && api.every((x) => modeOf.get(x.connectionId) !== 'live');
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
      if ((d.platformSource === 'device' || d.platformSource === 'manual') && d.platform !== 'Unassigned') continue;
      const dir = s.roomPlatform(d.customerId, d.site, d.room);
      const inferred = roomPlatforms.get(`${d.customerId}|${d.site}|${d.room}`);
      if (dir) { d.platform = dir; d.platformSource = 'room directory'; }
      else if (inferred) { d.platform = inferred; d.platformSource = 'inferred from room'; }
      else { d.platform = 'Unassigned'; d.platformSource = null; }
    }
    // Firmware: compare with the approved baseline in the model master. Models
    // without a baseline fall back to the newest version seen in the estate.
    const catalogue = new Map(s.models.map((m) => [modelKey(m.make, m.model), m]));
    const newest = new Map();
    for (const d of devices) {
      if (!d.firmware) continue;
      const cur = newest.get(d.model);
      if (!cur || compareVersions(d.firmware, cur) > 0) newest.set(d.model, d.firmware);
    }
    const now = Date.now();
    for (const d of devices) {
      const m = catalogue.get(modelKey(d.make, d.model)) || null;
      d.modelId = m?.id ?? null;
      d.baseline = m?.baseline ?? null;
      if (!d.firmware) d.firmwareStatus = 'unknown';
      else if (!m) d.firmwareStatus = 'uncatalogued';
      else if (!m.baseline) d.firmwareStatus = 'no-baseline';
      else d.firmwareStatus = compareVersions(d.firmware, m.baseline) < 0 ? 'behind' : compareVersions(d.firmware, m.baseline) > 0 ? 'ahead' : 'compliant';
      const lc = lifecycleStage(m, now);
      d.lifecycle = { ...lc, endOfSale: m?.endOfSale ?? null, endOfSupport: m?.endOfSupport ?? null, endOfLife: m?.endOfLife ?? null };
      d.warrantyStatus = warrantyStatus(d.warrantyExpires, now);

      // Derived health for sources without native health (Poly Lens, Zoom).
      const noNative = d.sources.every((x) => getConnectorClass(x.oem).nativeHealth === false);
      if (!noNative || d.health !== 'healthy' || !d.firmware) continue;
      if (d.firmwareStatus === 'behind') {
        d.health = 'warning';
        d.healthReason = `Firmware ${d.firmware} is below the approved baseline ${d.baseline}`;
        d.issues = [...(d.issues || []), issue('EM-FW-001', 'Estate Monitor', `firmware ${d.firmware} < baseline ${d.baseline}`)];
      } else if (!d.baseline) {
        const latest = newest.get(d.model);
        if (latest && compareVersions(d.firmware, latest) < 0) {
          d.health = 'warning';
          d.healthReason = `Firmware ${d.firmware} is behind ${latest}, the newest version seen in the estate for this model`;
          d.issues = [...(d.issues || []), issue('EM-FW-001', 'Estate Monitor', `firmware ${d.firmware} < newest in estate ${latest}`)];
        }
      }
    }
    // Error codes with meaning, likely causes and checks (healthy and manual devices have none).
    for (const d of devices) {
      d.issues = ['healthy', 'unmonitored'].includes(d.health) ? [] : d.issues || [];
      d.diagnosis = d.issues.map(explain);
      d.errorCodes = [...new Set(d.issues.map((i) => i.code))];
    }
  }

  /** Firmware compliance, warranty and lifecycle roll-up for the Lifecycle tab. */
  lifecycle(devs) {
    const count = (fn) => devs.reduce((acc, d) => { const k = fn(d); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const models = new Map();
    for (const d of devs) {
      const k = d.modelId || `x|${d.make}|${d.model}`;
      if (!models.has(k)) models.set(k, { modelId: d.modelId, make: d.make, model: d.model, deviceType: d.deviceType, baseline: d.baseline, lifecycle: d.lifecycle, total: 0, behind: 0, versions: {} });
      const m = models.get(k);
      m.total++;
      if (d.firmwareStatus === 'behind') m.behind++;
      if (d.firmware) m.versions[d.firmware] = (m.versions[d.firmware] || 0) + 1;
    }
    const attention = devs.filter((d) => d.firmwareStatus === 'behind' || ['expired', 'expiring'].includes(d.warrantyStatus) || ['eol', 'eos', 'eosale', 'soon'].includes(d.lifecycle?.stage));
    return {
      total: devs.length,
      firmware: count((d) => d.firmwareStatus),
      warranty: count((d) => d.warrantyStatus),
      lifecycle: count((d) => d.lifecycle?.stage || 'unknown'),
      models: [...models.values()].sort((a, b) => b.behind - a.behind || b.total - a.total),
      attention: attention.slice(0, 500),
      attentionTotal: attention.length,
    };
  }

  /** Devices visible to the given customers, after applying filters. */
  query(allowed, f = {}) {
    const set = new Set(allowed);
    const list = (v) => (v ? String(v).split(',').filter(Boolean) : null);
    const filters = {
      customerId: list(f.customer), region: list(f.region), site: list(f.site), platform: list(f.platform),
      deviceType: list(f.deviceType), health: list(f.health),
      firmwareStatus: list(f.firmwareStatus), warrantyStatus: list(f.warrantyStatus),
    };
    const oems = list(f.oem);
    const q = f.q ? String(f.q).toLowerCase() : null;
    return this.devices.filter((d) => {
      if (!set.has(d.customerId)) return false;
      for (const [k, vals] of Object.entries(filters)) if (vals && !vals.includes(d[k])) return false;
      if (oems && !d.oems.some((o) => oems.includes(o))) return false;
      if (f.room && d.room !== f.room) return false;
      if (q && ![d.model, d.room, d.site, d.serial, d.make, d.customerName, d.hostName, d.assetTag, ...(d.tags || []), ...(d.errorCodes || [])].some((x) => x && String(x).toLowerCase().includes(q))) return false;
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
  /**
   * Site -> room -> devices hierarchy for drill-down.
   * `configured` adds sites and rooms set up during onboarding that have no devices yet.
   */
  tree(devs, configured = null) {
    const sites = new Map();
    const site = (customerId, name, region, country) => {
      const sk = `${customerId}|${name}`;
      if (!sites.has(sk)) sites.set(sk, { customerId, customerName: this.store.customerName(customerId), site: name, region, country, rooms: new Map() });
      return sites.get(sk);
    };
    const room = (s, name, platform) => {
      if (!s.rooms.has(name)) s.rooms.set(name, { room: name, platform, devices: [], hasSchematic: !!this.store.schematic(s.customerId, s.site, name) });
      return s.rooms.get(name);
    };
    for (const d of devs) room(site(d.customerId, d.site, d.region, d.country), d.room, d.platform).devices.push(d);
    if (configured) {
      const allowed = new Set(configured.allowed);
      const want = (k, v) => !configured.f?.[k] || String(configured.f[k]).split(',').includes(v);
      for (const customerId of allowed) {
        if (!want('customer', customerId)) continue;
        for (const [name, info] of Object.entries(this.store.sitesFor(customerId))) {
          if (want('region', info.region) && want('site', name)) site(customerId, name, info.region, info.country);
        }
      }
      for (const k of new Set([...Object.keys(this.store.data.schematics), ...Object.keys(this.store.data.roomDirectory)])) {
        const [customerId, siteName, roomName] = k.split('|');
        const s = sites.get(`${customerId}|${siteName}`);
        if (s && allowed.has(customerId)) room(s, roomName, this.store.roomPlatform(customerId, siteName, roomName) || 'Unassigned');
      }
    }
    return [...sites.values()].map((s) => {
      const rooms = [...s.rooms.values()].map((r) => ({ ...r, health: Inventory.healthCounts(r.devices), worst: worst(r.devices) }));
      const all = rooms.flatMap((r) => r.devices);
      return { ...s, rooms: rooms.sort((a, b) => a.room.localeCompare(b.room)), health: Inventory.healthCounts(all), worst: worst(all) };
    }).sort((a, b) => (a.customerName + a.site).localeCompare(b.customerName + b.site));
  }

  /** Sites with coordinates and health, for the map. */
  map(devs, configured) {
    return this.tree(devs, configured).map((s) => {
      const info = this.store.siteInfo(s.customerId, s.site) || {};
      return {
        customerId: s.customerId, customerName: s.customerName, site: s.site, region: s.region, country: s.country,
        city: info.city, address: info.address, lat: info.lat ?? null, lng: info.lng ?? null,
        health: s.health, worst: s.worst,
        rooms: s.rooms.map((r) => ({ room: r.room, platform: r.platform, health: r.health, worst: r.worst, hasSchematic: r.hasSchematic, devices: r.devices.map((d) => ({ id: d.id, make: d.make, model: d.model, deviceType: d.deviceType, health: d.health })) })),
      };
    });
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
      firmwareStatus: ['behind', 'compliant', 'ahead', 'no-baseline', 'uncatalogued', 'unknown'].filter((v) => devs.some((d) => d.firmwareStatus === v)),
      warrantyStatus: ['expired', 'expiring', 'active', 'unknown'].filter((v) => devs.some((d) => d.warrantyStatus === v)),
    };
  }
}

const RANK = { healthy: 0, warning: 1, offline: 2, critical: 3 };
function worst(devs) {
  if (!devs.length) return 'none';
  devs = devs.filter((d) => d.health !== 'unmonitored');
  if (!devs.length) return 'unmonitored';
  return devs.reduce((w, d) => (RANK[d.health] > RANK[w] ? d.health : w), 'healthy');
}
