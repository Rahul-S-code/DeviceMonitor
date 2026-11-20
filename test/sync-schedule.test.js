// Sync schedule: admin-configurable intervals (global default + per connection),
// validation, staggering, concurrency, timeouts and back-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { cleanInterval, SYNC_LIMITS } from '../server/services/sync.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-sync-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const f = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    f.json = async (p, init) => (await f(p, init)).json();
    return f;
  };
  return { ctx, login, dataDir };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('interval validation: whole seconds between 1 minute and 24 hours, null = default', () => {
  assert.equal(cleanInterval(null), null);
  assert.equal(cleanInterval(''), null);
  assert.equal(cleanInterval(300), 300);
  assert.throws(() => cleanInterval(30), /at least 1 minute/);
  assert.throws(() => cleanInterval(90_000), /at most 24 hours/);
  assert.throws(() => cleanInterval(61.5), /whole number/);
  assert.throws(() => cleanInterval('soon'), /whole number/);
  assert.throws(() => cleanInterval(120, { min: 300 }), /at least 5 minutes/);
});

test('super admin sets the default interval; admins set per-connection intervals; customers cannot', async (t) => {
  const { ctx, login } = await startApp(t);
  const sup = await login('superadmin@provider.example');
  const admin = await login('admin@provider.example');
  const viewer = await login('it@demo.example');

  const s0 = await sup.json('/api/admin/sync');
  assert.equal(s0.defaultIntervalSec, SYNC_LIMITS.default);
  assert.equal(s0.defaultSource, 'built-in');
  assert.ok(s0.connections.length > 5 && s0.connections.every((c) => c.effectiveSec === SYNC_LIMITS.default && c.source === 'default'));
  assert.equal(s0.storage.kind, 'file');

  assert.equal((await viewer('/api/admin/sync')).status, 403);
  assert.equal((await admin('/api/admin/sync', { method: 'PUT', body: JSON.stringify({ defaultIntervalSec: 600 }) })).status, 403, 'only the super admin changes the default');
  assert.equal((await sup('/api/admin/sync', { method: 'PUT', body: JSON.stringify({ defaultIntervalSec: 10 }) })).status, 400, 'below the minimum');
  const s1 = await sup.json('/api/admin/sync', { method: 'PUT', body: JSON.stringify({ defaultIntervalSec: 600 }) });
  assert.equal(s1.defaultIntervalSec, 600);
  assert.equal(s1.defaultSource, 'admin');
  assert.ok(s1.connections.every((c) => c.effectiveSec === 600));
  assert.equal(ctx.store.syncSettings().defaultIntervalSec, 600, 'persisted in the store');

  const conn = s1.connections[0];
  assert.equal((await viewer(`/api/connections/${conn.id}/schedule`, { method: 'PUT', body: JSON.stringify({ syncIntervalSec: 120 }) })).status, 403);
  assert.equal((await admin(`/api/connections/${conn.id}/schedule`, { method: 'PUT', body: JSON.stringify({ syncIntervalSec: 5 }) })).status, 400);
  const c1 = await admin.json(`/api/connections/${conn.id}/schedule`, { method: 'PUT', body: JSON.stringify({ syncIntervalSec: 120 }) });
  assert.equal(c1.effectiveSec, 120);
  assert.equal(c1.source, 'connection');
  assert.equal(ctx.store.connections.find((c) => c.id === conn.id).syncIntervalSec, 120);
  // Connection list shows the interval too.
  const listed = (await admin.json('/api/connections')).find((c) => c.id === conn.id);
  assert.equal(listed.syncIntervalSec, 120);
  assert.equal(listed.status.intervalSec, 120);
  // Back to the default.
  const c2 = await admin.json(`/api/connections/${conn.id}/schedule`, { method: 'PUT', body: JSON.stringify({ syncIntervalSec: null }) });
  assert.equal(c2.effectiveSec, 600);
  assert.equal(c2.source, 'default');
  // Both changes are audited.
  const actions = (await sup.json('/api/audit')).entries.map((e) => e.action);
  assert.ok(actions.includes('sync.default_interval') && actions.includes('connection.sync_interval'));
  // Connection edit form can set it too.
  const put = await admin(`/api/connections/${conn.id}`, { method: 'PUT', body: JSON.stringify({ syncIntervalSec: 900 }) });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).syncIntervalSec, 900);
});

test('scheduler: first runs are staggered, concurrency is capped, slow syncs time out, failures back off', async (t) => {
  const { ctx } = await startApp(t);
  const { sync, store } = ctx;
  sync.stop();
  sync.concurrency = 2;
  sync.timeoutMs = 80;
  let active = 0; let peak = 0; let calls = 0;
  const slowId = store.connections[0].id;
  const failId = store.connections[1].id;
  sync.connectorFor = (conn) => ({
    sync: async () => {
      calls++;
      // The timed-out sync is abandoned (its slot is freed), so it isn't counted as running.
      const counted = conn.id !== slowId;
      if (counted) { active++; peak = Math.max(peak, active); }
      try {
        if (conn.id === slowId) await sleep(500);
        else await sleep(20);
        if (conn.id === failId) throw new Error('rate limited');
        return [];
      } finally { if (counted) active--; }
    },
  });
  // Staggering: never-synced connections start spread over 30 seconds, not all at once.
  sync.status.clear();
  sync.nextAt.clear();
  sync.started = false;
  sync.start();
  sync.stop();
  const offsets = store.connections.map((c) => sync.nextAt.get(c.id) - Date.now());
  assert.ok(offsets.every((o) => o <= 30_000 + 50));
  assert.ok(new Set(offsets.map((o) => Math.round(o / 1000))).size > 3, 'first runs are spread out');

  // Concurrency cap with everything due now.
  await sync.syncAll();
  assert.ok(peak <= 2, `at most 2 syncs at once (peak ${peak})`);
  assert.equal(calls, store.connections.length);
  assert.equal(sync.statusFor(slowId).state, 'error');
  assert.match(sync.statusFor(slowId).error, /did not finish syncing/);

  // Back-off: each failure pushes the next try further out (x2, x4...).
  const conn = store.connections.find((c) => c.id === failId);
  const base = sync.intervalInfo(conn).seconds * 1000;
  sync.failures.set(failId, 1); sync.planNext(conn);
  const one = sync.nextAt.get(failId) - Date.now();
  sync.failures.set(failId, 3); sync.planNext(conn);
  const three = sync.nextAt.get(failId) - Date.now();
  assert.ok(one >= base * 2 * 0.94 && three > one, `back-off grows (${one} -> ${three})`);
  assert.ok(three <= Math.max(base, 3_600_000) * 1.06, 'capped at an hour');
  // A healthy connection is planned one interval ahead (+-5% jitter).
  const okConn = store.connections[2];
  sync.failures.delete(okConn.id); sync.planNext(okConn);
  const next = sync.nextAt.get(okConn.id) - Date.now();
  const b2 = sync.intervalInfo(okConn).seconds * 1000;
  assert.ok(next > b2 * 0.94 && next < b2 * 1.06);
});

test('a connection snapshot is restored after a restart, before the first sync', async (t) => {
  const { ctx, dataDir } = await startApp(t);
  const total = ctx.inventory.devices.length;
  assert.ok(total > 0);
  assert.ok(fs.readdirSync(path.join(dataDir, 'snapshots')).length > 0, 'snapshots written');
  ctx.store.flush();
  const again = createApp({ dataDir, autoStart: false });
  t.after(() => { again.sync.stop(); again.store.close(); again.history.close(); });
  assert.equal(again.sync.restore(), ctx.store.connections.filter((c) => ctx.inventory.snapshot(c.id)?.devices.length || ctx.inventory.snapshot(c.id)).length);
  assert.equal(again.inventory.devices.length, total, 'same estate straight after restart');
  assert.ok(again.store.connections.every((c) => again.sync.statusFor(c.id).state === 'ok'));
});
