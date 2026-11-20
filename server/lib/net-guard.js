// Outbound request guard (SSRF). Connector URLs (Token URL, GraphQL URL, API
// base URL...) are editable by admins, so a bad value must not let the server
// call its own internal network: loopback, private ranges, link-local (cloud
// metadata), the hosting provider's private network (*.internal) and so on.
// Set ALLOW_PRIVATE_API_HOSTS=true only for an on-premises install that really
// has to reach a vendor server on a private address.
import dns from 'node:dns';
import net from 'node:net';

const allowPrivate = () => process.env.ALLOW_PRIVATE_API_HOSTS === 'true';

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** True for any address the server must not call: loopback, private, link-local, CGNAT, multicast, reserved. */
export function isPrivateAddress(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(s)) return v4Private(s);
  if (net.isIPv6(s)) {
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return v4Private(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) return true; // mapped v4 in hex form
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
  }
  return false;
}

/** Hostnames that are internal by name, or private IP literals. */
export function isBlockedHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || /\.(localhost|local|internal|intranet|lan|home\.arpa)$/.test(h) || h === 'metadata' || h === 'metadata.google.internal') return true;
  return isPrivateAddress(h);
}

/** Throws when the URL points at an internal address (by name or after DNS lookup). */
export async function assertPublicUrl(url) {
  if (allowPrivate()) return;
  const u = new URL(String(url));
  if (isBlockedHost(u.hostname)) throw new Error(`Refusing to call ${u.hostname}: internal and private addresses are not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch { return; } // fetch reports the DNS failure itself
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`Refusing to call ${u.hostname}: it resolves to an internal address`);
}

/** dns.lookup replacement for https.request: checks the address actually connected to (no DNS rebinding). */
export function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    if (!allowPrivate()) {
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (list.some(isPrivateAddress)) return cb(new Error(`Refusing to call ${hostname}: it resolves to an internal address`));
    }
    cb(null, address, family);
  });
}
