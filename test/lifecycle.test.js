import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { LIFECYCLE_CATALOGUE, lifecycleFor, applyLifecycle } from '../server/lib/lifecycle-catalogue.js';
import { lifecycleStage, cleanModel } from '../server/lib/models.js';
import { demoModels } from '../server/mock/estate.js';
import { avDemoModels } from '../server/mock/av-estate.js';

test('every demo model has a lifecycle catalogue entry with valid data', () => {
  for (const d of [...demoModels(), ...avDemoModels()]) assert.ok(lifecycleFor(d.make, d.model), `${d.make} ${d.model} missing from catalogue`);
  for (const e of LIFECYCLE_CATALOGUE) {
    assert.ok(['announced', 'discontinued', 'not-announced'].includes(e.status));
    // No guessed dates: anything not "announced" has none.
    if (e.status !== 'announced') assert.ok(!e.endOfSale && !e.endOfSupport && !e.endOfLife, `${e.model} has dates without a notice`);
    for (const r of e.refs) assert.match(r.url, /^https:\/\//);
    assert.ok(e.note);
  }
});

test('catalogue fills empty models but never overwrites admin data', () => {
  const m = cleanModel({ make: 'Crestron', model: 'Crestron HD-MD-400-C-E' });
  assert.equal(applyLifecycle(m), true);
  assert.equal(m.lifecycleStatus, 'discontinued');
  assert.equal(lifecycleStage(m).stage, 'discontinued');
  const n = cleanModel({ make: 'Poly', model: 'Studio X50', endOfSale: '2027-01-01' });
  assert.equal(applyLifecycle(n), false);
  assert.equal(n.endOfSale, '2027-01-01');
  const edited = cleanModel({ lifecycleStatus: null }, { ...m, lifecycleSource: 'catalogue' });
  assert.equal(edited.lifecycleSource, 'admin');
});

test('seeded models and devices carry lifecycle status and sources', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const ctx = createApp({ dataDir, autoStart: false });
  t.after(() => { ctx.sync.stop(); ctx.store.close(); ctx.history?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await ctx.sync.syncAll();
  assert.ok(ctx.store.models.length >= 30);
  for (const m of ctx.store.models) assert.ok(m.lifecycleStatus, `${m.model} has no lifecycle status`);
  const d = ctx.inventory.devices.find((x) => x.modelId);
  assert.ok(d.lifecycle.status);
  assert.ok(['notannounced', 'discontinued'].includes(d.lifecycle.stage));
});
