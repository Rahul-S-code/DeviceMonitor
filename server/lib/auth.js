// Local sign-in with scrypt-hashed passwords and HttpOnly session cookies.
// Microsoft Entra ID sign-in is a later phase; it will plug in by issuing the
// same session after an OIDC callback.
import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32);
  const want = Buffer.from(hash, 'base64');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}

const SESSION_TTL = 12 * 3600 * 1000;
export const COOKIE = 'dm_session';

export class Sessions {
  constructor() { this.map = new Map(); }
  create(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.map.set(token, { userId, exp: Date.now() + SESSION_TTL });
    return token;
  }
  get(token) {
    const s = token && this.map.get(token);
    if (!s) return null;
    if (s.exp < Date.now()) { this.map.delete(token); return null; }
    return s;
  }
  destroy(token) { this.map.delete(token); }
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

/** Customer ids a user may see. Provider admins see all; customer users see only their own. */
export function allowedCustomers(user, store) {
  if (!user) return [];
  if (user.role === 'provider_admin') return store.customers.map((c) => c.id);
  return user.customerId ? [user.customerId] : [];
}
