// Shared HTTP helpers for the REST/JSON connectors (Yealink, Neat, Crestron,
// Q-SYS, Domotz, BrightSign, Sony). Each connector still has its own transport
// class; these only remove the repeated fetch, error and token code.
import { trackedFetch } from '../lib/api-calls.js';

/**
 * Call a JSON API and return the parsed body. Throws an Error whose message
 * says what to fix (bad credentials, missing permission, rate limit).
 */
export async function requestJson(url, { method = 'GET', headers = {}, body, vendor = 'The API', fetchImpl = trackedFetch, hint401, hint403, form = false } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers } };
  if (body !== undefined) {
    init.body = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
    init.headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  let res;
  try {
    res = await fetchImpl(String(url), init);
  } catch (e) {
    throw new Error(`${vendor} could not be reached (${e.cause?.code || e.message})`);
  }
  if (res.status === 401) throw new Error(`${vendor} returned 401: ${hint401 || 'the credentials are wrong or expired.'}`);
  if (res.status === 403) throw new Error(`${vendor} returned 403: ${hint403 || 'the key does not have permission for this call.'}`);
  if (res.status === 404) throw new Error(`${vendor} returned 404: check the account, organisation or ID in the settings.`);
  if (res.status === 429) throw new Error(`${vendor} rate limit reached. The next sync will try again.`);
  if (!res.ok) throw new Error(`${vendor} API error (HTTP ${res.status})`);
  if (res.status === 204) return {};
  const text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Error(`${vendor} returned something that is not JSON`); }
}

/** Caches an OAuth access token until a minute before it expires. */
export class TokenCache {
  constructor(fetchToken) { this.fetchToken = fetchToken; this.token = null; this.expires = 0; this.pending = null; }
  async get() {
    if (this.token && Date.now() < this.expires - 60_000) return this.token;
    if (!this.pending) {
      this.pending = this.fetchToken().then(({ token, expiresIn }) => {
        this.token = token; this.expires = Date.now() + (Number(expiresIn) || 3600) * 1000; return token;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }
  clear() { this.token = null; this.expires = 0; }
}

export const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/** First value that is set, so a mapping survives small differences in field names. */
export const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? null;

/** Accept a bare array or the usual wrappers ({items}, {data}, {results}...). */
export function listOf(body, ...keys) {
  if (Array.isArray(body)) return body;
  for (const k of [...keys, 'items', 'data', 'results', 'devices', 'endpoints', 'rooms']) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

/** "00-10-7f-9c-c8-61_-1" or "00107F9CC861" to "00:10:7f:9c:c8:61"; null when it is not a MAC. */
export function macFrom(v) {
  const hex = String(v || '').split('_')[0].replace(/[^a-f0-9]/gi, '');
  return hex.length === 12 ? hex.toLowerCase().match(/../g).join(':') : null;
}
