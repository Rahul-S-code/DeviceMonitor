import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Vault, maskSecrets } from './lib/vault.js';
import { Sessions, COOKIE, parseCookies, verifyPassword, allowedCustomers, isAdminRole, isSuperAdmin, hashPassword } from './lib/auth.js';
import { validateSchematic, SCHEMATIC_TEMPLATES } from './lib/schematic.js';
import { Inventory } from './services/inventory.js';
import { SyncService } from './services/sync.js';
import { CONNECTORS, getConnectorClass, createConnector } from './connectors/registry.js';
import { PLATFORMS } from './lib/device-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency); real env vars win.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function createApp({ dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data'), intervalMs, autoStart = true } = {}) {
  const store = new Store(dataDir);
  const production = process.env.NODE_ENV === 'production';
  // In production, never fall back to a well-known password.
  const randomPw = () => crypto.randomBytes(9).toString('base64url');
  const demoPassword = process.env.DEMO_PASSWORD || (production ? randomPw() : 'demo1234');
  const superPassword = process.env.SUPERADMIN_PASSWORD || (production ? randomPw() : demoPassword);
  if (store.seedIfEmpty(demoPassword)) console.log(`[seed] Demo data created. Demo users' password: ${process.env.DEMO_PASSWORD ? '(DEMO_PASSWORD)' : demoPassword}`);
  if (store.migrate(superPassword)) console.log(`[seed] Super admin created: superadmin@provider.example / ${process.env.SUPERADMIN_PASSWORD ? '(SUPERADMIN_PASSWORD)' : superPassword}`);
  const showDemoAccounts = process.env.SHOW_DEMO_ACCOUNTS ? process.env.SHOW_DEMO_ACCOUNTS === 'true' : !production;
  const vault = Vault.fromEnv(dataDir);
  const inventory = new Inventory(store);
  const sync = new SyncService({ store, vault, inventory, intervalMs: intervalMs ?? Number(process.env.SYNC_INTERVAL_SECONDS || 30) * 1000 });
  const sessions = new Sessions();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.basemaps.cartocdn.com; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  // --- auth -------------------------------------------------------------
  app.use((req, _res, next) => {
    const s = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    req.session = s;
    req.user = s ? store.users.find((u) => u.id === s.userId) : null;
    next();
  });
  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in required' }));
  const requireAdmin = (req, res, next) => (isAdminRole(req.user) ? next() : res.status(403).json({ error: 'Admin only' }));
  const requireSuper = (req, res, next) => (isSuperAdmin(req.user) ? next() : res.status(403).json({ error: 'Super admin only' }));
  // Mutations must be JSON (blocks cross-site form posts together with SameSite=Strict).
  const requireJson = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'JSON required' }));

  const failures = new Map();
  app.post('/api/login', requireJson, (req, res) => {
    const ip = req.ip;
    const f = failures.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    const { email, password } = req.body || {};
    const user = store.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
    if (!user || !verifyPassword(String(password || ''), user.password)) {
      f.n += 1; if (f.n >= 5) { f.until = Date.now() + 60_000; f.n = 0; }
      failures.set(ip, f);
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    failures.delete(ip);
    const token = sessions.create(user.id);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600 * 1000, path: '/' });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    sessions.destroy(parseCookies(req.headers.cookie)[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/config', (_req, res) => res.json({ showDemoAccounts }));
  app.get('/api/me', requireUser, (req, res) => {
    const { id, email, name, role, customerId } = req.user;
    const acting = isAdminRole(req.user) && req.session.actingCustomerId && store.customers.some((c) => c.id === req.session.actingCustomerId) ? req.session.actingCustomerId : null;
    res.json({ id, email, name, role, customerId, customerName: customerId ? store.customerName(customerId) : null, actingCustomerId: acting, actingCustomerName: acting ? store.customerName(acting) : null });
  });

  const scope = (req) => allowedCustomers(req.user, store, req.session);
  const inScope = (req, customerId) => scope(req).includes(customerId);
  // Empty onboarded sites/rooms only make sense when no device-level filter is active.
  const configuredScope = (req) => (['platform', 'oem', 'deviceType', 'health', 'q', 'room'].some((k) => req.query[k]) ? null : { allowed: scope(req), f: req.query });

  // "Enter" a customer: admins see the app exactly as that customer's estate.
  app.post('/api/session/enter', requireAdmin, requireJson, (req, res) => {
    const { customerId } = req.body || {};
    if (!store.customers.some((c) => c.id === customerId)) return res.status(400).json({ error: 'Unknown customer' });
    req.session.actingCustomerId = customerId;
    res.json({ ok: true });
  });
  app.post('/api/session/exit', requireAdmin, (req, res) => { delete req.session.actingCustomerId; res.json({ ok: true }); });

  // --- inventory --------------------------------------------------------
  app.get('/api/filters', requireUser, (req, res) => res.json(inventory.filterOptions(scope(req))));
  app.get('/api/summary', requireUser, (req, res) => res.json(inventory.summary(inventory.query(scope(req), req.query))));
  app.get('/api/tree', requireUser, (req, res) => res.json(inventory.tree(inventory.query(scope(req), req.query), configuredScope(req))));
  app.get('/api/devices', requireUser, (req, res) => res.json(inventory.query(scope(req), req.query)));
  app.get('/api/devices/:id', requireUser, (req, res) => {
    const d = inventory.query(scope(req)).find((x) => x.id === req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'Not found' });
  });
  app.get('/api/map', requireUser, (req, res) => res.json(inventory.map(inventory.query(scope(req), req.query), configuredScope(req))));

  // Bulk update: group devices into a room, set platform, tags, notes, or reset to OEM values.
  app.post('/api/devices/bulk', requireAdmin, requireJson, (req, res) => {
    const { ids, set = {}, reset } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000) return res.status(400).json({ error: 'Select between 1 and 2000 devices' });
    const visible = new Map(inventory.query(scope(req)).map((d) => [d.id, d]));
    const targets = ids.map((id) => visible.get(id)).filter(Boolean);
    if (targets.length !== ids.length) return res.status(404).json({ error: 'Some devices were not found' });
    if (set.platform && !PLATFORMS.includes(set.platform)) return res.status(400).json({ error: 'Unknown platform' });
    const text = (v, n) => (v === undefined ? undefined : v === null ? null : String(v).trim().slice(0, n));
    for (const d of targets) {
      if (reset) { store.clearOverride(d.id); continue; }
      const patch = {};
      if (set.site !== undefined) patch.site = text(set.site, 60);
      if (set.room !== undefined) patch.room = text(set.room, 80);
      if (set.platform !== undefined) patch.platform = set.platform === 'Unassigned' ? null : set.platform;
      if (set.notes !== undefined) patch.notes = text(set.notes, 500);
      if (set.assetTag !== undefined) patch.assetTag = text(set.assetTag, 60);
      if (Array.isArray(set.addTags) || Array.isArray(set.removeTags)) {
        const cur = new Set(store.override(d.id)?.tags || []);
        for (const t of set.addTags || []) if (String(t).trim()) cur.add(String(t).trim().slice(0, 30));
        for (const t of set.removeTags || []) cur.delete(String(t).trim());
        patch.tags = cur.size ? [...cur].slice(0, 20) : null;
      }
      store.patchOverride(d.id, patch);
    }
    store.save();
    sync.refresh();
    res.json({ ok: true, updated: targets.length });
  });

  // Room schematics (cabling diagrams).
  app.get('/api/schematic-templates', requireUser, (_req, res) => res.json(SCHEMATIC_TEMPLATES));
  app.get('/api/rooms/schematic', requireUser, (req, res) => {
    const { customerId, site, room } = req.query;
    if (!inScope(req, customerId)) return res.status(404).json({ error: 'Not found' });
    res.json(store.schematic(customerId, site, room));
  });
  app.put('/api/rooms/schematic', requireAdmin, requireJson, (req, res) => {
    const { customerId, site, room, schematic } = req.body || {};
    if (!inScope(req, customerId) || !site || !room) return res.status(400).json({ error: 'Unknown room' });
    try {
      store.setSchematic(customerId, site, room, schematic ? validateSchematic(schematic) : null);
      sync.refresh();
      res.json({ ok: true, schematic: store.schematic(customerId, site, room) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // --- super admin: customers and onboarding -----------------------------
  const customerSummary = (c) => {
    const devs = inventory.devices.filter((d) => d.customerId === c.id);
    return {
      ...c,
      sites: Object.entries(store.sitesFor(c.id)).map(([name, s]) => ({ name, ...s })),
      users: store.users.filter((u) => u.customerId === c.id).map(({ id, email, name }) => ({ id, email, name })),
      connections: store.connections.filter((x) => x.customerId === c.id).map((x) => ({ id: x.id, oem: x.oem, name: x.name, mode: x.mode, status: sync.statusFor(x.id) })),
      deviceCount: devs.length,
      health: Inventory.healthCounts(devs),
    };
  };
  app.get('/api/admin/customers', requireSuper, (_req, res) => res.json(store.customers.map(customerSummary)));
  app.post('/api/admin/customers', requireSuper, requireJson, async (req, res) => {
    const b = req.body || {};
    try {
      const conns = (b.connections || []).map((oem) => { const C = getConnectorClass(oem); return { oem, displayName: C.displayName }; });
      const rooms = (b.rooms || []).map((r) => ({
        site: String(r.site || '').trim(), room: String(r.room || '').trim().slice(0, 80),
        platform: PLATFORMS.includes(r.platform) && r.platform !== 'Unassigned' ? r.platform : null,
        schematic: r.schematic ? validateSchematic(r.schematic) : null,
      }));
      const out = store.onboardCustomer({ ...b, platforms: (b.platforms || []).filter((p) => PLATFORMS.includes(p)), connections: conns, rooms });
      await Promise.all(out.connections.map((c) => sync.syncConnection(c)));
      sync.refresh();
      res.status(201).json(customerSummary(out.customer));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/customers/:id', requireSuper, requireJson, async (req, res) => {
    try {
      const c = store.updateCustomer(req.params.id, req.body || {});
      await Promise.all(store.connections.filter((x) => x.customerId === c.id).map((x) => sync.syncConnection(x)));
      sync.refresh();
      res.json(customerSummary(c));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/admin/customers/:id', requireSuper, (req, res) => {
    try {
      for (const c of store.connections.filter((x) => x.customerId === req.params.id)) inventory.removeConnection(c.id);
      store.deleteCustomer(req.params.id);
      if (req.session.actingCustomerId === req.params.id) delete req.session.actingCustomerId;
      sync.refresh();
      res.json({ ok: true });
    } catch (e) { res.status(404).json({ error: e.message }); }
  });
  app.post('/api/admin/customers/:id/users', requireSuper, requireJson, (req, res) => {
    const c = store.customers.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (store.users.some((u) => u.email === email)) return res.status(400).json({ error: 'That email is already in use' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    store.users.push({ id: `u-${crypto.randomUUID()}`, email, name: String(req.body?.name || email).slice(0, 80), role: 'customer_viewer', customerId: c.id, password: hashPassword(password) });
    store.save();
    res.status(201).json(customerSummary(c));
  });
  app.delete('/api/admin/users/:id', requireSuper, (req, res) => {
    const i = store.users.findIndex((u) => u.id === req.params.id && u.role === 'customer_viewer');
    if (i < 0) return res.status(404).json({ error: 'User not found' });
    store.users.splice(i, 1); store.save();
    res.json({ ok: true });
  });

  app.get('/api/alerts', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(store.data.alerts.filter((a) => allowed.has(a.customerId)).slice(0, limit));
  });

  // Room platform directory (Logitech Sync does not report a meeting platform).
  app.put('/api/rooms/platform', requireAdmin, requireJson, (req, res) => {
    const { customerId, site, room, platform } = req.body || {};
    if (!inScope(req, customerId)) return res.status(400).json({ error: 'Unknown customer' });
    if (platform && !PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
    store.setRoomPlatform(customerId, site, room, platform === 'Unassigned' ? null : platform);
    sync.refresh();
    res.json({ ok: true });
  });

  // --- live events (SSE) ------------------------------------------------
  app.get('/api/events', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    const isAdmin = isAdminRole(req.user);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onAlert = (a) => { if (allowed.has(a.customerId)) send('alert', a); };
    const onInv = (d) => send('inventory', d);
    const onSync = (s) => {
      const conn = store.connections.find((c) => c.id === s.connectionId);
      if (conn && allowed.has(conn.customerId)) send('sync', isAdmin ? s : { ...s, error: s.error ? 'Sync error' : null });
    };
    sync.on('alert', onAlert); sync.on('inventory', onInv); sync.on('sync', onSync);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); sync.off('alert', onAlert); sync.off('inventory', onInv); sync.off('sync', onSync); });
  });

  // --- connectors & connections ----------------------------------------
  app.get('/api/connectors', requireUser, (_req, res) => res.json(CONNECTORS.map((C) => C.describe())));

  const publicConnection = (c, admin) => {
    const C = getConnectorClass(c.oem);
    const base = { id: c.id, customerId: c.customerId, customerName: store.customerName(c.customerId), oem: c.oem, oemName: C.displayName, name: c.name, mode: c.mode, status: sync.statusFor(c.id) };
    if (!admin) return { ...base, status: { ...base.status, error: base.status.error ? 'Sync error' : null } };
    let secrets = {};
    try { secrets = c.secret ? vault.decrypt(c.secret) : {}; } catch { secrets = {}; }
    return { ...base, settings: c.settings, credentials: maskSecrets(C.credentialFields, secrets), hasCredentials: !!c.secret };
  };

  app.get('/api/connections', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    const admin = isAdminRole(req.user);
    res.json(store.connections.filter((c) => allowed.has(c.customerId)).map((c) => publicConnection(c, admin)));
  });

  const cleanSettings = (C, input = {}) => Object.fromEntries(C.settingFields.map((f) => [f.key, String(input[f.key] ?? '').trim()]).filter(([, v]) => v !== ''));
  const mergeSecrets = (C, existingBox, input = {}) => {
    const current = existingBox ? vault.decrypt(existingBox) : {};
    for (const f of C.credentialFields) {
      const v = input[f.key];
      if (typeof v === 'string' && v.trim() !== '') current[f.key] = v.trim();
      if (v === null) delete current[f.key];
    }
    return Object.keys(current).length ? vault.encrypt(current) : null;
  };

  app.post('/api/connections', requireAdmin, requireJson, async (req, res) => {
    const { customerId, oem, name, settings, credentials, mode = 'mock' } = req.body || {};
    if (!inScope(req, customerId)) return res.status(400).json({ error: 'Unknown customer' });
    let C; try { C = getConnectorClass(oem); } catch (e) { return res.status(400).json({ error: e.message }); }
    const conn = {
      id: crypto.randomUUID(), customerId, oem, mode: mode === 'live' ? 'live' : 'mock',
      name: name || `${store.customerName(customerId)} · ${C.displayName}`,
      settings: cleanSettings(C, settings), secret: mergeSecrets(C, null, credentials), createdAt: new Date().toISOString(),
    };
    store.connections.push(conn); store.save();
    sync.syncOne(conn.id).catch(() => {});
    res.status(201).json(publicConnection(conn, true));
  });

  app.put('/api/connections/:id', requireAdmin, requireJson, async (req, res) => {
    const conn = store.connections.find((c) => c.id === req.params.id && inScope(req, c.customerId));
    if (!conn) return res.status(404).json({ error: 'Not found' });
    const C = getConnectorClass(conn.oem);
    const { name, settings, credentials, mode } = req.body || {};
    if (name) conn.name = String(name).slice(0, 120);
    if (settings) conn.settings = cleanSettings(C, settings);
    if (credentials) conn.secret = mergeSecrets(C, conn.secret, credentials);
    if (mode === 'live' || mode === 'mock') conn.mode = mode;
    store.save();
    await sync.syncOne(conn.id);
    res.json(publicConnection(conn, true));
  });

  // Test with the saved settings, or with unsaved values from the form.
  app.post('/api/connections/:id/test', requireAdmin, requireJson, async (req, res) => {
    const conn = store.connections.find((c) => c.id === req.params.id);
    if (!conn) return res.status(404).json({ error: 'Not found' });
    const C = getConnectorClass(conn.oem);
    const b = req.body || {};
    const draft = { ...conn, mode: b.mode || conn.mode, settings: b.settings ? cleanSettings(C, b.settings) : conn.settings };
    const creds = { ...(conn.secret ? vault.decrypt(conn.secret) : {}) };
    for (const f of C.credentialFields) if (typeof b.credentials?.[f.key] === 'string' && b.credentials[f.key].trim()) creds[f.key] = b.credentials[f.key].trim();
    try {
      const result = await createConnector(draft, draft.mode === 'live' ? creds : {}).testConnection();
      res.json(result);
    } catch (e) {
      res.json({ ok: false, message: e.message });
    }
  });

  app.post('/api/connections/:id/sync', requireAdmin, async (req, res) => {
    try { res.json(await sync.syncOne(req.params.id)); } catch (e) { res.status(404).json({ error: e.message }); }
  });

  app.delete('/api/connections/:id', requireAdmin, (req, res) => {
    const i = store.connections.findIndex((c) => c.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Not found' });
    const [conn] = store.connections.splice(i, 1);
    inventory.removeConnection(conn.id);
    store.save();
    sync.refresh();
    res.json({ ok: true });
  });

  app.get('/api/customers', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    res.json(store.customers.filter((c) => allowed.has(c.id)));
  });

  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  if (autoStart) sync.start();
  return { app, store, sync, inventory, vault };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const port = Number(process.env.PORT || 8080);
  app.listen(port, () => console.log(`Device monitor running on http://localhost:${port}`));
}
