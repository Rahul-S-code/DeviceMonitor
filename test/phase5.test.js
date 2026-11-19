// Phase 5: AV and network connectors, bulk CSV import, documentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { CONNECTORS, AV_DEMO_OEMS, createConnector, getConnectorClass } from '../server/connectors/registry.js';
import { YealinkYmcsConnector, YealinkHttpTransport, YEALINK_REGIONS } from '../server/connectors/yealink-ymcs/index.js';
import { NeatPulseConnector, NeatPulseHttpTransport } from '../server/connectors/neat-pulse/index.js';
import { CrestronXioConnector, CrestronXioHttpTransport } from '../server/connectors/crestron-xio/index.js';
import { QsysReflectConnector, reflectHealth } from '../server/connectors/qsys-reflect/index.js';
import { DomotzConnector, DomotzHttpTransport } from '../server/connectors/domotz/index.js';
import { BrightSignBsnConnector, BrightSignHttpTransport, BSN } from '../server/connectors/brightsign-bsn/index.js';
import { SonyBraviaConnector, SonyBraviaHttpTransport } from '../server/connectors/sony-bravia/index.js';
import { CrestronXioMockTransport } from '../server/connectors/crestron-xio/mock.js';
import { BrightSignMockTransport } from '../server/connectors/brightsign-bsn/mock.js';
import { dedupeDevices } from '../server/services/dedupe.js';
import { apiCatalogue } from '../server/services/api-tracker.js';
import { ERROR_CODES } from '../server/lib/issues.js';
import { HEALTH_ORDER, classifyDeviceType } from '../server/lib/device-model.js';
import { parseCsv, toCsv, csvObjects } from '../server/lib/csv.js';
import { Store } from '../server/lib/store.js';
import { docSections, BULK_COLUMNS_DOC } from '../public/docs.js';

const conn = (oem, extra = {}) => ({ id: `c-${oem}`, customerId: 'cust-helix', oem, mode: 'mock', settings: {}, ...extra });

/** A fetch stand-in: route(url, init) returns { status, body } and every call is recorded. */
function fakeFetch(route) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = (await route(String(url), init)) || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { calls, fetchImpl };
}

async function startApp(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm5-'));
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
  return { ctx, base, login, dataDir };
}

// ------------------------------------------------------------------ connectors

test('every new connector syncs valid devices from its mock, with codes on every fault', async () => {
  for (const oem of AV_DEMO_OEMS) {
    const C = getConnectorClass(oem);
    assert.ok(C.short && C.short.length === 2, `${oem} has a badge`);
    assert.ok(C.guide?.summary && C.guide?.health && C.guide?.location && C.guide?.needs?.length, `${oem} has documentation`);
    assert.ok(C.setupSteps.length, `${oem} has setup steps`);
    const devices = await createConnector(conn(oem), {}).sync();
    assert.ok(devices.length > 0, `${oem} returns devices`);
    for (const d of devices) {
      assert.ok(HEALTH_ORDER.includes(d.health), `${oem} health`);
      assert.ok(d.site && d.room && d.model && d.make && d.deviceType, `${oem} location and model`);
      assert.equal(d.sources[0].oem, oem);
      assert.ok(d.id.startsWith(`${oem}:`));
      if (d.health !== 'healthy') {
        assert.ok(d.issues.length, `${oem} ${d.health} device has an issue`);
        for (const i of d.issues) assert.ok(ERROR_CODES[i.code], `${oem} uses a known code (${i.code})`);
      }
    }
    assert.equal(new Set(devices.map((d) => d.id)).size, devices.length, `${oem} ids are unique`);
  }
});

test('demo-only connectors cannot go live and say why', async (t) => {
  for (const oem of ['biamp-workplace', 'shure-cloud', 'netgear-insight']) {
    const C = getConnectorClass(oem);
    assert.equal(C.liveSupported, false);
    assert.ok(C.liveNote.length > 40);
    assert.ok(C.actionsNote);
  }
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const res = await admin('/api/connections', { method: 'POST', body: JSON.stringify({ customerId: 'cust-helix', oem: 'netgear-insight', mode: 'live', name: 'x' }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no public API/i);
});

test('Yealink live: Basic token with timestamp and nonce, then Bearer, with paging', async () => {
  const devices = Array.from({ length: 130 }, (_, i) => ({ id: `d${i}`, mac: `805ec0${String(i).padStart(6, '0')}`, sn: `SN${i}`, modelId: 'm1', siteId: 'r1', programVersion: '1.0', deviceStatus: i === 0 ? 'offline' : i === 1 ? 'pending' : 'online' }));
  const { calls, fetchImpl } = fakeFetch((url, init) => {
    if (url.endsWith('/v2/token')) return { body: { access_token: 'ytok', expires_in: 86400 } };
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/v2/dm/listSites')) return { body: { data: [{ id: 's1', name: 'London HQ' }, { id: 'r1', name: 'Atlas', parentId: 's1' }], total: 2 } };
    if (url.endsWith('/v2/dm/listDevices')) return { body: { skip: body.skip, limit: body.limit, ...(body.autoCount ? { total: devices.length } : {}), data: devices.slice(body.skip, body.skip + body.limit) } };
    if (url.includes('/v2/dm/models')) return { body: url.endsWith('=3') ? [{ id: 'm1', name: 'MeetingBar A40' }] : [] };
    if (url.endsWith('/v2/dm/listAlarms')) return { body: { data: [{ id: 'a1', event: 'Camera disconnected', mac: '805ec0000002', status: 1 }] } };
    if (url.endsWith('/v2/dm/device/reboot')) return { body: { successCount: 1 } };
    return { status: 404 };
  });
  const c = new YealinkYmcsConnector({
    connection: conn('yealink-ymcs', { mode: 'live', settings: { region: 'eu' } }),
    credentials: { accessKeyId: 'AK', accessKeySecret: 'SK' },
    transport: new YealinkHttpTransport({ baseUrl: YEALINK_REGIONS.eu, accessKeyId: 'AK', accessKeySecret: 'SK', fetchImpl }),
  });
  const out = await c.sync();
  assert.equal(out.length, 130);
  const tok = calls.find((x) => x.url.endsWith('/v2/token'));
  assert.equal(tok.url, 'https://eu-api.ymcs.yealink.com/v2/token');
  assert.equal(tok.init.headers.authorization, `Basic ${Buffer.from('AK:SK').toString('base64')}`);
  assert.equal(calls.filter((x) => x.url.endsWith('/v2/token')).length, 1, 'token is cached');
  const nonces = calls.map((x) => x.init.headers.nonce);
  assert.ok(nonces.every(Boolean) && new Set(nonces).size === nonces.length, 'every request has a fresh nonce');
  assert.ok(calls.every((x) => /^\d{13}$/.test(x.init.headers.timestamp)));
  assert.ok(calls.filter((x) => !x.url.endsWith('/v2/token')).every((x) => x.init.headers.authorization === 'Bearer ytok'));
  assert.equal(calls.filter((x) => x.url.endsWith('/listDevices')).length, 2, 'pages of 100');
  const by = Object.fromEntries(out.map((d) => [d.serial, d]));
  assert.equal(by.SN0.health, 'offline'); assert.equal(by.SN0.issues[0].code, 'EM-NET-001');
  assert.equal(by.SN1.issues[0].code, 'EM-REG-001');
  assert.equal(by.SN2.health, 'warning'); assert.equal(by.SN2.issues[0].code, 'EM-PER-001');
  assert.equal(by.SN5.site, 'London HQ'); assert.equal(by.SN5.room, 'Atlas'); assert.equal(by.SN5.model, 'Yealink MeetingBar A40');
  assert.equal(by.SN5.deviceType, 'Video bar');
  // Reboot sends the YMCS device id and type.
  const r = await c.runAction('reboot', out[3].sources[0], out[3]);
  assert.ok(r.ok);
  const reboot = calls.find((x) => x.url.endsWith('/v2/dm/device/reboot'));
  assert.deepEqual(JSON.parse(reboot.init.body), { deviceIds: ['d3'], deviceType: 3 });
});

test('Neat Pulse live: Bearer key, org path, rooms and firmware updates, reboot', async () => {
  const { calls, fetchImpl } = fakeFetch((url) => {
    if (url.endsWith('/v1/orgs/ORG1/endpoints')) return { body: [{ id: 'e1', serial: 'NB1', model: 'Neat Bar', roomId: 'r1', connected: true }, { id: 'e2', serialNumber: 'NP2', model: 'Pad', roomId: 'r1', status: 'offline' }, { id: 'e3', serial: 'NB3', model: 'Neat Board', roomId: 'r1', online: true }] };
    if (url.endsWith('/rooms')) return { body: [{ id: 'r1', name: 'Fjord', locationId: 'l1' }] };
    if (url.endsWith('/locations')) return { body: [{ id: 'l1', name: 'Oslo' }] };
    if (url.endsWith('/endpoints/apps')) return { body: [{ endpointId: 'e3', needs_firmware_update: true }] };
    if (url.endsWith('/reboot')) return { body: {} };
    return { status: 404 };
  });
  const c = new NeatPulseConnector({ connection: conn('neat-pulse', { mode: 'live', settings: { orgId: 'ORG1' } }), credentials: { apiKey: 'K' }, transport: new NeatPulseHttpTransport({ apiKey: 'K', fetchImpl }) });
  const out = await c.sync();
  assert.ok(calls.every((x) => x.init.headers.authorization === 'Bearer K' && x.url.startsWith('https://api.pulse.neat.no/v1/orgs/ORG1/')));
  const by = Object.fromEntries(out.map((d) => [d.serial, d]));
  assert.equal(by.NB1.health, 'healthy'); assert.equal(by.NB1.site, 'Oslo'); assert.equal(by.NB1.room, 'Fjord');
  assert.equal(by.NP2.health, 'offline'); assert.equal(by.NP2.model, 'Neat Pad'); assert.equal(by.NP2.deviceType, 'Touch controller');
  assert.equal(by.NB3.health, 'warning'); assert.equal(by.NB3.issues[0].code, 'EM-FW-001');
  await c.runAction('reboot', by.NB1.sources[0], by.NB1);
  assert.equal(calls.at(-1).url, 'https://api.pulse.neat.no/v1/orgs/ORG1/endpoints/e1/reboot');
  assert.equal(calls.at(-1).init.method, 'POST');
});

test('Crestron XiO live: subscription key header, paged status, room groups, faults', async () => {
  const dev = (i, status, extra = {}) => ({ device: { 'device-cid': `00-10-7f-00-00-0${i}_-1`, 'device-model': 'TSW-1070', 'device-category': 'TouchPanel', 'device-manufacturer': 'Crestron', 'device-status': status, 'device-groupid': 'room', 'serial-number': `CR${i}`, 'firmware-version': '3.0' }, ...extra });
  const { calls, fetchImpl } = fakeFetch((url) => {
    const m = url.match(/pageno\/(\d+)\/pagesize\/\d+\/status$/);
    if (m) return { body: { Pagination: { TotalDevices: 3, TotalPages: 2 }, DeviceList: m[1] === '1' ? [dev(1, 'Online'), dev(2, 'Offline')] : [dev(3, 'Online', { 'hdmi-input': { 'hdmi-input-fault': 'No sync' } })] } };
    if (url.endsWith('/groups')) return { body: [{ id: 'site', Name: 'Leeds', ParentGroupId: null }, { id: 'room', Name: 'Aire', ParentGroupId: 'site', IsRoom: true }] };
    return { status: 404 };
  });
  const c = new CrestronXioConnector({ connection: conn('crestron-xio', { mode: 'live', settings: { accountId: 'ACC' } }), credentials: { subscriptionKey: 'XK' }, transport: new CrestronXioHttpTransport({ subscriptionKey: 'XK', fetchImpl }) });
  const out = await c.sync();
  assert.equal(out.length, 3);
  assert.ok(calls.every((x) => x.init.headers['XiO-subscription-key'] === 'XK'));
  assert.equal(calls[0].url, 'https://api.crestron.io/api/v2/device/accountid/ACC/pageno/1/pagesize/100/status');
  const by = Object.fromEntries(out.map((d) => [d.serial, d]));
  assert.equal(by.CR1.site, 'Leeds'); assert.equal(by.CR1.room, 'Aire'); assert.equal(by.CR1.mac, '00:10:7f:00:00:01'); assert.equal(by.CR1.model, 'Crestron TSW-1070');
  assert.equal(by.CR2.health, 'offline');
  assert.equal(by.CR3.health, 'warning'); assert.equal(by.CR3.issues[0].code, 'EM-PER-004');
  assert.equal(CrestronXioConnector.actions.length, 0);
});

test('Crestron mock pages like the real API', async () => {
  const inner = new CrestronXioMockTransport('cust-helix');
  const seen = [];
  const transport = { get: (p) => { seen.push(p); return inner.get(p.replace('/pagesize/100/', '/pagesize/5/')); } };
  const paged = await new CrestronXioConnector({ connection: conn('crestron-xio'), transport }).sync();
  const all = await new CrestronXioConnector({ connection: conn('crestron-xio') }).sync();
  assert.equal(paged.length, all.length);
  assert.ok(seen.filter((p) => p.includes('/pageno/')).length >= Math.ceil(all.length / 5));
});

test('Q-SYS Reflect maps status codes and messages to health', () => {
  assert.equal(reflectHealth({ status: { code: 0, message: 'OK' }, isOnline: true }), 'healthy');
  assert.equal(reflectHealth({ status: { code: 0, message: 'Running' } }), 'healthy');
  assert.equal(reflectHealth({ status: { code: 2, message: 'Compromised' }, isOnline: true }), 'warning');
  assert.equal(reflectHealth({ status: { code: 4, message: 'Fault: amplifier' } }), 'critical');
  assert.equal(reflectHealth({ status: { code: 7, message: 'Offline' } }), 'offline');
  assert.equal(reflectHealth({ status: { code: 0, message: 'OK' }, isOnline: false }), 'offline');
  assert.equal(reflectHealth({ status: { code: 5, message: 'Not Present' } }), 'offline');
});

test('Q-SYS Reflect uses the regional server and a Bearer token', async () => {
  const c = new QsysReflectConnector({ connection: conn('qsys-reflect', { mode: 'live', settings: { region: 'EMEA' } }), credentials: { token: 'T'.repeat(64) } });
  assert.equal(c.transport.baseUrl, 'https://emea.reflect.qsc.com/api/public/v0');
  const us = new QsysReflectConnector({ connection: conn('qsys-reflect', { mode: 'live', settings: {} }), credentials: { token: 'x' } });
  assert.equal(us.transport.baseUrl, 'https://reflect.qsc.com/api/public/v0');
  const devices = await new QsysReflectConnector({ connection: conn('qsys-reflect') }).sync();
  assert.ok(devices.some((d) => d.deviceType === 'Camera') && devices.some((d) => d.deviceType === 'Audio DSP'));
  assert.ok(devices.every((d) => d.make === 'Q-SYS'));
});

test('Domotz: X-Api-Key, room filter, DOWN is EM-NET-003, collector offline marks its site', async () => {
  const agents = [{ id: 11, display_name: 'Leeds', status: { value: 'ONLINE' } }, { id: 12, display_name: 'York', status: { value: 'OFFLINE' } }];
  const devs = {
    11: [
      { id: 1, display_name: 'sw', status: 'ONLINE', importance: 'VITAL', hw_address: '9c:c9:eb:00:00:01', ip_addresses: ['10.0.0.2'], vendor: 'NETGEAR', model: 'M4250-10G2XF-PoE+', details: { room: 'Aire', serial: 'NG1' } },
      { id: 2, display_name: 'tv', status: 'DOWN', importance: 'FLOATING', hw_address: '04:5d:4b:00:00:02', vendor: 'Sony', details: { room: 'Aire' } },
      { id: 3, display_name: 'laptop', status: 'ONLINE', importance: 'FLOATING', hw_address: 'aa:bb:cc:00:00:03', vendor: 'Dell' },
      { id: 4, display_name: 'ghost', status: 'HIDDEN', importance: 'VITAL', details: { room: 'Aire' } },
    ],
    12: [{ id: 5, display_name: 'panel', status: 'ONLINE', importance: 'VITAL', hw_address: '00:10:7f:00:00:05', vendor: 'Crestron', details: { room: 'Ouse' } }],
  };
  const { calls, fetchImpl } = fakeFetch((url, init) => {
    if (init.method === 'POST') return { body: {} };
    if (url.endsWith('/agent')) return { body: agents };
    const m = url.match(/\/agent\/(\d+)\/device$/);
    return m ? { body: devs[m[1]] } : { status: 404 };
  });
  const make = (filter) => new DomotzConnector({ connection: conn('domotz', { mode: 'live', settings: { baseUrl: 'https://api-eu-central-1-cell-1.domotz.com/public-api/v1', filter } }), credentials: { apiKey: 'DK' }, transport: new DomotzHttpTransport({ apiKey: 'DK', baseUrl: 'https://api-eu-central-1-cell-1.domotz.com/public-api/v1', fetchImpl }) });
  const room = await make('room').sync();
  assert.deepEqual(room.map((d) => d.hostName).sort(), ['panel', 'sw', 'tv']);
  assert.ok(calls.every((x) => x.init.headers['x-api-key'] === 'DK' && x.url.startsWith('https://api-eu-central-1-cell-1.domotz.com/')));
  const tv = room.find((d) => d.hostName === 'tv');
  assert.equal(tv.health, 'offline'); assert.equal(tv.issues[0].code, 'EM-NET-003'); assert.equal(tv.site, 'Leeds'); assert.equal(tv.room, 'Aire');
  const panel = room.find((d) => d.hostName === 'panel');
  assert.equal(panel.health, 'offline'); assert.match(panel.healthReason, /collector/);
  assert.equal((await make('vital').sync()).length, 2);
  assert.equal((await make('all').sync()).length, 4);
  await make('room').runAction('cycle', tv.sources[0], tv);
  assert.match(calls.at(-1).url, /\/agent\/11\/device\/2\/action\/power\/cycle$/);
  assert.equal(DomotzConnector.apiSetLabel, 'Network monitoring API');
});

test('BrightSign live: client-credentials token, network selected once, marker paging, stale players offline', async () => {
  const now = Date.now();
  const player = (i, extra = {}) => ({ id: i, serial: `XT${i}`, model: 'XT1144', settings: { name: `Sign ${i}`, description: 'Leeds / Aire' }, status: { health: 'Normal', lastModifiedDate: new Date(now - 60_000).toISOString(), ...extra } });
  const { calls, fetchImpl } = fakeFetch((url, init) => {
    if (url === BSN.authUrl) return { body: { access_token: 'btok', expires_in: 3600 } };
    if (url.endsWith('/Self/Session/Network')) return { status: 204 };
    if (url.includes('/Devices/')) return url.includes('marker=') ? { body: { items: [player(3, { health: 'Error' })], isTruncated: false } } : { body: { items: [player(1), player(2, { lastModifiedDate: new Date(now - 3 * 3_600_000).toISOString() })], isTruncated: true, nextMarker: 'm2' } };
    return { status: 404 };
  });
  const c = new BrightSignBsnConnector({ connection: conn('brightsign-bsn', { mode: 'live', settings: { network: 'Lobby' } }), credentials: { clientId: 'ci', clientSecret: 'cs' }, transport: new BrightSignHttpTransport({ clientId: 'ci', clientSecret: 'cs', network: 'Lobby', fetchImpl }) });
  const out = await c.sync();
  const tok = calls[0];
  assert.equal(tok.init.body, 'grant_type=client_credentials');
  assert.equal(tok.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tok.init.headers.authorization, `Basic ${Buffer.from('ci:cs').toString('base64')}`);
  const net = calls.filter((x) => x.url.endsWith('/Self/Session/Network'));
  assert.equal(net.length, 1); assert.equal(net[0].init.method, 'PUT'); assert.deepEqual(JSON.parse(net[0].init.body), { name: 'Lobby' });
  assert.equal(out.length, 3);
  const by = Object.fromEntries(out.map((d) => [d.serial, d]));
  assert.equal(by.XT1.health, 'healthy'); assert.equal(by.XT1.site, 'Leeds'); assert.equal(by.XT1.room, 'Aire'); assert.equal(by.XT1.deviceType, 'Signage player');
  assert.equal(by.XT2.health, 'offline');
  assert.equal(by.XT3.health, 'critical');
});

test('BrightSign mock pages with markers', async () => {
  const inner = new BrightSignMockTransport('cust-helix');
  const transport = { get: (p) => inner.get(p.replace('pageSize=100', 'pageSize=2')) };
  const a = await new BrightSignBsnConnector({ connection: conn('brightsign-bsn'), transport }).sync();
  const b = await new BrightSignBsnConnector({ connection: conn('brightsign-bsn') }).sync();
  assert.equal(a.length, b.length);
});

test('Sony BRAVIA live: key headers, online status per display, site and room from the name, screen actions', async () => {
  const { calls, fetchImpl } = fakeFetch((url, init) => {
    if (url.endsWith('/devices')) return { body: { devices: [{ deviceId: 'a', deviceName: 'Leeds / Aire / Display', modelName: 'FW-85BZ40L', serial: 'S1', softwareVersion: '6.7381', networkInterfaces: [{ type: 'wired', macAddress: '04:5d:4b:00:00:02', ipv4Address: '10.0.0.9' }] }, { deviceId: 'b', deviceName: 'Lobby screen', modelName: 'FW-55BZ30L', serial: 'S2' }] } };
    if (url.endsWith('/a/online-status')) return { body: { online: true } };
    if (url.endsWith('/b/online-status')) return { body: { online: false } };
    if (init.method === 'POST') return { status: 201, body: { requestId: 'r1' } };
    return { status: 404 };
  });
  const c = new SonyBraviaConnector({ connection: conn('sony-bravia', { mode: 'live', settings: { defaultSite: 'HQ' } }), credentials: { apiKey: 'AK', accessKey: 'XK' }, transport: new SonyBraviaHttpTransport({ apiKey: 'AK', accessKey: 'XK', fetchImpl }) });
  const out = await c.sync();
  assert.ok(calls.every((x) => x.init.headers['x-api-key'] === 'AK' && x.init.headers['x-access-key'] === 'XK'));
  const [a, b] = out;
  assert.equal(a.site, 'Leeds'); assert.equal(a.room, 'Aire'); assert.equal(a.health, 'healthy'); assert.equal(a.mac, '04:5d:4b:00:00:02'); assert.equal(a.model, 'BRAVIA FW-85BZ40L');
  assert.equal(b.site, 'HQ'); assert.equal(b.room, 'Lobby screen'); assert.equal(b.health, 'offline');
  await c.runAction('screen-off', a.sources[0], a);
  assert.match(calls.at(-1).url, /\/devices\/a\/screen\/requests$/);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { screen: 'OFF' });
  await c.runAction('reboot', a.sources[0], a);
  assert.match(calls.at(-1).url, /\/devices\/a\/reboot\/requests$/);
  // Custom header names from Sony's onboarding pack.
  const custom = new SonyBraviaConnector({ connection: conn('sony-bravia', { mode: 'live', settings: { apiKeyHeader: 'X-Sony-Key', accessKeyHeader: 'X-Sony-Access' } }), credentials: { apiKey: 'AK', accessKey: 'XK' } });
  assert.deepEqual(custom.transport.headers, { 'X-Sony-Key': 'AK', 'X-Sony-Access': 'XK' });
});

test('HTTP errors become messages that say what to fix', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 401 }));
  const c = new NeatPulseConnector({ connection: conn('neat-pulse', { mode: 'live', settings: { orgId: 'O' } }), credentials: { apiKey: 'bad' }, transport: new NeatPulseHttpTransport({ apiKey: 'bad', fetchImpl }) });
  await assert.rejects(() => c.testConnection(), /Neat Pulse returned 401: the API key is wrong/);
  const rl = fakeFetch(() => ({ status: 429 }));
  const x = new CrestronXioConnector({ connection: conn('crestron-xio', { mode: 'live', settings: { accountId: 'A' } }), credentials: { subscriptionKey: 'k' }, transport: new CrestronXioHttpTransport({ subscriptionKey: 'k', fetchImpl: rl.fetchImpl }) });
  await assert.rejects(() => x.testConnection(), /rate limit/);
  const missing = new YealinkYmcsConnector({ connection: conn('yealink-ymcs', { mode: 'live', settings: { region: 'us' } }), credentials: {} });
  await assert.rejects(() => missing.testConnection(), /Missing AccessKey ID, AccessKey Secret/);
});

test('Domotz merges with the vendor record of the same device, and the vendor\'s fields win', async () => {
  const all = [];
  for (const oem of ['sony-bravia', 'netgear-insight', 'brightsign-bsn', 'crestron-xio', 'domotz']) all.push(...await createConnector(conn(oem), {}).sync());
  const merged = dedupeDevices(all);
  const withDomotz = merged.filter((d) => d.sources.some((s) => s.oem === 'domotz'));
  assert.ok(withDomotz.length > 10);
  assert.ok(withDomotz.every((d) => d.sources.length === 2), 'every Domotz device matched its vendor record');
  const sony = withDomotz.find((d) => d.sources.some((s) => s.oem === 'sony-bravia'));
  assert.equal(sony.make, 'Sony'); assert.match(sony.model, /^BRAVIA FW-85/);
  const sw = withDomotz.find((d) => d.sources.some((s) => s.oem === 'netgear-insight'));
  assert.equal(sw.make, 'NETGEAR'); assert.equal(sw.deviceType, 'Network switch');
});

test('new device types and the network error code', () => {
  assert.equal(classifyDeviceType('Tesira FORTE X 1600'), 'Audio DSP');
  assert.equal(classifyDeviceType('Shure MXA920'), 'Microphone');
  assert.equal(classifyDeviceType('TSW-1070'), 'Touch controller');
  assert.equal(classifyDeviceType('CP4N'), 'Control processor');
  assert.equal(classifyDeviceType('Yealink CP965'), 'Conference phone');
  assert.equal(classifyDeviceType('M4250-10G2XF-PoE+'), 'Network switch');
  assert.equal(classifyDeviceType('XT1144'), 'Signage player');
  assert.equal(classifyDeviceType('BRAVIA FW-85BZ40L'), 'Display');
  assert.equal(classifyDeviceType('Rally Bar'), 'Video bar');
  assert.equal(classifyDeviceType('Poly TC8'), 'Touch controller');
  assert.ok(ERROR_CODES['EM-NET-003'].causes.length >= 3);
});

test('API tracker lists the new APIs; ShureCloud and NETGEAR show as no API', () => {
  const cat = apiCatalogue([]);
  for (const id of ['yealink-devices', 'neat-endpoints', 'xio-status', 'reflect-items', 'domotz-devices', 'bsn-devices', 'sony-devices']) {
    const a = cat.find((x) => x.id === id);
    assert.ok(a, id); assert.ok(a.probe?.startsWith('https://'), `${id} probe`); assert.ok(!a.probe.includes('{'), `${id} probe has no placeholder`);
  }
  for (const id of ['shure-cloud', 'netgear-insight']) assert.equal(cat.find((x) => x.id === id).probe, null);
  const ids = cat.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'API ids are unique');
});

test('every connector has a unique badge and documentation', () => {
  const shorts = CONNECTORS.map((C) => C.short);
  assert.equal(new Set(shorts).size, shorts.length);
  for (const C of CONNECTORS) {
    assert.ok(C.guide?.summary, `${C.oem} guide`);
    const d = C.describe();
    assert.ok(d.short && d.guide && Array.isArray(d.apis));
    assert.ok(d.apis.every((a) => !('probe' in a)));
  }
  assert.equal(getConnectorClass('webex-control-hub').displayName, 'Cisco Control Hub (Webex)');
});

// ------------------------------------------------------------------ demo data

test('demo customers get the AV demo connections once, and old stores are migrated once', async (t) => {
  const { ctx, login, dataDir } = await startApp(t);
  for (const id of ['cust-helix', 'cust-northwind', 'cust-meridian']) {
    const oems = ctx.store.connections.filter((c) => c.customerId === id).map((c) => c.oem);
    for (const o of AV_DEMO_OEMS) assert.ok(oems.includes(o), `${id} has ${o}`);
  }
  assert.ok(ctx.store.models.some((m) => m.make === 'Crestron' && m.monitoredBy.includes('domotz')));
  const admin = await login('admin@provider.example');
  const devices = await (await admin('/api/devices')).json();
  for (const o of AV_DEMO_OEMS) assert.ok(devices.some((d) => d.oems.includes(o)), `devices from ${o}`);
  assert.ok(devices.filter((d) => d.oems.includes('sony-bravia')).every((d) => d.mock), 'demo devices carry the Mock flag');

  // An older store (before phase 5) gains them on start; a deleted one is not re-added.
  const file = path.join(dataDir, 'store.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.connections = old.connections.filter((c) => !AV_DEMO_OEMS.includes(c.oem));
  delete old.phase5;
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dm5m-'));
  t.after(() => fs.rmSync(dir2, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir2, 'store.json'), JSON.stringify(old));
  const s = new Store(dir2);
  assert.equal(s.migrate('pw'), true);
  assert.equal(s.connections.filter((c) => c.oem === 'domotz').length, 3);
  s.data.connections = s.connections.filter((c) => c.oem !== 'domotz');
  s.migrate('pw');
  assert.equal(s.connections.filter((c) => c.oem === 'domotz').length, 0);
  s.close?.();
});

// ------------------------------------------------------------------ CSV

test('CSV reader handles quotes, commas, CRLF and the Excel BOM; writer escapes and blocks formulas', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""",z\r\n\r\n1,,3\n"multi\nline",2,3');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', 'z'], ['1', '', '3'], ['multi\nline', '2', '3']]);
  assert.throws(() => parseCsv('a,"b\n1,2'), /never closed/);
  assert.equal(toCsv([['a,b', 'q"q', '=SUM(A1)', '@x', 'plain']]), '"a,b","q""q",\'=SUM(A1),\'@x,plain\r\n');
  const o = csvObjects('Site,Room,Asset Tag,warranty_end\nL,R,A1,2028-01-01');
  assert.deepEqual(o.headers, ['site', 'room', 'assettag', 'warrantyend']);
  assert.deepEqual(o.records[0], { line: 2, values: { site: 'L', room: 'R', assettag: 'A1', warrantyend: '2028-01-01' } });
});

test('bulk import: template, row-by-row preview, import, duplicates and permissions', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const tpl = await admin('/api/manual-devices/template.csv');
  assert.equal(tpl.status, 200);
  assert.match(tpl.headers.get('content-type'), /text\/csv/);
  assert.match(tpl.headers.get('content-disposition'), /attachment/);
  const text = await tpl.text();
  const [head] = parseCsv(text);
  assert.deepEqual(head, ['customer', 'site', 'room', 'make', 'model', 'device_type', 'serial', 'mac', 'firmware', 'platform', 'asset_tag', 'warranty_end', 'warranty_type', 'notes']);
  assert.ok(text.includes('Poly Studio X50'), 'lists the model master');
  assert.equal(BULK_COLUMNS_DOC.map((c) => c[0]).join(), head.join(), 'documentation matches the template');

  const csv = [
    'customer,site,room,make,model,serial,mac,firmware,warranty_end,notes',
    'Helix Financial,London HQ,Atlas 4.01,Poly,Poly Studio X50,BULK0001,00:11:22:33:44:01,4.2.0,2028-01-31,first',
    ',London HQ,Atlas 4.01,Poly,Poly TC8,BULK0002,,,,',
    'Helix Financial,London HQ,Atlas 4.01,Acme,Widget 9000,BULK0003,,,,',
    'Helix Financial,London HQ,,Poly,Poly TC8,BULK0004,,,,',
    'Helix Financial,London HQ,Atlas 4.01,Poly,Poly TC8,BULK0001,,,,',
    'Nope Ltd,London HQ,Atlas 4.01,Poly,Poly TC8,BULK0005,,,,',
    'Helix Financial,London HQ,Atlas 4.01,Poly,Poly TC8,BULK0006,zz,,,',
    'Helix Financial,London HQ,Atlas 4.01,Poly,Poly TC8,BULK0007,,,31/12/2028,',
    '"Helix Financial","New ""Wing""",Room 1,poly,poly studio x50,BULK0008,,,,"multi, comma"',
    '# a comment line from the template,,,,,,',
  ].join('\n');
  const post = (body) => admin('/api/manual-devices/import', { method: 'POST', body: JSON.stringify(body) });
  // No default customer: row 3 has no customer.
  let r = await (await post({ csv })).json();
  const err = (line) => r.rows.find((x) => x.line === line).error;
  assert.equal(r.rows.length, 9, 'comment line skipped');
  assert.equal(r.valid, 2);
  assert.match(err(3), /No customer/);
  assert.match(err(4), /not in the model master/);
  assert.match(err(5), /required/);
  assert.match(err(6), /already been added/);
  assert.match(err(7), /Customer "Nope Ltd" not found/);
  assert.match(err(8), /MAC address/);
  assert.match(err(9), /YYYY-MM-DD/);
  const quoted = r.rows.find((x) => x.line === 10);
  assert.ok(quoted.ok); assert.equal(quoted.site, 'New "Wing"'); assert.equal(quoted.model, 'Poly Studio X50', 'case-insensitive match to the master');
  assert.equal(ctx.store.manualDevices.length, 0, 'preview saves nothing');

  // Default customer and unlisted models allowed.
  r = await (await post({ csv, customerId: 'cust-helix', allowUnlisted: true })).json();
  assert.equal(r.valid, 4);
  assert.equal(r.rows.find((x) => x.line === 4).linked, false);

  r = await (await post({ csv, customerId: 'cust-helix', allowUnlisted: true, commit: true })).json();
  assert.equal(r.added, 4);
  assert.equal(ctx.store.manualDevices.length, 4);
  const devices = await (await admin('/api/devices?q=BULK')).json();
  assert.equal(devices.length, 4);
  assert.ok(devices.every((d) => d.health === 'unmonitored' && !d.mock));
  const widget = devices.find((d) => d.serial === 'BULK0003');
  assert.equal(widget.make, 'Acme');
  // Importing the same file again: every serial is now taken.
  r = await (await post({ csv, customerId: 'cust-helix', allowUnlisted: true, commit: true })).json();
  assert.equal(r.added, 0);
  const audit = await (await admin('/api/audit?action=device.bulk_import')).json();
  assert.ok(audit.entries.some((e) => e.action === 'device.bulk_import' && /4 devices from CSV/.test(e.target)));

  // Bad files.
  let res = await post({ csv: 'name,serial\nx,y' });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /site, room, make, model/);
  res = await post({ csv: '' });
  assert.equal(res.status, 400);
  res = await post({ csv: `site,room,make,model\n${'a,b,Poly,Poly TC8\n'.repeat(2001)}`, customerId: 'cust-helix' });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /2000 rows/);
  res = await post({ csv: 'site,room,make,model\n"a,b', customerId: 'cust-helix' });
  assert.equal(res.status, 400); assert.match((await res.json()).error, /never closed/);
  // A large file (over the normal 256 kB body limit) is accepted.
  const big = `site,room,make,model,notes\n${Array.from({ length: 1900 }, (_, i) => `S,R${i},Poly,Poly TC8,${'n'.repeat(150)}`).join('\n')}`;
  res = await post({ csv: big, customerId: 'cust-helix' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).valid, 1900);

  // Customers cannot import or download the template.
  const viewer = await login('it@helix.example');
  assert.equal((await viewer('/api/manual-devices/template.csv')).status, 403);
  assert.equal((await viewer('/api/manual-devices/import', { method: 'POST', body: JSON.stringify({ csv }) })).status, 403);
});

test('bulk import respects the customer an admin has entered', async (t) => {
  const { login } = await startApp(t);
  const admin = await login('admin@provider.example');
  const enter = await admin('/api/session/enter', { method: 'POST', body: JSON.stringify({ customerId: 'cust-northwind' }) });
  assert.equal(enter.status, 200);
  const csv = 'customer,site,room,make,model\nHelix Financial,London HQ,Atlas,Poly,Poly TC8\nNorthwind Retail,Chicago,Lake,Poly,Poly TC8';
  const r = await (await admin('/api/manual-devices/import', { method: 'POST', body: JSON.stringify({ csv }) })).json();
  assert.equal(r.rows[0].ok, false);
  assert.match(r.rows[0].error, /not found/);
  assert.equal(r.rows[1].ok, true);
});

// ------------------------------------------------------------------ documentation

test('documentation covers every connector and hides admin chapters from customers', async (t) => {
  const connectors = CONNECTORS.map((C) => C.describe());
  const admin = docSections({ connectors, role: 'provider_admin' });
  const html = admin.map((s) => s.html).join('');
  for (const C of CONNECTORS) {
    assert.ok(html.includes(`id="doc-conn-${C.oem}"`), `${C.oem} chapter`);
    for (const step of C.setupSteps) assert.ok(html.includes(step.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')), `${C.oem} step shown`);
  }
  assert.ok(admin.some((s) => s.id === 'adding') && admin.some((s) => s.id === 'hosting'));
  assert.ok(html.includes('Cisco Control Hub'));
  const viewer = docSections({ connectors, role: 'customer_viewer' });
  assert.ok(!viewer.some((s) => ['adding', 'configure', 'hosting'].includes(s.id)));
  assert.ok(new Set(admin.map((s) => s.id)).size === admin.length);
  const { base } = await startApp(t);
  const js = await fetch(`${base}/docs.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});
