import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Vault, maskSecrets } from './lib/vault.js';
import { Sessions, COOKIE, parseCookies, verifyPassword, allowedCustomers, isAdminRole, isSuperAdmin, hashPassword } from './lib/auth.js';
import { validateSchematic, withBlockPorts, SCHEMATIC_TEMPLATES, BLOCKS, CABLES, NODE_KINDS, CONDITIONS } from './lib/schematic.js';
import { detectDesignType, cleanFileName, DESIGN_ACCEPT, MAX_DESIGNS_PER_ROOM } from './lib/designs.js';
import { ApiTracker } from './services/api-tracker.js';
import { ERROR_CODES } from './lib/issues.js';
import { Inventory, listItem, SORT_KEYS } from './services/inventory.js';
import { SyncService, SYNC_LIMITS, SYNC_PRESETS, cleanInterval, minIntervalFor, fmtSeconds } from './services/sync.js';
import { FilePersistence, openPersistence } from './lib/persistence.js';
import { History, slaReport, WINDOWS } from './services/history.js';
import { CONNECTORS, getConnectorClass, createConnector } from './connectors/registry.js';
import { PLATFORMS } from './lib/device-model.js';
import { csvObjects, toCsv } from './lib/csv.js';
import { LEVELS, LIFECYCLE_LIMITS, resolveFirmware } from './lib/baselines.js';
import { compareVersions } from './lib/models.js';

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

export function createApp({ dataDir = path.resolve(ROOT, process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || 'data'), intervalMs, autoStart = true, persistence = null } = {}) {
  persistence ||= new FilePersistence(dataDir);
  const store = new Store(dataDir, { persistence });
  const production = process.env.NODE_ENV === 'production';
  // In production, never fall back to a well-known password.
  const randomPw = () => crypto.randomBytes(9).toString('base64url');
  const demoPassword = process.env.DEMO_PASSWORD || (production ? randomPw() : 'demo1234');
  const superPassword = process.env.SUPERADMIN_PASSWORD || (production ? randomPw() : demoPassword);
  if (store.seedIfEmpty(demoPassword)) console.log(`[seed] Demo data created. Demo users' password: ${process.env.DEMO_PASSWORD ? '(DEMO_PASSWORD)' : demoPassword}`);
  if (store.migrate(superPassword, demoPassword)) console.log(`[seed] Super admin created: superadmin@provider.example / ${process.env.SUPERADMIN_PASSWORD ? '(SUPERADMIN_PASSWORD)' : superPassword}`);
  // Map base layers. OpenStreetMap's own tiles by default; MAP_TILE_URL adds a
  // self-hosted or other open tile server (e.g. https://tiles.example.com/{z}/{x}/{y}.png).
  const mapLayers = [
    { id: 'osm', name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
    { id: 'carto-light', name: 'Light (OpenStreetMap data)', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', subdomains: 'abcd', maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
  ];
  if (process.env.MAP_TILE_URL && /^https:\/\/[^\s"'<>]+$/.test(process.env.MAP_TILE_URL)) {
    mapLayers.unshift({ id: 'custom', name: process.env.MAP_TILE_NAME || 'Custom map', url: process.env.MAP_TILE_URL, maxZoom: 19, attribution: process.env.MAP_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  }
  const tileHosts = [...new Set(mapLayers.map((l) => { const h = new URL(l.url.replace(/\{s\}/, 'x').replace(/\{[^}]+\}/g, '0')).host; return l.subdomains ? `https://*.${h.split('.').slice(1).join('.')}` : `https://${h}`; }))].join(' ');
  const showDemoAccounts = process.env.SHOW_DEMO_ACCOUNTS ? process.env.SHOW_DEMO_ACCOUNTS === 'true' : !production;
  const vault = Vault.fromEnv(dataDir);
  const inventory = new Inventory(store);
  const history = new History(dataDir, { persistence });
  // SYNC_INTERVAL_SECONDS is only the starting default: admins change it on the Sync schedule page.
  const sync = new SyncService({ store, vault, inventory, history, persistence, intervalMs: intervalMs ?? (process.env.SYNC_INTERVAL_SECONDS ? Number(process.env.SYNC_INTERVAL_SECONDS) * 1000 : null) });
  const sessions = new Sessions();
  const apiTracker = new ApiTracker({ store, sync, mapLayers, intervalMinutes: Number(process.env.API_CHECK_MINUTES ?? 30) });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // CSV imports can be larger than other requests; body-parser skips a body already parsed.
  app.use('/api/manual-devices/import', express.json({ limit: '2mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: ${tileHosts}; connect-src 'self'`,
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

  // Audit log: who did what, when. Never record secret values.
  const actorOf = (u) => (u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null);
  const audit = (req, action, extra = {}) => store.audit({
    actor: actorOf(req.user), actingCustomerId: req.session?.actingCustomerId || null, ip: req.ip, action, ...extra,
  });

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
      store.audit({ actor: actorOf(user) || { id: null, email: String(email || '').slice(0, 120).toLowerCase(), name: null, role: null }, ip, action: 'auth.login_failed', customerId: user?.customerId || null });
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    failures.delete(ip);
    const token = sessions.create(user.id);
    store.audit({ actor: actorOf(user), ip, action: 'auth.login', customerId: user.customerId || null });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600 * 1000, path: '/' });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    if (req.user) audit(req, 'auth.logout', { customerId: req.user.customerId || null });
    sessions.destroy(parseCookies(req.headers.cookie)[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  app.get('/api/config', (_req, res) => res.json({ showDemoAccounts, mapLayers }));
  app.get('/api/me', requireUser, (req, res) => {
    const { id, email, name, role, customerId } = req.user;
    const acting = isAdminRole(req.user) && req.session.actingCustomerId && store.customers.some((c) => c.id === req.session.actingCustomerId) ? req.session.actingCustomerId : null;
    res.json({ id, email, name, role, customerId, customerName: customerId ? store.customerName(customerId) : null, actingCustomerId: acting, actingCustomerName: acting ? store.customerName(acting) : null });
  });

  const scope = (req) => allowedCustomers(req.user, store, req.session);
  const inScope = (req, customerId) => scope(req).includes(customerId);
  // Empty onboarded sites/rooms only make sense when no device-level filter is active.
  const configuredScope = (req) => (['platform', 'oem', 'deviceType', 'health', 'firmwareStatus', 'warrantyStatus', 'q', 'room'].some((k) => req.query[k]) ? null : { allowed: scope(req), f: req.query });

  // "Enter" a customer: admins see the app exactly as that customer's estate.
  app.post('/api/session/enter', requireAdmin, requireJson, (req, res) => {
    const { customerId } = req.body || {};
    if (!store.customers.some((c) => c.id === customerId)) return res.status(400).json({ error: 'Unknown customer' });
    req.session.actingCustomerId = customerId;
    audit(req, 'session.enter_customer', { customerId, target: store.customerName(customerId) });
    res.json({ ok: true });
  });
  app.post('/api/session/exit', requireAdmin, (req, res) => {
    const was = req.session.actingCustomerId;
    delete req.session.actingCustomerId;
    if (was) audit(req, 'session.exit_customer', { customerId: was, target: store.customerName(was) });
    res.json({ ok: true });
  });

  // --- inventory --------------------------------------------------------
  app.get('/api/filters', requireUser, (req, res) => res.json(inventory.filterOptions(scope(req))));
  app.get('/api/summary', requireUser, (req, res) => {
    const allowed = scope(req);
    res.json(inventory.summary(inventory.query(allowed, req.query), Inventory.filterKey(allowed, req.query)));
  });
  // Rooms carry counts; ?devices=1 adds each room's devices (use it with a customer and site filter).
  app.get('/api/tree', requireUser, (req, res) => {
    const devs = inventory.query(scope(req), req.query);
    const tree = inventory.tree(devs, configuredScope(req), { withDevices: req.query.devices === '1' });
    if (req.query.devices === '1') for (const s of tree) for (const r of s.rooms) r.devices = r.devices.map(listItem);
    res.json(tree);
  });
  // Paged list: ?limit=&offset=&sort=&dir= returns { items, total, offset, limit }.
  // Without paging parameters the old array form is returned, capped at MAX_UNPAGED devices (X-Total-Count has the full count).
  const MAX_UNPAGED = 5000;
  app.get('/api/devices', requireUser, (req, res) => {
    const q = req.query;
    if (q.limit !== undefined || q.offset !== undefined || q.sort !== undefined) {
      if (q.sort && !SORT_KEYS.includes(q.sort)) return res.status(400).json({ error: `sort must be one of ${SORT_KEYS.join(', ')}` });
      return res.json(inventory.page(scope(req), q, { sort: q.sort || null, dir: q.dir === 'desc' || q.dir === '-1' ? -1 : 1, offset: Number(q.offset) || 0, limit: Number(q.limit) || 100 }));
    }
    const all = inventory.query(scope(req), q);
    res.set('X-Total-Count', String(all.length));
    if (all.length > MAX_UNPAGED) res.set('X-Truncated', 'true');
    res.json(all.length > MAX_UNPAGED ? all.slice(0, MAX_UNPAGED) : all);
  });
  // List rows for specific devices (e.g. the current selection), in scope only.
  app.post('/api/devices/lookup', requireUser, requireJson, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 2000) : [];
    res.json(ids.map((id) => visibleDevice(req, String(id))).filter(Boolean).map(listItem));
  });
  const visibleDevice = (req, id) => { const d = inventory.get(id); return d && inScope(req, d.customerId) ? d : null; };
  app.get('/api/devices/:id', requireUser, (req, res) => {
    const d = visibleDevice(req, req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'Not found' });
  });
  // --- device actions (admins): run through the vendor API that reports the device
  const actionSets = (d) => d.sources.filter((src) => src.oem !== 'manual').map((src) => {
    const C = getConnectorClass(src.oem);
    const conn = store.connections.find((c) => c.id === src.connectionId);
    return {
      oem: C.oem, displayName: C.displayName, kind: C.kind, apiSet: C.apiSetLabel || (C.kind === 'platform' ? 'Meeting platform API' : 'OEM device cloud API'),
      connectionId: src.connectionId, connectionName: conn?.name || null, mode: conn?.mode || null,
      actions: conn ? C.actions.filter((a) => C.actionApplies(a, d, src)) : [],
      note: !conn ? 'The connection that reported this device has been removed.' : C.actions.length ? (C.actions.some((a) => C.actionApplies(a, d, src)) ? null : `${C.displayName} actions don't apply to this device.`) : C.actionsNote,
    };
  });
  const lastAction = new Map();
  app.get('/api/devices/:id/actions', requireAdmin, (req, res) => {
    const d = visibleDevice(req, req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json({ sets: actionSets(d) });
  });
  app.post('/api/devices/:id/actions', requireAdmin, requireJson, async (req, res) => {
    const d = visibleDevice(req, req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    const { connectionId, action } = req.body || {};
    const src = d.sources.find((x) => x.connectionId === connectionId && x.oem !== 'manual');
    const conn = store.connections.find((c) => c.id === connectionId);
    if (!src || !conn) return res.status(400).json({ error: 'That connection does not report this device' });
    const C = getConnectorClass(conn.oem);
    const a = C.actions.find((x) => x.id === action);
    if (!a || !C.actionApplies(a, d, src)) return res.status(400).json({ error: `${C.displayName} cannot run that action on this device` });
    const key = `${a.target === 'room' ? `${conn.id}|${src.roomId}` : d.id}|${a.id}`;
    if (Date.now() - (lastAction.get(key) || 0) < 60_000) return res.status(429).json({ error: 'This action was just run. Wait a minute before running it again.' });
    lastAction.set(key, Date.now());
    const details = { action: a.label, via: C.displayName, apiSet: a.api.set, endpoint: `${a.api.method} ${a.api.endpoint}`, mode: conn.mode };
    try {
      const r = await Promise.race([
        sync.connectorFor(conn).runAction(a.id, src, d),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${C.displayName} did not answer within 20 seconds`)), 20_000).unref?.()),
      ]);
      audit(req, 'device.action', { customerId: d.customerId, target: `${d.make} ${d.model} (${d.room}, ${d.site})`, details: { ...details, result: r.simulated ? 'simulated (demo connection)' : 'sent' } });
      res.json({ ...r, action: a.label, via: C.displayName, apiSet: a.api.set });
    } catch (e) {
      lastAction.delete(key);
      audit(req, 'device.action_failed', { customerId: d.customerId, target: `${d.make} ${d.model} (${d.room}, ${d.site})`, details: { ...details, error: e.message } });
      res.status(502).json({ error: e.message });
    }
  });
  // Error code reference, with how many devices in scope have each code now.
  app.get('/api/error-codes', requireUser, (req, res) => {
    const counts = {};
    for (const d of inventory.query(scope(req))) for (const c of d.errorCodes || []) counts[c] = (counts[c] || 0) + 1;
    res.json(Object.entries(ERROR_CODES).map(([code, e]) => ({ code, ...e, devices: counts[code] || 0 })));
  });
  app.get('/api/map', requireUser, (req, res) => res.json(inventory.map(inventory.query(scope(req), req.query), configuredScope(req))));

  // Bulk update: group devices into a room, set platform, tags, notes, or reset to OEM values.
  app.post('/api/devices/bulk', requireAdmin, requireJson, (req, res) => {
    const { ids, set = {}, reset } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000) return res.status(400).json({ error: 'Select between 1 and 2000 devices' });
    const targets = ids.map((id) => visibleDevice(req, String(id))).filter(Boolean);
    if (targets.length !== ids.length) return res.status(404).json({ error: 'Some devices were not found' });
    if (set.platform && !PLATFORMS.includes(set.platform)) return res.status(400).json({ error: 'Unknown platform' });
    const text = (v, n) => (v === undefined ? undefined : v === null ? null : String(v).trim().slice(0, n));
    const isoDate = (v, label) => {
      if (v === undefined || v === null || v === '') return v === undefined ? undefined : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(Date.parse(v))) throw new Error(`${label} must be a date (YYYY-MM-DD)`);
      return String(v);
    };
    let dates;
    try { dates = { warrantyExpires: isoDate(set.warrantyExpires, 'Warranty end'), purchaseDate: isoDate(set.purchaseDate, 'Purchase date') }; } catch (e) { return res.status(400).json({ error: e.message }); }
    for (const d of targets) {
      if (reset) { store.clearOverride(d.id); continue; }
      const patch = {};
      if (set.site !== undefined) patch.site = text(set.site, 60);
      if (set.room !== undefined) patch.room = text(set.room, 80);
      if (set.platform !== undefined) patch.platform = set.platform === 'Unassigned' ? null : set.platform;
      if (set.notes !== undefined) patch.notes = text(set.notes, 500);
      if (set.assetTag !== undefined) patch.assetTag = text(set.assetTag, 60);
      if (dates.warrantyExpires !== undefined) patch.warrantyExpires = dates.warrantyExpires;
      if (dates.purchaseDate !== undefined) patch.purchaseDate = dates.purchaseDate;
      if (set.warrantyType !== undefined) patch.warrantyType = text(set.warrantyType, 40);
      if (set.contractRef !== undefined) patch.contractRef = text(set.contractRef, 60);
      if (Array.isArray(set.addTags) || Array.isArray(set.removeTags)) {
        const cur = new Set(store.override(d.id)?.tags || []);
        for (const t of set.addTags || []) if (String(t).trim()) cur.add(String(t).trim().slice(0, 30));
        for (const t of set.removeTags || []) cur.delete(String(t).trim());
        patch.tags = cur.size ? [...cur].slice(0, 20) : null;
      }
      store.patchOverride(d.id, patch);
    }
    store.save();
    const custs = [...new Set(targets.map((d) => d.customerId))];
    for (const c of custs) inventory.invalidate(c);
    sync.refreshPending();
    audit(req, reset ? 'device.reset' : 'device.bulk_update', {
      customerId: custs.length === 1 ? custs[0] : null,
      target: targets.length === 1 ? `${targets[0].make} ${targets[0].model} (${targets[0].room})` : `${targets.length} devices`,
      details: { devices: targets.length, fields: reset ? [] : Object.keys(set).filter((k) => set[k] !== undefined), deviceIds: targets.slice(0, 50).map((d) => d.id) },
    });
    res.json({ ok: true, updated: targets.length });
  });

  // Devices added by hand (kit with no API). Make and model come from the model master;
  // they show as "Not monitored" until a connector reports the same serial or MAC.
  const manualLabel = (m) => { const mod = store.models.find((x) => x.id === m.modelId); return `${mod ? `${mod.make} ${mod.model}` : `${m.make || ''} ${m.model || 'Device'}`.trim()} (${m.room}, ${m.site})`; };
  const manualOf = (req) => store.manualDevices.find((d) => d.id === req.params.id && inScope(req, d.customerId));
  app.post('/api/manual-devices', requireAdmin, requireJson, (req, res) => {
    const b = req.body || {};
    if (!inScope(req, b.customerId)) return res.status(400).json({ error: 'Pick a customer' });
    try {
      const d = store.addManualDevice({ ...b, createdBy: req.user.email });
      sync.refresh(d.customerId);
      audit(req, 'device.manual_add', { customerId: d.customerId, target: manualLabel(d), details: { serial: d.serial, mac: d.mac } });
      res.status(201).json(inventory.devices.find((x) => x.manualId === d.id || x.id === d.id) || d);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // Bulk add from CSV: download the template, preview (commit=false), then import (commit=true).
  const BULK_COLUMNS = ['customer', 'site', 'room', 'make', 'model', 'device_type', 'serial', 'mac', 'firmware', 'platform', 'asset_tag', 'warranty_end', 'warranty_type', 'notes'];
  const MAX_IMPORT_ROWS = 2000;
  app.get('/api/manual-devices/template.csv', requireAdmin, (req, res) => {
    const custs = store.customers.filter((c) => inScope(req, c.id));
    const models = [...store.models].sort((a, b) => `${a.make}${a.model}`.localeCompare(`${b.make}${b.model}`));
    const ex = (i) => models[i % Math.max(models.length, 1)];
    const rows = [BULK_COLUMNS];
    if (models.length) {
      rows.push([custs[0]?.name || '', 'London HQ', 'Atlas 4.01', ex(0).make, ex(0).model, '', 'SERIAL001', '00:11:22:33:44:55', ex(0).baseline || '', 'Microsoft Teams', 'ASSET-0001', '2028-03-31', 'Standard', 'Example row: delete before importing']);
    }
    rows.push([]);
    rows.push(['# Allowed make and model pairs (from the model master). Delete these lines before importing.']);
    for (const m of models) rows.push(['#', '', '', m.make, m.model, m.deviceType]);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="estate-monitor-devices-template.csv"' });
    res.send(toCsv(rows));
  });
  app.post('/api/manual-devices/import', requireAdmin, requireJson, (req, res) => {
    const { csv, customerId = null, commit = false, allowUnlisted = false } = req.body || {};
    if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'Choose a CSV file' });
    if (customerId && !inScope(req, customerId)) return res.status(400).json({ error: 'Pick a customer' });
    let parsed;
    try { parsed = csvObjects(csv); } catch (e) { return res.status(400).json({ error: e.message }); }
    const missing = ['site', 'room', 'make', 'model'].filter((c) => !parsed.headers.includes(c));
    if (missing.length) return res.status(400).json({ error: `The CSV needs a header row with these columns: ${missing.join(', ')}. Download the template to start from.` });
    const records = parsed.records.filter((r) => !String(r.values[parsed.headers[0]] || '').startsWith('#'));
    if (!records.length) return res.status(400).json({ error: 'The CSV has no device rows' });
    if (records.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `Up to ${MAX_IMPORT_ROWS} rows per file. Split the file and import each part.` });
    const out = store.importManualDevices(records, { customerIds: scope(req), defaultCustomerId: customerId, commit: !!commit, allowUnlisted: !!allowUnlisted, by: req.user.email });
    if (commit && out.added.length) {
      for (const cid of new Set(out.added.map((d) => d.customerId))) inventory.invalidate(cid); sync.refreshPending();
      const byCust = new Map();
      for (const d of out.added) byCust.set(d.customerId, (byCust.get(d.customerId) || 0) + 1);
      for (const [cid, n] of byCust) audit(req, 'device.bulk_import', { customerId: cid, target: `${n} devices from CSV`, details: { rows: out.rows.length, added: n, skipped: out.invalid } });
    }
    res.json({ rows: out.rows, valid: out.valid, invalid: out.invalid, added: commit ? out.added.length : 0, committed: !!commit });
  });
  app.put('/api/manual-devices/:id', requireAdmin, requireJson, (req, res) => {
    const cur = manualOf(req);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    try {
      const d = store.updateManualDevice(cur.id, req.body || {});
      sync.refresh(d.customerId);
      audit(req, 'device.manual_update', { customerId: d.customerId, target: manualLabel(d), details: { fields: Object.keys(req.body || {}) } });
      res.json(d);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/manual-devices/:id', requireUser, (req, res) => {
    const d = manualOf(req);
    return d ? res.json(d) : res.status(404).json({ error: 'Not found' });
  });
  app.delete('/api/manual-devices/:id', requireAdmin, (req, res) => {
    const cur = manualOf(req);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    store.deleteManualDevice(cur.id);
    sync.refresh(cur.customerId);
    audit(req, 'device.manual_delete', { customerId: cur.customerId, target: manualLabel(cur), details: { serial: cur.serial } });
    res.json({ ok: true });
  });

  // Room schematics (cabling diagrams).
  app.get('/api/schematic-templates', requireUser, (_req, res) => res.json(SCHEMATIC_TEMPLATES));
  app.get('/api/schematic-blocks', requireUser, (_req, res) => res.json({ blocks: BLOCKS, cables: CABLES, kinds: NODE_KINDS, conditions: CONDITIONS, designAccept: DESIGN_ACCEPT }));
  // Normalise a schematic loaded from a file so it opens port to port in the designer.
  app.post('/api/schematics/prepare', requireUser, requireJson, (req, res) => {
    try { res.json(withBlockPorts(validateSchematic(req.body))); } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/rooms/schematic', requireUser, (req, res) => {
    const { customerId, site, room } = req.query;
    if (!inScope(req, customerId)) return res.status(404).json({ error: 'Not found' });
    const saved = store.schematic(customerId, site, room);
    // Schematics saved before the designer existed get ports from their building blocks.
    res.json(saved && saved.nodes.some((n) => !Array.isArray(n.ports)) ? withBlockPorts(saved) : saved);
  });
  app.put('/api/rooms/schematic', requireAdmin, requireJson, (req, res) => {
    const { customerId, site, room, schematic } = req.body || {};
    if (!inScope(req, customerId) || !site || !room) return res.status(400).json({ error: 'Unknown room' });
    try {
      store.setSchematic(customerId, site, room, schematic ? { ...validateSchematic(schematic), updatedBy: req.user.name || req.user.email } : null);
      sync.refresh(customerId);
      audit(req, schematic ? 'room.schematic_saved' : 'room.schematic_removed', { customerId, target: `${room}, ${site}`, details: schematic ? { nodes: schematic.nodes?.length || 0, links: schematic.links?.length || 0 } : undefined });
      res.json({ ok: true, schematic: store.schematic(customerId, site, room) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Room design documents: uploaded drawings (PDF, image, Visio, AutoCAD).
  const roomArgs = (q) => ({ customerId: String(q.customerId || ''), site: String(q.site || '').slice(0, 120), room: String(q.room || '').slice(0, 120) });
  const designOut = (d) => ({ id: d.id, name: d.name, title: d.title || null, ext: d.ext, mime: d.mime, label: d.label, preview: d.preview, size: d.size, uploadedAt: d.uploadedAt, uploadedBy: d.uploadedBy, url: `/api/designs/${d.id}/file` });
  app.get('/api/rooms/designs', requireUser, (req, res) => {
    const { customerId, site, room } = roomArgs(req.query);
    if (!inScope(req, customerId)) return res.status(404).json({ error: 'Not found' });
    res.json(store.designsFor(customerId, site, room).map(designOut));
  });
  app.post('/api/rooms/designs', requireAdmin, (req, res, next) => {
    // Uploads are raw bytes, not JSON. A custom header can't be sent cross-site without CORS, so it stands in for requireJson.
    if (req.get('x-requested-with') !== 'estate-monitor') return res.status(415).json({ error: 'Upload from the app' });
    next();
  }, express.raw({ type: () => true, limit: '10mb' }), (req, res) => {
    const { customerId, site, room } = roomArgs(req.query);
    if (!inScope(req, customerId) || !site || !room) return res.status(400).json({ error: 'Unknown room' });
    try {
      if (store.designsFor(customerId, site, room).length >= MAX_DESIGNS_PER_ROOM) throw new Error(`A room can hold up to ${MAX_DESIGNS_PER_ROOM} files. Remove one first.`);
      const name = cleanFileName(req.query.name);
      const type = detectDesignType(req.body, name);
      const title = req.query.title ? String(req.query.title).trim().slice(0, 120) || null : null;
      const d = store.addDesign({ customerId, site, room, name, title, ...type, uploadedBy: req.user.name || req.user.email }, req.body);
      audit(req, 'room.design_uploaded', { customerId, target: `${room}, ${site}`, details: { file: name, type: type.label, size: d.size } });
      res.json(designOut(d));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  const findDesign = (req, res) => {
    const d = store.data.designs.find((x) => x.id === req.params.id);
    if (!d || !inScope(req, d.customerId)) { res.status(404).json({ error: 'Not found' }); return null; }
    return d;
  };
  app.get('/api/designs/:id/file', requireUser, (req, res) => {
    const d = findDesign(req, res); if (!d) return;
    const inline = d.preview !== 'download' && req.query.download === undefined;
    const ascii = d.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.set({
      'Content-Type': d.mime,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
      'Cache-Control': 'private, max-age=300',
    });
    res.sendFile(store.designPath(d), (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'The file is missing. It may have been lost when the server restarted.' }); });
  });
  app.delete('/api/designs/:id', requireAdmin, (req, res) => {
    const d = findDesign(req, res); if (!d) return;
    store.removeDesign(d.id);
    audit(req, 'room.design_removed', { customerId: d.customerId, target: `${d.room}, ${d.site}`, details: { file: d.name } });
    res.json({ ok: true });
  });

  // --- API tracker (admins; checks are super admin only) ---------------------
  app.get('/api/admin/apis', requireAdmin, (_req, res) => res.json(apiTracker.report()));
  app.post('/api/admin/apis/check', requireSuper, requireJson, async (req, res) => {
    const id = req.body?.id ? String(req.body.id) : null;
    try {
      const report = await apiTracker.check({ id, actor: req.user.email });
      const checked = report.apis.filter((a) => a.latest && (!id || a.id === id));
      audit(req, 'api.check', { target: id ? checked[0]?.name : 'All APIs', details: { checked: checked.length, down: checked.filter((a) => a.state === 'down').length } });
      res.json(report);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // --- super admin: customers and onboarding -----------------------------
  const customerSummary = (c) => {
    const devs = inventory.forCustomer(c.id);
    return {
      ...c,
      mockData: store.mockEnabled(c.id),
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
      const out = store.onboardCustomer({ ...b, mockData: b.mockData !== false, platforms: (b.platforms || []).filter((p) => PLATFORMS.includes(p)), connections: conns, rooms });
      await Promise.all(out.connections.map((c) => sync.syncConnection(c)));
      sync.refresh();
      audit(req, 'customer.onboard', { customerId: out.customer.id, target: out.customer.name, details: { sites: Object.keys(store.sitesFor(out.customer.id)).length, users: out.users, connections: out.connections.map((c) => c.oem), rooms: rooms.length } });
      res.status(201).json(customerSummary(out.customer));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/customers/:id', requireSuper, requireJson, async (req, res) => {
    try {
      const before = store.customers.find((x) => x.id === req.params.id);
      const prevTarget = before ? store.slaTarget(before.id) : null;
      const prevMock = before ? store.mockEnabled(before.id) : null;
      const body = { ...(req.body || {}) };
      if (body.mockData !== undefined) body.mockData = body.mockData !== false;
      const c = store.updateCustomer(req.params.id, body);
      const mockChanged = body.mockData !== undefined && prevMock !== c.mockData;
      audit(req, 'customer.update', { customerId: c.id, target: c.name, details: { fields: Object.keys(req.body || {}), ...(req.body?.slaTarget !== undefined ? { slaTarget: { from: prevTarget, to: c.slaTarget } } : {}), ...(mockChanged ? { mockData: { from: prevMock, to: c.mockData } } : {}) } });
      await Promise.all(store.connections.filter((x) => x.customerId === c.id).map((x) => sync.syncConnection(x)));
      sync.refresh(c.id);
      if (mockChanged && c.mockData === false) {
        // Alerts raised by the mock devices that just went away.
        store.data.alerts = store.data.alerts.filter((a) => a.customerId !== c.id || a.kind !== 'device' || inventory.byId.has(a.deviceId));
        store.save();
      }
      res.json(customerSummary(c));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/admin/customers/:id', requireSuper, (req, res) => {
    try {
      for (const c of store.connections.filter((x) => x.customerId === req.params.id)) { inventory.removeConnection(c.id); persistence.deleteSnapshot(c.id); }
      const name = store.customerName(req.params.id);
      store.deleteCustomer(req.params.id);
      audit(req, 'customer.delete', { customerId: req.params.id, target: name });
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
    audit(req, 'user.create', { customerId: c.id, target: email });
    res.status(201).json(customerSummary(c));
  });
  app.delete('/api/admin/users/:id', requireSuper, (req, res) => {
    const i = store.users.findIndex((u) => u.id === req.params.id && u.role === 'customer_viewer');
    if (i < 0) return res.status(404).json({ error: 'User not found' });
    const [gone] = store.users.splice(i, 1); store.save();
    audit(req, 'user.delete', { customerId: gone.customerId, target: gone.email });
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
    const before = store.roomPlatform(customerId, site, room);
    store.setRoomPlatform(customerId, site, room, platform === 'Unassigned' ? null : platform);
    sync.refresh(customerId);
    audit(req, 'room.platform', { customerId, target: `${room}, ${site}`, details: { from: before || 'Unassigned', to: platform || 'Unassigned' } });
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
    const onAlerts = (x) => send('alerts', x); // a burst (e.g. first sync of a big estate): the page reloads its feed
    const onInv = (d) => send('inventory', d);
    const onSync = (s) => {
      const conn = store.connections.find((c) => c.id === s.connectionId);
      if (conn && allowed.has(conn.customerId)) send('sync', isAdmin ? s : { ...s, error: s.error ? 'Sync error' : null });
    };
    sync.on('alert', onAlert); sync.on('alerts', onAlerts); sync.on('inventory', onInv); sync.on('sync', onSync);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); sync.off('alert', onAlert); sync.off('alerts', onAlerts); sync.off('inventory', onInv); sync.off('sync', onSync); });
  });

  // --- connectors & connections ----------------------------------------
  app.get('/api/connectors', requireUser, (_req, res) => res.json(CONNECTORS.map((C) => C.describe())));

  const publicConnection = (c, admin) => {
    const C = getConnectorClass(c.oem);
    const base = { id: c.id, customerId: c.customerId, customerName: store.customerName(c.customerId), oem: c.oem, oemName: C.displayName, name: c.name, mode: c.mode, syncIntervalSec: c.syncIntervalSec ?? null, minIntervalSec: minIntervalFor(c.oem), status: sync.statusFor(c.id) };
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
  // URL settings (authUrl, apiUrl, baseUrl ...) must be https URLs. Catches browser
  // autofill putting an email or a password into a URL field.
  const isUrlField = (f) => f.type === 'url' || /Url$/.test(f.key);
  const settingsError = (C, input) => {
    if (!input) return null;
    for (const f of C.settingFields.filter(isUrlField)) {
      const v = String(input[f.key] ?? '').trim();
      if (!v) continue;
      let u = null; try { u = new URL(v); } catch { /* invalid */ }
      if (!u || u.protocol !== 'https:' || /@/.test(v)) return `${f.label} must be a full https:// address${f.default ? `, for example ${f.default}` : ''}. Clear the field to use the default.`;
    }
    return null;
  };
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
    let syncIntervalSec = null;
    try { syncIntervalSec = cleanInterval(req.body?.syncIntervalSec, { min: minIntervalFor(oem) }); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (mode === 'live' && C.liveSupported === false) return res.status(400).json({ error: C.liveNote || `${C.displayName} has no live API` });
    const badSetting = settingsError(C, settings); if (badSetting) return res.status(400).json({ error: badSetting });
    const conn = {
      id: crypto.randomUUID(), customerId, oem, mode: mode === 'live' ? 'live' : 'mock',
      name: name || `${store.customerName(customerId)} · ${C.displayName}`,
      settings: cleanSettings(C, settings), secret: mergeSecrets(C, null, credentials), createdAt: new Date().toISOString(),
      ...(syncIntervalSec ? { syncIntervalSec } : {}),
    };
    store.connections.push(conn); store.save();
    audit(req, 'connection.create', { customerId, target: conn.name, details: { oem, mode: conn.mode, settings: Object.keys(conn.settings), credentialsSet: Object.keys(credentials || {}).filter((k) => credentials[k]) } });
    sync.syncOne(conn.id).catch(() => {});
    res.status(201).json(publicConnection(conn, true));
  });

  app.put('/api/connections/:id', requireAdmin, requireJson, async (req, res) => {
    const conn = store.connections.find((c) => c.id === req.params.id && inScope(req, c.customerId));
    if (!conn) return res.status(404).json({ error: 'Not found' });
    const C = getConnectorClass(conn.oem);
    const { name, settings, credentials, mode } = req.body || {};
    if (mode === 'live' && C.liveSupported === false) return res.status(400).json({ error: C.liveNote || `${C.displayName} has no live API` });
    const badSetting = settingsError(C, settings); if (badSetting) return res.status(400).json({ error: badSetting });
    let interval;
    if (req.body && 'syncIntervalSec' in req.body) { try { interval = cleanInterval(req.body.syncIntervalSec, { min: minIntervalFor(conn.oem) }); } catch (e) { return res.status(400).json({ error: e.message }); } }
    const before = { name: conn.name, mode: conn.mode, settings: JSON.stringify(conn.settings), syncIntervalSec: conn.syncIntervalSec ?? null };
    if (interval !== undefined) { if (interval === null) delete conn.syncIntervalSec; else conn.syncIntervalSec = interval; sync.reschedule(conn); }
    if (name) conn.name = String(name).slice(0, 120);
    if (settings) conn.settings = cleanSettings(C, settings);
    if (credentials) conn.secret = mergeSecrets(C, conn.secret, credentials);
    if (mode === 'live' || mode === 'mock') conn.mode = mode;
    store.save();
    // Only names of changed fields are logged, never credential values.
    const credChanged = Object.entries(credentials || {}).filter(([, v]) => v === null || (typeof v === 'string' && v.trim())).map(([k]) => k);
    audit(req, 'connection.update', { customerId: conn.customerId, target: conn.name, details: {
      ...(before.mode !== conn.mode ? { mode: { from: before.mode, to: conn.mode } } : {}),
      ...(before.name !== conn.name ? { renamed: { from: before.name, to: conn.name } } : {}),
      ...(before.settings !== JSON.stringify(conn.settings) ? { settingsChanged: true } : {}),
      ...(before.syncIntervalSec !== (conn.syncIntervalSec ?? null) ? { syncInterval: { from: before.syncIntervalSec ?? 'default', to: conn.syncIntervalSec ?? 'default' } } : {}),
      ...(credChanged.length ? { credentialsReplaced: credChanged } : {}),
    } });
    await sync.syncOne(conn.id);
    res.json(publicConnection(conn, true));
  });

  // Test with the saved settings, or with unsaved values from the form.
  app.post('/api/connections/:id/test', requireAdmin, requireJson, async (req, res) => {
    const conn = store.connections.find((c) => c.id === req.params.id && inScope(req, c.customerId));
    if (!conn) return res.status(404).json({ error: 'Not found' });
    const C = getConnectorClass(conn.oem);
    const b = req.body || {};
    const badSetting = settingsError(C, b.settings); if (badSetting) return res.json({ ok: false, message: badSetting });
    const draft = { ...conn, mode: b.mode || conn.mode, settings: b.settings ? cleanSettings(C, b.settings) : conn.settings };
    const creds = { ...(conn.secret ? vault.decrypt(conn.secret) : {}) };
    for (const f of C.credentialFields) if (typeof b.credentials?.[f.key] === 'string' && b.credentials[f.key].trim()) creds[f.key] = b.credentials[f.key].trim();
    try {
      const result = await createConnector(draft, draft.mode === 'live' ? creds : {}).testConnection();
      audit(req, 'connection.test', { customerId: conn.customerId, target: conn.name, details: { mode: draft.mode, ok: result.ok } });
      res.json(result);
    } catch (e) {
      audit(req, 'connection.test', { customerId: conn.customerId, target: conn.name, details: { mode: draft.mode, ok: false, error: e.message.slice(0, 200) } });
      res.json({ ok: false, message: e.message });
    }
  });

  app.post('/api/connections/:id/sync', requireAdmin, async (req, res) => {
    const conn = store.connections.find((c) => c.id === req.params.id && inScope(req, c.customerId));
    if (!conn) return res.status(404).json({ error: 'Not found' });
    audit(req, 'connection.sync', { customerId: conn.customerId, target: conn.name });
    try { res.json(await sync.syncOne(conn.id)); } catch (e) { res.status(404).json({ error: e.message }); }
  });

  app.delete('/api/connections/:id', requireAdmin, (req, res) => {
    const i = store.connections.findIndex((c) => c.id === req.params.id && inScope(req, c.customerId));
    if (i < 0) return res.status(404).json({ error: 'Not found' });
    const [conn] = store.connections.splice(i, 1);
    audit(req, 'connection.delete', { customerId: conn.customerId, target: conn.name, details: { oem: conn.oem } });
    inventory.removeConnection(conn.id);
    persistence.deleteSnapshot(conn.id);
    store.save();
    sync.refresh(conn.customerId);
    res.json({ ok: true });
  });

  // --- sync schedule (admin page) ------------------------------------------------
  const syncSchedule = (req) => {
    const allowed = new Set(scope(req));
    const st = store.syncSettings();
    return {
      defaultIntervalSec: sync.defaultIntervalSec(),
      defaultSource: typeof st.defaultIntervalSec === 'number' ? 'admin' : process.env.SYNC_INTERVAL_SECONDS ? 'environment' : 'built-in',
      updatedAt: st.updatedAt || null, updatedBy: st.updatedBy || null,
      limits: { ...SYNC_LIMITS, builtInDefault: SYNC_LIMITS.default }, presets: SYNC_PRESETS,
      concurrency: sync.concurrency, timeoutSec: Math.round(sync.timeoutMs / 1000),
      canEditDefault: isSuperAdmin(req.user),
      connections: store.connections.filter((c) => allowed.has(c.customerId)).map((c) => {
        const info = sync.intervalInfo(c);
        const status = sync.statusFor(c.id);
        return { id: c.id, name: c.name, customerId: c.customerId, customerName: store.customerName(c.customerId), oem: c.oem, oemName: getConnectorClass(c.oem).displayName, mode: c.mode, syncIntervalSec: c.syncIntervalSec ?? null, effectiveSec: info.seconds, source: info.source, minSec: info.min, state: status.state, lastRunAt: status.lastRunAt, nextRunAt: status.nextRunAt, durationMs: status.durationMs, deviceCount: status.deviceCount, failures: status.failures };
      }),
      // Rough vendor API load with these settings: full device pulls per hour.
      pullsPerHour: Math.round(store.connections.filter((c) => allowed.has(c.customerId)).reduce((n, c) => n + 3600 / sync.intervalInfo(c).seconds, 0)),
      estate: { devices: inventory.devices.length, customers: store.customers.length, connections: store.connections.length, builtAt: inventory.builtAt },
      storage: isSuperAdmin(req.user) ? persistence.describe() : undefined,
    };
  };
  app.get('/api/admin/sync', requireAdmin, (req, res) => res.json(syncSchedule(req)));
  app.put('/api/admin/sync', requireSuper, requireJson, (req, res) => {
    const before = sync.defaultIntervalSec();
    let v;
    try { v = cleanInterval(req.body?.defaultIntervalSec, { label: 'Default sync interval' }); } catch (e) { return res.status(400).json({ error: e.message }); }
    store.setSyncSettings({ defaultIntervalSec: v }, req.user.email);
    sync.rescheduleAll();
    audit(req, 'sync.default_interval', { target: 'Sync schedule', details: { from: fmtSeconds(before), to: fmtSeconds(sync.defaultIntervalSec()) } });
    res.json(syncSchedule(req));
  });
  // Per-connection interval (null = follow the default). Admins, for connections they can see.
  app.put('/api/connections/:id/schedule', requireAdmin, requireJson, (req, res) => {
    const conn = store.connections.find((c) => c.id === req.params.id && inScope(req, c.customerId));
    if (!conn) return res.status(404).json({ error: 'Not found' });
    let v;
    try { v = cleanInterval(req.body?.syncIntervalSec, { min: minIntervalFor(conn.oem) }); } catch (e) { return res.status(400).json({ error: e.message }); }
    const before = conn.syncIntervalSec ?? null;
    if (v === null) delete conn.syncIntervalSec; else conn.syncIntervalSec = v;
    store.save();
    sync.reschedule(conn);
    audit(req, 'connection.sync_interval', { customerId: conn.customerId, target: conn.name, details: { from: before ? fmtSeconds(before) : 'default', to: v ? fmtSeconds(v) : 'default' } });
    res.json({ ...syncSchedule(req).connections.find((c) => c.id === conn.id) });
  });

  // --- model and firmware master (super admin maintains, everyone can read) ----
  const modelCounts = (devs) => {
    const counts = new Map();
    for (const d of devs) {
      if (!d.modelId) continue;
      const c = counts.get(d.modelId) || counts.set(d.modelId, { devices: 0, behind: 0 }).get(d.modelId);
      c.devices++; if (d.firmwareStatus === 'behind') c.behind++;
    }
    return counts;
  };
  const modelView = (m, devs, counts = modelCounts(devs)) => {
    const latest = m.releases[0]?.version ?? null;
    const c = counts.get(m.id) || { devices: 0, behind: 0 };
    return { ...m, latest, devices: c.devices, behind: c.behind };
  };
  app.get('/api/models', requireUser, (req, res) => {
    const devs = inventory.query(scope(req));
    const uncatalogued = new Map();
    for (const d of devs) {
      if (d.modelId) continue;
      const k = `${d.make}|${d.model}`;
      if (!uncatalogued.has(k)) uncatalogued.set(k, { make: d.make, model: d.model, deviceType: d.deviceType, oems: new Set(), devices: 0 });
      const u = uncatalogued.get(k); u.devices++; d.oems.forEach((o) => u.oems.add(o));
    }
    res.json({
      models: (() => { const counts = modelCounts(devs); return store.models.map((m) => modelView(m, devs, counts)); })().sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model)),
      uncatalogued: [...uncatalogued.values()].map((u) => ({ ...u, oems: [...u.oems] })).sort((a, b) => b.devices - a.devices),
    });
  });
  const modelAction = (fn, action) => (req, res) => {
    try {
      const m = fn(req);
      audit(req, action, { target: `${m.make} ${m.model}`, details: req.body && Object.keys(req.body).length ? { ...req.body } : undefined });
      sync.refresh();
      res.json(modelView(m, inventory.devices));
    } catch (e) { res.status(400).json({ error: e.message }); }
  };
  app.post('/api/models', requireSuper, requireJson, modelAction((req) => store.createModel(req.body || {}), 'model.create'));
  app.put('/api/models/:id', requireSuper, requireJson, modelAction((req) => store.updateModel(req.params.id, req.body || {}), 'model.update'));
  app.delete('/api/models/:id', requireSuper, modelAction((req) => store.deleteModel(req.params.id), 'model.delete'));
  app.post('/api/models/:id/releases', requireSuper, requireJson, modelAction((req) => store.addRelease(req.params.id, req.body || {}), 'model.release_add'));
  app.delete('/api/models/:id/releases/:version', requireSuper, modelAction((req) => store.removeRelease(req.params.id, req.params.version), 'model.release_remove'));
  // Add models seen in the estate that are not catalogued yet.
  app.post('/api/models/import', requireSuper, requireJson, (req, res) => {
    const wanted = Array.isArray(req.body?.models) ? req.body.models : null;
    const added = [];
    const seen = new Set();
    for (const d of inventory.devices) {
      if (d.modelId || seen.has(`${d.make}|${d.model}`)) continue;
      seen.add(`${d.make}|${d.model}`);
      if (wanted && !wanted.some((w) => w.make === d.make && w.model === d.model)) continue;
      try { added.push(store.createModel({ make: d.make, model: d.model, deviceType: d.deviceType, monitoredBy: d.oems })); } catch { /* already there */ }
    }
    if (added.length) audit(req, 'model.import', { target: `${added.length} models`, details: { models: added.map((m) => `${m.make} ${m.model}`) } });
    sync.refresh();
    res.json({ added: added.length });
  });

  // --- lifecycle: firmware compliance, warranty, end of sale / support / life --
  app.get('/api/lifecycle', requireUser, (req, res) => {
    const ids = req.query.customer ? scope(req).filter((id) => String(req.query.customer).split(',').includes(id)) : scope(req);
    res.json(inventory.lifecycle(inventory.query(scope(req), req.query), ids));
  });

  // --- baseline standards: provider advisory + per-customer (versioned) -----
  const versionSummary = (v) => ({ version: v.version, level: v.level, exceptions: Object.keys(v.models || {}).length, policy: v.policy, note: v.note, restoredFrom: v.restoredFrom ?? null, advisoryVersion: v.advisoryVersion ?? null, createdAt: v.createdAt, createdBy: v.createdBy?.email ?? null });
  app.get('/api/baselines/advisory', requireUser, (_req, res) => res.json({
    version: store.advisoryVersion(), policy: store.advisoryPolicy(), levels: LEVELS, lifecycleLimits: LIFECYCLE_LIMITS,
    versions: store.advisoryVersions().map((v) => ({ version: v.version, policy: v.policy, note: v.note, createdAt: v.createdAt, createdBy: v.createdBy?.email ?? null })).reverse(),
  }));
  app.put('/api/baselines/advisory', requireSuper, requireJson, (req, res) => {
    try {
      const before = store.advisoryPolicy();
      const v = store.saveAdvisoryPolicy(req.body || {}, actorOf(req.user));
      audit(req, 'baseline.advisory_save', { target: `Advisory baseline v${v.version}`, details: { from: before, to: v.policy, note: v.note } });
      sync.refresh();
      res.json(v);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  const customerBaselineView = (customerId, version = null) => {
    const versions = store.customerBaselineVersions(customerId);
    const cb = version === null ? versions.at(-1) ?? null : versions.find((v) => v.version === version) ?? null;
    const devs = inventory.forCustomer(customerId);
    const models = store.models.map((m) => {
      const mine = devs.filter((d) => d.modelId === m.id);
      const fw = resolveFirmware(m, cb);
      const behind = (t) => (t ? mine.filter((d) => d.firmware && compareVersions(d.firmware, t) < 0).length : 0);
      return {
        id: m.id, make: m.make, model: m.model, deviceType: m.deviceType, releases: m.releases.map((r) => r.version),
        rule: cb?.models?.[m.id] ?? null, ...fw, devices: mine.length, behind: behind(fw.target), behindAdvisory: behind(fw.advisory),
      };
    }).sort((a, b) => (b.devices > 0) - (a.devices > 0) || (a.make + a.model).localeCompare(b.make + b.model));
    return {
      customerId, customerName: store.customerName(customerId),
      current: cb ? versionSummary(cb) : { version: 0, level: 'advisory', exceptions: 0, policy: null, note: 'Following the advisory baseline (default)', createdAt: null, createdBy: null },
      latestVersion: versions.at(-1)?.version ?? 0,
      policy: cb?.policy || store.advisoryPolicy(), policySource: cb?.policy ? 'customer' : 'advisory',
      advisory: { version: store.advisoryVersion(), policy: store.advisoryPolicy() },
      levels: LEVELS, lifecycleLimits: LIFECYCLE_LIMITS,
      versions: versions.map(versionSummary).reverse(),
      models,
    };
  };
  app.get('/api/baselines/customers/:id', requireUser, (req, res) => {
    if (!inScope(req, req.params.id)) return res.status(404).json({ error: 'Customer not found' });
    const v = req.query.version !== undefined ? Number(req.query.version) : null;
    res.json(customerBaselineView(req.params.id, Number.isInteger(v) ? v : null));
  });
  app.post('/api/baselines/customers/:id', requireAdmin, requireJson, (req, res) => {
    if (!inScope(req, req.params.id)) return res.status(404).json({ error: 'Customer not found' });
    try {
      const v = store.saveCustomerBaseline(req.params.id, req.body || {}, actorOf(req.user));
      audit(req, 'baseline.customer_save', { customerId: req.params.id, target: `${store.customerName(req.params.id)} baseline v${v.version}`, details: { level: v.level, exceptions: v.models, policy: v.policy || 'advisory', note: v.note } });
      sync.refresh(req.params.id);
      res.json(customerBaselineView(req.params.id));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/baselines/customers/:id/restore', requireAdmin, requireJson, (req, res) => {
    if (!inScope(req, req.params.id)) return res.status(404).json({ error: 'Customer not found' });
    try {
      const v = store.restoreCustomerBaseline(req.params.id, req.body?.version, actorOf(req.user));
      audit(req, 'baseline.customer_restore', { customerId: req.params.id, target: `${store.customerName(req.params.id)} baseline v${v.version}`, details: { restoredFrom: v.restoredFrom } });
      sync.refresh(req.params.id);
      res.json(customerBaselineView(req.params.id));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // --- SLA ----------------------------------------------------------------
  app.get('/api/sla', requireUser, (req, res) => {
    const window = WINDOWS[req.query.window] ? req.query.window : '7d';
    res.json(slaReport(history, inventory.query(scope(req), req.query), { window, targetFor: (id) => store.slaTarget(id) }));
  });

  // --- audit log (admins) ---------------------------------------------------
  const auditQuery = (req) => {
    const q = req.query;
    const acting = req.session.actingCustomerId;
    const from = q.from ? Date.parse(q.from) : null;
    const to = q.to ? Date.parse(q.to) + (String(q.to).length === 10 ? 86_400_000 : 0) : null;
    const text = q.q ? String(q.q).toLowerCase() : null;
    return store.data.audit.filter((e) => {
      if (acting && e.customerId !== acting) return false;
      if (q.customer && e.customerId !== q.customer) return false;
      if (q.action && !e.action.startsWith(String(q.action))) return false;
      if (q.actor && !String(e.actor?.email || '').toLowerCase().includes(String(q.actor).toLowerCase())) return false;
      const t = Date.parse(e.at);
      if (from && t < from) return false;
      if (to && t >= to) return false;
      if (text && ![e.action, e.target, e.actor?.email, e.actor?.name, JSON.stringify(e.details || '')].some((x) => x && String(x).toLowerCase().includes(text))) return false;
      return true;
    }).map((e) => ({ ...e, customerName: e.customerId ? store.customerName(e.customerId) : null }));
  };
  app.get('/api/audit', requireAdmin, (req, res) => {
    const rows = auditQuery(req);
    const limit = Math.min(Number(req.query.limit) || 300, 2000);
    res.json({ total: rows.length, entries: rows.slice(0, limit), actions: [...new Set(store.data.audit.map((e) => e.action))].sort() });
  });
  app.get('/api/audit.csv', requireAdmin, (req, res) => {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['Time (UTC)', 'User', 'Role', 'Action', 'Target', 'Customer', 'Acting as customer', 'IP', 'Details'];
    const lines = auditQuery(req).map((e) => [e.at, e.actor?.email, e.actor?.role, e.action, e.target, e.customerName, e.actingCustomerId ? store.customerName(e.actingCustomerId) : '', e.ip, e.details].map(cell).join(','));
    audit(req, 'audit.export', { details: { rows: lines.length } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send([head.map(cell).join(','), ...lines].join('\r\n'));
  });

  app.get('/api/customers', requireUser, (req, res) => {
    const allowed = new Set(scope(req));
    res.json(store.customers.filter((c) => allowed.has(c.id)));
  });

  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  if (autoStart) { sync.start(); apiTracker.start(); }
  return { app, store, sync, inventory, vault, history, apiTracker };
}

/** Start the server: Postgres when DATABASE_URL is set, otherwise JSON files in the data folder. */
export async function startServer({ port = Number(process.env.PORT || 8080) } = {}) {
  const dataDir = path.resolve(ROOT, process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || 'data');
  const persistence = await openPersistence({ dataDir });
  const ctx = createApp({ dataDir, persistence });
  console.log(`[storage] ${persistence.kind === 'postgres' ? `Postgres (${persistence.describe().location || 'DATABASE_URL'})` : `files in ${dataDir}`}`);
  const server = ctx.app.listen(port, () => console.log(`Device monitor running on http://localhost:${port}`));
  // Write everything out before the platform stops the process (deploys, restarts).
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal}: saving data`);
    ctx.sync.stop(); ctx.apiTracker.stop?.();
    try { ctx.store.flush(); ctx.history.flush(); await persistence.close(); } catch (e) { console.error(`[shutdown] ${e.message}`); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { ...ctx, server };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((e) => { console.error(`[start] ${e.message}`); process.exit(1); });
}
