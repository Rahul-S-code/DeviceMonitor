import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { validateSchematic, SCHEMATIC_TEMPLATES } from '../server/lib/schematic.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm2-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password = 'demo1234') => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login ${email}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    call.json = async (p, init) => (await call(p, init)).json();
    return call;
  };
  return { ctx, login };
}

test('every schematic template is valid', () => {
  for (const t of SCHEMATIC_TEMPLATES) assert.doesNotThrow(() => validateSchematic(t.schematic), t.id);
});

test('schematic validation rejects broken links and unknown kinds', () => {
  assert.throws(() => validateSchematic({ nodes: [{ id: 'a' }], links: [{ from: 'a', to: 'zz', cable: 'HDMI' }] }), /unknown item/);
  assert.throws(() => validateSchematic({ nodes: [{ id: 'a' }, { id: 'a' }] }), /Duplicate/);
  const v = validateSchematic({ nodes: [{ id: 'a', kind: 'rocket' }, { id: 'b', kind: 'display' }], links: [{ from: 'a', to: 'b', cable: 'Laser' }] });
  assert.equal(v.nodes[0].kind, 'peripheral');
  assert.equal(v.links[0].cable, 'Ethernet');
});

test('super admin onboards a customer whose user only sees that customer', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  assert.equal((await admin('/api/admin/customers')).status, 403, 'provider admin cannot onboard');
  const sup = await login('superadmin@provider.example');
  const res = await sup('/api/admin/customers', { method: 'POST', body: JSON.stringify({
    name: 'Contoso Group', platforms: ['Zoom'],
    sites: [{ name: 'Paris', region: 'EMEA', country: 'France', lat: 48.85, lng: 2.35, mockRooms: 3 }],
    users: [{ email: 'it@contoso.example', password: 'contoso-pass' }],
    connections: ['poly-lens', 'logitech-sync'],
    rooms: [{ site: 'Paris', room: 'Louvre 1', platform: 'Zoom', schematic: SCHEMATIC_TEMPLATES[0].schematic }],
  }) });
  assert.equal(res.status, 201);
  const c = await res.json();
  assert.ok(c.deviceCount > 0, 'mock devices generated from the onboarded sites');
  const user = await login('it@contoso.example', 'contoso-pass');
  const devs = await user.json('/api/devices');
  assert.ok(devs.length > 0 && devs.every((d) => d.customerId === c.id));
  const tree = await user.json('/api/tree');
  assert.ok(tree[0].rooms.some((r) => r.room === 'Louvre 1' && r.hasSchematic), 'pre-loaded room appears before it has devices');
  const map = await user.json('/api/map');
  assert.equal(map.length, 1);
  assert.equal(map[0].lat, 48.85);
});

test('admins can enter a customer and see only that estate', async (t) => {
  const { login } = await startApp(t);
  const sup = await login('superadmin@provider.example');
  await sup('/api/session/enter', { method: 'POST', body: JSON.stringify({ customerId: 'cust-northwind' }) });
  const me = await sup.json('/api/me');
  assert.equal(me.actingCustomerName, 'Northwind Retail');
  assert.ok((await sup.json('/api/devices')).every((d) => d.customerId === 'cust-northwind'));
  await sup('/api/session/exit', { method: 'POST' });
  assert.equal(new Set((await sup.json('/api/devices')).map((d) => d.customerId)).size, 3);
  const viewer = await login('it@helix.example');
  assert.equal((await viewer('/api/session/enter', { method: 'POST', body: JSON.stringify({ customerId: 'cust-northwind' }) })).status, 403);
});

test('bulk update groups devices into a room and can be reset', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const devs = (await admin.json('/api/devices?customer=cust-helix')).slice(0, 3);
  const ids = devs.map((d) => d.id);
  const r = await admin.json('/api/devices/bulk', { method: 'POST', body: JSON.stringify({ ids, set: { site: 'London HQ', room: 'War Room', platform: 'Zoom', addTags: ['VIP'] } }) });
  assert.equal(r.updated, 3);
  const after = await admin.json('/api/devices?room=War%20Room');
  assert.equal(after.length, 3);
  assert.ok(after.every((d) => d.platform === 'Zoom' && d.platformSource === 'manual' && d.tags.includes('VIP')));
  await admin('/api/devices/bulk', { method: 'POST', body: JSON.stringify({ ids, reset: true }) });
  assert.equal((await admin.json('/api/devices?room=War%20Room')).length, 0);
  // Customer viewers cannot bulk edit, and nobody can touch devices outside their scope.
  const viewer = await login('it@northwind.example');
  assert.equal((await viewer('/api/devices/bulk', { method: 'POST', body: JSON.stringify({ ids, set: { room: 'x' } }) })).status, 403);
});

test('room schematics are saved, validated and scoped', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const room = { customerId: 'cust-helix', site: 'London HQ', room: 'Test Room' };
  const bad = await admin('/api/rooms/schematic', { method: 'PUT', body: JSON.stringify({ ...room, schematic: { nodes: [{ id: 'a' }], links: [{ from: 'a', to: 'b' }] } }) });
  assert.equal(bad.status, 400);
  const ok = await admin('/api/rooms/schematic', { method: 'PUT', body: JSON.stringify({ ...room, schematic: SCHEMATIC_TEMPLATES[2].schematic }) });
  assert.equal(ok.status, 200);
  const q = `customerId=cust-helix&site=London%20HQ&room=Test%20Room`;
  assert.equal((await admin.json(`/api/rooms/schematic?${q}`)).nodes.length, SCHEMATIC_TEMPLATES[2].schematic.nodes.length);
  const other = await login('it@northwind.example');
  assert.equal((await other(`/api/rooms/schematic?${q}`)).status, 404);
});

test('mock data switch: a customer onboarded with it off has no devices, and switching it off clears mock devices', async (t) => {
  const { ctx, login } = await startApp(t);
  const sup = await login('superadmin@provider.example');
  const res = await sup('/api/admin/customers', { method: 'POST', body: JSON.stringify({
    name: 'Fabrikam', platforms: ['Zoom'], mockData: false,
    sites: [{ name: 'Leeds', region: 'EMEA', mockRooms: 5 }],
    connections: ['poly-lens', 'logitech-sync'],
  }) });
  assert.equal(res.status, 201);
  const c = await res.json();
  assert.equal(c.mockData, false);
  assert.equal(c.deviceCount, 0, 'no mock devices');
  assert.ok(c.connections.every((x) => x.status.mockOff && x.status.deviceCount === 0));
  assert.equal((await sup.json('/api/tree')).filter((s) => s.customerId === c.id).flatMap((s) => s.rooms).length, 0, 'no mock rooms');

  // A manual device still shows up.
  const add = await sup('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: c.id, site: 'Leeds', room: 'Board 1', make: 'Acme', model: 'Projector X', deviceType: 'Display', serial: 'FAB-1' }) });
  assert.ok(add.status === 201 || add.status === 200, `manual add ${add.status}`);

  // Switch mock data off on a demo customer: its mock devices and mock alerts go.
  const before = ctx.inventory.devices.filter((d) => d.customerId === 'cust-helix').length;
  assert.ok(before > 0);
  const off = await sup('/api/admin/customers/cust-helix', { method: 'PUT', body: JSON.stringify({ mockData: false }) });
  assert.equal(off.status, 200);
  const offBody = await off.json();
  assert.equal(offBody.mockData, false);
  assert.equal(offBody.deviceCount, 0);
  assert.ok(!ctx.store.data.alerts.some((a) => a.customerId === 'cust-helix' && a.kind === 'device'));
  assert.ok(ctx.inventory.devices.some((d) => d.customerId === 'cust-northwind'), 'other customers keep their mock data');

  // And back on.
  const on = await (await sup('/api/admin/customers/cust-helix', { method: 'PUT', body: JSON.stringify({ mockData: true }) })).json();
  assert.equal(on.deviceCount, before);
  assert.equal(ctx.inventory.devices.filter((d) => d.customerId === c.id).length, 1, 'manual device kept with mock data off');
});
