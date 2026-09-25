import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createAutomationStore, validateAutomation } from './store.mjs';
import { openSyntheticDatabase } from './local-harness.mjs';
import { fixture, OWNER_A, OWNER_B, NOW, LATER } from './fixtures.mjs';
import { registerRetirementContract } from './retirement-contract.mjs';

// Unexpected network use is an immediate failure, not an accidental provider request.
globalThis.fetch = () => { throw new Error('Network is forbidden in the synthetic pilot'); };
async function setup(t) {
  const local = openSyntheticDatabase();
  t.after(local.close);
  return { ...local, a: await createAutomationStore(local.db, OWNER_A), b: await createAutomationStore(local.db, OWNER_B) };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
registerRetirementContract(test, setup);

test('normalized Firestore fields and exact identifiers round-trip without rewriting', async t => {
  const { a } = await setup(t);
  const original = fixture();
  assert.deepEqual(await a.create(original), { automation: original, revision: 1 });
  assert.deepEqual((await a.get(original.id)).automation, original);
});

test('legacy absence of optional grounding/mode/cursor is preserved, not silently backfilled', async t => {
  const { a } = await setup(t);
  const legacy = fixture();
  delete legacy.grounding; delete legacy.mode; delete legacy.pageCursor;
  assert.deepEqual((await a.create(legacy)).automation, legacy);
});

const invalidRecords = {
  'unknown field': { secret: 'synthetic-not-a-secret' },
  'nested value': { promptSeed: { text: 'bad' } },
  'bad id': { id: '../not-an-auto-id' },
  'long id': { id: 'x'.repeat(21) },
  'owner path': { ownerUid: 'owner/other' },
  'noncanonical slug': { clientId: 'Synthetic Client' },
  'ambiguous slug': { clientId: 'synthetic--client' },
  'blank name': { client: '  ' },
  'bad platform': { platform: 'constructor' },
  'bad content type': { contentType: 'video' },
  'bad mode': { mode: 'publish' },
  'bad grounding': { grounding: 'google-reviews' },
  'too frequent': { intervalHours: 11 },
  'too large interval': { intervalHours: 8761 },
  'coercible interval': { intervalHours: '48' },
  'fractional count': { runCount: 1.5 },
  'negative cursor': { pageCursor: -1 },
  'unsafe integer': { pageCursor: Number.MAX_SAFE_INTEGER + 1 },
  'nonboolean': { enabled: 1 },
  'invalid date rollover': { nextRunAt: '2026-02-31T12:00:00.000Z' },
  'noncanonical time': { nextRunAt: '2026-09-07T12:00:00Z' },
  'backward update': { updatedAt: '2025-09-07T12:00:00.000Z' },
  'oversize prompt': { promptSeed: 'x'.repeat(2001) },
  'oversize error': { lastError: 'x'.repeat(301) },
};
for (const [name, overrides] of Object.entries(invalidRecords)) {
  test(`rejects ${name} before writing`, async t => {
    const { a, sqlite } = await setup(t);
    await assert.rejects(a.create(fixture(1, overrides)));
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM automation_configs_pilot').get().n, 0);
  });
}

test('missing, array, inherited and symbol-key shapes fail closed', () => {
  const missing = fixture(); delete missing.nextRunAt;
  for (const candidate of [missing, [], null, Object.create(fixture()), { ...fixture(), [Symbol('hidden')]: 1 }]) {
    assert.throws(() => validateAutomation(candidate));
  }
});

test('exact create retry is idempotent, differing or later create conflicts', async t => {
  const { a } = await setup(t);
  const record = fixture();
  await a.create(record);
  assert.equal((await a.create({ ...record })).revision, 1);
  await rejects(a.create({ ...record, promptSeed: 'Different' }), 'conflict');
  await a.patch(record.id, 1, { enabled: false, updatedAt: LATER });
  await rejects(a.create(record), 'conflict');
  assert.equal((await a.list()).items.length, 1);
});

test('owner isolation covers create, direct read, list, due, patch, remove and colliding IDs', async t => {
  const { a, b } = await setup(t);
  const record = fixture();
  await a.create(record);
  await rejects(b.create(record), 'owner_mismatch');
  await rejects(b.create({ ...record, ownerUid: OWNER_B }), 'conflict');
  assert.equal(await b.get(record.id), null);
  assert.deepEqual(await b.list(), { items: [], nextCursor: null });
  assert.deepEqual(await b.due(LATER), []);
  await rejects(b.patch(record.id, 1, { enabled: false, updatedAt: LATER }), 'not_found');
  await rejects(b.remove(record.id, 1), 'not_found');
  assert.deepEqual((await a.get(record.id)).automation, record);
});

test('list pagination is bounded, deterministic and client-scoped, including same display names', async t => {
  const { a } = await setup(t);
  for (const n of [3, 1, 2]) await a.create(fixture(n));
  await a.create(fixture(4, { clientId: 'synthetic-client-b' }));
  const page1 = await a.list({ clientId: 'synthetic-client-a', limit: 2 });
  assert.deepEqual(page1.items.map(x => x.automation.id), [fixture(1).id, fixture(2).id]);
  const page2 = await a.list({ clientId: 'synthetic-client-a', limit: 2, after: page1.nextCursor });
  assert.deepEqual(page2.items.map(x => x.automation.id), [fixture(3).id]);
  assert.equal(page2.nextCursor, null);
  for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { clientId: '' }, { after: "' OR 1=1 --" }]) {
    await assert.rejects(a.list(options));
  }
});

test('due selection keeps paused/future rows out and orders oldest then stable ID', async t => {
  const { a } = await setup(t);
  await a.create(fixture(3)); await a.create(fixture(2));
  await a.create(fixture(1, { nextRunAt: '2026-09-06T12:00:00.000Z' }));
  await a.create(fixture(4, { enabled: false }));
  await a.create(fixture(5, { nextRunAt: LATER }));
  assert.deepEqual((await a.due(NOW)).map(x => x.automation.id), [fixture(1).id, fixture(2).id, fixture(3).id]);
  assert.equal((await a.due(NOW, 1)).length, 1);
  await rejects(a.due('not-a-time'), 'invalid_time');
});

test('successful scheduled result atomically stores schedule, cursor and count; retry does not double count', async t => {
  const { a } = await setup(t);
  const record = fixture(); await a.create(record);
  const patch = { lastRunAt: NOW, lastStatus: 'ok', lastError: '', runCount: 1,
    nextRunAt: LATER, updatedAt: NOW, pageCursor: 4 };
  const result = await a.patch(record.id, 1, patch);
  assert.equal(result.revision, 2);
  assert.equal(result.automation.nextRunAt, LATER);
  assert.equal(result.automation.pageCursor, 4);
  assert.equal(result.automation.runCount, 1);
  const retry = await a.patch(record.id, 1, Object.fromEntries(Object.entries(patch).reverse()));
  assert.deepEqual(retry, result);
});

test('scheduled failure advances schedule/cursor without inventing success; budget no-op leaves state alone', async t => {
  const { a } = await setup(t);
  const record = fixture(); await a.create(record);
  // Budget failure precedes generation in the real runner: the caller must not write a patch.
  assert.deepEqual((await a.get(record.id)).automation, record);
  const result = await a.patch(record.id, 1, { lastRunAt: NOW, lastStatus: 'error',
    lastError: 'Synthetic generation failure', nextRunAt: LATER, updatedAt: NOW, pageCursor: 4 });
  assert.equal(result.automation.runCount, 0);
  assert.equal(result.automation.lastStatus, 'error');
  assert.equal(result.automation.pageCursor, 4);
  assert.equal(result.automation.nextRunAt, LATER);
});

test('preview success/failure may advance cursor without disturbing scheduled time', async t => {
  const { a } = await setup(t);
  const record = fixture(); await a.create(record);
  const ok = await a.patch(record.id, 1, { lastRunAt: NOW, lastStatus: 'ok', lastError: '',
    runCount: 1, pageCursor: 4, updatedAt: NOW });
  const failed = await a.patch(record.id, ok.revision, { pageCursor: 5, updatedAt: LATER });
  assert.equal(failed.automation.nextRunAt, record.nextRunAt);
  assert.equal(failed.automation.runCount, 1);
  assert.equal(failed.automation.pageCursor, 5);
});

test('concurrent distinct edits yield exactly one winner and one conflict', async t => {
  const { a } = await setup(t);
  await a.create(fixture());
  const results = await Promise.allSettled([
    a.patch(fixture().id, 1, { enabled: false, updatedAt: LATER }),
    a.patch(fixture().id, 1, { pageCursor: 9, updatedAt: LATER }),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'conflict');
  assert.equal((await a.get(fixture().id)).revision, 2);
});

test('concurrent identical retry has one revision, and a later edit prevents replay', async t => {
  const { a } = await setup(t);
  await a.create(fixture());
  const patch = { pageCursor: 4, updatedAt: NOW };
  const results = await Promise.all([a.patch(fixture().id, 1, patch), a.patch(fixture().id, 1, patch)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].revision, 2);
  await a.patch(fixture().id, 2, { pageCursor: 5, updatedAt: LATER });
  await rejects(a.patch(fixture().id, 1, patch), 'conflict');
});

test('schema validation and expected revision protect all writes; failures leave original bytes unchanged', async t => {
  const { a } = await setup(t);
  const record = fixture(); await a.create(record);
  for (const patch of [{ id: record.id }, { ownerUid: OWNER_B }, { clientId: 'synthetic-client-b' },
    { platform: 'blog' }, { createdAt: LATER }, { runCount: -1 }, { pageCursor: null },
    { enabled: 'false' }, { pageCursor: 4n }, { pageCursor: undefined }, { secret: 'wrong' }]) {
    await assert.rejects(a.patch(record.id, 1, { updatedAt: LATER, ...patch }));
  }
  for (const rev of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER, NaN]) {
    await rejects(a.patch(record.id, rev, { enabled: false, updatedAt: LATER }), 'invalid_revision');
    await rejects(a.remove(record.id, rev), 'invalid_revision');
  }
  await rejects(a.patch(record.id, 1, { enabled: false }), 'invalid_patch');
  assert.deepEqual(await a.get(record.id), { automation: record, revision: 1 });
});

test('display-name lifecycle edit preserves slug, owner, ID, schedule and another same-name client', async t => {
  const { a } = await setup(t);
  const original = fixture(); await a.create(original);
  const other = fixture(2, { clientId: 'synthetic-client-b' }); await a.create(other);
  const renamed = await a.patch(original.id, 1, { client: 'Synthetic renamed client', updatedAt: LATER });
  for (const field of ['id', 'ownerUid', 'clientId', 'nextRunAt', 'runCount', 'pageCursor']) {
    assert.equal(renamed.automation[field], original[field]);
  }
  assert.deepEqual((await a.get(other.id)).automation, other);
});

test('remove scrubs config, is retry-safe, blocks stale edits/resurrection and leaves other tenants alone', async t => {
  const { a, sqlite } = await setup(t);
  const original = fixture(); await a.create(original);
  await a.create(fixture(2, { clientId: 'synthetic-client-b' }));
  const result = await a.remove(original.id, 1);
  assert.deepEqual(await a.remove(original.id, 1), result);
  assert.equal(await a.get(original.id), null);
  assert.equal((await a.list({ clientId: original.clientId })).items.length, 0);
  assert.equal((await a.due(LATER)).length, 1);
  await rejects(a.create(original), 'conflict');
  await rejects(a.patch(original.id, 1, { enabled: true, updatedAt: LATER }), 'not_found');
  const tombstone = sqlite.prepare('SELECT * FROM automation_configs_pilot WHERE id = ?').get(original.id);
  assert.equal(tombstone.record_json, null);
  assert.equal(tombstone.last_patch_json, null);
  assert.equal(tombstone.enabled, 0);
  assert.equal(tombstone.next_run_at, '');
});

test('delete cannot erase a concurrent edit with a stale revision', async t => {
  const { a } = await setup(t);
  await a.create(fixture());
  await a.patch(fixture().id, 1, { pageCursor: 4, updatedAt: LATER });
  await rejects(a.remove(fixture().id, 1), 'conflict');
  assert.equal((await a.get(fixture().id)).automation.pageCursor, 4);
});

test('SQL constraints reject malformed JSON and denormalized tenant drift', async t => {
  const { a, sqlite } = await setup(t);
  await a.create(fixture());
  for (const value of ['{bad', '{}', JSON.stringify({ ...fixture(), clientId: 'other-client' })]) {
    assert.throws(() => sqlite.prepare('UPDATE automation_configs_pilot SET record_json = ?').run(value));
  }
  assert.throws(() => sqlite.prepare('UPDATE automation_configs_pilot SET revision = 0').run());
  assert.deepEqual((await a.get(fixture().id)).automation, fixture());
});

test('malformed stored fields stop reads/lists rather than returning a plausible empty success', async t => {
  const { a, sqlite } = await setup(t);
  await a.create(fixture());
  sqlite.prepare("UPDATE automation_configs_pilot SET record_json = json_set(record_json, '$.runCount', -1)").run();
  await rejects(a.get(fixture().id), 'corrupt_storage');
  await rejects(a.list(), 'corrupt_storage');
  await rejects(a.due(LATER), 'corrupt_storage');
});

test('unsupported schema is refused; storage errors are redacted', async t => {
  const { db } = await setup(t);
  for (const schema_version of [1, 999]) {
    const unsupported = { prepare: () => ({ bind: () => ({ first: async () => ({ schema_version }) }) }) };
    await rejects(createAutomationStore(unsupported, OWNER_A), 'unsupported_schema');
  }
  const broken = { prepare: () => { throw new Error('Synthetic confidential prompt in SQL error'); } };
  await assert.rejects(createAutomationStore(broken, OWNER_A), error =>
    error.code === 'storage_failed' && !error.message.includes('confidential'));
  await rejects(createAutomationStore(db, ''), 'invalid_owner');
});

test('lost acknowledgements after committed create/patch/remove are safe to retry', async t => {
  const { db } = await setup(t);
  let loseNextWrite = true;
  const lossy = {
    prepare(sql) {
      return { bind(...params) {
        const statement = db.prepare(sql).bind(...params);
        return { ...statement, async first() {
          const result = await statement.first();
          if (loseNextWrite && /^(INSERT|UPDATE)/.test(sql)) {
            loseNextWrite = false;
            throw new Error('Synthetic response loss after commit');
          }
          return result;
        } };
      } };
    },
  };
  const store = await createAutomationStore(lossy, OWNER_A);
  await rejects(store.create(fixture()), 'storage_failed');
  assert.equal((await store.create(fixture())).revision, 1);
  loseNextWrite = true;
  const patch = { pageCursor: 4, runCount: 1, updatedAt: LATER };
  await rejects(store.patch(fixture().id, 1, patch), 'storage_failed');
  assert.equal((await store.patch(fixture().id, 1, patch)).revision, 2);
  loseNextWrite = true;
  await rejects(store.remove(fixture().id, 2), 'storage_failed');
  assert.deepEqual(await store.remove(fixture().id, 2), { deleted: true, revision: 3 });
});

test('failed list/due reads stay failures rather than empty success', async t => {
  const { db } = await setup(t);
  const broken = { prepare(sql) {
    if (sql.includes('automation_configs_pilot')) throw new Error('Synthetic storage outage');
    return db.prepare(sql);
  } };
  const store = await createAutomationStore(broken, OWNER_A);
  await rejects(store.list(), 'storage_failed');
  await rejects(store.due(LATER), 'storage_failed');
});

test('ordinary source and deploy configuration have no prototype imports or binding', () => {
  const root = new URL('../../', import.meta.url);
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) scan(file);
      else if (/\.(jsx?|mjs|toml|ya?ml)$/.test(entry.name)) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /prototypes\/automation-d1|automation_(configs|retired_clients)_pilot/);
      }
    }
  }
  scan(new URL('src/', root)); scan(new URL('worker/', root));
  assert.doesNotMatch(readFileSync(new URL('wrangler.toml', root), 'utf8'), /\[\[d1_databases\]\]|automation_configs_pilot/);
});
