// Five-tier roles: super admin > MSP admin > customer admin > technical user > end user.
// MSP-to-MSP isolation, user management limits, the configurable permission matrix,
// the phase 7 migration and audit logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { Store } from '../server/lib/store.js';
import { resolveMatrix, DEFAULTS, ROLES } from '../server/lib/roles.js';
import { addSecondCustomer } from './fixtures.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmroles-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  addSecondCustomer(ctx.store);
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); ctx.apiTracker.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password = 'demo1234') => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login ${email}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
    call.json = async (p) => (await call(p)).json();
    call.send = (method, p, body) => call(p, { method, body: JSON.stringify(body ?? {}) });
    return call;
  };
  return { ctx, base, login };
}

/** A second MSP with its own admin and one onboarded customer. */
async function secondMsp(login) {
  const sup = await login('superadmin@provider.example');
  const m = await (await sup.send('POST', '/api/admin/msps', { name: 'Acme Managed Services' })).json();
  assert.ok(m.id);
  const u = await sup.send('POST', '/api/users', { email: 'ops@acme-msp.example', name: 'Acme Ops', password: 'acme-pass-1', role: 'msp_admin', mspId: m.id });
  assert.equal(u.status, 201);
  const acme = await login('ops@acme-msp.example', 'acme-pass-1');
  const res = await acme.send('POST', '/api/admin/customers', {
    name: 'Globex', platforms: ['Zoom'], mspId: 'msp-default', // ignored: MSP admins always onboard into their own MSP
    sites: [{ name: 'Berlin', region: 'EMEA', country: 'Germany', lat: 52.52, lng: 13.4, mockRooms: 2 }],
    users: [{ email: 'it@globex.example', password: 'globex-pass', role: 'customer_admin' }],
    connections: ['poly-lens'],
  });
  assert.equal(res.status, 201);
  const globex = await res.json();
  assert.equal(globex.mspId, m.id);
  return { sup, acme, msp: m, globex };
}

test('MSP admins only ever see their own MSP\'s customers, users and audit entries', async (t) => {
  const { ctx, login } = await startApp(t);
  const { acme, msp, globex } = await secondMsp(login);
  const dflt = await login('admin@provider.example');
  const leaks = (body, words) => words.some((w) => body.includes(w));

  // Default MSP admin: no Globex anywhere.
  for (const p of ['/api/customers', '/api/devices', '/api/admin/customers', '/api/connections', '/api/alerts?limit=500', '/api/filters', '/api/users', '/api/audit?limit=2000', '/api/admin/sync', '/api/tree', '/api/map', '/api/sla', '/api/lifecycle']) {
    const body = JSON.stringify(await dflt.json(p));
    assert.ok(!leaks(body, [globex.id, 'Globex', 'ops@acme-msp.example']), `${p} leaks the other MSP to the default MSP admin`);
  }
  // Acme admin: none of the default MSP's customers.
  for (const p of ['/api/customers', '/api/devices', '/api/admin/customers', '/api/connections', '/api/alerts?limit=500', '/api/filters', '/api/users', '/api/audit?limit=2000', '/api/admin/sync', '/api/tree', '/api/sla']) {
    const body = JSON.stringify(await acme.json(p));
    assert.ok(!leaks(body, ['cust-demo', 'cust-northwind', 'Northwind', 'it@demo.example']), `${p} leaks the default MSP to Acme`);
  }
  const theirDevice = ctx.inventory.forCustomer('cust-demo')[0];
  const theirConn = ctx.store.connections.find((c) => c.customerId === 'cust-demo');
  assert.equal((await acme(`/api/devices/${encodeURIComponent(theirDevice.id)}`)).status, 404);
  assert.equal((await acme.send('POST', '/api/session/enter', { customerId: 'cust-demo' })).status, 400);
  assert.equal((await acme.send('PUT', `/api/admin/customers/cust-demo`, { name: 'x' })).status, 404);
  assert.equal((await acme('/api/admin/customers/cust-demo', { method: 'DELETE' })).status, 404);
  assert.equal((await acme.send('PUT', `/api/connections/${theirConn.id}`, { name: 'x' })).status, 404);
  assert.equal((await acme.send('POST', `/api/connections`, { customerId: 'cust-demo', oem: 'poly-lens' })).status, 400);
  assert.equal((await acme.send('POST', '/api/users', { email: 'x@y.example', password: 'longenough', role: 'end_user', customerId: 'cust-demo' })).status, 403);
  const demoUser = ctx.store.users.find((u) => u.email === 'it@demo.example');
  assert.equal((await acme(`/api/users/${demoUser.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await acme('/api/roles?layer=customer&id=cust-demo')).status, 404);
  assert.equal((await acme('/api/roles?layer=msp&id=msp-default')).status, 404);
  assert.equal((await acme.send('PUT', '/api/roles', { layer: 'msp', id: 'msp-default', overrides: { end_user: { 'service.view': false } } })).status, 403);
  // MSP admins can't create MSPs, other MSP admins, or touch the model master.
  assert.equal((await acme.send('POST', '/api/admin/msps', { name: 'Rogue' })).status, 403);
  assert.equal((await acme.send('POST', '/api/users', { email: 'z@acme.example', password: 'longenough', role: 'msp_admin', mspId: msp.id })).status, 403);
  assert.equal((await acme.send('POST', '/api/models', { make: 'X', model: 'Y' })).status, 403);
  // The super admin sees both.
  const sup = await login('superadmin@provider.example');
  const all = (await sup.json('/api/admin/customers')).map((c) => c.id);
  assert.ok(all.includes(globex.id) && all.includes('cust-demo'));
  // Globex's own customer admin sees only Globex.
  const gx = await login('it@globex.example', 'globex-pass');
  const devs = await gx.json('/api/devices');
  assert.ok(devs.length && devs.every((d) => d.customerId === globex.id));
});

test('each level creates users only below itself, inside its own scope', async (t) => {
  const { ctx, login } = await startApp(t);
  const cadmin = await login('admin@demo.example');
  const me = await cadmin.json('/api/me');
  assert.equal(me.role, 'customer_admin');
  assert.ok(me.permissions.includes('users.manage'));
  const mk = (body) => cadmin.send('POST', '/api/users', { password: 'longenough', ...body });
  assert.equal((await mk({ email: 'eng@demo.example', role: 'technical_user', customerId: 'cust-demo' })).status, 201);
  assert.equal((await mk({ email: 'joe@demo.example', role: 'end_user', customerId: 'cust-demo' })).status, 201);
  assert.equal((await mk({ email: 'boss@demo.example', role: 'customer_admin', customerId: 'cust-demo' })).status, 403, 'not at its own level');
  assert.equal((await mk({ email: 'x@nw.example', role: 'end_user', customerId: 'cust-northwind' })).status, 403, 'not in another customer');
  assert.equal((await mk({ email: 'm@demo.example', role: 'msp_admin', mspId: 'msp-default' })).status, 403);
  // It can't change a peer, or promote a user to its own level.
  const peer = ctx.store.users.find((u) => u.email === 'admin@demo.example');
  const eng = ctx.store.users.find((u) => u.email === 'eng@demo.example');
  assert.equal((await cadmin.send('PUT', `/api/users/${eng.id}`, { role: 'customer_admin' })).status, 403);
  assert.equal((await cadmin.send('PUT', `/api/users/${eng.id}`, { role: 'end_user' })).status, 200);
  assert.equal((await cadmin.send('PUT', `/api/users/${peer.id}`, { name: 'Me' })).status, 404, 'cannot edit itself');
  // Disabling a user stops them signing in.
  const joe = ctx.store.users.find((u) => u.email === 'joe@demo.example');
  assert.equal((await cadmin.send('PUT', `/api/users/${joe.id}`, { disabled: true })).status, 200);
  // Technical and end users can't manage users at all.
  const tech = await login('tech@demo.example');
  assert.equal((await tech('/api/users')).status, 403);
  assert.equal((await tech.send('POST', '/api/users', { email: 'q@demo.example', password: 'longenough', role: 'end_user', customerId: 'cust-demo' })).status, 403);
  // Everything is in the audit log, visible to the customer admin.
  const log = await cadmin.json('/api/audit?action=user.');
  const actions = log.entries.map((e) => e.action);
  for (const a of ['user.create', 'user.role_change', 'user.disable']) assert.ok(actions.includes(a), a);
  assert.ok(log.entries.every((e) => e.customerId === 'cust-demo'));
});

test('disabled users cannot sign in', async (t) => {
  const { ctx, base } = await startApp(t);
  ctx.store.users.find((u) => u.email === 'tech@demo.example').disabled = true;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'tech@demo.example', password: 'demo1234' }) });
  assert.equal(res.status, 401);
});

test('default permissions follow the role descriptions', async (t) => {
  const { ctx, login } = await startApp(t);
  const dev = ctx.inventory.forCustomer('cust-demo').find((d) => d.sources.some((s) => s.oem === 'poly-lens'));
  const end = await login('it@demo.example');
  const tech = await login('tech@demo.example');
  const cadmin = await login('admin@demo.example');
  const id = encodeURIComponent(dev.id);
  // End user: read only, can report an issue.
  assert.equal((await end(`/api/devices/${id}`)).status, 200);
  assert.equal((await end(`/api/devices/${id}/actions`)).status, 403);
  assert.equal((await end.send('POST', '/api/devices/bulk', { ids: [dev.id], set: { notes: 'x' } })).status, 403);
  const rep = await end.send('POST', '/api/issues', { deviceId: dev.id, summary: 'Camera shows a black picture' });
  assert.equal(rep.status, 201);
  const alerts = await cadmin.json('/api/alerts');
  assert.ok(alerts.some((a) => a.kind === 'report' && a.message.includes('black picture')));
  // Technical user: diagnostics and actions, no device record edits, no admin.
  assert.equal((await tech(`/api/devices/${id}/actions`)).status, 200);
  assert.equal((await tech.send('POST', '/api/devices/bulk', { ids: [dev.id], set: { notes: 'x' } })).status, 403);
  assert.equal((await tech('/api/audit')).status, 403);
  // Customer admin: estate, sites and contacts, audit; no connections or baselines.
  assert.equal((await cadmin.send('POST', '/api/devices/bulk', { ids: [dev.id], set: { notes: 'x' } })).status, 200);
  const sites = await cadmin.send('PUT', '/api/customers/cust-demo/sites', { sites: [{ name: 'London HQ', region: 'EMEA', city: 'London', lat: 51.5, lng: -0.12 }] });
  assert.equal(sites.status, 200);
  assert.equal((await sites.json()).sites[0].city, 'London');
  assert.equal((await cadmin.send('PUT', '/api/customers/cust-northwind/sites', { sites: [] })).status, 404);
  assert.equal((await cadmin.send('POST', '/api/connections', { customerId: 'cust-demo', oem: 'poly-lens' })).status, 403);
  assert.equal((await cadmin.send('POST', '/api/baselines/customers/cust-demo', { level: 'latest' })).status, 403);
  assert.equal((await cadmin('/api/admin/customers')).status, 403);
});

test('permissions are configurable per layer, never above the editor\'s own', async (t) => {
  const { login } = await startApp(t);
  const cadmin = await login('admin@demo.example');
  const tech = await login('tech@demo.example');
  const dev = (await tech.json('/api/devices')).find((d) => d.oems.includes('poly-lens'));
  const id = encodeURIComponent(dev.id);
  const view = await cadmin.json('/api/roles');
  assert.equal(view.layer, 'customer');
  assert.equal(view.matrix.technical_user['devices.actions'].editable, true);
  assert.equal(view.matrix.customer_admin['devices.actions'].editable, false, 'cannot edit its own role');
  assert.equal(view.matrix.technical_user['connections.manage'].editable, false, 'cannot grant what it does not hold');
  // Turn remote actions off for technical users of this customer.
  const off = await cadmin.send('PUT', '/api/roles', { layer: 'customer', id: 'cust-demo', overrides: { technical_user: { 'devices.actions': false } } });
  assert.equal(off.status, 200);
  assert.equal((await tech(`/api/devices/${id}/actions`)).status, 403);
  // Granting something the editor lacks is refused.
  const bad = await cadmin.send('PUT', '/api/roles', { layer: 'customer', id: 'cust-demo', overrides: { technical_user: { 'connections.manage': true } } });
  assert.equal(bad.status, 400);
  // Its own row can't be changed (silently ignored) and the platform layer is super admin only.
  await cadmin.send('PUT', '/api/roles', { layer: 'customer', id: 'cust-demo', overrides: { customer_admin: { 'connections.manage': true } } });
  assert.ok(!(await cadmin.json('/api/me')).permissions.includes('connections.manage'));
  assert.equal((await cadmin.send('PUT', '/api/roles', { layer: 'platform', overrides: { end_user: { 'service.view': false } } })).status, 403);
  // The MSP admin removes record editing from customer admins; the customer layer can't hand it to technical users.
  const msp = await login('admin@provider.example');
  assert.equal((await msp.send('PUT', '/api/roles', { layer: 'msp', id: 'msp-default', overrides: { customer_admin: { 'estate.edit': false } } })).status, 200);
  assert.ok(!(await cadmin.json('/api/me')).permissions.includes('estate.edit'));
  assert.equal((await cadmin.send('PUT', '/api/roles', { layer: 'customer', id: 'cust-demo', overrides: { technical_user: { 'estate.edit': true } } })).status, 400);
  // The super admin renames a role; everyone sees the new label.
  const sup = await login('superadmin@provider.example');
  assert.equal((await sup.send('PUT', '/api/roles', { layer: 'platform', overrides: {}, labels: { technical_user: 'Field engineer' } })).status, 200);
  assert.equal((await tech.json('/api/me')).roleLabel, 'Field engineer');
  const log = await sup.json('/api/audit?action=roles.');
  assert.equal(log.entries.length, 4);
});

test('the permission matrix keeps lower roles within the role above', () => {
  const m = resolveMatrix([{ end_user: { 'devices.actions': true }, technical_user: { 'service.view': false } }]);
  assert.ok(!m.end_user.has('devices.actions'), 'end users can never run actions');
  assert.ok(!m.end_user.has('service.view'), 'nothing the technical user lacks');
  assert.ok(m.end_user.has('estate.view'), 'locked permissions stay on');
  for (const r of ROLES.slice(1)) assert.ok(!m[r].has('platform.manage'));
  assert.deepEqual([...resolveMatrix([]).super_admin].sort(), [...DEFAULTS.super_admin].sort());
});

test('phase 7 migration: provider admins become MSP admins of a default MSP, viewers become end users', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm7m-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({
    customers: [{ id: 'cust-demo', name: 'Demo Customer' }, { id: 'cust-real', name: 'Real Co', mockData: false }],
    users: [
      { id: 'u-super', email: 'superadmin@provider.example', role: 'super_admin', customerId: null, password: 'x' },
      { id: 'u-admin', email: 'admin@provider.example', role: 'provider_admin', customerId: null, password: 'x' },
      { id: 'u-real', email: 'it@real.example', role: 'customer_viewer', customerId: 'cust-real', password: 'x' },
    ],
    connections: [], audit: [{ id: 'a1', at: '2026-01-01T00:00:00Z', action: 'customer.update', customerId: 'cust-real' }],
    phase3: true, phase5: true, phase6: true,
  }));
  const s = new Store(dir);
  assert.equal(s.migrate('pw', 'demo-pw'), true);
  assert.deepEqual(s.msps.map((m) => m.id), ['msp-default']);
  assert.ok(s.customers.every((c) => c.mspId === 'msp-default'));
  const by = (e) => s.users.find((u) => u.email === e);
  assert.equal(by('admin@provider.example').role, 'msp_admin');
  assert.equal(by('admin@provider.example').mspId, 'msp-default');
  assert.equal(by('it@real.example').role, 'end_user');
  assert.equal(by('admin@demo.example').role, 'customer_admin');
  assert.equal(by('tech@demo.example').role, 'technical_user');
  assert.ok(!s.users.some((u) => ['provider_admin', 'customer_viewer'].includes(u.role)));
  // Idempotent.
  s.flush();
  const again = new Store(dir);
  again.migrate('pw', 'demo-pw');
  assert.equal(again.users.length, s.users.length);
  assert.equal(again.msps.length, 1);
});

test('action inbox follows the roles: technical users decide, end users have no access, MSPs stay apart', async (t) => {
  const { ctx, login } = await startApp(t);
  const { acme } = await secondMsp(login);
  const dflt = await login('admin@provider.example');
  assert.equal((await dflt.send('POST', '/api/checks/run', {})).status < 300, true);
  const tech = await login('tech@demo.example');
  const end = await login('it@demo.example');
  const actions = await tech.json('/api/actions');
  const list = actions.actions || actions.items || actions;
  assert.ok(Array.isArray(list));
  assert.ok(list.every((a) => a.customerId === 'cust-demo'));
  const open = list.find((a) => a.status === 'proposed');
  if (open) assert.equal((await tech.send('POST', `/api/actions/${open.id}/decline`, { reason: 'test' })).status, 200);
  assert.equal((await end('/api/actions')).status, 403);
  assert.equal((await end('/api/contacts/cust-demo')).status, 403);
  assert.equal((await tech.send('PUT', '/api/contacts/cust-demo', { scope: 'customer', role: 'engineer', contact: null })).status, 403, 'contacts are edited by admins');
  assert.equal((await tech.send('PUT', '/api/admin/checks', { enabled: false })).status, 403);
  // The other MSP never sees the default MSP's actions.
  const theirs = await acme.json('/api/actions');
  const tl = theirs.actions || theirs.items || theirs;
  assert.ok(!JSON.stringify(tl).includes('cust-demo'));
  const cc = (await acme('/api/contacts/cust-demo')).status;
  assert.ok(cc === 403 || cc === 404, `contacts of another MSP's customer: ${cc}`);
  // Turning inbox decisions off for technical users takes effect at once.
  const cadmin = await login('admin@demo.example');
  assert.equal((await cadmin.send('PUT', '/api/roles', { layer: 'customer', id: 'cust-demo', overrides: { technical_user: { 'inbox.approve': false } } })).status, 200);
  void ctx;
  const anyId = list[0]?.id || 'x';
  assert.equal((await tech.send('POST', `/api/actions/${anyId}/decline`, {})).status, 403);
});
