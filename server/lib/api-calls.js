// Counts the real outbound API calls the connectors make (live mode only),
// so the API tracker can show call volume, errors and latency per endpoint.
// In memory: the figures cover the time since the server last started.

const stats = new Map(); // url prefix -> stats
let prefixes = []; // [{ prefix, id }] longest first

/** Tell the recorder which endpoint each URL belongs to. */
export function registerEndpoints(list) {
  prefixes = list.filter((x) => x.url).map((x) => ({ id: x.id, prefix: x.url.split('{')[0] })).sort((a, b) => b.prefix.length - a.prefix.length);
}

function endpointFor(url) {
  const u = String(url);
  const hit = prefixes.find((p) => u.startsWith(p.prefix));
  if (hit) return hit.id;
  try { return `host:${new URL(u).host}`; } catch { return 'unknown'; }
}

export function recordCall(url, { status = null, ms = 0, error = null } = {}) {
  const id = endpointFor(url);
  const s = stats.get(id) || { calls: 0, errors: 0, totalMs: 0, lastAt: null, lastStatus: null, lastError: null, lastMs: null, lastOkAt: null };
  const failed = !!error || !status || status >= 400;
  s.calls++; s.totalMs += ms; s.lastAt = new Date().toISOString(); s.lastStatus = status; s.lastMs = ms;
  if (failed) { s.errors++; s.lastError = error || `HTTP ${status}`; } else { s.lastOkAt = s.lastAt; s.lastError = null; }
  stats.set(id, s);
}

export function callStats(id) {
  const s = stats.get(id);
  return s ? { ...s, avgMs: s.calls ? Math.round(s.totalMs / s.calls) : null, totalMs: undefined } : null;
}

export function resetCallStats() { stats.clear(); }

/** fetch() that records each call. Connectors use it for their live transports. */
export async function trackedFetch(url, opts) {
  const started = Date.now();
  try {
    const res = await fetch(url, opts);
    recordCall(url, { status: res.status, ms: Date.now() - started });
    return res;
  } catch (e) {
    recordCall(url, { ms: Date.now() - started, error: e.cause?.code || e.message });
    throw e;
  }
}
