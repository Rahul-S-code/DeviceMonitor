// Where Estate Monitor keeps its data.
//
//   FilePersistence      JSON files in DATA_DIR (default). Fine for a demo or a
//                        small estate on one instance with a disk or volume.
//   PgPersistence        Postgres, used when DATABASE_URL is set. Configuration
//                        is stored per section and only changed sections are
//                        written; health history is upserted per device; each
//                        connection's latest device snapshot is kept so a restart
//                        does not have to pull every vendor API again.
//
// Both expose the same synchronous interface to the rest of the app: data is
// loaded once at start-up (Postgres loads asynchronously before the app is
// created) and writes are queued, so request handlers never wait on storage.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha1').update(s).digest('base64');

export class FilePersistence {
  constructor(dataDir) {
    this.kind = 'file';
    this.dir = dataDir;
    this.storeFile = path.join(dataDir, 'store.json');
    this.historyFile = path.join(dataDir, 'history.json');
    this.snapDir = path.join(dataDir, 'snapshots');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  describe() { return { kind: 'file', location: this.dir }; }

  loadStore() {
    return fs.existsSync(this.storeFile) ? JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) : null;
  }

  saveStore(data) { writeAtomic(this.storeFile, JSON.stringify(data), 0o600); }

  loadHistory() {
    try { return JSON.parse(fs.readFileSync(this.historyFile, 'utf8')).devices || {}; } catch { return {}; }
  }

  // The file backend rewrites the whole history; `dirty` and `removed` are for incremental backends.
  saveHistory(devices) {
    try { writeAtomic(this.historyFile, JSON.stringify({ devices })); } catch (e) { console.error(`[history] could not save: ${e.message}`); }
  }

  loadSnapshots() {
    let files = [];
    try { files = fs.readdirSync(this.snapDir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.snapDir, f), 'utf8'))); } catch { /* skip a damaged snapshot; the next sync replaces it */ }
    }
    return out;
  }

  saveSnapshot(snap) {
    try {
      fs.mkdirSync(this.snapDir, { recursive: true });
      writeAtomic(path.join(this.snapDir, `${safeName(snap.connectionId)}.json`), JSON.stringify(snap), 0o600);
    } catch (e) { console.error(`[snapshots] could not save: ${e.message}`); }
  }

  deleteSnapshot(connectionId) {
    try { fs.unlinkSync(path.join(this.snapDir, `${safeName(connectionId)}.json`)); } catch { /* not there */ }
  }

  async flush() {}
  async close() {}
}

export class PgPersistence {
  /** Connect, create tables if needed, and load everything the app reads at start-up. */
  static async connect(url, { pool = null, importFrom = null } = {}) {
    const { default: pg } = await import('pg');
    const p = pool || new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX) || 5 });
    const self = new PgPersistence(p);
    await self.migrate();
    await self.load();
    // First start on an empty database: bring over an existing file store, if any.
    if (!self.storeData && importFrom) await self.importFiles(importFrom);
    return self;
  }

  constructor(pool) {
    this.kind = 'postgres';
    this.pool = pool;
    this.queue = Promise.resolve();
    this.sectionHash = new Map();
    this.historyHash = new Map();
    this.storeData = null;
    this.history = {};
    this.snapshots = [];
    this.errors = 0;
  }

  describe() {
    const o = this.pool.options || {};
    let host = null;
    try { host = new URL(o.connectionString).hostname; } catch { /* no URL */ }
    return { kind: 'postgres', location: host };
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (section text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS device_history (device_id text PRIMARY KEY, data jsonb NOT NULL, seen_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS device_history_seen ON device_history (seen_at);
      CREATE TABLE IF NOT EXISTS connection_snapshots (connection_id text PRIMARY KEY, customer_id text, hash text, synced_at timestamptz, device_count int, devices jsonb NOT NULL);
    `);
  }

  async load() {
    const st = await this.pool.query('SELECT section, data FROM app_state');
    if (st.rows.length) {
      this.storeData = {};
      for (const r of st.rows) { this.storeData[r.section] = r.data; this.sectionHash.set(r.section, sha(JSON.stringify(r.data))); }
    }
    const h = await this.pool.query('SELECT device_id, data FROM device_history');
    for (const r of h.rows) { this.history[r.device_id] = r.data; this.historyHash.set(r.device_id, sha(JSON.stringify(r.data))); }
    const s = await this.pool.query('SELECT connection_id, customer_id, hash, synced_at, devices FROM connection_snapshots');
    this.snapshots = s.rows.map((r) => ({ connectionId: r.connection_id, customerId: r.customer_id, hash: r.hash, syncedAt: r.synced_at?.toISOString?.() ?? r.synced_at, devices: r.devices }));
  }

  async importFiles(dataDir) {
    const f = new FilePersistence(dataDir);
    const data = f.loadStore();
    if (!data) return;
    console.log(`[postgres] importing the existing file store from ${dataDir}`);
    this.storeData = data;
    this.saveStore(data);
    this.history = f.loadHistory();
    this.saveHistory(this.history, Object.keys(this.history), []);
    this.snapshots = f.loadSnapshots();
    for (const s of this.snapshots) this.saveSnapshot(s);
    await this.flush();
  }

  /** Run writes one after another; a failed write is logged and the next one still runs. */
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => { this.errors++; console.error(`[postgres] write failed: ${e.message}`); });
    return this.queue;
  }

  loadStore() { return this.storeData; }

  /** Write only the sections that changed since the last write. */
  saveStore(data) {
    const changed = [];
    for (const [k, v] of Object.entries(data)) {
      const json = JSON.stringify(v ?? null);
      const h = sha(json);
      if (this.sectionHash.get(k) === h) continue;
      this.sectionHash.set(k, h);
      changed.push([k, json]);
    }
    if (!changed.length) return;
    this.enqueue(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const [k, json] of changed) await client.query('INSERT INTO app_state (section, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (section) DO UPDATE SET data = EXCLUDED.data, updated_at = now()', [k, json]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    });
  }

  loadHistory() { return this.history; }

  /** Upsert the devices whose history changed, delete the ones pruned away. */
  saveHistory(devices, dirty = Object.keys(devices), removed = []) {
    const rows = [];
    for (const id of dirty) {
      const e = devices[id];
      if (!e) continue;
      const json = JSON.stringify(e);
      const h = sha(json);
      if (this.historyHash.get(id) === h) continue;
      this.historyHash.set(id, h);
      rows.push([id, json, new Date(e.seen ?? e.since ?? Date.now()).toISOString()]);
    }
    for (const id of removed) this.historyHash.delete(id);
    if (!rows.length && !removed.length) return;
    this.enqueue(async () => {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        await this.pool.query(
          `INSERT INTO device_history (device_id, data, seen_at) SELECT * FROM unnest($1::text[], $2::jsonb[], $3::timestamptz[])
           ON CONFLICT (device_id) DO UPDATE SET data = EXCLUDED.data, seen_at = EXCLUDED.seen_at`,
          [chunk.map((r) => r[0]), chunk.map((r) => r[1]), chunk.map((r) => r[2])],
        );
      }
      for (let i = 0; i < removed.length; i += 1000) await this.pool.query('DELETE FROM device_history WHERE device_id = ANY($1::text[])', [removed.slice(i, i + 1000)]);
    });
  }

  loadSnapshots() { return this.snapshots; }

  saveSnapshot(snap) {
    this.enqueue(() => this.pool.query(
      `INSERT INTO connection_snapshots (connection_id, customer_id, hash, synced_at, device_count, devices) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (connection_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, hash = EXCLUDED.hash, synced_at = EXCLUDED.synced_at, device_count = EXCLUDED.device_count, devices = EXCLUDED.devices`,
      [snap.connectionId, snap.customerId, snap.hash, snap.syncedAt, snap.devices.length, JSON.stringify(snap.devices)],
    ));
  }

  deleteSnapshot(connectionId) {
    this.enqueue(() => this.pool.query('DELETE FROM connection_snapshots WHERE connection_id = $1', [connectionId]));
  }

  /** Wait for every queued write. */
  async flush() { await this.queue; }

  async close() { await this.flush(); await this.pool.end(); }
}

/** Postgres when DATABASE_URL is set, otherwise JSON files in dataDir. */
export async function openPersistence({ dataDir, databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) return new FilePersistence(dataDir);
  return PgPersistence.connect(databaseUrl, { importFrom: dataDir });
}

function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function safeName(id) { return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_'); }
