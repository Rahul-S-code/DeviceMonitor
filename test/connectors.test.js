import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PolyLensConnector, PolyLensHttpTransport, POLY_DEFAULTS, polyAuthError, safeUrl } from '../server/connectors/poly-lens/index.js';
import { PolyLensMockTransport } from '../server/connectors/poly-lens/mock.js';
import { LogitechSyncConnector } from '../server/connectors/logitech-sync/index.js';
import { CONNECTORS } from '../server/connectors/registry.js';
import { BaseConnector } from '../server/connectors/base.js';
import { HEALTH_ORDER } from '../server/lib/device-model.js';

const conn = (oem, extra = {}) => ({ id: `c-${oem}`, customerId: 'cust-helix', oem, mode: 'mock', settings: {}, ...extra });

test('every registered connector implements the shared interface', () => {
  for (const C of CONNECTORS) {
    assert.ok(Object.getPrototypeOf(C) === BaseConnector, `${C.name} extends BaseConnector`);
    for (const m of ['testConnection', 'fetchRaw', 'mapDevices']) assert.notEqual(C.prototype[m], BaseConnector.prototype[m], `${C.name}.${m}`);
    assert.ok(C.oem && C.displayName && C.docsUrl);
  }
});

test('Poly Lens mock produces valid common devices', async () => {
  const devices = await new PolyLensConnector({ connection: conn('poly-lens') }).sync();
  assert.ok(devices.length > 10);
  for (const d of devices) {
    assert.equal(d.customerId, 'cust-helix');
    assert.equal(d.make, 'Poly');
    assert.ok(HEALTH_ORDER.includes(d.health));
    assert.ok(['healthy', 'offline'].includes(d.health), 'Poly Lens only reports connected/disconnected');
    assert.ok(d.site && d.room && d.model && d.deviceType);
  }
});

test('Poly Lens connector follows nextToken pagination', async () => {
  const inner = new PolyLensMockTransport('cust-helix');
  let pages = 0;
  const transport = {
    graphql: (q, v) => {
      if (v?.params) { pages++; v = { ...v, params: { ...v.params, pageSize: 4 } }; }
      return inner.graphql(q, v);
    },
  };
  const all = await new PolyLensConnector({ connection: conn('poly-lens') }).sync();
  const paged = await new PolyLensConnector({ connection: conn('poly-lens'), transport }).sync();
  assert.equal(paged.length, all.length);
  assert.equal(pages, Math.ceil(all.length / 4));
});

test('Poly Lens live transport uses OAuth client credentials and a Bearer token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === POLY_DEFAULTS.authUrl) return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok123', expires_in: 3600 }) };
    return { ok: true, status: 200, json: async () => ({ data: { tenants: [{ id: 't1', name: 'Tenant 1' }] } }) };
  };
  const transport = new PolyLensHttpTransport({ clientId: 'id', clientSecret: 'secret', ...POLY_DEFAULTS, fetchImpl });
  const c = new PolyLensConnector({ connection: conn('poly-lens', { mode: 'live' }), credentials: { clientId: 'id', clientSecret: 'secret' }, transport });
  const r = await c.testConnection();
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { client_id: 'id', client_secret: 'secret', grant_type: 'client_credentials' });
  assert.equal(calls[1].url, POLY_DEFAULTS.apiUrl);
  assert.equal(calls[1].init.headers.authorization, 'Bearer tok123');
});

test('Poly Lens live mode refuses to run without credentials', async () => {
  const c = new PolyLensConnector({ connection: conn('poly-lens', { mode: 'live' }), credentials: {}, transport: { graphql: async () => ({}) } });
  await assert.rejects(() => c.sync(), /Missing Client ID, Client secret/);
});

// Example "Get Places - Response 1" from Logitech's Sync Cloud API OpenAPI definition.
const LOGI_EXAMPLE = {
  places: [{
    id: 'room1', type: 'Room', name: 'Large Room 5', group: '/US/California/San Francisco/Headquarters/', location: '/Main Campus/Building A/Floor 13/Green Area/', seatCount: 12, occupancy: 0,
    devices: [
      { id: 'd1', type: 'Computer', name: 'DESKTOP-PW8ZH', version: '3.3.176', status: 'Online', healthStatus: 'NoIssues', lastSeen: 1717200000000, createdAt: 1717200000000 },
      { id: 'd2', type: 'Logitech', name: 'Rally', version: '1.2.69', status: 'Online', healthStatus: 'Warning', peripherals: { camera: { count: { actual: 1, expected: 1 } }, micPod: { count: { actual: 1, expected: 2 } } }, lastSeen: 1717200000000, createdAt: 1717200000000 },
      { id: 'd3', type: 'Generic', name: 'USB Keyboard', status: 'Offline', healthStatus: 'Error', lastSeen: 1717200000000, createdAt: 1717200000000 },
      { id: 'd4', type: 'Logitech', name: 'Rally Bar', version: '1.12.252', serial: '2685Y5O4TW98', status: 'InUse', healthStatus: 'Error', lastSeen: 1717200123000, createdAt: 1717200000000, network: { ip: '192.168.10.26', mac: '44:73:d6:c7:42:45', hostName: 'RallyBar-1L5V32' } },
    ],
  }],
};

test('Logitech Sync maps the official API example to the common format', () => {
  const c = new LogitechSyncConnector({ connection: conn('logitech-sync') });
  const [pc, rally, kb, bar] = c.mapDevices(LOGI_EXAMPLE.places, Date.parse('2024-06-01T00:10:00Z'));
  assert.equal(pc.site, 'Headquarters');
  assert.equal(pc.room, 'Large Room 5');
  assert.equal(pc.deviceType, 'Room PC');
  assert.equal(pc.health, 'healthy');
  assert.equal(rally.health, 'warning');
  assert.equal(rally.healthReason, 'Mic Pod: 1 of 2 connected');
  assert.equal(kb.health, 'offline');
  assert.equal(kb.lastSeen, new Date(1717200000000).toISOString());
  assert.equal(kb.weakIdentity, true);
  assert.equal(bar.health, 'critical');
  assert.equal(bar.serial, '2685Y5O4TW98');
  assert.equal(bar.mac, '44:73:d6:c7:42:45');
  assert.equal(bar.inUse, true);
  assert.equal(bar.deviceType, 'Video bar');
});

test('Logitech Sync follows continuation pagination', async () => {
  const pages = [
    { places: [LOGI_EXAMPLE.places[0]], continuation: 'abc' },
    { places: [{ ...LOGI_EXAMPLE.places[0], id: 'room2', name: 'Room 2' }] },
  ];
  const seen = [];
  const transport = { get: async (p, q) => { seen.push(q.continuation); return pages[seen.length - 1]; } };
  const devices = await new LogitechSyncConnector({ connection: conn('logitech-sync'), transport }).sync();
  assert.deepEqual(seen, [undefined, 'abc']);
  assert.equal(devices.length, 8);
});

test('Logitech Sync live mode calls /org/{orgId}/place over mutual TLS', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtls-'));
  const ssl = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=test-ca');
  for (const n of ['server', 'client']) {
    ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', `/CN=${n === 'server' ? 'localhost' : 'sync-client'}`);
    fs.writeFileSync(path.join(dir, `${n}.ext`), n === 'server' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1' : 'extendedKeyUsage=clientAuth');
    ssl('x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${n}.pem`, '-days', '1', '-extfile', `${n}.ext`);
  }
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const requests = [];
  const server = https.createServer({ key: read('server.key'), cert: read('server.pem'), ca: read('ca.pem'), requestCert: true, rejectUnauthorized: true }, (req, res) => {
    requests.push({ url: req.url, cn: req.socket.getPeerCertificate().subject?.CN });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(LOGI_EXAMPLE));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `https://127.0.0.1:${server.address().port}/v1`;
  const connection = conn('logitech-sync', { mode: 'live', settings: { orgId: 'ORG123', baseUrl: base } });
  const good = new LogitechSyncConnector({ connection, credentials: { certPem: read('client.pem'), keyPem: read('client.key'), caPem: read('ca.pem') } });
  const devices = await good.sync();
  assert.equal(devices.length, 4);
  assert.match(requests[0].url, /^\/v1\/org\/ORG123\/place\?projection=place\.info%2Cplace\.device/);
  assert.equal(requests[0].cn, 'sync-client');
  // Without a client certificate the server must refuse the connection.
  const bad = new LogitechSyncConnector({ connection, credentials: { certPem: 'x', keyPem: 'x', caPem: read('ca.pem') } });
  await assert.rejects(() => bad.sync());
});

test('Poly Lens auth: trims credentials and reports Poly\'s own error reason', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_client', error_description: 'Client not found' }) }; };
  const t = new PolyLensHttpTransport({ clientId: '  abc\n', clientSecret: ' s3cret ', ...POLY_DEFAULTS, fetchImpl });
  await assert.rejects(() => t.getToken(), (e) => /HTTP 400/.test(e.message) && /invalid_client: Client not found/.test(e.message) && /client ID/.test(e.message));
  assert.deepEqual(JSON.parse(calls[0].init.body), { client_id: 'abc', client_secret: 's3cret', grant_type: 'client_credentials' });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.match(polyAuthError(401, {}, ''), /wrong/);
  assert.match(polyAuthError(400, {}, '<html>bad</html>'), /^Poly Lens auth failed \(HTTP 400\)\. /);
});

test('Poly Lens ignores a Token URL that is not an https URL', () => {
  assert.equal(safeUrl('rahul@example.com', POLY_DEFAULTS.authUrl), POLY_DEFAULTS.authUrl);
  assert.equal(safeUrl('http://login.example.com/oauth/token', 'x'), 'x');
  assert.equal(safeUrl(' https://login.silica-prod01.io.lens.poly.com/oauth/token ', 'x'), POLY_DEFAULTS.authUrl);
  const c = new PolyLensConnector({ connection: conn('poly-lens', { mode: 'live', settings: { authUrl: 'someone@example.com' } }), credentials: { clientId: 'a', clientSecret: 'b' } });
  assert.equal(c.transport.authUrl, POLY_DEFAULTS.authUrl);
});
