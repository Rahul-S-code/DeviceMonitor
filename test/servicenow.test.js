// ServiceNow incidents per customer: settings, live client against a fake
// Table API, raising/dedupe/resolve, ServiceNow-side closes, reports, inbox
// dispatches, manual raise, permissions and tenant isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { addSecondCustomer } from './fixtures.js';
import { ServiceNowClient, MockServiceNowClient, cleanInstanceUrl, correlationId } from '../server/lib/servicenow.js';
import { cleanItsm } from '../server/services/tickets.js';

const OTHER = 'cust-northwind';

async function startApp(t, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsnow-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false, checksMinDownMs: 0, ...opts });
  addSecondCustomer(ctx.store);
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.checks.stop(); ctx.tickets.stop(); ctx.store.close(); ctx.history.close(); ctx.apiTracker.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password = 'demo1234') => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login ${email}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = async (p, body, method = body ? 'POST' : 'GET') => {
      const r = await fetch(base + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return call;
  };
  return { ctx, login };
}

/** A fake ServiceNow Table API. */
function fakeServiceNow() {
  const rows = new Map();
  const calls = [];
  let n = 10000;
  const json = (status, body) => ({ ok: status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
    if (init.headers?.authorization !== `Basic ${Buffer.from('estate.monitor:pw1').toString('base64')}`) return json(401, { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' });
    if (u.pathname === '/api/now/table/sys_user_group') return json(200, { result: u.searchParams.get('sysparm_query') === 'name=Service Desk' ? [{ sys_id: 'g1', name: 'Service Desk' }] : [] });
    if (u.pathname === '/api/now/table/incident' && init.method === 'GET') {
      const q = u.searchParams.get('sysparm_query') || '';
      if (q.startsWith('correlation_id=')) { const c = q.slice(15).replace('^active=true', ''); return json(200, { result: [...rows.values()].filter((r) => r.correlation_id === c && r.active === 'true').slice(0, 1) }); }
      if (q.startsWith('sys_idIN')) { const ids = q.slice(8).split(','); return json(200, { result: ids.map((id) => rows.get(id)).filter(Boolean) }); }
      return json(200, { result: [...rows.values()].slice(0, 1) });
    }
    if (u.pathname === '/api/now/table/incident' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const row = { sys_id: `s${++n}`, number: `INC00${n}`, state: '1', active: 'true', ...b };
      rows.set(row.sys_id, row);
      return json(201, { result: row });
    }
    const m = u.pathname.match(/^\/api\/now\/table\/incident\/(.+)$/);
    if (m && init.method === 'PATCH') {
      const row = rows.get(m[1]);
      if (!row) return json(404, { error: { message: 'No Record found' } });
      const b = JSON.parse(init.body);
      if (b.state === '6' && b.close_code === 'Bad code') return json(403, { error: { message: 'Operation Failed', detail: 'Data Policy Exception: Resolution code is mandatory' } });
      Object.assign(row, b);
      if (b.state) row.active = ['6', '7', '8'].includes(String(b.state)) ? 'false' : 'true';
      return json(200, { result: row });
    }
    return json(404, { error: { message: 'unexpected' } });
  };
  return { rows, calls, fetchImpl };
}

test('instance URL and settings are validated', () => {
  assert.equal(cleanInstanceUrl('dev489785'), 'https://dev489785.service-now.com');
  assert.equal(cleanInstanceUrl(' https://dev489785.service-now.com/now/nav/ui/classic/params/target/ui_page.do '), 'https://dev489785.service-now.com');
  assert.throws(() => cleanInstanceUrl('http://dev1.service-now.com'), /https/);
  assert.throws(() => cleanInstanceUrl('https://user:pw@dev1.service-now.com'), /https/);
  assert.throws(() => cleanItsm({ enabled: true, mode: 'live' }), /instance URL/);
  assert.throws(() => cleanItsm({ priorities: { offline: 9 } }), /Priority/);
  assert.throws(() => cleanItsm({ delayMinutes: -1 }), /Wait/);
  const c = cleanItsm({ enabled: true, triggers: { warning: true }, delayMinutes: '5' });
  assert.equal(c.mode, 'mock'); assert.equal(c.triggers.warning, true); assert.equal(c.triggers.offline, true); assert.equal(c.delayMinutes, 5);
  assert.ok(correlationId('device:x').startsWith('estate-monitor:'));
  assert.ok(correlationId(`device:${'y'.repeat(200)}`).length <= 100);
});

test('live client: auth errors explain themselves, group is checked, incidents are created with display values', async () => {
  const sn = fakeServiceNow();
  const bad = new ServiceNowClient({ instanceUrl: 'https://dev1.service-now.com', username: 'estate.monitor', password: 'nope', fetchImpl: sn.fetchImpl });
  await assert.rejects(() => bad.test(), /HTTP 401: User Not Authenticated.*user name or password/);
  const c = new ServiceNowClient({ instanceUrl: 'https://dev1.service-now.com', username: 'estate.monitor', password: 'pw1', fetchImpl: sn.fetchImpl });
  assert.equal((await c.test({ assignmentGroup: 'Service Desk' })).ok, true);
  const miss = await c.test({ assignmentGroup: 'Nope' });
  assert.equal(miss.ok, false); assert.match(miss.message, /no assignment group called "Nope"/);
  const row = await c.create({ short_description: 'x', correlation_id: 'estate-monitor:k' });
  assert.match(row.number, /^INC/);
  const post = sn.calls.find((x) => x.method === 'POST');
  assert.equal(post.query.sysparm_input_display_value, 'true');
  assert.equal((await c.findOpen('estate-monitor:k')).sys_id, row.sys_id);
  // A sleeping developer instance answers with a web page.
  const asleep = new ServiceNowClient({ instanceUrl: 'https://dev1.service-now.com', username: 'a', password: 'b', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>Your instance is hibernating</html>' }) });
  await assert.rejects(() => asleep.test(), /asleep/);
});

test('device faults raise one incident each after the delay, and recovery resolves it', async (t) => {
  const sn = fakeServiceNow();
  const { ctx, login } = await startApp(t);
  ctx.tickets.clientFactory = (cid, cfg) => (cfg.mode === 'live' ? new ServiceNowClient({ instanceUrl: cfg.instanceUrl, username: cfg.username, password: 'pw1', fetchImpl: sn.fetchImpl }) : new MockServiceNowClient(cid));
  let now = Date.now();
  ctx.tickets.now = () => now;
  const admin = await login('admin@provider.example');
  const save = await admin('/api/itsm/cust-demo', { enabled: true, mode: 'live', instanceUrl: 'dev1', username: 'estate.monitor', password: 'pw1', assignmentGroup: 'Service Desk', delayMinutes: 10, includeExisting: true }, 'PUT');
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(save.body.hasPassword, true);
  assert.equal(save.body.password, undefined);
  const bad = ctx.inventory.forCustomer('cust-demo').filter((d) => ['offline', 'critical'].includes(d.health));
  assert.ok(bad.length > 0, 'demo estate has faulty devices');
  await ctx.tickets.schedule();
  assert.equal(sn.rows.size, 0, 'nothing raised before the delay');
  now += 11 * 60_000;
  await ctx.tickets.schedule();
  const expected = Math.min(bad.length, 20);
  assert.equal(sn.rows.size, expected);
  const first = [...sn.rows.values()][0];
  assert.equal(first.assignment_group, 'Service Desk');
  assert.equal(first.category, 'hardware');
  assert.ok(first.description.includes('Customer: '));
  // Running again raises nothing new.
  await ctx.tickets.schedule();
  assert.equal(sn.rows.size, expected);
  // A restart that lost its records finds the open incident instead of raising another.
  const one = ctx.tickets.all.find((x) => x.kind === 'device' && x.state === 'open');
  ctx.store.data.tickets = ctx.tickets.all.filter((x) => x !== one);
  await ctx.tickets.schedule();
  assert.equal(sn.rows.size, expected, 'adopted, not duplicated');
  // The alert feed shows the number.
  const alerts = await admin('/api/alerts?limit=500');
  assert.ok(alerts.body.some((a) => a.ticket?.number?.startsWith('INC')));
  // Recovery resolves.
  const dev = ctx.inventory.get(ctx.tickets.all.find((x) => x.kind === 'device' && x.state === 'open').deviceId);
  dev.health = 'healthy';
  await ctx.tickets.schedule();
  const tk = ctx.tickets.latestFor(`device:${dev.id}`);
  assert.equal(tk.state, 'resolved');
  assert.equal(sn.rows.get(tk.sysId).state, '6');
  assert.equal(sn.rows.get(tk.sysId).close_code, 'Solution provided');
  // Device panel carries the ticket.
  const panel = await admin(`/api/devices/${encodeURIComponent(dev.id)}`);
  assert.equal(panel.body.itsm.ticket.number, tk.number);
});

test('faults already open when switched on are skipped, and a close in ServiceNow is respected', async (t) => {
  const sn = fakeServiceNow();
  const { ctx, login } = await startApp(t);
  ctx.tickets.clientFactory = (cid, cfg) => new ServiceNowClient({ instanceUrl: 'https://dev1.service-now.com', username: 'estate.monitor', password: 'pw1', fetchImpl: sn.fetchImpl });
  let now = Date.now();
  ctx.tickets.now = () => now;
  const admin = await login('admin@provider.example');
  await admin('/api/itsm/cust-demo', { enabled: true, mode: 'live', instanceUrl: 'dev1', username: 'estate.monitor', password: 'pw1', delayMinutes: 0 }, 'PUT');
  await ctx.tickets.schedule();
  assert.equal(sn.rows.size, 0, 'existing faults are not ticketed');
  // A healthy device fails: raised.
  const d = ctx.inventory.forCustomer('cust-demo').find((x) => x.health === 'healthy');
  d.health = 'offline';
  await ctx.tickets.schedule();
  assert.equal(sn.rows.size, 1);
  // Someone closes it in ServiceNow while the device is still down: no new incident.
  const row = [...sn.rows.values()][0];
  row.state = '7'; row.active = 'false';
  now += 6 * 60_000;
  await ctx.tickets.schedule();
  assert.equal(ctx.tickets.latestFor(`device:${d.id}`).state, 'closed');
  now += 6 * 60_000;
  await ctx.tickets.schedule();
  assert.equal(sn.rows.size, 1);
  // It recovers and fails again: a new incident.
  d.health = 'healthy'; await ctx.tickets.schedule();
  d.health = 'offline'; await ctx.tickets.schedule();
  assert.equal(sn.rows.size, 2);
});

test('a resolve the instance refuses leaves a work note and keeps the ticket open with the reason', async (t) => {
  const sn = fakeServiceNow();
  const { ctx, login } = await startApp(t);
  ctx.tickets.clientFactory = () => new ServiceNowClient({ instanceUrl: 'https://dev1.service-now.com', username: 'estate.monitor', password: 'pw1', fetchImpl: sn.fetchImpl });
  const admin = await login('admin@provider.example');
  await admin('/api/itsm/cust-demo', { enabled: true, mode: 'live', instanceUrl: 'dev1', username: 'estate.monitor', password: 'pw1', delayMinutes: 0, closeCode: 'Bad code' }, 'PUT');
  const d = ctx.inventory.forCustomer('cust-demo').find((x) => x.health === 'healthy');
  d.health = 'critical'; await ctx.tickets.schedule();
  d.health = 'healthy'; await ctx.tickets.schedule();
  const tk = ctx.tickets.latestFor(`device:${d.id}`);
  assert.equal(tk.state, 'open');
  assert.match(tk.error, /Resolution code is mandatory/);
  assert.match(sn.rows.get(tk.sysId).work_notes, /recovered/);
});

test('failures are kept and retried; reports, inbox dispatches and the device button raise incidents (mock mode)', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  // Live without reachable instance: the ticket fails with the reason, and can be retried.
  let fail = true;
  ctx.tickets.clientFactory = (cid, cfg) => (fail ? { mode: 'live', instanceUrl: 'https://x', findOpen: async () => { throw new Error('Could not reach https://x: ENOTFOUND'); } } : new MockServiceNowClient(cid));
  await admin('/api/itsm/cust-demo', { enabled: true, mode: 'mock', delayMinutes: 0 }, 'PUT');
  const d = ctx.inventory.forCustomer('cust-demo').find((x) => x.health === 'healthy');
  d.health = 'offline';
  await ctx.tickets.schedule();
  const tk = ctx.tickets.latestFor(`device:${d.id}`);
  assert.equal(tk.state, 'failed'); assert.match(tk.error, /ENOTFOUND/);
  fail = false;
  const r = await admin(`/api/tickets/${tk.id}/retry`, {});
  assert.equal(r.body.state, 'open'); assert.match(r.body.number, /^INC/);
  // End user report.
  const user = await login('it@demo.example');
  const rep = await user('/api/issues', { customerId: 'cust-demo', summary: 'No sound in the boardroom' });
  assert.ok([200, 201].includes(rep.status), JSON.stringify(rep.body));
  await ctx.tickets.onReport(ctx.store.data.alerts.find((a) => a.kind === 'report')); // the started service hears the 'alert' event
  const reportTicket = ctx.tickets.all.find((x) => x.kind === 'report');
  assert.ok(reportTicket?.number, 'report raised');
  // Inbox: an approved dispatch raises one, Done resolves it.
  ctx.checks.runCustomer('cust-demo');
  const act = ctx.store.actionsFor('cust-demo').find((a) => a.execution.kind === 'dispatch' || a.execution.kind === 'task');
  const ap = await admin(`/api/actions/${act.id}/approve`, { to: 'site@example.com', send: false });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  await new Promise((res) => setTimeout(res, 50));
  const at = ctx.tickets.latestFor(`action:${act.id}`);
  assert.equal(at.state, 'open');
  const detail = await admin(`/api/actions/${act.id}`);
  assert.equal(detail.body.ticket.number, at.number);
  await admin(`/api/actions/${act.id}/done`, { note: 'fixed' });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(at.state, 'resolved');
  // Device panel button.
  const d2 = ctx.inventory.forCustomer('cust-demo').find((x) => x.health === 'healthy' && x.id !== d.id);
  const man = await admin(`/api/devices/${encodeURIComponent(d2.id)}/incident`, { note: 'Screen flickers' });
  assert.equal(man.status, 200, JSON.stringify(man.body));
  assert.equal(man.body.manual, true);
});

test('only admins configure it, everyone in scope sees numbers, and customers never see each other', async (t) => {
  const { ctx, login } = await startApp(t);
  const tech = await login('tech@demo.example');
  assert.equal((await tech('/api/itsm/cust-demo')).status, 403);
  assert.equal((await tech('/api/itsm/cust-demo', { enabled: true }, 'PUT')).status, 403);
  const enduser = await login('it@demo.example');
  assert.equal((await enduser('/api/tickets')).status, 200);
  // A customer admin can't reach another customer's settings; by default only MSP admins manage connections.
  const custAdmin = await login('admin@demo.example');
  assert.equal((await custAdmin(`/api/itsm/${OTHER}`)).status, 403);
  const admin = await login('admin@provider.example');
  // The password is never returned, and must be retyped when the instance changes.
  await admin('/api/itsm/cust-demo', { enabled: false, mode: 'live', instanceUrl: 'dev1', username: 'estate.monitor', password: 'secret-pw' }, 'PUT');
  const got = await admin('/api/itsm/cust-demo');
  assert.ok(!JSON.stringify(got.body).includes('secret-pw'));
  assert.equal(got.body.hasPassword, true);
  const moved = await admin('/api/itsm/cust-demo', { instanceUrl: 'dev2' }, 'PUT');
  assert.equal(moved.body.hasPassword, false);
  // Tickets of another customer stay hidden.
  ctx.tickets.newTicket(OTHER, { kind: 'device', key: 'device:zz', title: 'Other customer', number: 'INC9', state: 'open' });
  const list = await custAdmin('/api/tickets');
  assert.ok(list.body.length === 0 || list.body.every((x) => x.customerId === 'cust-demo'));
  assert.ok((await admin('/api/tickets')).body.some((x) => x.customerId === OTHER), 'the MSP admin sees both customers');
  // The audit log records settings changes without the password.
  const audit = ctx.store.data.audit.filter((e) => e.action === 'servicenow.settings');
  assert.ok(audit.length >= 2 && !JSON.stringify(audit).includes('secret-pw'));
});

test('customer profile gathers connections, ServiceNow and settings in one scoped call', async (t) => {
  const { ctx, login } = await startApp(t);
  const admin = await login('admin@provider.example');
  await admin('/api/itsm/cust-demo', { enabled: true, mode: 'live', instanceUrl: 'dev1', username: 'estate.monitor', password: 'top-secret-pw' }, 'PUT');
  const r = await admin('/api/admin/customers/cust-demo/profile');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body;
  assert.equal(p.customer.id, 'cust-demo');
  assert.ok(p.connections.length > 0 && p.connections.every((c) => c.status && c.oemName));
  assert.equal(p.servicenow.enabled, true); assert.equal(p.servicenow.mode, 'live'); assert.equal(p.servicenow.instanceUrl, 'https://dev1.service-now.com');
  assert.ok(p.estate.devices > 0 && p.estate.bySource.length > 0);
  assert.ok(p.sites.length > 0 && 'contact' in p.sites[0]);
  assert.ok('version' in p.baseline && 'byStatus' in p.inbox && 'overrides' in p.roles);
  assert.ok(!JSON.stringify(p).includes('top-secret-pw'), 'no secrets');
  // Scope: customer roles can't open it, unknown ids are 404.
  assert.equal((await (await login('admin@demo.example'))('/api/admin/customers/cust-demo/profile')).status, 403);
  assert.equal((await admin('/api/admin/customers/nope/profile')).status, 404);
  assert.ok(ctx.store.customers.some((c) => c.id === OTHER));
});
