// API tracker: every external API this tool depends on, how it is being used,
// and how it is performing.
//
// Three kinds of evidence per endpoint:
//   - calls:  real connector traffic since the server started (live mode only)
//   - checks: reachability probes run on a schedule or by the super admin.
//             A probe is an unauthenticated request; any HTTP answer below 500
//             means the service is up (401/403/405 are expected without a token).
//   - connections: an authenticated test of each customer connection that
//             uses the API, run with the same check.
import { CONNECTORS, createConnector } from '../connectors/registry.js';
import { registerEndpoints, callStats } from '../lib/api-calls.js';

const KEEP_CHECKS = 48;
const TIMEOUT_MS = 8000;
const SLOW_MS = 1500;
const UA = 'EstateMonitor-APICheck/1.0 (+https://github.com/Rahul-S-code/DeviceMonitor)';

const tileProbe = (url) => url.replace('{s}', 'a').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0').replace('{r}', '');

/** The catalogue: connector endpoints, map tiles and browser-side services. */
export function apiCatalogue(mapLayers = []) {
  const list = [];
  for (const C of CONNECTORS) {
    for (const a of C.apis) {
      list.push({
        ...a,
        group: C.kind === 'platform' ? 'Meeting platform APIs' : 'OEM device clouds',
        provider: C.displayName,
        oem: C.oem,
        docsUrl: C.docsUrl,
        usedFor: 'Device sync',
        calledFrom: 'Server',
        probe: a.availability ? null : a.probe || a.url?.split('{')[0].replace(/\/$/, ''),
      });
    }
  }
  for (const l of mapLayers) {
    list.push({
      id: `map-${l.id}`, name: `${l.name} map tiles`, method: 'GET', url: l.url, probe: tileProbe(l.url), group: 'Map and browser', provider: l.name,
      purpose: 'Background map on the Map page', auth: 'None', calledFrom: 'Browser', usedFor: 'Map',
      docsUrl: l.id === 'osm' ? 'https://operations.osmfoundation.org/policies/tiles/' : l.id === 'carto-light' ? 'https://github.com/CartoDB/basemap-styles' : null,
    });
  }
  list.push({
    id: 'google-fonts', name: 'Google Fonts', method: 'GET', url: 'https://fonts.googleapis.com/css2?family=Manrope', probe: 'https://fonts.googleapis.com/css2?family=Manrope', group: 'Map and browser', provider: 'Google',
    purpose: 'The Manrope typeface. The app falls back to system fonts if it is down', auth: 'None', calledFrom: 'Browser', usedFor: 'Fonts', docsUrl: 'https://developers.google.com/fonts/docs/css2',
  });
  return list;
}

/** Probe one URL without credentials. Never throws. */
export async function probe(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - started;
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    if (res.status >= 500) return { ok: false, ms, status: res.status, note: `Server error (HTTP ${res.status})` };
    return { ok: true, ms, status: res.status, note: res.status === 401 || res.status === 403 ? 'Reachable. Asked for credentials, as expected' : res.status === 405 ? 'Reachable. Method not allowed without a request body, as expected' : null };
  } catch (e) {
    const ms = Date.now() - started;
    const code = e.cause?.code || e.code || e.name;
    // mTLS APIs (Logitech Sync) can end the handshake when no client certificate is sent: the service is still up.
    if (/CERTIFICATE_REQUIRED|HANDSHAKE_FAILURE|ALERT_BAD_CERTIFICATE/i.test(String(code)) || /certificate required/i.test(e.cause?.message || '')) {
      return { ok: true, ms, status: null, note: 'Reachable. Asked for the client certificate, as expected' };
    }
    const why = code === 'TimeoutError' || code === 'AbortError' ? `No answer within ${timeoutMs / 1000} s`
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'DNS lookup failed'
        : code === 'ECONNREFUSED' ? 'Connection refused'
          : code === 'ECONNRESET' ? 'Connection reset'
            : /CERT|SSL|TLS/i.test(String(code)) ? `TLS error (${code})`
              : e.cause?.message || e.message;
    return { ok: false, ms, status: null, note: why };
  }
}

const percentile = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

export class ApiTracker {
  constructor({ store, sync, mapLayers = [], fetchImpl = fetch, intervalMinutes = 30 }) {
    Object.assign(this, { store, sync, fetchImpl, intervalMinutes });
    this.catalogue = apiCatalogue(mapLayers);
    registerEndpoints(this.catalogue);
    this.connTests = new Map(); // connectionId -> { at, ok, ms, message }
    this.running = null;
    this.lastRunAt = null;
    this.timer = null;
  }

  get checks() { return this.store.data.apiChecks; }

  /** Run the checks (all, or one endpoint). Concurrent callers share one run. */
  async check({ id = null, actor = 'schedule' } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      const targets = this.catalogue.filter((a) => a.probe && (!id || a.id === id));
      if (id && !targets.length) throw new Error('That API has nothing to check');
      const at = new Date().toISOString();
      await Promise.all(targets.map(async (a) => {
        const r = await probe(a.probe, { fetchImpl: this.fetchImpl });
        const list = this.checks[a.id] || (this.checks[a.id] = []);
        list.unshift({ at, by: actor, ...r });
        list.length = Math.min(list.length, KEEP_CHECKS);
      }));
      // Authenticated test of every connection that uses the checked APIs.
      const oems = new Set(targets.map((a) => a.oem).filter(Boolean));
      await Promise.all(this.store.connections.filter((c) => oems.has(c.oem)).map(async (c) => {
        const started = Date.now();
        try {
          const creds = c.mode === 'live' ? this.sync.vault.decrypt(c.secret) : {};
          const r = await Promise.race([
            createConnector(c, creds).testConnection(),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`No answer within ${2 * TIMEOUT_MS / 1000} s`)), 2 * TIMEOUT_MS).unref?.()),
          ]);
          this.connTests.set(c.id, { at, ok: !!r.ok, ms: Date.now() - started, message: r.message });
        } catch (e) {
          this.connTests.set(c.id, { at, ok: false, ms: Date.now() - started, message: e.message });
        }
      }));
      this.lastRunAt = at;
      this.store.save();
      return this.report();
    })();
    try { return await this.running; } finally { this.running = null; }
  }

  report() {
    const conns = this.store.connections;
    const apis = this.catalogue.map((a) => {
      const checks = this.checks[a.id] || [];
      const latest = checks[0] || null;
      const okMs = checks.filter((c) => c.ok).map((c) => c.ms);
      const using = conns.filter((c) => c.oem === a.oem).map((c) => {
        const st = this.sync.statusFor(c.id);
        return {
          id: c.id, name: c.name, customerId: c.customerId, customerName: this.store.customerName(c.customerId), mode: c.mode,
          sync: { state: st.state, lastSuccessAt: st.lastSuccessAt, durationMs: st.durationMs, error: st.error },
          test: this.connTests.get(c.id) || null,
        };
      });
      const calls = callStats(a.id);
      let state;
      if (a.availability === 'retired') state = 'retired';
      else if (a.availability === 'none') state = 'no-api';
      else if (!latest) state = 'unchecked';
      else if (!latest.ok) state = 'down';
      else if (latest.ms > SLOW_MS) state = 'slow';
      else state = 'up';
      const { probe: probeUrl, ...rest } = a;
      return {
        ...rest, probeUrl, state, latest,
        checks: checks.slice(0, 24).map(({ at, ok, ms, status }) => ({ at, ok, ms, status })),
        uptime: checks.length ? Math.round((checks.filter((c) => c.ok).length / checks.length) * 1000) / 10 : null,
        avgMs: okMs.length ? Math.round(okMs.reduce((x, y) => x + y, 0) / okMs.length) : null,
        p95Ms: percentile(okMs, 95),
        connections: using,
        live: using.filter((c) => c.mode === 'live').length,
        mock: using.filter((c) => c.mode !== 'live').length,
        calls,
      };
    });
    const count = (s) => apis.filter((a) => a.state === s).length;
    return {
      lastRunAt: this.lastRunAt || apis.map((a) => a.latest?.at).filter(Boolean).sort().pop() || null,
      running: !!this.running,
      intervalMinutes: this.intervalMinutes,
      slowMs: SLOW_MS,
      summary: { total: apis.length, up: count('up'), slow: count('slow'), down: count('down'), unchecked: count('unchecked'), unavailable: count('retired') + count('no-api') },
      apis,
    };
  }

  start() {
    if (!this.intervalMinutes) return;
    const run = () => this.check().catch((e) => console.error(`[api-check] ${e.message}`));
    this.first = setTimeout(run, 60_000);
    this.timer = setInterval(run, this.intervalMinutes * 60_000);
    this.first.unref?.(); this.timer.unref?.();
  }

  stop() { clearTimeout(this.first); clearInterval(this.timer); }
}
