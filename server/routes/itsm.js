// ServiceNow (ITSM) settings per customer, the incidents raised, and the
// "Raise incident" button on the device panel.
import { can, requirePermission } from '../lib/permissions.js';

export function registerItsm(app, { store, inventory, tickets, scope, inScope, audit, requireJson }) {
  const manage = requirePermission('connections.manage');
  const custOk = (req, res) => {
    if (inScope(req, req.params.customerId)) return true;
    res.status(404).json({ error: 'Customer not found' });
    return false;
  };

  app.get('/api/itsm', manage, (req, res) => {
    res.json(scope(req).map((id) => ({ customerId: id, customerName: store.customerName(id), ...tickets.publicConfig(id) })));
  });

  app.get('/api/itsm/:customerId', manage, (req, res) => {
    if (!custOk(req, res)) return;
    res.json({ customerId: req.params.customerId, customerName: store.customerName(req.params.customerId), ...tickets.publicConfig(req.params.customerId) });
  });

  app.put('/api/itsm/:customerId', manage, requireJson, (req, res) => {
    if (!custOk(req, res)) return;
    const cid = req.params.customerId;
    const b = req.body || {};
    const before = tickets.publicConfig(cid);
    try {
      const pw = typeof b.password === 'string' ? b.password : b.password === null ? null : undefined;
      const after = tickets.saveConfig(cid, b, { password: pw }, req.user);
      const changed = ['enabled', 'mode', 'instanceUrl', 'username', 'assignmentGroup', 'category', 'callerId', 'closeCode', 'delayMinutes', 'autoResolve'].filter((k) => before[k] !== after[k]);
      audit(req, 'servicenow.settings', { customerId: cid, target: store.customerName(cid), details: { changed, enabled: after.enabled, mode: after.mode, passwordReplaced: !!b.password } });
      res.json(after);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/itsm/:customerId/test', manage, requireJson, async (req, res) => {
    if (!custOk(req, res)) return;
    const b = req.body || {};
    const r = await tickets.test(req.params.customerId, Object.keys(b).length ? b : null, typeof b.password === 'string' && b.password ? b.password : null, req.user);
    audit(req, 'servicenow.test', { customerId: req.params.customerId, target: store.customerName(req.params.customerId), details: { ok: r.ok, mode: r.mode || null } });
    res.json(r);
  });

  // Incidents: everyone who can see the estate sees their numbers.
  app.get('/api/tickets', requirePermission('estate.view'), (req, res) => {
    const allowed = new Set(req.query.customer ? scope(req).filter((id) => id === req.query.customer) : scope(req));
    let list = tickets.all.filter((t) => allowed.has(t.customerId));
    if (req.query.device) list = list.filter((t) => t.deviceId === req.query.device);
    if (req.query.action) list = list.filter((t) => t.actionId === req.query.action);
    if (req.query.state) { const st = new Set(String(req.query.state).split(',')); list = list.filter((t) => st.has(t.state)); }
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(list.slice(0, limit).map((t) => ({ ...tickets.view(t), customerName: store.customerName(t.customerId) })));
  });

  app.post('/api/tickets/:id/retry', manage, requireJson, async (req, res) => {
    const t = tickets.all.find((x) => x.id === req.params.id && inScope(req, x.customerId));
    if (!t) return res.status(404).json({ error: 'Not found' });
    const r = await tickets.retry(t);
    audit(req, 'servicenow.retry', { customerId: t.customerId, target: t.title, details: { state: r?.state || null } });
    res.json(r ? tickets.view(r) : null);
  });

  app.post('/api/devices/:id/incident', requirePermission('devices.actions'), requireJson, async (req, res) => {
    const d = inventory.get(req.params.id);
    if (!d || !inScope(req, d.customerId)) return res.status(404).json({ error: 'Not found' });
    try {
      const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
      const t = await tickets.raiseManual(d.customerId, d.id, { by: req.user.name || req.user.email, note });
      audit(req, 'servicenow.raise', { customerId: d.customerId, target: `${d.make} ${d.model}, ${d.room}`, details: { number: t.number, state: t.state } });
      if (t.state === 'failed') return res.status(502).json({ error: t.error, ticket: tickets.view(t) });
      res.json(tickets.view(t));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

/** Ticket fields added to device and alert responses. */
export function deviceTicket(tickets, d, user) {
  const cfg = tickets.config(d.customerId);
  const t = tickets.latestFor(`device:${d.id}`);
  return { enabled: cfg.enabled, mode: cfg.mode, canRaise: cfg.enabled && can(user, 'devices.actions'), ticket: t ? tickets.view(t) : null };
}
