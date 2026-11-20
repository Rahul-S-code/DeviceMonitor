// Load test: a synthetic estate of 50,000 devices (100 customers, 400 connections).
// Checks that rebuilds are incremental, reads are paged and cached, and that
// payload sizes stay small however big the estate is. Time limits are generous
// so a slow CI machine passes; `npm run loadtest` prints the actual timings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { syntheticEstate, loadIntoApp } from './load/synthetic.js';

const N = Number(process.env.LOAD_DEVICES) || 50_000;
const ms = (f) => { const t = performance.now(); const r = f(); return [r, performance.now() - t]; };

async function bigApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-scale-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  const estate = syntheticEstate({ devices: N });
  loadIntoApp(ctx, estate);
  const [, buildMs] = ms(() => ctx.sync.refresh());
  const server = ctx.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'superadmin@provider.example', password: 'demo1234' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = async (p, opts = {}) => { const r = await fetch(`${base}${p}`, { ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) } }); return { status: r.status, headers: r.headers, text: await r.text() }; };
  return { ctx, estate, get, buildMs };
}

test(`load: ${N.toLocaleString()} devices build, page, summarise and map within budget`, { timeout: 120_000 }, async (t) => {
  const { ctx, get, buildMs } = await bigApp(t);
  const total = ctx.inventory.devices.length;
  assert.ok(total >= N * 0.95 && total <= N + 1000, `about ${N} devices after de-duplication (got ${total})`);
  assert.ok(buildMs < 15_000, `full build ${Math.round(buildMs)} ms`);

  // A page of 100 devices, sorted on the server: small and fast.
  let t0 = performance.now();
  const p1 = await get('/api/devices?limit=100&offset=0&sort=health&dir=desc');
  const firstPageMs = performance.now() - t0;
  const page = JSON.parse(p1.text);
  assert.equal(page.items.length, 100);
  assert.equal(page.total, total);
  assert.ok(p1.text.length < 150_000, `page payload ${p1.text.length} bytes`);
  assert.ok(firstPageMs < 3000, `first page ${Math.round(firstPageMs)} ms`);
  assert.equal(page.items[0].health, 'critical', 'worst health first when sorted descending');
  assert.ok(!('diagnosis' in page.items[0]) && !('sources' in page.items[0]), 'list rows are the light form');
  // Next page comes from the cached sort.
  t0 = performance.now();
  const p2 = JSON.parse((await get('/api/devices?limit=100&offset=100&sort=health&dir=desc')).text);
  assert.ok(performance.now() - t0 < 1000, 'cached page');
  assert.ok(!p2.items.some((d) => page.items.some((x) => x.id === d.id)), 'pages do not overlap');
  // Filters and search run on the server too.
  const crit = JSON.parse((await get('/api/devices?limit=50&health=critical')).text);
  assert.ok(crit.total > 0 && crit.items.every((d) => d.health === 'critical'));
  const search = JSON.parse((await get('/api/devices?limit=10&q=rally')).text);
  assert.ok(search.items.every((d) => /rally/i.test(d.model)));
  // Unpaged requests are capped so nobody downloads the whole estate by accident.
  const legacy = await get('/api/devices');
  assert.equal(legacy.headers.get('x-total-count'), String(total));
  assert.equal(JSON.parse(legacy.text).length, 5000);
  // Lookup by id (used for bulk actions on a selection across pages).
  const look = JSON.parse((await get('/api/devices/lookup', { method: 'POST', body: JSON.stringify({ ids: [page.items[0].id, p2.items[0].id, 'nope'] }) })).text);
  assert.equal(look.length, 2);

  // Summary, filters, map and the site list stay small.
  t0 = performance.now();
  const sum = JSON.parse((await get('/api/summary')).text);
  assert.ok(performance.now() - t0 < 5000);
  assert.equal(sum.totals.total, total);
  t0 = performance.now();
  await get('/api/summary');
  assert.ok(performance.now() - t0 < 500, 'summary is cached until the inventory changes');
  const map = await get('/api/map');
  assert.ok(map.text.length < 1_000_000, `map payload ${map.text.length} bytes (sites only, no devices)`);
  const tree = await get('/api/tree');
  assert.ok(!tree.text.includes('"devices":['), 'site list carries room counts, not devices');
  const one = JSON.parse(map.text).find((x) => x.health.total > 0);
  const site = JSON.parse((await get(`/api/tree?customer=${encodeURIComponent(one.customerId)}&site=${encodeURIComponent(one.site)}&devices=1`)).text);
  assert.equal(site.length, 1);
  assert.ok(site[0].rooms.some((r) => r.devices.length > 0), 'one site with its devices on request');
  const filters = JSON.parse((await get('/api/filters')).text);
  assert.equal(filters.customer.length, 100 + 1);
});

test('load: a sync that changes one connection rebuilds only its customer', { timeout: 120_000 }, async (t) => {
  const { ctx, estate } = await bigApp(t);
  const conn = estate.connections[0];
  const before = ctx.inventory.version;
  // Identical snapshot: nothing to rebuild.
  assert.equal(ctx.inventory.setConnectionDevices(conn.id, estate.snapshots.get(conn.id)), false);
  assert.equal(ctx.sync.refreshPending(), null);
  assert.equal(ctx.inventory.version, before);
  // One device goes offline: one customer is rebuilt, and one alert is raised.
  const snap = estate.snapshots.get(conn.id);
  const idx = snap.findIndex((d) => d.health === 'healthy' && ctx.inventory.get(d.id)?.health === 'healthy');
  const changed = snap.map((d, i) => (i === idx ? { ...d, health: 'offline', healthReason: 'Unplugged' } : d));
  const target = changed[idx];
  const newestBefore = ctx.store.data.alerts[0]?.id;
  assert.equal(ctx.inventory.setConnectionDevices(conn.id, changed), true);
  let result;
  const [, incMs] = ms(() => { result = ctx.inventory.rebuild(); ctx.sync.apply(result); });
  assert.deepEqual(result.customers, [conn.customerId]);
  assert.ok(result.devices.length < 1000, 'only that customer\'s devices were re-processed');
  assert.ok(incMs < 2000, `incremental rebuild ${Math.round(incMs)} ms`);
  assert.equal(ctx.inventory.get(target.id).health, 'offline');
  const fresh = ctx.store.data.alerts.slice(0, ctx.store.data.alerts.findIndex((a) => a.id === newestBefore));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].deviceId, target.id, 'the change raised one alert, for that device');
});

test('load: alerts and history stay bounded', { timeout: 120_000 }, async (t) => {
  const { ctx } = await bigApp(t);
  // The first build of a big estate raises an alert for every unhealthy device; retention caps the list.
  ctx.store.addAlerts(Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, at: new Date().toISOString(), customerId: 'cust-load-0', kind: 'device', message: 'x' })));
  assert.ok(ctx.store.data.alerts.length <= 10_000);
  // Old alerts fall off.
  ctx.store.data.alerts = [{ id: 'old', at: '2000-01-01T00:00:00.000Z', customerId: 'cust-load-0', message: 'old' }];
  ctx.store.addAlerts([{ id: 'new', at: new Date().toISOString(), customerId: 'cust-load-0', message: 'new' }]);
  assert.deepEqual(ctx.store.data.alerts.map((a) => a.id), ['new']);
  // History records transitions only: a second record of unchanged health writes nothing.
  ctx.history.flush();
  ctx.history.record(ctx.inventory.devices, () => false);
  assert.equal(ctx.history.dirty.size, 0, 'unchanged health is not rewritten');
});
