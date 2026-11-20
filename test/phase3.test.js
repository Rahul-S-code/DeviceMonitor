import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { addSecondCustomer } from './fixtures.js';
import { ZoomRoomsConnector } from '../server/connectors/zoom-rooms/index.js';
import { WebexConnector, WebexHttpTransport } from '../server/connectors/webex/index.js';
import { modelKey, lifecycleStage, warrantyStatus } from '../server/lib/models.js';
import { History } from '../server/services/history.js';

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
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers || {}) }, ...init });

test('Zoom Rooms live: S2S OAuth token, paged rooms, devices per room', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.hostname === 'zoom.us') return json({ access_token: 'tok', expires_in: 3600 });
    if (u.pathname === '/v2/rooms') return u.searchParams.get('next_page_token') ? json({ rooms: [{ id: 'r2', name: 'Atlas', location_id: 'b1', status: 'Offline' }] }) : json({ rooms: [{ id: 'r1', name: 'Orion', location_id: 'f1', status: 'InMeeting' }], next_page_token: 'n1' });
    if (u.pathname === '/v2/rooms/locations') return json({ locations: [{ id: 'b1', name: 'HQ', type: 'building' }, { id: 'f1', name: 'Floor 3', type: 'floor', parent_location_id: 'b1' }] });
    if (u.pathname === '/v2/rooms/r1/devices') return json({ devices: [{ id: 'd1', device_type: 'Zoom Rooms Computer', status: 'Online', device_manufacturer: 'Lenovo', device_model: 'ThinkSmart Core', serial_number: 'SN1', device_mac_addresses: ['aa:bb:cc:dd:ee:ff'], app_version: '6.3.5' }] });
    if (u.pathname === '/v2/rooms/r2/devices') return json({ devices: [{ id: 'd2', device_type: 'Zoom Rooms Appliance', status: 'Offline', device_manufacturer: 'Poly', device_model: 'Studio X50', device_firmware: '4.2.0' }] });
    throw new Error(`unexpected ${u}`);
  };
  const { ZoomHttpTransport } = await import('../server/connectors/zoom-rooms/index.js');
  const transport = new ZoomHttpTransport({ accountId: 'acc', clientId: 'id', clientSecret: 'sec', authUrl: 'https://zoom.us/oauth/token', apiUrl: 'https://api.zoom.us/v2', fetchImpl });
  const c = new ZoomRoomsConnector({ connection: { id: 'c', customerId: 'A', mode: 'live', settings: { accountId: 'acc' } }, credentials: { clientId: 'id', clientSecret: 'sec' }, transport });
  const devices = await c.sync();
  const tokenCall = calls.find((x) => x.url.hostname === 'zoom.us');
  assert.equal(tokenCall.url.searchParams.get('grant_type'), 'account_credentials');
  assert.equal(tokenCall.init.headers.authorization, `Basic ${Buffer.from('id:sec').toString('base64')}`);
  assert.equal(devices.length, 2);
  const pc = devices.find((d) => d.serial === 'SN1');
  assert.equal(pc.site, 'HQ', 'floor walks up to its building');
  assert.equal(pc.deviceType, 'Room PC');
  assert.equal(pc.platform, 'Zoom');
  assert.equal(pc.inUse, true);
  assert.equal(devices.find((d) => d.model === 'Studio X50').health, 'offline');
});

test('Webex live: bearer token, Link-header paging, workspace and location names', async () => {
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    assert.equal(init.headers.authorization, 'Bearer T');
    if (u.pathname === '/v1/devices' && !u.searchParams.get('cursor')) return json({ items: [{ id: 'x1', product: 'Cisco Room Bar', serial: 'FOC1', software: 'RoomOS 11.20', connectionStatus: 'connected_with_issues', errorCodes: ['cameraNotDetected'], workspaceId: 'w1' }] }, { headers: { link: '<https://webexapis.com/v1/devices?cursor=2>; rel="next"' } });
    if (u.pathname === '/v1/devices') return json({ items: [{ id: 'x2', product: 'Cisco Board Pro', connectionStatus: 'disconnected', workspaceId: 'w1' }] });
    if (u.pathname === '/v1/workspaces') return json({ items: [{ id: 'w1', displayName: 'Summit', locationId: 'l1' }] });
    if (u.pathname === '/v1/locations') return json({ items: [{ id: 'l1', name: 'Boston' }] });
    throw new Error(`unexpected ${u}`);
  };
  const c = new WebexConnector({ connection: { id: 'c', customerId: 'A', mode: 'live', settings: {} }, credentials: { accessToken: 'T' }, transport: new WebexHttpTransport({ baseUrl: 'https://webexapis.com/v1', accessToken: 'T', fetchImpl }) });
  const devices = await c.sync();
  assert.equal(devices.length, 2);
  assert.equal(devices[0].make, 'Cisco');
  assert.equal(devices[0].room, 'Summit');
  assert.equal(devices[0].site, 'Boston');
  assert.equal(devices[0].health, 'warning');
  assert.match(devices[0].healthReason, /cameraNotDetected/);
  assert.equal(devices[1].health, 'offline');
});

test('Teams Rooms and Google Meet cannot be switched to live', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const conns = await (await admin('/api/connections')).json();
  const teams = conns.find((c) => c.oem === 'teams-rooms');
  assert.ok(teams, 'demo customers get a Teams Rooms connection');
  const res = await admin(`/api/connections/${teams.id}`, { method: 'PUT', body: JSON.stringify({ mode: 'live' }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /teamworkDevice/);
  const create = await admin('/api/connections', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', oem: 'google-meet-hardware', mode: 'live' }) });
  assert.equal(create.status, 400);
});

test('model master: baseline drives firmware compliance; only the super admin can edit', async (t) => {
  const { login } = await startApp(t);
  const sup = await login('superadmin@provider.example');
  const admin = await login('admin@provider.example');
  const { models } = await (await sup('/api/models')).json();
  const tap = models.find((m) => m.make === 'Logitech' && m.model === 'Tap IP');
  assert.ok(tap && tap.releases.length);
  assert.equal((await admin(`/api/models/${tap.id}`, { method: 'PUT', body: JSON.stringify({ baseline: '9.9.9' }) })).status, 403);
  const res = await sup(`/api/models/${tap.id}`, { method: 'PUT', body: JSON.stringify({ baseline: '9.9.9', endOfSupport: '2020-01-31' }) });
  assert.equal(res.status, 200);
  const devs = (await (await sup('/api/devices')).json()).filter((d) => d.modelId === tap.id);
  assert.ok(devs.length && devs.every((d) => d.firmwareStatus === 'behind' && d.lifecycle.stage === 'eos'));
  assert.equal((await sup(`/api/models/${tap.id}`, { method: 'PUT', body: JSON.stringify({ endOfLife: '31/12/2030' }) })).status, 400);
  // Manual release with notes link; fleet versions are already recorded.
  const rel = await (await sup(`/api/models/${tap.id}/releases`, { method: 'POST', body: JSON.stringify({ version: '1.13.0', releasedAt: '2026-10-01', notesUrl: 'https://example.com/notes' }) })).json();
  assert.equal(rel.latest, '1.13.0');
  assert.equal(rel.releases.find((r) => r.version === '1.12.252').source, 'fleet');
  const life = await (await sup('/api/lifecycle')).json();
  assert.ok(life.firmware.behind >= devs.length);
  assert.ok(life.lifecycle.eos >= devs.length);
});

test('warranty comes from Logitech Sync and can be overridden in bulk', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const devices = await (await admin('/api/devices')).json();
  const logi = devices.find((d) => d.warrantySource === 'Logitech Sync');
  assert.ok(logi?.warrantyExpires && logi.warrantyType);
  const poly = devices.find((d) => d.make === 'Poly' && !d.warrantyExpires);
  const res = await admin('/api/devices/bulk', { method: 'POST', body: JSON.stringify({ ids: [poly.id], set: { warrantyExpires: '2020-05-01', warrantyType: 'Poly+ Premier', contractRef: 'C-42' } }) });
  assert.equal(res.status, 200);
  const after = await (await admin(`/api/devices/${encodeURIComponent(poly.id)}`)).json();
  assert.equal(after.warrantyStatus, 'expired');
  assert.equal(after.contractRef, 'C-42');
  assert.equal((await admin('/api/devices/bulk', { method: 'POST', body: JSON.stringify({ ids: [poly.id], set: { warrantyExpires: 'soon' } }) })).status, 400);
});

test('SLA report is scoped per customer and uses the customer target', async (t) => {
  const { login } = await startApp(t);
  const sup = await login('superadmin@provider.example');
  await sup('/api/admin/customers/cust-demo', { method: 'PUT', body: JSON.stringify({ slaTarget: 99.9 }) });
  const helix = await login('it@demo.example');
  const r = await (await helix('/api/sla?window=30d')).json();
  assert.equal(r.byCustomer.length, 1);
  assert.equal(r.byCustomer[0].target, 99.9);
  assert.equal(r.overall.target, 99.9);
  assert.ok(r.overall.availability > 90 && r.overall.availability <= 100);
  assert.equal(r.trend.length, 30);
  assert.ok(r.simulated);
  assert.ok(r.incidents.every((i) => i.customerId === 'cust-demo'));
});

test('audit log records changes, hides secrets, and is admin-only', async (t) => {
  const { login, base } = await startApp(t);
  const admin = await login('admin@provider.example');
  const conns = await (await admin('/api/connections')).json();
  const poly = conns.find((c) => c.oem === 'poly-lens');
  await admin(`/api/connections/${poly.id}`, { method: 'PUT', body: JSON.stringify({ credentials: { clientId: 'visible-id', clientSecret: 'TOP-SECRET-VALUE' } }) });
  await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@provider.example', password: 'wrong' }) });
  const r = await (await admin('/api/audit')).json();
  const actions = r.entries.map((e) => e.action);
  for (const a of ['auth.login', 'auth.login_failed', 'connection.update']) assert.ok(actions.includes(a), a);
  const upd = r.entries.find((e) => e.action === 'connection.update');
  assert.deepEqual(upd.details.credentialsReplaced.sort(), ['clientId', 'clientSecret']);
  const csv = await (await admin('/api/audit.csv')).text();
  assert.ok(!csv.includes('TOP-SECRET-VALUE') && !JSON.stringify(r).includes('TOP-SECRET-VALUE'));
  assert.match(csv.split('\r\n')[0], /Time \(UTC\)/);
  const helix = await login('it@demo.example');
  assert.equal((await helix('/api/audit')).status, 403);
});

test('model helpers', () => {
  assert.equal(modelKey('Poly', 'Poly Studio X50'), modelKey('poly', 'Studio X50'));
  assert.equal(modelKey('Logitech', 'Logi Rally Bar'), modelKey('Logitech', 'Rally Bar'));
  const now = Date.parse('2026-06-01');
  assert.equal(lifecycleStage({ endOfSale: '2025-01-01', endOfSupport: '2028-01-01' }, now).stage, 'eosale');
  assert.equal(lifecycleStage({ endOfSupport: '2026-12-01' }, now).stage, 'soon');
  assert.equal(lifecycleStage(null).stage, 'unknown');
  assert.equal(warrantyStatus('2026-07-01', now), 'expiring');
  assert.equal(warrantyStatus(null), 'unknown');
});

test('history: recorded transitions for live devices give availability and incidents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-h-'));
  const h = new History(dir);
  const t0 = Date.now() - 3_600_000;
  h.record([{ id: 'd', health: 'healthy' }], () => false, t0);
  h.record([{ id: 'd', health: 'offline' }], () => false, t0 + 1_800_000);
  h.record([{ id: 'd', health: 'healthy' }], () => false, t0 + 2_400_000);
  const st = h.stats('d', t0, t0 + 3_600_000);
  assert.equal(st.measured, 3_600_000);
  assert.equal(st.down, 600_000);
  assert.equal(st.incidents.length, 1);
  h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('manual devices: model master only, Not monitored, merge with live data by serial', async (t) => {
  const { login, ctx } = await startApp(t);
  const admin = await login('admin@provider.example');
  const { models } = await (await admin('/api/models')).json();
  const scribe = models.find((m) => m.model === 'Scribe');
  // Unknown model is rejected.
  const bad = await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', modelId: 'nope', site: 'London HQ', room: 'Lab' }) });
  assert.equal(bad.status, 400);
  const res = await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', modelId: scribe.id, site: 'London HQ', room: 'Lab', serial: 'MANUAL-001', assetTag: 'A-1' }) });
  assert.equal(res.status, 201);
  const devs = await (await admin('/api/devices?health=unmonitored')).json();
  const mine = devs.find((d) => d.serial === 'MANUAL-001');
  assert.ok(mine && mine.health === 'unmonitored' && mine.make === 'Logitech' && mine.oems[0] === 'manual');
  const summary = await (await admin('/api/summary?customer=cust-demo')).json();
  assert.equal(summary.totals.unmonitored, 1);
  // Not in SLA, no alert.
  const sla = await (await admin('/api/sla?window=24h')).json();
  assert.ok(!sla.worstDevices.some((d) => d.id === mine.id));
  assert.ok(!ctx.store.data.alerts.some((a) => a.deviceId === mine.id));
  // Same serial as a live-reported device: merged, live health wins, manual fields kept.
  const live = (await (await admin('/api/devices?customer=cust-demo')).json()).find((d) => d.serial && d.oems.includes('poly-lens'));
  const polyModel = models.find((m) => m.make === live.make && live.model.endsWith(m.model.replace(/^Poly\s+/, ''))) || models.find((m) => m.make === 'Poly');
  await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', modelId: polyModel.id, site: 'Somewhere', room: 'Else', serial: live.serial, assetTag: 'A-2' }) });
  const merged = (await (await admin('/api/devices?customer=cust-demo')).json()).filter((d) => d.serial === live.serial);
  assert.equal(merged.length, 1);
  assert.notEqual(merged[0].health, 'unmonitored');
  assert.equal(merged[0].site, live.site, 'OEM location wins');
  assert.equal(merged[0].assetTag, 'A-2');
  assert.ok(merged[0].oems.includes('manual'));
  // Customers cannot add; audit records the add.
  const helix = await login('it@demo.example');
  assert.equal((await helix('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', modelId: scribe.id, site: 'x', room: 'y' }) })).status, 403);
  const audit = await (await admin('/api/audit?action=device.manual')).json();
  assert.equal(audit.entries.filter((e) => e.action === 'device.manual_add').length, 2);
  // Delete.
  assert.equal((await admin(`/api/manual-devices/${encodeURIComponent(mine.manualId)}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await (await admin('/api/devices')).json()).some((d) => d.serial === 'MANUAL-001'));
});

test('manual devices: "Other" make and model, tagged Not monitored when no API connector', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const r = await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', make: 'Neat', model: 'Bar Pro', deviceType: 'Video bar', site: 'London HQ', room: 'Lab', serial: 'NEAT-1' }) });
  assert.equal(r.status, 201);
  assert.equal((await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', make: 'Neat', site: 'London HQ', room: 'Lab' }) })).status, 400);
  const devs = await (await admin('/api/devices?q=NEAT-1')).json();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].make, 'Neat');
  assert.equal(devs[0].deviceType, 'Video bar');
  assert.deepEqual(devs[0].tags, ['Not monitored']);
  assert.match(devs[0].healthReason, /no API connector/);
  // Shows up as uncatalogued so the super admin can add it to the master.
  const { uncatalogued } = await (await admin('/api/models')).json();
  assert.ok(uncatalogued.some((u) => u.make === 'Neat' && u.model === 'Bar Pro'));
  // A model the master knows, with a connector, is not tagged.
  const { models } = await (await admin('/api/models')).json();
  const rally = models.find((m) => m.model === 'Rally Bar');
  await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', modelId: rally.id, site: 'London HQ', room: 'Lab', serial: 'RB-NEW-1' }) });
  const rb = (await (await admin('/api/devices?q=RB-NEW-1')).json())[0];
  assert.equal(rb.health, 'unmonitored');
  assert.ok(!rb.tags?.includes('Not monitored'));
  assert.match(rb.healthReason, /Waiting for Logitech Sync/);
  // Typing a make/model that is in the master links to it.
  await admin('/api/manual-devices', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo', make: 'logitech', model: 'Rally Bar', site: 'London HQ', room: 'Lab', serial: 'RB-NEW-2' }) });
  assert.equal((await (await admin('/api/devices?q=RB-NEW-2')).json())[0].modelId, rally.id);
});
