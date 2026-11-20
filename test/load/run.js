// Prints timings for a synthetic estate: `npm run loadtest` (LOAD_DEVICES=100000 for more).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../../server/index.js';
import { syntheticEstate, loadIntoApp } from './synthetic.js';

const N = Number(process.env.LOAD_DEVICES) || 50_000;
const rows = [];
const time = (label, fn) => { const t = performance.now(); const r = fn(); rows.push([label, `${Math.round(performance.now() - t)} ms`]); return r; };

process.env.MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-load-'));
const ctx = createApp({ dataDir, autoStart: false });
const estate = time('generate synthetic estate', () => syntheticEstate({ devices: N }));
loadIntoApp(ctx, estate);
time('full build (dedupe + enrich, all customers)', () => ctx.sync.refresh());
const allowed = ctx.store.customers.map((c) => c.id);
const conn = estate.connections[0];
const changed = estate.snapshots.get(conn.id).map((d, i) => (i === 0 ? { ...d, health: d.health === 'offline' ? 'healthy' : 'offline' } : d));
time('one connection changed: incremental rebuild', () => { ctx.inventory.setConnectionDevices(conn.id, changed); ctx.sync.refreshPending(); });
time('identical snapshot: no rebuild', () => { ctx.inventory.setConnectionDevices(conn.id, changed); ctx.sync.refreshPending(); });
const page = time('first page, sorted by health', () => ctx.inventory.page(allowed, {}, { sort: 'health', dir: -1, limit: 100 }));
time('next page (cached sort)', () => ctx.inventory.page(allowed, {}, { sort: 'health', dir: -1, offset: 100, limit: 100 }));
time('search "rally", first page', () => ctx.inventory.page(allowed, { q: 'rally' }, { limit: 100 }));
time('summary (uncached)', () => ctx.inventory.summary(ctx.inventory.query(allowed, {})));
time('map (sites only)', () => ctx.inventory.map(ctx.inventory.query(allowed, {})));
time('filters', () => ctx.inventory.filterOptions(allowed));
time('lifecycle', () => ctx.inventory.lifecycle(ctx.inventory.query(allowed, {})));
const mem = process.memoryUsage();
console.log(`\n${ctx.inventory.devices.length.toLocaleString()} devices · ${estate.customers.length} customers · ${estate.connections.length} connections\n`);
for (const [l, v] of rows) console.log(`${l.padEnd(46)} ${v.padStart(8)}`);
console.log(`${'page payload (100 rows)'.padEnd(46)} ${`${Math.round(JSON.stringify(page).length / 1024)} KB`.padStart(8)}`);
console.log(`${'heap used'.padEnd(46)} ${`${Math.round(mem.heapUsed / 1e6)} MB`.padStart(8)}`);
ctx.sync.stop(); ctx.store.close(); ctx.history.close();
fs.rmSync(dataDir, { recursive: true, force: true });
