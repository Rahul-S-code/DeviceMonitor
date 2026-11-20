import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dedupeDevices } from '../server/services/dedupe.js';
import { makeDevice } from '../server/lib/device-model.js';
import { Vault } from '../server/lib/vault.js';
import { createApp } from '../server/index.js';
import { addSecondCustomer } from './fixtures.js';

const dev = (o) => makeDevice({ customerId: 'A', site: 'S', room: 'R', deviceType: 'Video bar', make: 'Poly', model: 'Poly Studio', health: 'healthy', ...o });

test('dedupe merges devices with the same serial', () => {
  const out = dedupeDevices([
    dev({ id: 'poly-lens:1', serial: '8L-ABC-123', sources: [{ oem: 'poly-lens', connectionId: 'c1', sourceId: '1' }] }),
    dev({ id: 'poly-lens:2', serial: '8labc123', health: 'offline', sources: [{ oem: 'poly-lens', connectionId: 'c2', sourceId: '2' }] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sources.length, 2);
  assert.equal(out[0].health, 'offline', 'most severe health wins');
});

test('dedupe merges a serial-less generic peripheral into the matching device in the same room', () => {
  const out = dedupeDevices([
    dev({ id: 'poly-lens:1', serial: '8LXYZ999', sources: [{ oem: 'poly-lens', connectionId: 'c1', sourceId: '1' }] }),
    dev({ id: 'logitech-sync:g', make: 'Poly', model: 'Poly Studio', weakIdentity: true, sources: [{ oem: 'logitech-sync', connectionId: 'c2', sourceId: 'g' }] }),
    dev({ id: 'logitech-sync:other', room: 'Other room', model: 'Poly Studio', weakIdentity: true, sources: [{ oem: 'logitech-sync', connectionId: 'c2', sourceId: 'o' }] }),
  ]);
  assert.equal(out.length, 2);
  const merged = out.find((d) => d.sources.length === 2);
  assert.equal(merged.id, 'poly-lens:1', 'the manufacturer cloud is the primary record');
  assert.deepEqual(merged.oems ?? merged.sources.map((s) => s.oem), ['poly-lens', 'logitech-sync']);
});

test('dedupe never merges across customers', () => {
  const out = dedupeDevices([
    dev({ id: 'a', serial: 'SAME1234', sources: [{ oem: 'poly-lens', connectionId: 'c1', sourceId: 'a' }] }),
    dev({ id: 'b', customerId: 'B', serial: 'SAME1234', sources: [{ oem: 'poly-lens', connectionId: 'c2', sourceId: 'b' }] }),
  ]);
  assert.equal(out.length, 2);
});

test('vault round-trips and rejects tampered ciphertext', () => {
  const v = new Vault(crypto.randomBytes(32));
  const box = v.encrypt({ clientSecret: 's3cret' });
  assert.ok(!JSON.stringify(box).includes('s3cret'));
  assert.deepEqual(v.decrypt(box), { clientSecret: 's3cret' });
  const bad = { ...box, data: Buffer.from('tampered').toString('base64') };
  assert.throws(() => v.decrypt(bad));
});

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
    return (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  };
  return { ctx, base, login };
}

test('customers only see their own devices, alerts and connections', async (t) => {
  const { base, login } = await startApp(t);
  assert.equal((await fetch(`${base}/api/devices`)).status, 401);
  const admin = await login('admin@provider.example');
  const all = await (await admin('/api/devices')).json();
  assert.equal(new Set(all.map((d) => d.customerId)).size, 2);

  const helix = await login('it@demo.example');
  const mine = await (await helix('/api/devices')).json();
  assert.ok(mine.length > 0);
  assert.ok(mine.every((d) => d.customerId === 'cust-demo'));
  // Asking for another customer via the filter returns nothing.
  assert.equal((await (await helix('/api/devices?customer=cust-northwind')).json()).length, 0);
  const other = all.find((d) => d.customerId !== 'cust-demo');
  assert.equal((await helix(`/api/devices/${encodeURIComponent(other.id)}`)).status, 404);
  const alerts = await (await helix('/api/alerts')).json();
  assert.ok(alerts.every((a) => a.customerId === 'cust-demo'));
  // End users don't see connections by default; technical users see status but no settings.
  assert.equal((await helix('/api/connections')).status, 403);
  const tech = await login('tech@demo.example');
  const conns = await (await tech('/api/connections')).json();
  assert.ok(conns.length && conns.every((c) => c.customerId === 'cust-demo'));
  assert.ok(conns.every((c) => c.settings === undefined && c.credentials === undefined));
  // Customer users cannot change connections.
  assert.equal((await tech(`/api/connections/${conns[0].id}`, { method: 'PUT', body: JSON.stringify({ mode: 'live' }) })).status, 403);
});

test('credentials are stored encrypted and never returned to the browser', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const conns = await (await admin('/api/connections')).json();
  const poly = conns.find((c) => c.oem === 'poly-lens');
  const res = await admin(`/api/connections/${poly.id}`, { method: 'PUT', body: JSON.stringify({ credentials: { clientId: 'my-client-id', clientSecret: 'super-secret-value' } }) });
  const body = await res.json();
  assert.equal(body.credentials.clientSecret, 'Stored');
  assert.ok(!JSON.stringify(body).includes('super-secret-value'));
  ctx.store.flush();
  const onDisk = fs.readFileSync(ctx.store.file, 'utf8');
  assert.ok(!onDisk.includes('super-secret-value'));
  assert.ok(!onDisk.includes('my-client-id'));
  assert.deepEqual(ctx.vault.decrypt(ctx.store.connections.find((c) => c.id === poly.id).secret), { clientId: 'my-client-id', clientSecret: 'super-secret-value' });
});

test('switching a connector to live without keys reports a sync error but keeps the dashboard data', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const conns = await (await admin('/api/connections')).json();
  const logi = conns.find((c) => c.oem === 'logitech-sync');
  const before = (await (await admin('/api/summary')).json()).totals.total;
  const updated = await (await admin(`/api/connections/${logi.id}`, { method: 'PUT', body: JSON.stringify({ mode: 'live' }) })).json();
  assert.equal(updated.status.state, 'error');
  assert.match(updated.status.error, /Missing Organization ID/);
  assert.equal((await (await admin('/api/summary')).json()).totals.total, before);
});

test('mock estate de-duplicates devices seen by both OEM clouds', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const summary = await (await admin('/api/summary')).json();
  assert.ok(summary.mergedDuplicates > 0);
  const devices = await (await admin('/api/devices')).json();
  assert.equal(devices.filter((d) => d.oems.length > 1).length, summary.mergedDuplicates);
  // The USB bar in mixed rooms is reported by both OEM clouds.
  const both = devices.filter((d) => d.oems.includes('poly-lens') && d.oems.includes('logitech-sync'));
  assert.ok(both.length > 0);
  assert.ok(both.every((d) => d.model === 'Poly Studio' && d.serial));
  // Platform portals (Zoom, Teams, Webex, Meet) report the same room systems; they merge
  // into the OEM record and never create a duplicate or an "Unassigned site".
  const platformOnly = devices.filter((d) => d.oems.every((o) => ['zoom-rooms', 'teams-rooms', 'webex-control-hub', 'google-meet-hardware'].includes(o)));
  assert.equal(platformOnly.length, 0);
  assert.ok(devices.every((d) => d.site !== 'Unassigned site'));
});
