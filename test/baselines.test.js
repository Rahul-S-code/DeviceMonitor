import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { addSecondCustomer, SECOND } from './fixtures.js';
import { resolveFirmware, cleanCustomerBaseline, lifecycleBreach } from '../server/lib/baselines.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  addSecondCustomer(ctx.store);
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return (p, init = {}) => fetch(base + p, { ...init, body: init.body ? JSON.stringify(init.body) : undefined, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  };
  return { ctx, login };
}

test('firmware target resolves from advisory, highest level, pinned version or not enforced', () => {
  const m = { id: 'm1', baseline: '2.0.0', releases: [{ version: '3.1.0' }, { version: '2.0.0' }, { version: '1.5.0' }] };
  assert.deepEqual([resolveFirmware(m, null).target, resolveFirmware(m, null).drift], ['2.0.0', 'same']);
  assert.deepEqual([resolveFirmware(m, { level: 'latest', models: {} }).target, resolveFirmware(m, { level: 'latest', models: {} }).drift], ['3.1.0', 'above']);
  const low = resolveFirmware(m, { level: 'advisory', models: { m1: '1.5.0' } });
  assert.equal(low.target, '1.5.0'); assert.equal(low.drift, 'below'); assert.equal(low.source, 'customer');
  assert.equal(resolveFirmware(m, { level: 'latest', models: { m1: 'none' } }).drift, 'not-enforced');
  assert.equal(resolveFirmware(m, { level: 'latest', models: { m1: 'advisory' } }).target, '2.0.0');
  assert.throws(() => cleanCustomerBaseline({ level: 'gold' }, new Set()), /Level/);
  assert.throws(() => cleanCustomerBaseline({ models: { nope: '1.0' } }, new Set(['m1'])), /model master/);
  assert.deepEqual(cleanCustomerBaseline({ level: 'latest', models: { m1: 'latest' } }, new Set(['m1'])).models, {}, 'same as default needs no exception');
  assert.equal(lifecycleBreach('eos', 'eos'), true);
  assert.equal(lifecycleBreach('eosale', 'eos'), false);
  assert.equal(lifecycleBreach('eol', 'none'), false);
});

test('customer baselines are versioned, per customer, and drive compliance with drift from advisory', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const viewer = await login('it@demo.example');
  const dev = ctx.inventory.devices.find((d) => d.customerId === 'cust-demo' && d.modelId && d.firmware && d.advisoryBaseline);
  const model = ctx.store.models.find((m) => m.id === dev.modelId);

  // Version 0: follows the advisory.
  let r = await (await viewer('/api/baselines/customers/cust-demo')).json();
  assert.equal(r.current.version, 0);
  assert.equal(r.policySource, 'advisory');
  assert.equal((await viewer('/api/baselines/customers/cust-demo', { method: 'POST', body: { level: 'latest' } })).status, 403, 'customer viewers read only');
  assert.equal((await viewer(`/api/baselines/customers/${SECOND.id}`)).status, 404, 'other customers hidden');

  // Pin this model above whatever the device runs: the device falls below the customer's baseline
  // while its advisory status is unchanged.
  const pin = `${dev.firmware.split('.')[0] * 1 + 50}.0.0`;
  let res = await admin('/api/baselines/customers/cust-demo', { method: 'POST', body: { level: 'advisory', models: { [model.id]: pin }, policy: { warrantyRequired: false, warrantyNoticeDays: 30, lifecycleLimit: 'eol' }, note: 'Stricter for exec rooms' } });
  assert.equal(res.status, 200);
  r = await res.json();
  assert.equal(r.current.version, 1);
  assert.equal(r.policySource, 'customer');
  const row = r.models.find((m) => m.id === model.id);
  assert.equal(row.target, pin); assert.equal(row.drift, 'above');
  let d = ctx.inventory.devices.find((x) => x.id === dev.id);
  assert.equal(d.baseline, pin);
  assert.equal(d.firmwareStatus, 'behind');
  assert.equal(d.advisoryStatus, dev.advisoryStatus);
  assert.equal(d.compliance.firmware, false);
  assert.equal(d.policy.warrantyNoticeDays, 30);
  // The other customer is untouched.
  const other = ctx.inventory.devices.find((x) => x.customerId === SECOND.id && x.modelId === model.id);
  if (other) assert.equal(other.baseline, model.baseline);

  // Lifecycle tab reports the customer's baseline.
  const lc = await (await viewer('/api/lifecycle')).json();
  assert.equal(lc.baselines.length, 1);
  assert.equal(lc.baselines[0].version, 1);
  assert.ok(lc.attention.some((x) => x.id === dev.id));

  // Save v2 (highest), then restore v1 as v3.
  r = await (await admin('/api/baselines/customers/cust-demo', { method: 'POST', body: { level: 'latest' } })).json();
  assert.equal(r.current.version, 2);
  assert.equal(r.current.level, 'latest');
  r = await (await admin('/api/baselines/customers/cust-demo/restore', { method: 'POST', body: { version: 1 } })).json();
  assert.equal(r.current.version, 3);
  assert.equal(r.versions.length, 3);
  assert.equal(r.models.find((m) => m.id === model.id).target, pin);
  const v1 = await (await viewer('/api/baselines/customers/cust-demo?version=1')).json();
  assert.equal(v1.current.note, 'Stricter for exec rooms');

  // Advisory policy: super admin only, versioned, and customers without their own policy follow it.
  assert.equal((await admin('/api/baselines/advisory', { method: 'PUT', body: { policy: { warrantyNoticeDays: 60 } } })).status, 403);
  const sup = await login('superadmin@provider.example');
  res = await sup('/api/baselines/advisory', { method: 'PUT', body: { policy: { warrantyNoticeDays: 120 }, note: 'Longer notice' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 1);
  d = ctx.inventory.devices.find((x) => x.customerId === SECOND.id);
  assert.equal(d.policy.warrantyNoticeDays, 120);
  const audit = await (await admin('/api/audit?action=baseline.')).json();
  assert.ok(audit.entries.some((e) => e.action === 'baseline.customer_restore'));
});
