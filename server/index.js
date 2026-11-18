import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Vault, maskSecrets } from './lib/vault.js';
import { Sessions, COOKIE, parseCookies, verifyPassword, allowedCustomers } from './lib/auth.js';
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
  const demoPassword = process.env.DEMO_PASSWORD || 'demo1234';
  if (store.seedIfEmpty(demoPassword)) console.log(`[seed] Demo data created. Sign in as admin@provider.example / ${demoPassword}`);
  const vault = Vault.fromEnv(dataDir);
  const inventory = new Inventory(store);
  const sync = new SyncService({ store, vault, inventory, intervalMs: intervalMs ?? Number(process.env.SYNC_INTERVAL_SECONDS || 30) * 1000 });
  const sessions = new Sessions();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  // --- auth -------------------------------------------------------------
  app.use((req, _res, next) => {
    const s = sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    req.user = s ? store.users.find((u) => u.id === s.userId) : null;
    next();
  });
  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in required' }));
  const requireAdmin = (req, res, next) => (req.user?.role === 'provider_admin' ? next() : res.status(403).json({ error: 'Admin only' }));
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
  app.get('/api/me', requireUser, (req, res) => {
    const { id, email, name, role, customerId } = req.user;
    res.json({ id, email, name, role, customerId, customerName: customerId ? store.customerName(customerId) : null });
  });

  const scope = (req) => allowedCustomers(req.user, store);

  // --- inventory --------------------------------------------------------
  app.get('/api/filters', requireUser, (req, res) => res.json(inventory.filterOptions(scope(req))));
  app.get('/api/summary', requireUser, (req, res) => res.json(inventory.summary(inventory.query(scope(req), req.query))));
  app.get('/api/tree', requireUser, (req, res) => res.json(inventory.tree(inventory.query(scope(req), req.query))));
  app.get('/api/devices', requireUser, (req, res) => res.json(inventory.query(scope(req), req.query)));
  app.get('/api/devices/:id', requireUser, (req, res) => {
    const d = inventory.query(scope(req)).find((x) => x.id === req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'Not found' });
  });
  app.get('/api/alerts', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(store.data.alerts.filter((a) => allowed.has(a.customerId)).slice(0, limit));
  });

  // Room platform directory (Logitech Sync does not report a meeting platform).
  app.put('/api/rooms/platform', requireAdmin, requireJson, (req, res) => {
    const { customerId, site, room, platform } = req.body || {};
    if (!store.customers.some((c) => c.id === customerId)) return res.status(400).json({ error: 'Unknown customer' });
    if (platform && !PLATFORMS.includes(platform)) return res.status(400).json({ error: 'Unknown platform' });
    store.setRoomPlatform(customerId, site, room, platform === 'Unassigned' ? null : platform);
    sync.refresh();
    res.json({ ok: true });
  });

  // --- live events (SSE) ------------------------------------------------
  app.get('/api/events', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    const isAdmin = req.user.role === 'provider_admin';
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
    const admin = req.user.role === 'provider_admin';
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
    if (!store.customers.some((c) => c.id === customerId)) return res.status(400).json({ error: 'Unknown customer' });
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
    const conn = store.connections.find((c) => c.id === req.params.id);
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
