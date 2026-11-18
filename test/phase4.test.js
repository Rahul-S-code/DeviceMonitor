import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { validateSchematic, withBlockPorts, SCHEMATIC_TEMPLATES, BLOCKS } from '../server/lib/schematic.js';
import { detectDesignType } from '../server/lib/designs.js';
import { probe, apiCatalogue } from '../server/services/api-tracker.js';
import { recordCall, callStats, registerEndpoints, resetCallStats } from '../server/lib/api-calls.js';

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
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
  const room = 'customerId=cust-helix&site=London&room=Board%20Room';
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
  const helix = await login('it@helix.example');
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
  const viewer = await login('it@helix.example');
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
