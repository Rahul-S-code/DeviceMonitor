// Postgres storage. Runs only when TEST_DATABASE_URL points at a database it may
// wipe (tables are dropped first), e.g.
//   TEST_DATABASE_URL=postgres://user@localhost:5432/dmtest npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { PgPersistence } from '../server/lib/persistence.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

async function fresh() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: URL_ });
  await pool.query('DROP TABLE IF EXISTS app_state, device_history, connection_snapshots');
  await pool.end();
}

test('Postgres: store, history and snapshots survive a restart; only changed sections are written', { skip }, async (t) => {
  await fresh();
  process.env.MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pg-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const p1 = await PgPersistence.connect(URL_);
  const a = createApp({ dataDir, persistence: p1, autoStart: false });
  await a.sync.syncAll();
  const devices = a.inventory.devices.length;
  assert.ok(devices > 0);
  a.store.setSyncSettings({ defaultIntervalSec: 900 }, 'test');
  a.store.flush(); a.history.flush();
  await p1.flush();
  assert.equal(p1.errors, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'store.json')), false, 'nothing written to disk');

  // Only the changed section is written on the next save.
  const writes = [];
  a.store.setSyncSettings({ defaultIntervalSec: 1200 }, 'test');
  const spy = p1.pool.connect.bind(p1.pool);
  p1.pool.connect = async () => { const c = await spy(); const q = c.query.bind(c); c.query = (sql, args) => { if (/INSERT INTO app_state/.test(sql)) writes.push(args[0]); return q(sql, args); }; return c; };
  a.store.flush();
  await p1.flush();
  p1.pool.connect = spy;
  assert.deepEqual(writes, ['settings']);
  a.sync.stop(); a.store.close(); a.history.close();
  await p1.close();

  // Restart from the database alone.
  const p2 = await PgPersistence.connect(URL_);
  t.after(() => p2.close());
  const b = createApp({ dataDir, persistence: p2, autoStart: false });
  assert.equal(b.store.syncSettings().defaultIntervalSec, 1200);
  assert.equal(b.store.customers.length, a.store.customers.length);
  assert.ok(Object.keys(b.history.devices).length > 0, 'history loaded');
  assert.ok(b.sync.restore() > 0, 'snapshots restored');
  assert.equal(b.inventory.devices.length, devices, 'estate is back before any sync');
  b.sync.stop(); b.store.close(); b.history.close();
});

test('Postgres: an existing file store is imported on first start', { skip }, async (t) => {
  await fresh();
  process.env.MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pgimp-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const fileApp = createApp({ dataDir, autoStart: false });
  await fileApp.sync.syncAll();
  fileApp.store.setSyncSettings({ defaultIntervalSec: 1800 });
  fileApp.store.flush(); fileApp.history.flush();
  fileApp.sync.stop(); fileApp.store.close(); fileApp.history.close();

  const p = await PgPersistence.connect(URL_, { importFrom: dataDir });
  t.after(() => p.close());
  const app = createApp({ dataDir, persistence: p, autoStart: false });
  assert.equal(app.store.syncSettings().defaultIntervalSec, 1800);
  assert.equal(app.store.customers.length, fileApp.store.customers.length);
  assert.ok(app.sync.restore() > 0);
  app.sync.stop(); app.store.close(); app.history.close();
});

test('Postgres: an existing database moves to five-tier roles and a default MSP', { skip }, async (t) => {
  await fresh();
  process.env.MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pg7-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // A database written before phase 7: provider admin, customer viewer, no MSPs.
  const p0 = await PgPersistence.connect(URL_);
  const legacy = {
    customers: [{ id: 'cust-real', name: 'Real Co', mockData: false }],
    users: [
      { id: 'u-admin', email: 'admin@provider.example', role: 'provider_admin', customerId: null, password: 'x' },
      { id: 'u-real', email: 'it@real.example', role: 'customer_viewer', customerId: 'cust-real', password: 'x' },
    ],
    connections: [], phase3: true, phase5: true, phase6: true,
  };
  p0.saveStore(legacy);
  await p0.flush();
  await p0.close();

  const p1 = await PgPersistence.connect(URL_);
  const a = createApp({ dataDir, persistence: p1, autoStart: false });
  a.store.flush();
  await p1.flush();
  a.sync.stop(); a.store.close(); a.history.close();
  await p1.close();

  const p2 = await PgPersistence.connect(URL_);
  t.after(() => p2.close());
  const s = p2.storeData;
  assert.deepEqual(s.msps.map((m) => m.id), ['msp-default']);
  assert.equal(s.customers.find((c) => c.id === 'cust-real').mspId, 'msp-default');
  assert.equal(s.users.find((u) => u.id === 'u-admin').role, 'msp_admin');
  assert.equal(s.users.find((u) => u.id === 'u-admin').mspId, 'msp-default');
  assert.equal(s.users.find((u) => u.id === 'u-real').role, 'end_user');
  assert.equal(s.phase7, true);
});
