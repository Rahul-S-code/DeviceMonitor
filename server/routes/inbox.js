// Action inbox API: proposed actions per customer, decisions, execution
// (vendor API or emailed field dispatch), site contacts and the check schedule.
import { can, requirePermission } from '../lib/permissions.js';
import { cleanEmail, mailtoLink } from '../lib/mailer.js';
import { dispatchEmail, firmwareEmail, lifecycleEmail } from '../lib/runbooks.js';
import { OPEN, STATUSES, RULES, describe } from '../services/checks.js';
import { getConnectorClass } from '../connectors/registry.js';

const MAX_API_DEVICES = 50;
const SNOOZE_DAYS = [7, 30, 90, 365];

const cleanContact = (input) => {
  if (!input) return null;
  const email = cleanEmail(input.email);
  const name = String(input.name ?? '').trim().slice(0, 80);
  const phone = String(input.phone ?? '').trim().replace(/[^\d+()\-. ]/g, '').slice(0, 30);
  if (!email && !name && !phone) return null;
  if (input.email && !email) throw new Error('That email address is not valid');
  return { name: name || null, email, phone: phone || null };
};

export function registerInbox(app, { store, inventory, sync, mailer, checks, tickets = null, scope, inScope, audit, actorOf, requireJson, lastAction }) {
  const view = requirePermission('inbox.view');
  const decide = requirePermission('inbox.decide');

  const visibleAction = (req) => { const a = store.action(req.params.id); return a && inScope(req, a.customerId) ? a : null; };
  const pick = (req) => (req.query.customer ? scope(req).filter((id) => id === req.query.customer) : scope(req));
  const live = (a) => a.items.filter((i) => !i.cleared);
  const brief = (a) => ({
    id: a.id, ref: a.ref, customerId: a.customerId, customerName: store.customerName(a.customerId), rule: a.rule, ruleLabel: RULES[a.rule]?.label || a.rule, area: RULES[a.rule]?.area || null,
    title: a.title, reason: a.reason, severity: a.severity, status: a.status, site: a.site, execution: a.execution,
    count: live(a).length, total: a.items.length, createdAt: a.createdAt, updatedAt: a.updatedAt, lastCheckedAt: a.lastCheckedAt,
    snoozeUntil: a.snoozeUntil ?? null, decidedBy: a.decidedBy ?? null,
  });
  const ticketOf = (a) => { const t = tickets?.latestFor(`action:${a.id}`); return t ? tickets.view(t) : null; };
  const full = (a) => ({ ...brief(a), ticket: ticketOf(a), items: a.items.slice(0, 500), moreItems: Math.max(0, a.items.length - 500), history: a.history, result: a.result ?? null, dispatch: a.dispatch ?? null, recipient: recipientFor(a) });

  // ServiceNow: an approved dispatch or task raises an incident, Done resolves it (when set up for the customer).
  const ticket = (a, event) => { tickets?.onAction(a, event).catch((e) => console.error(`[servicenow] ${a.ref}: ${e.message}`)); };
  const setStatus = (req, a, status, note = null, extra = {}) => {
    const at = new Date().toISOString();
    a.status = status; a.updatedAt = at;
    if (req) a.decidedBy = actorOf(req.user)?.email ?? null;
    a.history.push({ at, status, by: req ? actorOf(req.user)?.email : null, note });
    Object.assign(a, extra);
    store.save();
  };

  // Who a dispatch or task goes to by default.
  const recipientFor = (a) => {
    const ct = store.contactsFor(a.customerId);
    const ex = a.execution;
    if (ex.kind === 'dispatch') {
      const site = ct.sites?.[a.site] || null;
      const roomCts = [...new Set(live(a).map((i) => ct.rooms?.[`${i.site}|${i.room}`]).filter((c) => c?.email))];
      // All devices in one room with its own contact: that contact. Otherwise the site contact, room contacts in copy.
      if (roomCts.length === 1 && live(a).every((i) => ct.rooms?.[`${i.site}|${i.room}`]?.email === roomCts[0].email)) return { to: roomCts[0], cc: site?.email && site.email !== roomCts[0].email ? [site] : [], source: 'room contact' };
      if (site?.email) return { to: site, cc: roomCts.filter((c) => c.email !== site.email), source: 'site contact' };
      if (roomCts.length) return { to: roomCts[0], cc: roomCts.slice(1), source: 'room contact' };
      return { to: null, cc: [], source: null, missing: `No local contact is set for ${a.site}. Add one under Site contacts, or type an address.` };
    }
    if (ex.kind === 'task') {
      const role = ex.recipientRole;
      const c = ct[role];
      if (c?.email) return { to: c, cc: [], source: role === 'engineer' ? 'engineer contact' : 'renewals contact' };
      return { to: null, cc: [], source: null, missing: `No ${role === 'engineer' ? 'engineer / service desk' : 'renewals'} contact is set for this customer. Add one under Site contacts, or type an address.` };
    }
    return null;
  };

  const draftFor = (a) => {
    const name = store.customerName(a.customerId);
    const items = live(a).length ? live(a) : a.items;
    const ex = a.execution;
    if (ex.kind === 'dispatch') return dispatchEmail({ kind: ex.runbook === 'inspect' ? 'inspect' : 'power-cycle', customerName: name, site: a.site, devices: items, contact: recipientFor(a)?.to, ref: a.ref });
    if (ex.template === 'firmware') {
      const groups = [];
      for (const i of items) {
        let g = groups.find((x) => x.make === i.make && x.model === i.model && x.target === i.target);
        if (!g) groups.push(g = { make: i.make, model: i.model, target: i.target, oem: i.oem, devices: [] });
        g.devices.push(i);
      }
      return firmwareEmail({ customerName: name, groups, ref: a.ref });
    }
    return lifecycleEmail({ customerName: name, kind: ex.template, devices: items, ref: a.ref });
  };

  // ---- reading -------------------------------------------------------------
  app.get('/api/actions', view, (req, res) => {
    const ids = new Set(pick(req));
    const status = req.query.status ? String(req.query.status).split(',') : null;
    const all = store.actions.filter((a) => ids.has(a.customerId));
    const rank = { high: 0, medium: 1, low: 2 };
    const rows = all.filter((a) => !status || status.includes(a.status))
      .sort((x, y) => (OPEN.has(y.status) - OPEN.has(x.status)) || rank[x.severity] - rank[y.severity] || y.updatedAt.localeCompare(x.updatedAt));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const a of all) counts[a.status] = (counts[a.status] || 0) + 1;
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const s = checks.settings();
    res.json({
      items: rows.slice(0, limit).map(brief), total: rows.length, counts,
      checks: { enabled: s.enabled, hourUtc: s.hourUtc, lastRunAt: s.lastRunAt || null, nextRunAt: checks.nextRunAt(), byCustomer: Object.fromEntries(Object.entries(s.byCustomer || {}).filter(([k]) => ids.has(k))) },
      mail: mailer.status(), canDecide: can(req.user, 'inbox.decide'), canRun: can(req.user, 'inbox.run'), canSchedule: can(req.user, 'checks.schedule'),
    });
  });
  // Open actions per customer, for the nav badge and the customer picker.
  app.get('/api/actions/summary', view, (req, res) => {
    const out = {};
    for (const id of scope(req)) out[id] = { name: store.customerName(id), proposed: 0, open: 0 };
    for (const a of store.actions) {
      if (!out[a.customerId]) continue;
      if (a.status === 'proposed') out[a.customerId].proposed++;
      if (OPEN.has(a.status)) out[a.customerId].open++;
    }
    res.json(out);
  });
  app.get('/api/actions/:id', view, (req, res) => {
    const a = visibleAction(req);
    return a ? res.json(full(a)) : res.status(404).json({ error: 'Not found' });
  });
  // The email that Yes would send (dispatch and task actions).
  app.get('/api/actions/:id/draft', view, (req, res) => {
    const a = visibleAction(req);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!['dispatch', 'task'].includes(a.execution.kind)) return res.status(400).json({ error: 'This action is not sent by email' });
    res.json({ ...draftFor(a), recipient: recipientFor(a), mail: mailer.status() });
  });

  // ---- deciding --------------------------------------------------------------
  const runApi = async (req, a) => {
    const ex = a.execution;
    if (ex.sync) {
      const conn = store.connections.find((c) => c.id === ex.connectionId && c.customerId === a.customerId);
      if (!conn) throw new Error('The connection has been removed');
      const st = await sync.syncOne(conn.id);
      return { ok: st.state === 'ok', results: [{ label: conn.name, ok: st.state === 'ok', message: st.state === 'ok' ? `Synced ${st.deviceCount} devices` : st.error }] };
    }
    const conn = store.connections.find((c) => c.id === ex.connectionId && c.customerId === a.customerId);
    if (!conn) throw new Error('The connection that reported these devices has been removed');
    const C = getConnectorClass(conn.oem);
    const act = C.actions.find((x) => x.id === ex.actionId);
    if (!act) throw new Error(`${C.displayName} can no longer run that action`);
    const results = [];
    const seenRooms = new Set();
    for (const it of live(a).slice(0, MAX_API_DEVICES)) {
      const d = inventory.get(it.deviceId);
      const label = `${it.make} ${it.model} (${it.room}, ${it.site})`;
      const src = d?.customerId === a.customerId ? d.sources.find((x) => x.connectionId === conn.id) : null;
      if (!src || !C.actionApplies(act, d, src)) { results.push({ label, ok: false, message: 'Device no longer reported by this connection' }); continue; }
      const key = `${act.target === 'room' ? `${conn.id}|${src.roomId}` : d.id}|${act.id}`;
      if (act.target === 'room') { if (seenRooms.has(key)) { results.push({ label, ok: true, message: 'Covered by the room restart' }); continue; } seenRooms.add(key); }
      if (Date.now() - (lastAction.get(key) || 0) < 60_000) { results.push({ label, ok: false, message: 'Run less than a minute ago; try again shortly' }); continue; }
      lastAction.set(key, Date.now());
      const details = { action: act.label, via: C.displayName, apiSet: act.api.set, endpoint: `${act.api.method} ${act.api.endpoint}`, mode: conn.mode, inboxAction: a.ref };
      try {
        const r = await Promise.race([
          sync.connectorFor(conn).runAction(act.id, src, d),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`${C.displayName} did not answer within 20 seconds`)), 20_000).unref?.()),
        ]);
        audit(req, 'device.action', { customerId: a.customerId, target: label, details: { ...details, result: r.simulated ? 'simulated (demo connection)' : 'sent' } });
        results.push({ label, ok: true, simulated: !!r.simulated, message: r.message || 'Sent' });
      } catch (e) {
        lastAction.delete(key);
        audit(req, 'device.action_failed', { customerId: a.customerId, target: label, details: { ...details, error: e.message } });
        results.push({ label, ok: false, message: e.message });
      }
    }
    return { ok: results.length > 0 && results.every((r) => r.ok), results, skipped: Math.max(0, live(a).length - MAX_API_DEVICES) };
  };

  // Yes. API actions run now; dispatch and task actions send the email (or return a mailto when no provider is set).
  app.post('/api/actions/:id/approve', decide, requireJson, async (req, res) => {
    const a = visibleAction(req);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!['proposed', 'failed', 'approved'].includes(a.status)) return res.status(409).json({ error: `This action is already ${a.status}` });
    const body = req.body || {};
    // A device action that can't (or didn't) run through the API can go to the site instead.
    if (body.via === 'dispatch' && a.execution.kind === 'api' && ['offline', 'faulty'].includes(a.rule)) {
      a.execution = { kind: 'dispatch', runbook: 'power-cycle', switchedFrom: a.execution.via };
      Object.assign(a, describe(a));
      a.history.push({ at: new Date().toISOString(), status: a.status, by: actorOf(req.user)?.email, note: 'Switched to a field dispatch' });
      store.save();
      return res.json({ action: full(a), next: 'dispatch' });
    }
    const ex = a.execution;
    if (ex.kind === 'api') {
      setStatus(req, a, 'approved', body.note ? String(body.note).slice(0, 500) : null);
      audit(req, 'inbox.approve', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { rule: a.rule, execution: `${ex.via}: ${ex.actionLabel}` } });
      try {
        const r = await runApi(req, a);
        const okN = r.results.filter((x) => x.ok).length;
        const note = `${ex.actionLabel} via ${ex.via}: ${okN} of ${r.results.length} succeeded${r.skipped ? `, ${r.skipped} not run (limit ${MAX_API_DEVICES} per action)` : ''}${r.results.some((x) => x.simulated) ? ' (demo connection, simulated)' : ''}`;
        setStatus(null, a, r.ok ? 'done' : 'failed', note, { result: { at: new Date().toISOString(), ...r } });
        audit(req, r.ok ? 'inbox.executed' : 'inbox.execute_failed', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { note } });
        return res.json({ action: full(a) });
      } catch (e) {
        setStatus(null, a, 'failed', e.message, { result: { at: new Date().toISOString(), ok: false, results: [], error: e.message } });
        audit(req, 'inbox.execute_failed', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { error: e.message } });
        return res.status(502).json({ error: e.message, action: full(a) });
      }
    }
    if (ex.kind === 'config') {
      setStatus(req, a, 'approved', 'Accepted: the admin will fix the configuration');
      audit(req, 'inbox.approve', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { rule: a.rule } });
      return res.json({ action: full(a), link: ex.link });
    }
    // dispatch / task: email
    const to = cleanEmail(body.to);
    if (!to) return res.status(400).json({ error: 'Enter a valid email address to send to' });
    const cc = (Array.isArray(body.cc) ? body.cc : String(body.cc || '').split(/[,;\s]+/)).filter(Boolean).slice(0, 5);
    const ccClean = cc.map(cleanEmail);
    if (ccClean.some((x) => !x)) return res.status(400).json({ error: 'A copy (Cc) address is not valid' });
    const draft = draftFor(a);
    const subject = String(body.subject || draft.subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
    const text = String(body.body || draft.body).slice(0, 50_000);
    const dispatch = { to, cc: ccClean, subject, preparedAt: new Date().toISOString(), preparedBy: actorOf(req.user)?.email };
    if (body.send !== false && mailer.configured) {
      try {
        const r = await mailer.send({ to, cc: ccClean, subject, text });
        setStatus(req, a, 'sent', `Emailed to ${to}${ccClean.length ? ` (cc ${ccClean.join(', ')})` : ''}`, { dispatch: { ...dispatch, sentAt: new Date().toISOString(), via: mailer.status().provider, messageId: r?.id || null } });
        ticket(a, 'approved');
        audit(req, 'inbox.dispatch_sent', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { to, cc: ccClean, subject, provider: mailer.status().provider } });
        return res.json({ action: full(a), sent: true });
      } catch (e) {
        audit(req, 'inbox.dispatch_failed', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { to, error: e.message } });
        return res.status(502).json({ error: `The email was not sent: ${e.message}` });
      }
    }
    // No provider (or the admin chose their own mail app): approved, waiting for "Mark as sent".
    setStatus(req, a, 'approved', `Approved; email prepared for ${to}, to send from the admin's own mail app`, { dispatch });
    audit(req, 'inbox.approve', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { rule: a.rule, to, mail: 'not configured: mailto fallback' } });
    ticket(a, 'approved');
    return res.json({ action: full(a), sent: false, mailto: mailtoLink({ to, subject, body: text }), text, subject });
  });

  // No. The same issue stays quiet until the snooze ends.
  app.post('/api/actions/:id/decline', decide, requireJson, (req, res) => {
    const a = visibleAction(req);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!['proposed', 'failed', 'approved'].includes(a.status)) return res.status(409).json({ error: `This action is already ${a.status}` });
    const days = SNOOZE_DAYS.includes(Number(req.body?.snoozeDays)) ? Number(req.body.snoozeDays) : 30;
    const note = String(req.body?.reason || '').trim().slice(0, 500) || null;
    setStatus(req, a, 'declined', `Declined${note ? `: ${note}` : ''}. Not proposed again for ${days} days.`, { snoozeUntil: new Date(Date.now() + days * 86_400_000).toISOString(), declineReason: note });
    audit(req, 'inbox.decline', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { reason: note, snoozeDays: days } });
    res.json({ action: full(a) });
  });

  app.post('/api/actions/:id/sent', decide, requireJson, (req, res) => {
    const a = visibleAction(req);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'approved' || !a.dispatch) return res.status(409).json({ error: 'Only an approved email action can be marked as sent' });
    setStatus(req, a, 'sent', `Sent by the admin from their own mail app to ${a.dispatch.to}`, { dispatch: { ...a.dispatch, sentAt: new Date().toISOString(), via: 'admin mail app' } });
    audit(req, 'inbox.mark_sent', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { to: a.dispatch.to } });
    res.json({ action: full(a) });
  });

  app.post('/api/actions/:id/done', decide, requireJson, (req, res) => {
    const a = visibleAction(req);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!OPEN.has(a.status)) return res.status(409).json({ error: `This action is already ${a.status}` });
    const note = String(req.body?.note || '').trim().slice(0, 500) || null;
    setStatus(req, a, 'done', note ? `Marked done: ${note}` : 'Marked done');
    ticket(a, 'done');
    audit(req, 'inbox.done', { customerId: a.customerId, target: `${a.ref} ${a.title}`, details: { note } });
    res.json({ action: full(a) });
  });

  // ---- running the checks ------------------------------------------------------
  app.post('/api/checks/run', requirePermission('inbox.run'), requireJson, (req, res) => {
    const ids = req.body?.customerId ? [req.body.customerId] : scope(req);
    if (req.body?.customerId && !inScope(req, req.body.customerId)) return res.status(404).json({ error: 'Customer not found' });
    sync.refreshPending();
    const out = {};
    for (const id of ids) out[id] = checks.runCustomer(id, { by: actorOf(req.user) });
    const total = Object.values(out).reduce((s, r) => ({ created: s.created + r.created, updated: s.updated + r.updated, closed: s.closed + r.closed }), { created: 0, updated: 0, closed: 0 });
    audit(req, 'checks.run', { customerId: ids.length === 1 ? ids[0] : null, target: ids.length === 1 ? store.customerName(ids[0]) : `${ids.length} customers`, details: total });
    res.json({ results: out, ...total });
  });
  app.put('/api/admin/checks', requirePermission('checks.schedule'), requireJson, (req, res) => {
    const { enabled, hourUtc } = req.body || {};
    const h = Number(hourUtc);
    if (hourUtc !== undefined && !(Number.isInteger(h) && h >= 0 && h <= 23)) return res.status(400).json({ error: 'hourUtc must be 0 to 23' });
    const before = checks.settings();
    store.settings.checks = { ...before, ...(typeof enabled === 'boolean' ? { enabled } : {}), ...(hourUtc !== undefined ? { hourUtc: h } : {}) };
    store.save();
    audit(req, 'checks.schedule', { target: 'Daily checks', details: { from: { enabled: before.enabled, hourUtc: before.hourUtc }, to: { enabled: store.settings.checks.enabled, hourUtc: store.settings.checks.hourUtc } } });
    res.json({ ...checks.settings(), nextRunAt: checks.nextRunAt() });
  });

  // ---- contacts ---------------------------------------------------------------
  app.get('/api/contacts/:customerId', requirePermission('contacts.view'), (req, res) => {
    const cid = req.params.customerId;
    if (!inScope(req, cid)) return res.status(404).json({ error: 'Customer not found' });
    const devs = inventory.forCustomer(cid);
    const sites = [...new Set([...Object.keys(store.sitesFor(cid)), ...devs.map((d) => d.site)])].sort();
    const rooms = [...new Set(devs.map((d) => `${d.site}|${d.room}`))].sort().map((k) => { const [site, room] = k.split('|'); return { site, room }; });
    res.json({ customerId: cid, customerName: store.customerName(cid), sites, rooms, contacts: store.contactsFor(cid), canEdit: can(req.user, 'contacts.edit') });
  });
  app.put('/api/contacts/:customerId', requirePermission('contacts.edit'), requireJson, (req, res) => {
    const cid = req.params.customerId;
    if (!inScope(req, cid)) return res.status(404).json({ error: 'Customer not found' });
    const { scope: sc, site, room } = req.body || {};
    if (!['site', 'room', 'engineer', 'renewals'].includes(sc)) return res.status(400).json({ error: 'scope must be site, room, engineer or renewals' });
    const s = String(site || '').trim().slice(0, 60);
    const r = String(room || '').trim().slice(0, 80);
    if ((sc === 'site' || sc === 'room') && !s) return res.status(400).json({ error: 'site is required' });
    if (sc === 'room' && !r) return res.status(400).json({ error: 'room is required' });
    let contact;
    try { contact = cleanContact(req.body.contact); } catch (e) { return res.status(400).json({ error: e.message }); }
    const key = sc === 'site' ? s : sc === 'room' ? `${s}|${r}` : null;
    store.setContact(cid, sc, key, contact);
    audit(req, 'contact.update', { customerId: cid, target: sc === 'site' ? `Site contact, ${s}` : sc === 'room' ? `Room contact, ${r}, ${s}` : `${sc === 'engineer' ? 'Engineer' : 'Renewals'} contact`, details: { contact: contact || 'removed' } });
    res.json(store.contactsFor(cid));
  });
}
