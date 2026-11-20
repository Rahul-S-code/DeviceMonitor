// Action inbox: proactive checks, dedupe, decisions, execution (vendor API or
// emailed dispatch), contacts, schedule, tenant isolation and roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { addSecondCustomer } from './fixtures.js';
import { findIssues, reconcile } from '../server/services/checks.js';
import { Mailer } from '../server/lib/mailer.js';
import { dispatchEmail, powerCycleSteps } from '../server/lib/runbooks.js';

const OTHER = 'cust-northwind';

async function startApp(t, { mailer = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dminbox-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false, mailer, checksMinDownMs: 0 });
  addSecondCustomer(ctx.store);
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.checks.stop(); ctx.store.close(); ctx.history.close(); ctx.apiTracker.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password = 'demo1234') => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, `login ${email}`);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const call = (p, init = {}) => fetch(base + p, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
    call.json = async (p, body, method = body ? 'POST' : 'GET') => { const r = await call(p, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
    return call;
  };
  return { ctx, login };
}

test('checks propose grouped actions, and running again proposes nothing new', async (t) => {
  const { ctx } = await startApp(t);
  const r1 = ctx.checks.runCustomer('cust-demo');
  assert.ok(r1.created > 3, 'demo estate produces proposals');
  const acts = ctx.store.actionsFor('cust-demo');
  assert.ok(acts.every((a) => a.status === 'proposed' && a.ref.startsWith('EM-') && a.title && a.reason && a.items.length));
  assert.ok(acts.some((a) => a.rule === 'firmware' && a.execution.kind === 'task'));
  assert.ok(acts.some((a) => ['offline', 'faulty'].includes(a.rule)));
  // Each item key appears in one action only.
  const keys = acts.flatMap((a) => a.items.map((i) => i.key));
  assert.equal(new Set(keys).size, keys.length);
  const r2 = ctx.checks.runCustomer('cust-demo');
  assert.equal(r2.created, 0);
  assert.equal(ctx.store.actionsFor('cust-demo').length, acts.length);
  // Never mixes customers.
  ctx.checks.runCustomer(OTHER);
  assert.ok(ctx.store.actionsFor(OTHER).every((a) => a.items.every((i) => !i.deviceId || ctx.inventory.get(i.deviceId)?.customerId === OTHER)));
});

test('offline devices are only sent to a power-cycle API, never a reboot a dead device cannot receive', async (t) => {
  const { ctx } = await startApp(t);
  const f = findIssues({ store: ctx.store, inventory: ctx.inventory, history: ctx.history, sync: ctx.sync, customerId: 'cust-demo', minDownMs: 0 });
  for (const x of f.filter((y) => y.rule === 'offline')) assert.ok(x.execution.kind === 'dispatch' || x.execution.actionId === 'cycle');
});

test('cleared issues close their actions; declined ones stay quiet until the snooze ends', async (t) => {
  const { ctx } = await startApp(t);
  const now = Date.now();
  const find = () => findIssues({ store: ctx.store, inventory: ctx.inventory, history: ctx.history, sync: ctx.sync, customerId: 'cust-demo', now, minDownMs: 0 });
  const all = find();
  reconcile(ctx.store, 'cust-demo', all, { now });
  const fw = ctx.store.actionsFor('cust-demo').find((a) => a.rule === 'firmware');
  const wd = ctx.store.actionsFor('cust-demo').find((a) => a.rule === 'warrantyData');
  // Decline the firmware action, approve-and-send the other one, then pretend everything is fixed.
  fw.status = 'declined'; fw.snoozeUntil = new Date(now + 30 * 86_400_000).toISOString();
  wd.status = 'sent';
  const fixedKeys = new Set([...fw.items, ...wd.items].map((i) => i.key));
  const r = reconcile(ctx.store, 'cust-demo', all.filter((x) => !wd.items.some((i) => i.key === x.key)), { now: now + 1000 });
  assert.equal(r.created, 0, 'declined items are not proposed again');
  assert.equal(wd.status, 'done');
  assert.match(wd.history.at(-1).note, /fixed/);
  // After the snooze, the still-present firmware drift is proposed again.
  const later = now + 31 * 86_400_000;
  const r2 = reconcile(ctx.store, 'cust-demo', all, { now: later });
  assert.ok(r2.created >= 1);
  assert.ok(ctx.store.actionsFor('cust-demo').some((a) => a.status === 'proposed' && a.rule === 'firmware' && a.items.some((i) => fixedKeys.has(i.key))));
  // A proposed action whose issue clears before a decision is "resolved".
  const p = ctx.store.actionsFor('cust-demo').find((a) => a.status === 'proposed');
  reconcile(ctx.store, 'cust-demo', all.filter((x) => !p.items.some((i) => i.key === x.key)), { now: later + 1000 });
  assert.equal(p.status, 'resolved');
});

test('Yes on an API action runs it through the connector and audits it', async (t) => {
  const { ctx, login } = await startApp(t);
  ctx.checks.runCustomer('cust-demo');
  const a = ctx.store.actionsFor('cust-demo').find((x) => x.execution.kind === 'api' && !x.execution.sync);
  assert.ok(a, 'the demo estate has a device fixable through an API (Domotz)');
  const admin = await login('admin@provider.example');
  const r = await admin.json(`/api/actions/${a.id}/approve`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.action.status, 'done');
  assert.ok(r.body.action.result.results.every((x) => x.ok && x.simulated));
  const audit = ctx.store.data.audit.map((e) => e.action);
  assert.ok(audit.includes('inbox.approve') && audit.includes('inbox.executed') && audit.includes('device.action'));
  // Already decided.
  assert.equal((await admin.json(`/api/actions/${a.id}/approve`, {})).status, 409);
});

test('dispatch goes to the site contact: mailto fallback without email setup, then mark as sent', async (t) => {
  const { ctx, login } = await startApp(t);
  ctx.checks.runCustomer('cust-demo');
  const a = ctx.store.actionsFor('cust-demo').find((x) => x.execution.kind === 'dispatch');
  const admin = await login('admin@provider.example');
  // No contact yet: the draft says so.
  let d = await admin.json(`/api/actions/${a.id}/draft`);
  assert.ok(d.body.recipient.missing);
  assert.equal(d.body.mail.configured, false);
  assert.equal((await admin.json(`/api/contacts/cust-demo`, { scope: 'site', site: a.site, contact: { name: 'Sam', email: 'not-an-email' } }, 'PUT')).status, 400);
  const saved = await admin.json(`/api/contacts/cust-demo`, { scope: 'site', site: a.site, contact: { name: 'Sam Site', email: 'sam@demo.example', phone: '+44 20 1234' } }, 'PUT');
  assert.equal(saved.status, 200);
  d = await admin.json(`/api/actions/${a.id}/draft`);
  assert.equal(d.body.recipient.to.email, 'sam@demo.example');
  assert.match(d.body.body, /Hello Sam Site/);
  assert.match(d.body.body, new RegExp(a.ref));
  assert.match(d.body.subject, /\[EM-\d+\]/);
  const r = await admin.json(`/api/actions/${a.id}/approve`, { to: 'sam@demo.example', subject: d.body.subject, body: d.body.body });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, false);
  assert.match(r.body.mailto, /^mailto:sam%40demo\.example\?subject=/);
  assert.equal(r.body.action.status, 'approved');
  const s = await admin.json(`/api/actions/${a.id}/sent`, {});
  assert.equal(s.body.action.status, 'sent');
  const done = await admin.json(`/api/actions/${a.id}/done`, { note: 'Rebooted by Sam' });
  assert.equal(done.body.action.status, 'done');
  assert.ok(ctx.store.data.audit.some((e) => e.action === 'contact.update'));
  assert.ok(ctx.store.data.audit.some((e) => e.action === 'inbox.mark_sent'));
});

test('dispatch is emailed when a provider is configured', async (t) => {
  const sent = [];
  const mailer = new Mailer({}, { transport: async (m) => { sent.push(m); return { id: 'm1' }; } });
  const { ctx, login } = await startApp(t, { mailer });
  ctx.checks.runCustomer('cust-demo');
  const a = ctx.store.actionsFor('cust-demo').find((x) => x.execution.kind === 'dispatch');
  const admin = await login('admin@provider.example');
  assert.equal((await admin.json(`/api/actions/${a.id}/approve`, { to: 'bad' })).status, 400);
  const r = await admin.json(`/api/actions/${a.id}/approve`, { to: 'spoc@demo.example', cc: 'it@demo.example' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, true);
  assert.equal(r.body.action.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'spoc@demo.example');
  assert.deepEqual(sent[0].cc, ['it@demo.example']);
  assert.match(sent[0].text, /Steps:/);
  assert.ok(ctx.store.data.audit.some((e) => e.action === 'inbox.dispatch_sent'));
});

test('No declines with a snooze and a reason in the audit log', async (t) => {
  const { ctx, login } = await startApp(t);
  ctx.checks.runCustomer('cust-demo');
  const a = ctx.store.actionsFor('cust-demo')[0];
  const admin = await login('admin@provider.example');
  const r = await admin.json(`/api/actions/${a.id}/decline`, { snoozeDays: 90, reason: 'Room being refurbished' });
  assert.equal(r.body.action.status, 'declined');
  assert.ok(Date.parse(r.body.action.snoozeUntil) > Date.now() + 89 * 86_400_000);
  const e = ctx.store.data.audit.find((x) => x.action === 'inbox.decline');
  assert.equal(e.details.reason, 'Room being refurbished');
  assert.equal(e.customerId, 'cust-demo');
  ctx.checks.runCustomer('cust-demo');
  const again = ctx.store.actionsFor('cust-demo').filter((x) => x.status === 'proposed').flatMap((x) => x.items.map((i) => i.key));
  assert.ok(a.items.every((i) => !again.includes(i.key)));
});

test('inbox is admin-only and an admin inside one customer cannot touch another customer\'s actions', async (t) => {
  const { ctx, login } = await startApp(t);
  ctx.checks.runAll();
  const theirs = ctx.store.actionsFor(OTHER)[0];
  assert.ok(theirs);
  const viewer = await login('it@demo.example');
  for (const [p, m] of [['/api/actions', 'GET'], [`/api/actions/${theirs.id}`, 'GET'], [`/api/actions/${theirs.id}/approve`, 'POST'], [`/api/actions/${theirs.id}/decline`, 'POST'], ['/api/contacts/cust-demo', 'GET'], ['/api/contacts/cust-demo', 'PUT'], ['/api/checks/run', 'POST']]) {
    assert.equal((await viewer(p, { method: m, ...(m !== 'GET' ? { body: '{}' } : {}) })).status, 403, `${m} ${p}`);
  }
  const admin = await login('admin@provider.example');
  await admin('/api/session/enter', { method: 'POST', body: JSON.stringify({ customerId: 'cust-demo' }) });
  const list = await admin.json(`/api/actions?customer=${OTHER}`);
  assert.equal(list.body.items.length, 0);
  const all = await admin.json('/api/actions');
  assert.ok(all.body.items.every((a) => a.customerId === 'cust-demo'));
  assert.ok(!JSON.stringify(await admin.json('/api/actions/summary')).includes(OTHER));
  for (const p of [`/api/actions/${theirs.id}`, `/api/actions/${theirs.id}/draft`]) assert.equal((await admin(p)).status, 404, p);
  for (const p of ['approve', 'decline', 'sent', 'done']) assert.equal((await admin(`/api/actions/${theirs.id}/${p}`, { method: 'POST', body: '{}' })).status, 404, p);
  assert.equal((await admin(`/api/contacts/${OTHER}`)).status, 404);
  assert.equal((await admin(`/api/contacts/${OTHER}`, { method: 'PUT', body: JSON.stringify({ scope: 'site', site: 'Chicago', contact: { email: 'x@y.com' } }) })).status, 404);
  assert.equal((await admin('/api/checks/run', { method: 'POST', body: JSON.stringify({ customerId: OTHER }) })).status, 404);
  assert.equal(theirs.status, 'proposed');
  // Only the super admin sets the schedule.
  assert.equal((await admin('/api/admin/checks', { method: 'PUT', body: JSON.stringify({ hourUtc: 3 }) })).status, 403);
  const su = await login('superadmin@provider.example');
  const s = await su.json('/api/admin/checks', { hourUtc: 3, enabled: true }, 'PUT');
  assert.equal(s.status, 200);
  assert.equal(s.body.hourUtc, 3);
  assert.equal((await su.json('/api/admin/checks', { hourUtc: 25 }, 'PUT')).status, 400);
});

test('the scheduler runs once per day after the configured hour', async (t) => {
  const { ctx } = await startApp(t);
  ctx.store.settings.checks = { enabled: true, hourUtc: 6 };
  const day = Date.UTC(2026, 10, 20);
  assert.equal(ctx.checks.tick(day + 5 * 3_600_000), false, 'before 06:00');
  assert.equal(ctx.checks.tick(day + 7 * 3_600_000), true);
  assert.equal(ctx.checks.tick(day + 9 * 3_600_000), false, 'already ran today');
  assert.equal(ctx.checks.tick(day + 30 * 3_600_000), true, 'next day');
  ctx.store.settings.checks.enabled = false;
  assert.equal(ctx.checks.tick(day + 60 * 3_600_000), false);
});

test('runbook emails name the device, the steps and the reference', () => {
  const d = { make: 'Logitech', model: 'Tap', deviceType: 'Touch controller', room: 'Aurora', site: 'London', serial: 'ABC123' };
  assert.ok(powerCycleSteps(d).some((s) => /PoE/.test(s)));
  const m = dispatchEmail({ kind: 'power-cycle', customerName: 'Demo', site: 'London', devices: [d], contact: { name: 'Sam' }, ref: 'EM-1' });
  assert.match(m.subject, /restart a meeting room device at London \[EM-1\]/);
  assert.match(m.body, /Serial number: ABC123/);
  assert.match(m.body, /do not factory-reset/);
});
