// Security checks: tenant isolation through API parameters, role checks,
// sign-in throttling, response headers and the outbound (SSRF) guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { addSecondCustomer } from './fixtures.js';
import { isPrivateAddress, isBlockedHost, assertPublicUrl } from '../server/lib/net-guard.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsec-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  addSecondCustomer(ctx.store);
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); ctx.apiTracker.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const login = async (email, password = 'demo1234') => {
    const res = await post('/api/login', { email, password });
    assert.equal(res.status, 200, `login ${email}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  };
  return { ctx, base, post, login };
}

test('a customer user cannot reach another customer through any API parameter', async (t) => {
  const { ctx, login } = await startApp(t);
  const as = await login('it@demo.example');
  const other = 'cust-northwind';
  const theirDevice = ctx.inventory.forCustomer(other)[0];
  const theirConn = ctx.store.connections.find((c) => c.customerId === other);
  assert.ok(theirDevice && theirConn);
  const json = async (p) => (await as(p)).json();

  const list = await json(`/api/devices?customer=${other}`);
  assert.ok(list.every((d) => d.customerId === 'cust-demo'));
  assert.equal((await as(`/api/devices/${encodeURIComponent(theirDevice.id)}`)).status, 404);
  const looked = await (await as('/api/devices/lookup', { method: 'POST', body: JSON.stringify({ ids: [theirDevice.id] }) })).json();
  assert.equal(looked.length, 0);
  assert.equal((await as(`/api/rooms/schematic?customerId=${other}&site=Chicago&room=x`)).status, 404);
  assert.equal((await as(`/api/rooms/designs?customerId=${other}&site=Chicago&room=x`)).status, 404);
  assert.equal((await as(`/api/baselines/customers/${other}`)).status, 404);
  const lc = await json(`/api/lifecycle?customer=${other}`);
  assert.ok(!JSON.stringify(lc).includes('Northwind'));
  for (const p of ['/api/customers', '/api/connections', '/api/alerts?limit=500', `/api/tree?customer=${other}`, `/api/map?customer=${other}`, `/api/sla?customer=${other}`, '/api/filters']) {
    const body = JSON.stringify(await json(p));
    assert.ok(!body.includes(other) && !body.includes('Northwind'), `${p} leaks the other customer`);
  }
  // Admin-only and super-admin-only endpoints refuse a customer user.
  for (const [p, method] of [['/api/audit', 'GET'], ['/api/admin/customers', 'GET'], ['/api/admin/sync', 'GET'], ['/api/admin/apis', 'GET'], [`/api/connections/${theirConn.id}/sync`, 'POST'], [`/api/devices/${encodeURIComponent(theirDevice.id)}/actions`, 'GET']]) {
    const r = await as(p, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  // An admin who has entered one customer is held to that customer too.
  const admin = await login('admin@provider.example');
  await admin('/api/session/enter', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo' }) });
  assert.equal((await admin(`/api/devices/${encodeURIComponent(theirDevice.id)}`)).status, 404);
  assert.equal((await admin(`/api/connections/${theirConn.id}`, { method: 'PUT', body: JSON.stringify({ name: 'x' }) })).status, 404);
});

test('sign-in is throttled per account even across IP addresses, without revealing which emails exist', async (t) => {
  const { post } = await startApp(t);
  for (let i = 0; i < 5; i++) {
    const r = await post('/api/login', { email: 'it@demo.example', password: 'wrong' }, { 'x-forwarded-for': `203.0.113.${i + 1}` });
    assert.equal(r.status, 401);
  }
  const locked = await post('/api/login', { email: 'it@demo.example', password: 'demo1234' }, { 'x-forwarded-for': '203.0.113.99' });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  const unknown = await post('/api/login', { email: 'nobody@nowhere.example', password: 'x' }, { 'x-forwarded-for': '203.0.113.50' });
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error, 'Email or password is incorrect');
});

test('responses carry security headers and API answers are not cached', async (t) => {
  const { login, base } = await startApp(t);
  const page = await fetch(`${base}/`);
  const csp = page.headers.get('content-security-policy');
  for (const d of ["script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(d), d);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.ok(page.headers.get('permissions-policy'));
  const as = await login('it@demo.example');
  assert.equal((await as('/api/devices')).headers.get('cache-control'), 'no-store');
  // HSTS only over HTTPS (the platform's proxy says so with X-Forwarded-Proto).
  assert.ok((await fetch(`${base}/api/config`, { headers: { 'x-forwarded-proto': 'https' } })).headers.get('strict-transport-security'));
});

test('connector URLs cannot point inside the network, and saved credentials never follow a changed URL', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  for (const bad of ['https://127.0.0.1/token', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://10.1.2.3/', 'https://[::1]/', 'https://postgres.railway.internal/']) {
    const r = await admin('/api/connections', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', oem: 'poly-lens', settings: { authUrl: bad } }) });
    assert.equal(r.status, 400, bad);
  }
  // A live connection with saved credentials.
  const made = await (await admin('/api/connections', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', oem: 'poly-lens', name: 'Poly live', credentials: { clientId: 'id-1', clientSecret: 'secret-1' } }) })).json();
  const conn = ctx.store.connections.find((c) => c.id === made.id);
  // Moving the token URL to another host without retyping the secret is refused.
  let r = await admin(`/api/connections/${conn.id}`, { method: 'PUT', body: JSON.stringify({ settings: { authUrl: 'https://attacker.example/token' } }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /credentials again/);
  // Testing against a new host does not send the saved secret.
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes('attacker.example')) { sent.push(String(init?.body || '') + JSON.stringify(init?.headers || {})); return new Response('{}', { status: 401 }); } return realFetch(url, init); };
  t.after(() => { globalThis.fetch = realFetch; });
  await admin(`/api/connections/${conn.id}/test`, { method: 'POST', body: JSON.stringify({ mode: 'live', settings: { authUrl: 'https://attacker.example/token' } }) });
  assert.ok(sent.every((s) => !s.includes('secret-1') && !s.includes(Buffer.from('id-1:secret-1').toString('base64'))), 'saved secret was sent to the new host');
  // Retyping every credential allows the change.
  r = await admin(`/api/connections/${conn.id}`, { method: 'PUT', body: JSON.stringify({ settings: { authUrl: 'https://login.example.com/token' }, credentials: { clientId: 'id-2', clientSecret: 'secret-2' } }) });
  assert.equal(r.status, 200);
});

test('the outbound guard knows internal addresses', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '52.1.2.3', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  for (const h of ['localhost', 'api.localhost', 'db.railway.internal', 'printer.local', '[::1]']) assert.ok(isBlockedHost(h), h);
  assert.ok(!isBlockedHost('api.silica-prod01.io.lens.poly.com'));
  await assert.rejects(() => assertPublicUrl('https://127.0.0.1/x'));
  await assert.rejects(() => assertPublicUrl('https://localhost:8443/x'));
});
