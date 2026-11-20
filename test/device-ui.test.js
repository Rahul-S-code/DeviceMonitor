// "Open device UI": the address, the override, permissions and the audit entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { deviceUi, cleanWebUrl } from '../server/lib/device-ui.js';

test('device UI address: from the reported IP, or set by hand (http/https only)', () => {
  assert.deepEqual(deviceUi({ ip: '10.0.4.21' }), { url: 'https://10.0.4.21/', source: 'ip' });
  assert.equal(deviceUi({ ip: 'fe80::1' }).url, 'https://[fe80::1]/');
  assert.equal(deviceUi({ ip: 'javascript:alert(1)' }), null);
  assert.equal(deviceUi({ ip: null }), null);
  assert.deepEqual(deviceUi({ ip: '10.0.4.21', webUrl: 'http://10.0.4.21:8080/' }), { url: 'http://10.0.4.21:8080/', source: 'manual' });
  assert.equal(cleanWebUrl('10.1.1.1:8443'), 'https://10.1.1.1:8443/');
  assert.equal(cleanWebUrl(''), null);
  assert.throws(() => cleanWebUrl('javascript:alert(1)'));
  assert.throws(() => cleanWebUrl('ftp://10.1.1.1/'));
  assert.throws(() => cleanWebUrl('https://admin:pw@10.1.1.1/'));
});

test('technical users open the device UI and it is audited; end users cannot', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmui-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  await ctx.sync.syncAll();
  const server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.close(); ctx.sync.stop(); ctx.store.close(); ctx.history.close(); ctx.apiTracker.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (p, method = 'GET', body) => fetch(base + p, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  };
  const withIp = ctx.inventory.forCustomer('cust-demo').find((d) => d.ip);
  assert.ok(withIp, 'a mock device reports an IP');
  const id = encodeURIComponent(withIp.id);
  const tech = await login('tech@demo.example');
  const d = await (await tech(`/api/devices/${id}`)).json();
  assert.equal(d.webUi.url, `https://${withIp.ip}/`);
  const opened = await tech(`/api/devices/${id}/webui`, 'POST', {});
  assert.equal(opened.status, 200);
  const end = await login('it@demo.example');
  assert.equal((await end(`/api/devices/${id}/webui`, 'POST', {})).status, 403);
  // A customer admin sets another address; bad ones are refused.
  const cadmin = await login('admin@demo.example');
  assert.equal((await cadmin('/api/devices/bulk', 'POST', { ids: [withIp.id], set: { webUrl: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await cadmin('/api/devices/bulk', 'POST', { ids: [withIp.id], set: { webUrl: 'http://10.9.9.9:8080/' } })).status, 200);
  assert.equal((await (await tech(`/api/devices/${id}`)).json()).webUi.url, 'http://10.9.9.9:8080/');
  const log = await (await cadmin('/api/audit?action=device.open_ui')).json();
  assert.equal(log.entries.length, 1);
});
