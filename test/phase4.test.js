import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { addSecondCustomer } from './fixtures.js';
import { validateSchematic, withBlockPorts, SCHEMATIC_TEMPLATES, BLOCKS } from '../server/lib/schematic.js';
import { detectDesignType } from '../server/lib/designs.js';
import { probe, apiCatalogue } from '../server/services/api-tracker.js';
import { recordCall, callStats, registerEndpoints, resetCallStats } from '../server/lib/api-calls.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  addSecondCustomer(ctx.store);
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); ctx.apiTracker.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  };
  return { ctx, base, login };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);

test('every template opens port to port, and blocks have unique port names', () => {
  for (const t of SCHEMATIC_TEMPLATES) {
    const s = validateSchematic(t.schematic);
    for (const n of s.nodes) assert.ok(Array.isArray(n.ports), `${t.id}/${n.id} has ports`);
    for (const l of s.links) {
      const from = s.nodes.find((n) => n.id === l.from); const to = s.nodes.find((n) => n.id === l.to);
      assert.ok(from.ports.some((p) => p.name === l.fromPort), `${t.id}: ${l.from}.${l.fromPort} exists`);
      assert.ok(to.ports.some((p) => p.name === l.toPort), `${t.id}: ${l.to}.${l.toPort} exists`);
    }
  }
  for (const b of BLOCKS) assert.equal(new Set(b.ports.map((p) => p.name.toLowerCase())).size, b.ports.length, b.id);
});

test('schematic validation: ports, cable details, and one cable per port', () => {
  const sch = {
    nodes: [
      { id: 'bar', label: 'Bar', kind: 'core', block: 'video-bar', ports: [{ name: 'HDMI out 1', type: 'HDMI', dir: 'out' }, { name: 'LAN', type: 'Ethernet', dir: 'io' }] },
      { id: 'tv', label: 'TV', kind: 'display', ports: [{ name: 'HDMI 1', type: 'HDMI', dir: 'in' }, { name: 'HDMI 2', type: 'HDMI', dir: 'in' }] },
    ],
    links: [{ from: 'bar', fromPort: 'HDMI out 1', to: 'tv', toPort: 'HDMI 1', cable: 'HDMI', label: 'C-01', length: '7.5', condition: 'faulty', note: 'Through floor box' }],
  };
  const v = validateSchematic(sch);
  assert.deepEqual(v.links[0], { from: 'bar', to: 'tv', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1', label: 'C-01', length: 7.5, condition: 'faulty', note: 'Through floor box' });
  sch.links.push({ from: 'bar', fromPort: 'HDMI out 1', to: 'tv', toPort: 'HDMI 2', cable: 'HDMI' });
  assert.throws(() => validateSchematic(sch), /two cables/);
  assert.throws(() => validateSchematic({ nodes: [{ id: 'a', ports: [{ name: 'X' }, { name: 'x' }] }], links: [] }), /two ports called/);
});

test('older schematics get ports from their building block and free ports are assigned', () => {
  const s = withBlockPorts({ nodes: [{ id: 'sw', label: 'Switch', kind: 'network' }, { id: 'bar', label: 'Bar', kind: 'core' }, { id: 'tap', label: 'Tap', kind: 'controller' }], links: [{ from: 'sw', to: 'bar', cable: 'Ethernet' }, { from: 'sw', to: 'tap', cable: 'PoE' }] });
  assert.equal(s.links[0].fromPort, 'Port 1');
  assert.equal(s.links[1].fromPort, 'Port 2');
  assert.equal(s.links[0].toPort, 'LAN');
  assert.equal(s.links[1].toPort, 'LAN');
  assert.doesNotThrow(() => validateSchematic(s));
});

test('design files: type comes from the content, not the name', () => {
  assert.equal(detectDesignType(PNG, 'x.png').ext, 'png');
  assert.equal(detectDesignType(Buffer.from('%PDF-1.7 ...'), 'a.pdf').ext, 'pdf');
  assert.equal(detectDesignType(Buffer.from('PK\x03\x04rest'), 'room.vsdx').ext, 'vsdx');
  assert.throws(() => detectDesignType(Buffer.from('PK\x03\x04rest'), 'evil.zip'), /Upload a PDF/);
  assert.throws(() => detectDesignType(Buffer.from('<svg onload=alert(1)>'), 'x.png'), /Upload a PDF/);
  assert.throws(() => detectDesignType(Buffer.from('<html>'), 'x.pdf'), /Upload a PDF/);
});

test('room design documents: upload, list, download, scoping and removal', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const room = 'customerId=cust-demo&site=London&room=Board%20Room';
  const up = (body, name, headers = { 'x-requested-with': 'estate-monitor' }) => admin(`/api/rooms/designs?${room}&name=${encodeURIComponent(name)}&title=As-built`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } });
  assert.equal((await up(PNG, 'plan.png', {})).status, 415, 'needs the app header');
  assert.equal((await up(Buffer.from('<html><script>'), 'plan.png')).status, 400);
  const res = await up(PNG, 'plan.png');
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.label, 'PNG image');
  const list = await (await admin(`/api/rooms/designs?${room}`)).json();
  assert.equal(list.length, 1);
  const file = await admin(d.url);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  const other = await login('it@northwind.example');
  assert.equal((await other(d.url)).status, 404, 'other customers cannot read it');
  assert.equal((await other(`/api/designs/${d.id}`, { method: 'DELETE' })).status, 403);
  const helix = await login('it@demo.example');
  assert.equal((await helix(d.url)).status, 200, 'the customer can read its own');
  assert.equal((await admin(`/api/designs/${d.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin(d.url)).status, 404);
});

test('API probe: any answer under 500 is up; errors and 5xx are down', async () => {
  const ok = await probe('https://x.example/', { fetchImpl: async () => new Response('', { status: 401 }) });
  assert.equal(ok.ok, true); assert.match(ok.note, /credentials/);
  assert.equal((await probe('https://x.example/', { fetchImpl: async () => new Response('', { status: 503 }) })).ok, false);
  const dns = await probe('https://x.example/', { fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; } });
  assert.equal(dns.ok, false); assert.equal(dns.note, 'DNS lookup failed');
  const mtls = await probe('https://x.example/', { fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' }; throw e; } });
  assert.equal(mtls.ok, true, 'an mTLS API asking for its certificate is up');
});

test('API call recording matches the most specific endpoint', () => {
  resetCallStats();
  registerEndpoints(apiCatalogue([]));
  recordCall('https://api.zoom.us/v2/rooms/abc/devices?page_size=300', { status: 200, ms: 120 });
  recordCall('https://api.zoom.us/v2/rooms/locations', { status: 500, ms: 80 });
  recordCall('https://api.zoom.us/v2/rooms?page_size=300', { status: 200, ms: 100 });
  assert.equal(callStats('zoom-room-devices').calls, 1);
  assert.equal(callStats('zoom-room-locations').errors, 1);
  assert.equal(callStats('zoom-rooms-list').avgMs, 100);
});

test('API tracker: lists every API, checks are super admin only and recorded', async (t) => {
  const { ctx, login } = await startApp(t);
  const seen = [];
  ctx.apiTracker.fetchImpl = async (url) => { seen.push(String(url)); return new Response('', { status: String(url).includes('webexapis') ? 503 : 401 }); };
  const admin = await login('admin@provider.example');
  const sup = await login('superadmin@provider.example');
  const viewer = await login('it@demo.example');
  assert.equal((await viewer('/api/admin/apis')).status, 403);
  const before = await (await admin('/api/admin/apis')).json();
  assert.ok(before.apis.some((a) => a.id === 'poly-lens-graphql' && a.state === 'unchecked'));
  assert.equal(before.apis.find((a) => a.id === 'graph-teamwork-devices').state, 'retired');
  assert.equal(before.apis.find((a) => a.id === 'google-meet-hardware').state, 'no-api');
  assert.ok(before.apis.find((a) => a.id === 'map-osm'), 'map tiles are tracked');
  assert.equal((await admin('/api/admin/apis/check', { method: 'POST', body: '{}' })).status, 403);
  const r = await (await sup('/api/admin/apis/check', { method: 'POST', body: '{}' })).json();
  assert.equal(r.apis.find((a) => a.id === 'poly-lens-auth').state, 'up');
  assert.equal(r.apis.find((a) => a.id === 'webex-devices').state, 'down');
  assert.ok(!seen.some((u) => u.includes('{')), 'templated paths are never called');
  const poly = r.apis.find((a) => a.id === 'poly-lens-graphql');
  assert.ok(poly.connections.length >= 1 && poly.connections.every((c) => c.test?.ok), 'each connection is tested with its own credentials');
  const one = await (await sup('/api/admin/apis/check', { method: 'POST', body: JSON.stringify({ id: 'zoom-auth' }) })).json();
  assert.equal(one.apis.find((a) => a.id === 'zoom-auth').checks.length, 2);
  assert.equal(one.apis.find((a) => a.id === 'poly-lens-auth').checks.length, 1);
  assert.ok(ctx.store.data.audit.some((e) => e.action === 'api.check'));
});

test('device actions: each runs through its own vendor API (live transports)', async () => {
  const { PolyLensConnector } = await import('../server/connectors/poly-lens/index.js');
  const { WebexConnector, WebexHttpTransport } = await import('../server/connectors/webex/index.js');
  const { ZoomRoomsConnector, ZoomHttpTransport } = await import('../server/connectors/zoom-rooms/index.js');
  // Poly Lens (OEM): GraphQL rebootDevice mutation
  let gql;
  const poly = new PolyLensConnector({ connection: { id: 'p', mode: 'live', settings: {} }, credentials: { clientId: 'a', clientSecret: 'b' }, transport: { graphql: async (q, v) => { gql = { q, v }; return { rebootDevice: { success: true, error: null } }; } } });
  assert.equal((await poly.runAction('reboot', { sourceId: 'dev-1' })).ok, true);
  assert.match(gql.q, /rebootDevice\(deviceId: \$deviceId\)/);
  assert.deepEqual(gql.v, { deviceId: 'dev-1' });
  // Webex (platform): cloud xAPI command
  const calls = [];
  const wx = new WebexConnector({ connection: { id: 'w', mode: 'live', settings: {} }, credentials: { accessToken: 't' }, transport: new WebexHttpTransport({ baseUrl: 'https://webexapis.com/v1', accessToken: 't', fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return new Response('{}', { status: 200 }); } }) });
  await wx.runAction('restart', { sourceId: 'wx-9' });
  assert.equal(calls[0].url, 'https://webexapis.com/v1/xapi/command/SystemUnit.Boot');
  assert.deepEqual(JSON.parse(calls[0].init.body), { deviceId: 'wx-9', arguments: { Action: 'Restart' } });
  assert.equal(WebexConnector.actionApplies(WebexConnector.actions[0], { make: 'Poly', model: 'Studio X50' }), false, 'xAPI is RoomOS only');
  // Zoom (platform): room controls
  const zc = [];
  const zt = new ZoomHttpTransport({ accountId: 'a', clientId: 'b', clientSecret: 'c', authUrl: 'https://zoom.us/oauth/token', apiUrl: 'https://api.zoom.us/v2', fetchImpl: async (url, init) => { zc.push({ url: String(url), init }); return String(url).includes('oauth') ? new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }) : new Response(null, { status: 204 }); } });
  const zoom = new ZoomRoomsConnector({ connection: { id: 'z', mode: 'live', settings: { accountId: 'a' } }, credentials: { clientId: 'b', clientSecret: 'c' }, transport: zt });
  await zoom.runAction('restart-room', { sourceId: 'd1', roomId: 'room 7' });
  const patch = zc.find((c) => c.init?.method === 'PATCH');
  assert.equal(patch.url, 'https://api.zoom.us/v2/rooms/room%207/events');
  assert.deepEqual(JSON.parse(patch.init.body), { method: 'zoomroom.restart' });
});

test('device actions API: admins only, demo connections simulate, audited and rate limited', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const devices = await (await admin('/api/devices')).json();
  const d = devices.find((x) => x.oems.includes('poly-lens'));
  const viewer = await login(`it@${d.customerId.replace('cust-', '')}.example`);
  assert.equal((await viewer(`/api/devices/${encodeURIComponent(d.id)}/actions`)).status, 403);
  const { sets } = await (await admin(`/api/devices/${encodeURIComponent(d.id)}/actions`)).json();
  const polySet = sets.find((s) => s.oem === 'poly-lens');
  assert.equal(polySet.apiSet, 'OEM device cloud API');
  assert.equal(polySet.actions[0].id, 'reboot');
  const run = () => admin(`/api/devices/${encodeURIComponent(d.id)}/actions`, { method: 'POST', body: JSON.stringify({ connectionId: polySet.connectionId, action: 'reboot' }) });
  const r = await (await run()).json();
  assert.equal(r.simulated, true);
  assert.equal(r.via, 'Poly Lens');
  assert.equal((await run()).status, 429);
  assert.ok(ctx.store.data.audit.some((e) => e.action === 'device.action' && e.details.via === 'Poly Lens'));
  const logi = devices.find((x) => x.oems.includes('logitech-sync'));
  const ls = (await (await admin(`/api/devices/${encodeURIComponent(logi.id)}/actions`)).json()).sets.find((s) => s.oem === 'logitech-sync');
  assert.equal(ls.actions.length, 0);
  assert.match(ls.note, /read-only/);
  assert.equal((await admin(`/api/devices/${encodeURIComponent(logi.id)}/actions`, { method: 'POST', body: JSON.stringify({ connectionId: ls.connectionId, action: 'reboot' }) })).status, 400);
});

test('error codes: every red or amber device has a code with causes, from each source', async (t) => {
  const { ERROR_CODES, classifyFault } = await import('../server/lib/issues.js');
  assert.equal(classifyFault('cameraNotDetected'), 'EM-PER-001');
  assert.equal(classifyFault('displayHub'), 'EM-PER-005');
  assert.equal(classifyFault('micPod'), 'EM-PER-002');
  assert.equal(classifyFault('temperatureCheck'), 'EM-ENV-001');
  for (const [code, e] of Object.entries(ERROR_CODES)) assert.ok(e.title && e.meaning && e.causes.length && e.checks.length, code);
  const { ctx, login } = await startApp(t);
  const bad = ctx.inventory.devices.filter((d) => ['warning', 'critical', 'offline'].includes(d.health));
  assert.ok(bad.length > 5);
  for (const d of bad) {
    assert.ok(d.diagnosis.length, `${d.id} (${d.healthReason}) has a code`);
    assert.ok(d.diagnosis.every((x) => ERROR_CODES[x.code] && x.source && x.causes.length));
  }
  assert.ok(ctx.inventory.devices.filter((d) => d.health === 'healthy').every((d) => !d.issues.length));
  const viewer = await login('it@demo.example');
  const codes = await (await viewer('/api/error-codes')).json();
  assert.ok(codes.find((c) => c.code === 'EM-NET-001'));
  const offline = bad.find((d) => d.customerId === 'cust-demo' && d.errorCodes.includes('EM-NET-001'));
  if (offline) assert.ok((await (await viewer('/api/devices?q=EM-NET-001')).json()).some((d) => d.id === offline.id), 'search finds devices by code');
});

test('mock flag: only devices fed solely by demo connections', async (t) => {
  const { ctx } = await startApp(t);
  const devs = ctx.inventory.devices;
  assert.ok(devs.filter((d) => d.sources.every((s) => s.oem !== 'manual')).every((d) => d.mock === true), 'demo estate is all mock');
  ctx.store.addManualDevice({ customerId: 'cust-demo', site: 'London HQ', room: 'Room X', make: 'Neat', model: 'Bar Pro', deviceType: 'Video bar' }, { name: 't' });
  ctx.sync.refresh();
  assert.equal(ctx.inventory.devices.find((d) => d.model === 'Bar Pro').mock, false, 'manual devices are not mock');
  const conn = ctx.store.connections[0];
  conn.mode = 'live';
  ctx.sync.refresh();
  assert.ok(ctx.inventory.devices.filter((d) => d.sources.some((s) => s.connectionId === conn.id)).every((d) => d.mock === false), 'a live source clears the tag');
});
