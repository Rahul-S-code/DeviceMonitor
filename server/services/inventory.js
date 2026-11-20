// Device inventory sized for large estates (tens of thousands of devices).
//
// Each connection's latest sync is kept as a snapshot. De-duplication only
// ever happens within one customer, so the merged inventory is built and
// cached per customer: a sync that changes one connection rebuilds only that
// customer, and a snapshot identical to the last one rebuilds nothing.
// Reads (paged device lists, summaries, filters) are answered from cached,
// indexed results that are thrown away whenever the inventory changes.
import crypto from 'node:crypto';
import { dedupeDevices } from './dedupe.js';
import { HEALTH_ORDER } from '../lib/device-model.js';
import { getConnectorClass } from '../connectors/registry.js';
import { compareVersions, modelKey, lifecycleStage, warrantyStatus } from '../lib/models.js';
import { makeDevice, PLATFORMS } from '../lib/device-model.js';
import { issue, explain } from '../lib/issues.js';
import { resolveFirmware, firmwareStatus, lifecycleBreach } from '../lib/baselines.js';

export { compareVersions };

export class Inventory {
  constructor(store) {
    this.store = store;
    this.byConnection = new Map(); // connectionId -> { devices, hash, customerId }
    this.byCustomer = new Map(); // customerId -> merged, enriched devices (sorted)
    this.newestBy = new Map(); // customerId -> Map(model -> newest firmware) in that customer
    this.newest = new Map(); // model -> newest firmware across the estate
    this.byId = new Map();
    this.devices = [];
    this.dirty = new Set();
    this.allDirty = true;
    this.builtAt = null;
    this.version = 0;
    this.cache = new Map(); // read cache, cleared on every rebuild
  }

  /**
   * Store a connection's latest devices. Returns false (and marks nothing
   * for rebuild) when the snapshot is identical to the previous one.
   */
  setConnectionDevices(connectionId, devices, customerId = null) {
    const cid = customerId ?? this.store.connections.find((c) => c.id === connectionId)?.customerId ?? devices[0]?.customerId ?? null;
    const hash = digest(devices);
    const prev = this.byConnection.get(connectionId);
    if (prev && prev.hash === hash && prev.customerId === cid) return false;
    this.byConnection.set(connectionId, { devices, hash, customerId: cid, at: Date.now() });
    if (cid) this.dirty.add(cid);
    if (prev?.customerId && prev.customerId !== cid) this.dirty.add(prev.customerId);
    return true;
  }

  snapshot(connectionId) { return this.byConnection.get(connectionId) ?? null; }

  removeConnection(connectionId) {
    const prev = this.byConnection.get(connectionId);
    if (prev?.customerId) this.dirty.add(prev.customerId);
    this.byConnection.delete(connectionId);
  }

  /** Mark one customer (or, with no argument, everything) for rebuild on the next refresh. */
  invalidate(customerId) {
    if (customerId) this.dirty.add(customerId); else this.allDirty = true;
  }

  get pending() { return this.allDirty || this.dirty.size > 0; }

  /** Devices of one customer (no copy). */
  forCustomer(customerId) { return this.byCustomer.get(customerId) ?? []; }

  get(id) { return this.byId.get(id) ?? null; }

  /**
   * Rebuild the customers marked dirty (or all of them). Returns what changed:
   * { customers, devices (the rebuilt customers' devices), removed (ids no longer present), full }.
   */
  rebuild({ full = false } = {}) {
    const s = this.store;
    const customerIds = new Set(s.customers.map((c) => c.id));
    const connCustomer = new Map(s.connections.map((c) => [c.id, c.customerId]));
    for (const [id, e] of this.byConnection) {
      if (!connCustomer.has(id)) { this.byConnection.delete(id); if (e.customerId) this.dirty.add(e.customerId); }
    }
    const removed = [];
    for (const cid of [...this.byCustomer.keys()]) {
      if (customerIds.has(cid)) continue;
      for (const d of this.byCustomer.get(cid)) removed.push(d.id);
      this.byCustomer.delete(cid); this.newestBy.delete(cid);
    }
    const isFull = full || this.allDirty;
    const targets = isFull ? [...customerIds] : [...this.dirty].filter((cid) => customerIds.has(cid));
    this.dirty.clear();
    this.allDirty = false;

    // Raw records per customer: connection snapshots plus devices added by hand.
    const raw = new Map(targets.map((cid) => [cid, []]));
    for (const e of this.byConnection.values()) raw.get(e.customerId)?.push(...e.devices);
    for (const d of this.manualRecords(new Set(targets))) raw.get(d.customerId)?.push(d);

    const merged = new Map();
    for (const cid of targets) {
      const list = dedupeDevices(raw.get(cid));
      merged.set(cid, list);
      this.newestBy.set(cid, newestFirmware(list));
    }
    // "Newest firmware in the estate" spans customers, so a change to it means every customer is re-checked.
    const newest = new Map();
    for (const m of this.newestBy.values()) for (const [k, v] of m) { const cur = newest.get(k); if (!cur || compareVersions(v, cur) > 0) newest.set(k, v); }
    if (!isFull && !sameMap(newest, this.newest)) { this.allDirty = true; return this.rebuild({ full: true }); }
    this.newest = newest;

    const ctx = this.enrichContext();
    const changed = [];
    for (const cid of targets) {
      const list = merged.get(cid);
      this.enrich(list, ctx);
      list.sort((a, b) => cmp(a.site, b.site) || cmp(a.room, b.room) || cmp(a.model, b.model));
      const before = this.byCustomer.get(cid);
      if (before) {
        const now = new Set(list.map((d) => d.id));
        for (const d of before) if (!now.has(d.id)) removed.push(d.id);
      }
      this.byCustomer.set(cid, list);
      changed.push(...list);
    }
    const order = [...this.byCustomer.keys()].sort();
    this.devices = order.flatMap((cid) => this.byCustomer.get(cid));
    this.byId = new Map(this.devices.map((d) => [d.id, d]));
    this.builtAt = new Date().toISOString();
    this.version++;
    this.cache.clear();
    return { customers: targets, devices: changed, removed, full: isFull };
  }

  /** Devices added by hand, as common device records with health "unmonitored". */
  manualRecords(customers = null) {
    const models = new Map(this.store.models.map((x) => [x.id, x]));
    return this.store.manualDevices.flatMap((m) => {
      if (customers && !customers.has(m.customerId)) return [];
      const model = m.modelId ? models.get(m.modelId) : null;
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

  /** Lookups shared by every customer's enrich pass in one rebuild. */
  enrichContext() {
    const s = this.store;
    return {
      names: new Map(s.customers.map((c) => [c.id, c.name])),
      modeOf: new Map(s.connections.map((c) => [c.id, c.mode])),
      catalogue: new Map(s.models.map((m) => [modelKey(m.make, m.model), m])),
      nativeHealth: new Map(),
      lifecycle: new Map(), // model id -> shared lifecycle object (identical for every device of a model)
      now: Date.now(),
    };
  }

  enrich(devices, ctx = this.enrichContext()) {
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
    const { modeOf } = ctx;
    // Region and customer name from the site directory.
    for (const d of devices) {
      const info = s.siteInfo(d.customerId, d.site);
      if (info?.region) d.region = info.region;
      if (info?.country) d.country = info.country;
      d.customerName = ctx.names.get(d.customerId) ?? d.customerId;
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
    // Firmware: compare with the customer's baseline (which follows, raises or
    // lowers the provider's advisory baseline from the model master). Models
    // with no target fall back to the newest version seen in the estate.
    const { catalogue, now } = ctx;
    const newest = ctx.newest || this.newest;
    const baselineOf = new Map();
    const custBaseline = (id) => {
      if (!baselineOf.has(id)) baselineOf.set(id, { cb: s.customerBaseline(id), policy: s.effectivePolicy(id) });
      return baselineOf.get(id);
    };
    for (const d of devices) {
      const m = catalogue.get(modelKey(d.make, d.model)) || null;
      const { cb, policy } = custBaseline(d.customerId);
      const fw = resolveFirmware(m, cb);
      d.modelId = m?.id ?? null;
      d.baseline = fw.target;
      d.advisoryBaseline = fw.advisory;
      d.baselineRule = fw.rule;
      d.baselineSource = fw.source;
      d.baselineDrift = m ? fw.drift : null;
      d.baselineVersion = cb?.version ?? 0;
      d.policy = policy;
      if (!d.firmware) d.firmwareStatus = 'unknown';
      else if (!m) d.firmwareStatus = 'uncatalogued';
      else if (!fw.target) d.firmwareStatus = 'no-baseline';
      else d.firmwareStatus = firmwareStatus(d.firmware, fw.target);
      d.advisoryStatus = d.firmware && m && fw.advisory ? firmwareStatus(d.firmware, fw.advisory) : null;
      const lcKey = m?.id ?? '';
      let shared = ctx.lifecycle.get(lcKey);
      if (!shared) {
        const lc = lifecycleStage(m, now);
        shared = {
          ...lc, endOfSale: m?.endOfSale ?? null, endOfSupport: m?.endOfSupport ?? null, endOfLife: m?.endOfLife ?? null,
          status: m?.lifecycleStatus ?? null, note: m?.lifecycleNote ?? null, url: m?.lifecycleUrl ?? null,
          refs: m?.lifecycleRefs ?? [], checkedAt: m?.lifecycleCheckedAt ?? null,
        };
        ctx.lifecycle.set(lcKey, shared);
      }
      const lc = shared;
      d.lifecycle = shared;
      d.warrantyStatus = warrantyStatus(d.warrantyExpires, now, policy.warrantyNoticeDays);
      // Compliance with the customer's baseline: firmware, warranty and lifecycle.
      const fwOk = d.firmwareStatus !== 'behind';
      const wOk = !policy.warrantyRequired || d.warrantyStatus !== 'expired';
      const lcOk = !lifecycleBreach(lc.stage, policy.lifecycleLimit);
      d.compliance = { firmware: fwOk, warranty: wOk, lifecycle: lcOk, ok: fwOk && wOk && lcOk };

      // Derived health for sources without native health (Poly Lens, Zoom).
      const noNative = d.sources.every((x) => {
        if (!ctx.nativeHealth.has(x.oem)) ctx.nativeHealth.set(x.oem, getConnectorClass(x.oem).nativeHealth !== false);
        return !ctx.nativeHealth.get(x.oem);
      });
      if (!noNative || d.health !== 'healthy' || !d.firmware) continue;
      if (d.firmwareStatus === 'behind') {
        d.health = 'warning';
        d.healthReason = `Firmware ${d.firmware} is below the customer's baseline ${d.baseline}`;
        d.issues = [...(d.issues || []), issue('EM-FW-001', 'Estate Monitor', `firmware ${d.firmware} < baseline ${d.baseline}`)];
      } else if (!d.baseline && d.baselineRule !== 'none') {
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

  /** Firmware compliance, warranty and lifecycle roll-up for the Lifecycle tab, against each customer's baseline. */
  lifecycle(devs, customerIds = null) {
    const count = (fn) => devs.reduce((acc, d) => { const k = fn(d); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const models = new Map();
    for (const d of devs) {
      const k = d.modelId || `x|${d.make}|${d.model}`;
      if (!models.has(k)) models.set(k, { modelId: d.modelId, make: d.make, model: d.model, deviceType: d.deviceType, baseline: d.baseline, advisory: d.advisoryBaseline, targets: {}, drift: {}, lifecycle: d.lifecycle, total: 0, behind: 0, behindAdvisory: 0, versions: {} });
      const m = models.get(k);
      m.total++;
      if (d.firmwareStatus === 'behind') m.behind++;
      if (d.advisoryStatus === 'behind') m.behindAdvisory++;
      if (d.baseline) m.targets[d.baseline] = (m.targets[d.baseline] || 0) + 1;
      if (d.baselineDrift) m.drift[d.baselineDrift] = (m.drift[d.baselineDrift] || 0) + 1;
      if (d.firmware) m.versions[d.firmware] = (m.versions[d.firmware] || 0) + 1;
    }
    // One target per model when every device in scope shares it (e.g. one customer).
    for (const m of models.values()) { const t = Object.keys(m.targets); m.baseline = t.length === 1 ? t[0] : null; m.mixedTargets = t.length > 1; }
    const attention = devs.filter((d) => !d.compliance?.ok || (d.policy?.warrantyRequired && d.warrantyStatus === 'expiring') || d.lifecycle?.stage === 'soon');
    const ids = customerIds || [...new Set(devs.map((d) => d.customerId))];
    const perCustomer = new Map();
    for (const d of devs) { if (!perCustomer.has(d.customerId)) perCustomer.set(d.customerId, []); perCustomer.get(d.customerId).push(d); }
    const baselines = ids.map((id) => {
      const cb = this.store.customerBaseline(id);
      const mine = perCustomer.get(id) || [];
      return {
        customerId: id, customerName: this.store.customerName(id),
        version: cb?.version ?? 0, level: cb?.level ?? 'advisory', exceptions: Object.keys(cb?.models || {}).length,
        policy: this.store.effectivePolicy(id), policySource: cb?.policy ? 'customer' : 'advisory',
        updatedAt: cb?.createdAt ?? null, updatedBy: cb?.createdBy?.email ?? null,
        devices: mine.length, compliant: mine.filter((d) => d.compliance?.ok).length,
        meetsCustomerBelowAdvisory: mine.filter((d) => d.firmwareStatus !== 'behind' && d.advisoryStatus === 'behind').length,
      };
    });
    return {
      total: devs.length,
      firmware: count((d) => d.firmwareStatus),
      advisoryFirmware: count((d) => d.advisoryStatus || 'none'),
      drift: count((d) => d.baselineDrift || 'none'),
      compliance: { ok: devs.filter((d) => d.compliance?.ok).length, firmware: devs.filter((d) => d.compliance && !d.compliance.firmware).length, warranty: devs.filter((d) => d.compliance && !d.compliance.warranty).length, lifecycle: devs.filter((d) => d.compliance && !d.compliance.lifecycle).length },
      warranty: count((d) => d.warrantyStatus),
      lifecycle: count((d) => d.lifecycle?.stage || 'unknown'),
      baselines,
      advisory: { version: this.store.advisoryVersion(), policy: this.store.advisoryPolicy() },
      models: [...models.values()].sort((a, b) => b.behind - a.behind || b.total - a.total),
      attention: attention.slice(0, 500),
      attentionTotal: attention.length,
    };
  }

  /** Devices of the given customers, in inventory order, without scanning the whole estate for a small scope. */
  scoped(allowed) {
    const ids = [...new Set(allowed)];
    if (ids.length * 2 > this.byCustomer.size) { const set = new Set(ids); return this.devices.filter((d) => set.has(d.customerId)); }
    return ids.sort().flatMap((cid) => this.byCustomer.get(cid) ?? []);
  }

  /** Devices visible to the given customers, after applying filters. */
  query(allowed, f = {}) {
    const list = (v) => (v ? String(v).split(',').filter(Boolean) : null);
    const filters = Object.entries({
      customerId: list(f.customer), region: list(f.region), site: list(f.site), platform: list(f.platform),
      deviceType: list(f.deviceType), health: list(f.health),
      firmwareStatus: list(f.firmwareStatus), warrantyStatus: list(f.warrantyStatus),
    }).filter(([, v]) => v).map(([k, v]) => [k, new Set(v)]);
    const oems = list(f.oem);
    const q = f.q ? String(f.q).toLowerCase() : null;
    const custFilter = filters.find(([k]) => k === 'customerId')?.[1];
    const base = this.scoped(custFilter ? allowed.filter((id) => custFilter.has(id)) : allowed);
    if (!filters.length && !oems && !f.room && !q) return base;
    return base.filter((d) => {
      for (const [k, vals] of filters) if (!vals.has(d[k])) return false;
      if (oems && !d.oems.some((o) => oems.includes(o))) return false;
      if (f.room && d.room !== f.room) return false;
      if (q && ![d.model, d.room, d.site, d.serial, d.make, d.customerName, d.hostName, d.assetTag, ...(d.tags || []), ...(d.errorCodes || [])].some((x) => x && String(x).toLowerCase().includes(q))) return false;
      return true;
    });
  }

  /** Memoise a read until the inventory next changes. */
  cached(key, fn) {
    if (this.cache.has(key)) { const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); return v; }
    const v = fn();
    this.cache.set(key, v);
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    return v;
  }

  static filterKey(allowed, f = {}) {
    const keys = ['customer', 'region', 'site', 'room', 'platform', 'oem', 'deviceType', 'health', 'firmwareStatus', 'warrantyStatus', 'q'];
    return `${[...allowed].sort().join(',')}|${keys.map((k) => f[k] ?? '').join('|')}`;
  }

  /**
   * One page of devices, sorted on the server: { items, total, offset, limit, sort, dir, builtAt }.
   * Items are the lightweight list form (see listItem); fetch /api/devices/:id for everything.
   */
  page(allowed, f = {}, { sort = null, dir = 1, offset = 0, limit = 100 } = {}) {
    const key = `page|${Inventory.filterKey(allowed, f)}|${sort}|${dir}`;
    const rows = this.cached(key, () => {
      const list = this.query(allowed, f);
      const keyOf = SORTS[sort];
      if (!keyOf) return list;
      const decorated = list.map((d) => [keyOf(d), d]);
      decorated.sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0) * dir);
      return decorated.map((x) => x[1]);
    });
    const o = Math.max(0, Math.floor(offset) || 0);
    const n = Math.min(Math.max(1, Math.floor(limit) || 100), MAX_PAGE);
    return { items: rows.slice(o, o + n).map(listItem), total: rows.length, offset: o, limit: n, sort: SORTS[sort] ? sort : null, dir: dir < 0 ? -1 : 1, builtAt: this.builtAt };
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
      let g = m.get(k);
      if (!g) { g = { key: k, ...Object.fromEntries(HEALTH_ORDER.map((h) => [h, 0])), total: 0 }; m.set(k, g); }
      g[d.health]++; g.total++;
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }

  summary(devs, key = null) {
    const build = () => {
      const siteRegion = new Map();
      const rooms = new Set();
      const sites = new Set();
      let merged = 0;
      for (const d of devs) {
        if (!siteRegion.has(d.site)) siteRegion.set(d.site, d.region);
        rooms.add(`${d.customerId}|${d.site}|${d.room}`);
        sites.add(`${d.customerId}|${d.site}`);
        if (d.duplicateOf?.length) merged++;
      }
      return {
        totals: Inventory.healthCounts(devs),
        byOem: Inventory.groupCounts(devs, (d) => d.oems),
        byMake: Inventory.groupCounts(devs, (d) => d.make),
        byPlatform: Inventory.groupCounts(devs, (d) => d.platform),
        byCustomer: Inventory.groupCounts(devs, (d) => d.customerName),
        bySite: Inventory.groupCounts(devs, (d) => `${d.site}`).map((s) => ({ ...s, region: siteRegion.get(s.key) })),
        byType: Inventory.groupCounts(devs, (d) => d.deviceType),
        rooms: rooms.size,
        sites: sites.size,
        mergedDuplicates: merged,
        builtAt: this.builtAt,
      };
    };
    return key ? this.cached(`summary|${key}`, build) : build();
  }

  /**
   * Site -> room hierarchy for drill-down.
   * `configured` adds sites and rooms set up during onboarding that have no devices yet.
   * Rooms carry counts only; `withDevices` adds each room's devices (list form), which
   * callers ask for when the tree is narrowed to one site.
   */
  tree(devs, configured = null, { withDevices = true } = {}) {
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
      const siteHealth = Object.fromEntries(HEALTH_ORDER.map((h) => [h, 0]));
      siteHealth.total = 0;
      let siteWorst = 'none';
      const rooms = [...s.rooms.values()].map((r) => {
        const health = Inventory.healthCounts(r.devices);
        for (const h of HEALTH_ORDER) siteHealth[h] += health[h];
        siteHealth.total += health.total;
        const w = worst(r.devices);
        siteWorst = worse(siteWorst, w);
        const out = { room: r.room, platform: r.platform, hasSchematic: r.hasSchematic, deviceCount: r.devices.length, makes: [...new Set(r.devices.map((d) => d.make))], health, worst: w };
        if (withDevices) out.devices = r.devices;
        return out;
      });
      return { ...s, rooms: rooms.sort((a, b) => a.room.localeCompare(b.room)), health: siteHealth, worst: siteWorst };
    }).sort((a, b) => (a.customerName + a.site).localeCompare(b.customerName + b.site));
  }

  /** Sites with coordinates and health, for the map (room detail is fetched per site from the tree). */
  map(devs, configured) {
    return this.tree(devs, configured, { withDevices: false }).map((s) => {
      const info = this.store.siteInfo(s.customerId, s.site) || {};
      return {
        customerId: s.customerId, customerName: s.customerName, site: s.site, region: s.region, country: s.country,
        city: info.city, address: info.address, lat: info.lat ?? null, lng: info.lng ?? null,
        health: s.health, worst: s.worst, rooms: s.rooms.length,
      };
    });
  }

  filterOptions(allowed) {
    return this.cached(`filters|${[...allowed].sort().join(',')}`, () => this.buildFilterOptions(allowed));
  }

  buildFilterOptions(allowed) {
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
const WORST_RANK = { none: -2, unmonitored: -1, ...RANK };
const worse = (a, b) => (WORST_RANK[b] > WORST_RANK[a] ? b : a);
const MAX_PAGE = 500;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const HEALTH_SORT = { unmonitored: 0, healthy: 1, warning: 2, offline: 3, critical: 4 };

/** Server-side sort keys, matching the device table's columns. */
const SORTS = {
  health: (d) => HEALTH_SORT[d.health] ?? 0,
  device: (d) => `${d.make} ${d.model}`.toLowerCase(),
  deviceType: (d) => d.deviceType || '',
  customer: (d) => d.customerName || '',
  site: (d) => d.site || '',
  room: (d) => d.room || '',
  platform: (d) => d.platform || '',
  serial: (d) => d.serial || '',
  firmware: (d) => d.firmware || '',
  warranty: (d) => d.warrantyExpires || '',
  lastSeen: (d) => d.lastSeen || '',
  sources: (d) => d.oems.length,
};
export const SORT_KEYS = Object.keys(SORTS);

/** The fields a device list row needs. The full record (sources, diagnosis, lifecycle...) comes from /api/devices/:id. */
export function listItem(d) {
  return {
    id: d.id, customerId: d.customerId, customerName: d.customerName, region: d.region, site: d.site, room: d.room,
    deviceType: d.deviceType, make: d.make, model: d.model, serial: d.serial, firmware: d.firmware,
    firmwareStatus: d.firmwareStatus, baseline: d.baseline, warrantyStatus: d.warrantyStatus, warrantyExpires: d.warrantyExpires ?? null,
    health: d.health, healthReason: d.healthReason, lastSeen: d.lastSeen, platform: d.platform, platformSource: d.platformSource ?? null,
    oems: d.oems, mock: d.mock, tags: d.tags, errorCodes: d.errorCodes, manualId: d.manualId, modelId: d.modelId,
  };
}

function digest(devices) {
  return crypto.createHash('sha1').update(JSON.stringify(devices)).digest('base64');
}

function newestFirmware(devices) {
  const m = new Map();
  for (const d of devices) {
    if (!d.firmware) continue;
    const cur = m.get(d.model);
    if (!cur || compareVersions(d.firmware, cur) > 0) m.set(d.model, d.firmware);
  }
  return m;
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function worst(devs) {
  if (!devs.length) return 'none';
  devs = devs.filter((d) => d.health !== 'unmonitored');
  if (!devs.length) return 'unmonitored';
  return devs.reduce((w, d) => (RANK[d.health] > RANK[w] ? d.health : w), 'healthy');
}
