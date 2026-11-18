// Health history for SLA reporting.
//
// Each device keeps a list of health transitions [timeMs, health] recorded on
// every sync, in data/history.json, trimmed to RETAIN_DAYS. Devices that only
// come from mock connections use a deterministic simulated history instead,
// so the SLA tab has 30 days of data on a fresh demo (the UI says so).
//
// Availability: a device is available when healthy or warning, and
// unavailable when critical or offline. An incident is a continuous
// unavailable period; MTTR is the mean length of incidents that ended.
import fs from 'node:fs';
import path from 'node:path';
import { hash } from '../mock/estate.js';

const DAY = 86_400_000;
const RETAIN_DAYS = 35;
const SIM_STEP = 15 * 60_000;
const DOWN = new Set(['critical', 'offline']);

export const WINDOWS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

export class History {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'history.json');
    this.devices = {};
    try { this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8')).devices || {}; } catch { this.devices = {}; }
    this.timer = null;
    this.cache = new Map();
  }

  /** Record the current health of every device. `isMock(d)` marks simulated-history devices. */
  record(devices, isMock, now = Date.now()) {
    let changed = false;
    for (const d of devices) {
      let e = this.devices[d.id];
      if (!e) {
        e = this.devices[d.id] = { since: now, mock: !!isMock(d), t: [[now, d.health]] };
        changed = true;
        continue;
      }
      e.mock = !!isMock(d);
      if (e.t[e.t.length - 1]?.[1] !== d.health) { e.t.push([now, d.health]); changed = true; }
      e.seen = now;
    }
    if (changed) { this.prune(now); this.save(); }
  }

  prune(now = Date.now()) {
    const cutoff = now - RETAIN_DAYS * DAY;
    for (const [id, e] of Object.entries(this.devices)) {
      if ((e.seen ?? e.since) < cutoff) { delete this.devices[id]; continue; }
      const i = e.t.findIndex(([t]) => t >= cutoff);
      if (i > 1) e.t = [[cutoff, e.t[i - 1][1]], ...e.t.slice(i)];
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error(`[history] could not save: ${e.message}`); }
  }

  close() { clearTimeout(this.timer); this.timer = null; }

  /** Health segments [{start, end, health, simulated}] covering [from, to). */
  segments(id, from, to) {
    const e = this.devices[id];
    if (!e) return [];
    const out = [];
    if (e.mock) {
      // Mock devices: the whole window is simulated (deterministic, so cached
      // per 15-minute bucket). Recorded transitions are used once a device
      // comes from a live connection.
      const key = `${id}|${Math.floor(from / SIM_STEP)}|${Math.floor(to / SIM_STEP)}`;
      let sim = this.cache.get(key);
      if (!sim) {
        sim = simulatedSegments(id, from, to);
        if (this.cache.size > 5000) this.cache.clear();
        this.cache.set(key, sim);
      }
      return sim.map((x) => ({ ...x }));
    }
    for (let i = 0; i < e.t.length; i++) {
      const [t, h] = e.t[i];
      const end = Math.min(e.t[i + 1]?.[0] ?? to, to);
      const start = Math.max(t, from);
      if (end > start) out.push({ start, end, health: h, simulated: false });
    }
    return out;
  }

  /** Availability and incidents for one device over [from, to). */
  stats(id, from, to) {
    const segs = this.segments(id, from, to);
    let measured = 0; let down = 0; let simulated = false;
    const incidents = [];
    let open = null;
    for (const s of segs) {
      const len = s.end - s.start;
      measured += len;
      if (s.simulated) simulated = true;
      if (DOWN.has(s.health)) {
        down += len;
        if (open && open.end === s.start) { open.end = s.end; if (s.health === 'offline') open.health = 'offline'; }
        else { open = { start: s.start, end: s.end, health: s.health }; incidents.push(open); }
      } else open = null;
    }
    const lastEnd = segs[segs.length - 1]?.end;
    for (const inc of incidents) inc.ongoing = inc.end === lastEnd && DOWN.has(segs[segs.length - 1].health) && to >= Date.now() - 60_000;
    return { measured, down, incidents, simulated };
  }
}

/** SLA report for a set of devices. */
export function slaReport(history, devices, { window = '7d', now = Date.now(), targetFor }) {
  const span = WINDOWS[window] || WINDOWS['7d'];
  const from = now - span;
  const buckets = window === '24h' ? 24 : window === '7d' ? 7 : 30;
  const bucketLen = span / buckets;
  const trend = Array.from({ length: buckets }, (_, i) => ({ start: from + i * bucketLen, measured: 0, down: 0 }));
  const groups = { customer: new Map(), site: new Map(), room: new Map() };
  const add = (map, key, base, st) => {
    if (!map.has(key)) map.set(key, { ...base, measured: 0, down: 0, incidents: 0, repaired: 0, repairMs: 0, devices: 0 });
    const g = map.get(key);
    g.measured += st.measured; g.down += st.down; g.devices++;
    g.incidents += st.incidents.length;
    for (const i of st.incidents) if (!i.ongoing) { g.repaired++; g.repairMs += i.end - i.start; }
  };
  const total = { measured: 0, down: 0, incidents: 0, repaired: 0, repairMs: 0, devices: 0 };
  const perDevice = [];
  const incidents = [];
  let simulated = false;
  for (const d of devices) {
    if (d.health === 'unmonitored') continue; // manual devices have no health history
    const st = history.stats(d.id, from, now);
    if (!st.measured) continue;
    simulated ||= st.simulated;
    total.measured += st.measured; total.down += st.down; total.devices++;
    total.incidents += st.incidents.length;
    for (const i of st.incidents) {
      if (!i.ongoing) { total.repaired++; total.repairMs += i.end - i.start; }
      incidents.push({ deviceId: d.id, make: d.make, model: d.model, customerId: d.customerId, customerName: d.customerName, site: d.site, room: d.room, ...i, durationMin: Math.round((i.end - i.start) / 60_000) });
    }
    for (const s of history.segments(d.id, from, now)) {
      for (let b = Math.max(0, Math.floor((s.start - from) / bucketLen)); b < buckets && trend[b].start < s.end; b++) {
        const a = Math.max(s.start, trend[b].start);
        const z = Math.min(s.end, trend[b].start + bucketLen);
        if (z <= a) continue;
        trend[b].measured += z - a;
        if (DOWN.has(s.health)) trend[b].down += z - a;
      }
    }
    add(groups.customer, d.customerId, { customerId: d.customerId, name: d.customerName }, st);
    add(groups.site, `${d.customerId}|${d.site}`, { customerId: d.customerId, customerName: d.customerName, site: d.site, region: d.region }, st);
    add(groups.room, `${d.customerId}|${d.site}|${d.room}`, { customerId: d.customerId, customerName: d.customerName, site: d.site, room: d.room }, st);
    perDevice.push({ id: d.id, make: d.make, model: d.model, deviceType: d.deviceType, customerName: d.customerName, site: d.site, room: d.room, health: d.health, availability: pct(st), incidents: st.incidents.length, downtimeMin: Math.round(st.down / 60_000) });
  }
  const finish = (g) => {
    const target = targetFor(g.customerId);
    const availability = pct(g);
    return {
      ...g, availability, target, met: availability === null ? null : availability >= target,
      downtimeMin: Math.round(g.down / 60_000), mttrMin: g.repaired ? Math.round(g.repairMs / g.repaired / 60_000) : null,
      measured: undefined, down: undefined, repairMs: undefined,
    };
  };
  const customers = [...groups.customer.values()].map(finish).sort((a, b) => a.availability - b.availability);
  return {
    window, from: new Date(from).toISOString(), to: new Date(now).toISOString(), simulated,
    overall: {
      availability: pct(total), devices: total.devices, incidents: total.incidents,
      downtimeMin: Math.round(total.down / 60_000), mttrMin: total.repaired ? Math.round(total.repairMs / total.repaired / 60_000) : null,
      target: customers.length === 1 ? customers[0].target : null,
      customersMeeting: customers.filter((c) => c.met).length, customers: customers.length,
    },
    trend: trend.map((b) => ({ start: new Date(b.start).toISOString(), availability: b.measured ? round((1 - b.down / b.measured) * 100) : null })),
    byCustomer: customers,
    bySite: [...groups.site.values()].map(finish).sort((a, b) => a.availability - b.availability),
    worstRooms: [...groups.room.values()].map(finish).sort((a, b) => a.availability - b.availability).slice(0, 15),
    worstDevices: perDevice.sort((a, b) => a.availability - b.availability || b.incidents - a.incidents).slice(0, 15),
    incidents: incidents.sort((a, b) => b.start - a.start).slice(0, 100).map((i) => ({ ...i, start: new Date(i.start).toISOString(), end: new Date(i.end).toISOString() })),
  };
}

/**
 * Simulated health for mock devices at 15-minute resolution: rare incidents
 * of 15 minutes to 2 hours, plus a few chronically flaky devices. Gives a
 * realistic 99%+ estate with some customers missing a 99.5% target.
 */
export function simulatedSegments(id, from, to) {
  const w0 = Math.floor(from / SIM_STEP);
  const w1 = Math.ceil(to / SIM_STEP);
  const flaky = hash(`${id}|flaky`) < 0.03;
  const state = new Array(w1 - w0).fill('healthy');
  for (let w = w0 - 8; w < w1; w++) {
    const r = hash(`${id}|inc|${w}`);
    if (r >= (flaky ? 0.02 : 0.0009)) {
      if (w >= w0 && state[w - w0] === 'healthy' && hash(`${id}|warn|${w}`) < 0.01) state[w - w0] = 'warning';
      continue;
    }
    const h = r < (flaky ? 0.01 : 0.0004) ? 'critical' : 'offline';
    const len = 1 + Math.floor(hash(`${id}|len|${w}`) * 8);
    for (let k = Math.max(w, w0); k < Math.min(w + len, w1); k++) state[k - w0] = h;
  }
  const out = [];
  for (let i = 0; i < state.length; i++) {
    const start = Math.max((w0 + i) * SIM_STEP, from);
    const end = Math.min((w0 + i + 1) * SIM_STEP, to);
    if (end <= start) continue;
    const last = out[out.length - 1];
    if (last && last.health === state[i]) last.end = end; else out.push({ start, end, health: state[i], simulated: true });
  }
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;
function pct(g) { return g.measured ? round((1 - g.down / g.measured) * 100) : null; }
