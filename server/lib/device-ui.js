// "Open device UI": a link to a device's own web interface on the customer's network.
// The address is the one an admin set on the device, else https://<IP the vendor reports>/.
// The browser opens it directly, so it only works from a computer that can reach the
// device (same network or VPN); Estate Monitor never proxies it.

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+(%[0-9a-z]+)?$/i;

/** A device UI address typed by an admin: http(s) only, no user name or password in it. */
export function cleanWebUrl(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  let s = String(v).trim().slice(0, 300);
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('Device UI address must be a web address, for example https://10.0.4.21/ or http://10.0.4.21:8080/'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Device UI address must start with http:// or https://');
  if (u.username || u.password) throw new Error('Leave the user name and password out of the device UI address');
  return u.toString();
}

/** The address to open for a device, or null when there is none. */
export function deviceUi(d) {
  if (d.webUrl) return { url: d.webUrl, source: 'manual' };
  const ip = String(d.ip || '').trim();
  if (IPV4.test(ip)) return { url: `https://${ip}/`, source: 'ip' };
  if (ip.includes(':') && IPV6.test(ip)) return { url: `https://[${ip.replace(/%/g, '%25')}]/`, source: 'ip' };
  return null;
}
