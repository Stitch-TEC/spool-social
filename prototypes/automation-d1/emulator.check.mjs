// Local workerd/D1 only. No Wrangler, account, credentials, remote resource or data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { createAutomationStore } from './store.mjs';
import { fixture, OWNER_A, OWNER_B, LATER } from './fixtures.mjs';

test('synthetic automation contract on local workerd D1 (not production performance)', async () => {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("synthetic local test"); } };',
    compatibilityDate: '2026-07-01',
    host: '127.0.0.1',
    port: 0,
    cf: false,
    d1Databases: { AUTOMATION_PILOT: 'synthetic-automation-pilot' },
    d1Persist: false,
    outboundService: () => { throw new Error('External requests are forbidden in this test'); },
  });
  try {
    const db = await runtime.getD1Database('AUTOMATION_PILOT');
    // This fixed schema has no semicolons inside strings or procedural blocks.
    // Not an exporter/importer/parser for arbitrary SQL or real backup artifacts.
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    const a = await createAutomationStore(db, OWNER_A);
    const b = await createAutomationStore(db, OWNER_B);
    const record = fixture();
    const created = await a.create(record);
    assert.deepEqual(created.automation, record);
    assert.deepEqual(await a.create(record), created);
    assert.equal(await b.get(record.id), null);
    assert.deepEqual(await b.due(LATER), []);
    await assert.rejects(b.patch(record.id, 1, { enabled: false, updatedAt: LATER }), /not_found/);

    await a.create(fixture(2));
    const page = await a.list({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, record.id);
    assert.equal((await a.list({ limit: 1, after: page.nextCursor })).items[0].automation.id, fixture(2).id);
    assert.equal((await a.due(LATER)).length, 2);

    const patches = await Promise.allSettled([
      a.patch(record.id, 1, { enabled: false, updatedAt: LATER }),
      a.patch(record.id, 1, { pageCursor: 7, updatedAt: LATER }),
    ]);
    assert.equal(patches.filter(p => p.status === 'fulfilled').length, 1);
    assert.equal(patches.find(p => p.status === 'rejected').reason.code, 'conflict');
    assert.equal((await a.get(record.id)).revision, 2);
    const removed = await a.remove(record.id, 2);
    assert.deepEqual(await a.remove(record.id, 2), removed);
    assert.equal(await a.get(record.id), null);
    await assert.rejects(a.create(record), /conflict/);
    assert.equal((await a.get(fixture(2).id)).revision, 1);
  } finally {
    await runtime.dispose();
  }
});
