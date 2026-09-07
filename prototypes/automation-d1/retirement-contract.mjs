// The same synthetic lifecycle cases run on RAM SQLite and local workerd D1.
import assert from 'node:assert/strict';
import { createAutomationStore } from './store.mjs';
import { fixture, OWNER_A, OWNER_B, NOW, LATER } from './fixtures.mjs';

const CLIENT = fixture().clientId;
const OTHER = 'synthetic-client-b';
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
const rawRows = async (db, table) => (await db.prepare(`SELECT * FROM ${table}`).bind().all()).results;
const configs = db => rawRows(db, 'automation_configs_pilot');
const fences = db => rawRows(db, 'automation_retired_clients_pilot');

// Pause immediately BEFORE one database statement. This models a request that
// passed earlier application checks but reaches SQL after retirement committed.
function interleave(db, match, before) {
  let armed = true;
  return {
    batch: statements => db.batch(statements),
    prepare(sql) {
      return { bind(...params) {
        const statement = db.prepare(sql).bind(...params);
        return {
          async first() {
            if (armed && match(sql)) { armed = false; await before(); }
            return statement.first();
          },
          all: () => statement.all(),
        };
      } };
    },
  };
}

export function registerRetirementContract(test, setup) {
  test('retirement scrubs only the exact owner/slug and retains no config in evidence', async t => {
    const { a, b, db } = await setup(t);
    await a.create(fixture(1)); await a.create(fixture(2));
    await a.remove(fixture(2).id, 1);
    const other = fixture(3, { clientId: OTHER }); await a.create(other);
    const otherOwner = fixture(4, { ownerUid: OWNER_B }); await b.create(otherOwner);
    const result = await a.retireClient(CLIENT, LATER);
    assert.deepEqual(result, { ownerUid: OWNER_A, clientId: CLIENT, retiredAt: LATER, scrubbedCount: 1 });
    assert.deepEqual(await a.retirement(CLIENT), result);
    assert.equal(await b.retirement(CLIENT), null);
    assert.deepEqual((await a.get(other.id)).automation, other);
    assert.deepEqual((await b.get(otherOwner.id)).automation, otherOwner);
    assert.deepEqual(await a.list({ clientId: CLIENT }), { items: [], nextCursor: null });
    const retiredRows = (await configs(db)).filter(r => r.owner_uid === OWNER_A && r.client_id === CLIENT);
    for (const row of retiredRows) {
      assert.equal(row.deleted, 1); assert.equal(row.enabled, 0); assert.equal(row.next_run_at, '');
      assert.equal(row.record_json, null); assert.equal(row.last_patch_json, null);
      assert.equal(row.revision, 2); // existing tombstone is not incremented again
    }
    assert.deepEqual(Object.keys((await fences(db))[0]).sort(), ['client_id', 'owner_uid', 'retired_at', 'scrubbed_count']);
  });

  test('retirement fences empty scopes and rejects delayed new IDs without affecting another owner', async t => {
    const { a, b } = await setup(t);
    assert.equal((await a.retireClient(CLIENT, NOW)).scrubbedCount, 0);
    await rejects(a.create(fixture()), 'client_retired');
    await rejects(a.create(fixture(2)), 'client_retired');
    await a.create(fixture(3, { clientId: OTHER }));
    await b.create(fixture(4, { ownerUid: OWNER_B }));
    assert.equal((await a.list()).items.length, 1);
    assert.equal((await b.list()).items.length, 1);
  });

  test('create SQL rechecks the fence when retirement wins the in-flight race', async t => {
    const { a, db } = await setup(t);
    const delayed = await createAutomationStore(interleave(db,
      sql => sql.startsWith('INSERT INTO automation_configs_pilot'),
      () => a.retireClient(CLIENT, NOW)), OWNER_A);
    await rejects(delayed.create(fixture()), 'client_retired');
    assert.equal((await configs(db)).length, 0);
    assert.equal((await a.retirement(CLIENT)).scrubbedCount, 0);
  });

  test('CAS SQL refuses an in-flight edit when retirement wins, including old retry payloads', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    const oldPatch = { pageCursor: 4, updatedAt: NOW };
    await a.patch(fixture().id, 1, oldPatch);
    const delayed = await createAutomationStore(interleave(db,
      sql => sql.startsWith('UPDATE automation_configs_pilot'),
      () => a.retireClient(CLIENT, LATER)), OWNER_A);
    await rejects(delayed.patch(fixture().id, 2, { pageCursor: 5, updatedAt: LATER }), 'conflict');
    await rejects(a.patch(fixture().id, 1, oldPatch), 'not_found');
    assert.equal(await a.get(fixture().id), null);
    const row = (await configs(db))[0];
    assert.equal(row.revision, 3); assert.equal(row.record_json, null);
  });

  test('remove SQL refuses a delayed deletion after retirement without changing its evidence', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    const delayed = await createAutomationStore(interleave(db,
      sql => sql.startsWith('UPDATE automation_configs_pilot'),
      () => a.retireClient(CLIENT, NOW)), OWNER_A);
    await rejects(delayed.remove(fixture().id, 1), 'not_found');
    assert.equal((await configs(db))[0].revision, 2);
    assert.equal((await a.retirement(CLIENT)).scrubbedCount, 1);
  });

  test('retired scope stays unreadable/unwritable even if a corrupt unscrubbed row remains', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    // Deliberately inconsistent fixture, not a supported operational write path.
    await db.prepare(`INSERT INTO automation_retired_clients_pilot VALUES (?, ?, ?, ?)`)
      .bind(OWNER_A, CLIENT, NOW, 0).all();
    assert.equal(await a.get(fixture().id), null);
    assert.deepEqual(await a.list(), { items: [], nextCursor: null });
    assert.deepEqual(await a.due(LATER), []);
    await rejects(a.create(fixture()), 'client_retired');
    await rejects(a.patch(fixture().id, 1, { enabled: false, updatedAt: LATER }), 'not_found');
    await rejects(a.remove(fixture().id, 1), 'not_found');
    assert.equal((await configs(db))[0].revision, 1);
  });

  test('retirement retries and simultaneous calls retain the first evidence and one revision advance', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    const results = await Promise.all([a.retireClient(CLIENT, NOW), a.retireClient(CLIENT, LATER)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(await a.retireClient(CLIENT, '2026-12-01T12:00:00.000Z'), results[0]);
    assert.equal(results[0].scrubbedCount, 1);
    assert.equal((await configs(db))[0].revision, 2);
    assert.equal((await fences(db)).length, 1);
  });

  test('lost acknowledgement after a committed retirement can be retried without another scrub', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    let lose = true;
    const lossy = await createAutomationStore({
      prepare: sql => db.prepare(sql),
      async batch(statements) {
        const result = await db.batch(statements);
        if (lose) { lose = false; throw new Error('Synthetic response loss after commit'); }
        return result;
      },
    }, OWNER_A);
    await rejects(lossy.retireClient(CLIENT, NOW), 'storage_failed');
    assert.deepEqual(await lossy.retireClient(CLIENT, LATER), {
      ownerUid: OWNER_A, clientId: CLIENT, retiredAt: NOW, scrubbedCount: 1,
    });
    assert.equal((await configs(db))[0].revision, 2);
  });

  test('batch failure after fence or after scrub rolls back the complete retirement', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    for (const failAt of [1, 2]) {
      const broken = await createAutomationStore({
        prepare: sql => db.prepare(sql),
        batch: statements => db.batch([
          ...statements.slice(0, failAt),
          db.prepare('SELECT * FROM synthetic_missing_table').bind(),
          ...statements.slice(failAt),
        ]),
      }, OWNER_A);
      await rejects(broken.retireClient(CLIENT, NOW), 'storage_failed');
      assert.equal(await a.retirement(CLIENT), null);
      assert.deepEqual(await a.get(fixture().id), { automation: fixture(), revision: 1 });
    }
    await a.create(fixture(2));
    assert.equal((await a.retireClient(CLIENT, LATER)).scrubbedCount, 2);
  });

  test('invalid retirement scope/time fails before data changes', async t => {
    const { a, db } = await setup(t);
    await a.create(fixture());
    for (const clientId of ['', 'Synthetic Client', 'bad--slug', "x' OR 1=1 --", '../other']) {
      await rejects(a.retireClient(clientId, NOW), 'invalid_client_id');
      await rejects(a.retirement(clientId), 'invalid_client_id');
    }
    for (const time of ['', undefined, '2026-02-31T12:00:00.000Z', '2026-09-07']) {
      await rejects(a.retireClient(CLIENT, time), 'invalid_time');
    }
    assert.equal((await fences(db)).length, 0);
    assert.deepEqual((await a.get(fixture().id)).automation, fixture());
  });
}
