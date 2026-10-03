import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('firebase/firestore', () => ({ runTransaction: vi.fn(), getDocFromServer: vi.fn(), doc: (_db, _path, id) => ({ id }) }));
import { getDocFromServer, runTransaction } from 'firebase/firestore';
import { OPERATOR_UID } from '../config/roles';
import { bulkTagBaselineFor, checkBulkTagReceipt, runBulkTagAttempt } from './bulkTagAttempt';

const post = patch => ({ uid: OPERATOR_UID, clientId: 'acme', client: 'Acme', status: 'draft',
  updatedAt: '2026-10-03T12:00:00.000Z', tags: ['keep'], content: 'Keep exact caption',
  imageUrl: '/media/keep.png', scheduledDate: null, approvalStatus: 'approved', feedback: 'Keep feedback', ...patch });
const item = (id = 'a', data = post()) => ({ id, postRef: { id }, baseline: bulkTagBaselineFor(data) });
const db = { app: { options: { projectId: 'demo-spool-tags' } } };
let rows, calls, writes;
const attempt = patch => runBulkTagAttempt({ db, items: [item()], tags: ['new'], action: 'add', actorUid: OPERATOR_UID, assertAdmission: () => {}, ...patch });
const transaction = () => ({
  get: async ref => { calls.push(`read:${ref.id}`); return { exists: () => rows.has(ref.id), data: () => rows.get(ref.id) }; },
  update: (ref, patch) => { calls.push(`write:${ref.id}`); writes.push({ ref, patch }); },
});
beforeEach(() => {
  vi.clearAllMocks(); rows = new Map([['a', post()], ['b', post()]]); calls = []; writes = [];
  runTransaction.mockImplementation(async (_db, callback) => callback(transaction()));
  getDocFromServer.mockImplementation(async ref => ({ id: ref.id, exists: () => rows.has(ref.id), data: () => rows.get(ref.id) }));
});

describe('whole-selection atomic tag attempt', () => {
  it('reads every selection before patches and preserves all non-tag fields', async () => {
    const before = structuredClone([...rows]);
    const result = await attempt({ items: [item('a'), item('b')] });
    expect(result).toMatchObject({ status: 'complete', confirmed: true, changedIds: ['a', 'b'], unchangedIds: [] });
    expect(calls).toEqual(['read:a', 'read:b', 'write:a', 'write:b']);
    for (const { patch } of writes) {
      expect(Object.keys(patch).sort()).toEqual(['tags', 'updatedAt']); expect(patch.tags).toEqual(['keep', 'new']);
      expect(Date.parse(patch.updatedAt)).toBeGreaterThan(Date.parse(post().updatedAt));
    }
    expect([...rows]).toEqual(before);
  });
  it('separates confirmed changed/unchanged rows and never stamps a no-op', async () => {
    rows.set('b', post({ tags: ['keep', 'new'] }));
    const result = await attempt({ items: [item('a'), item('b', rows.get('b'))] });
    expect(result).toMatchObject({ status: 'complete', changedIds: ['a'], unchangedIds: ['b'] });
    expect(writes).toHaveLength(1);
    expect(await attempt({ tags: ['keep'] })).toMatchObject({ status: 'complete', changedIds: [], unchangedIds: ['a'] });
    expect(writes).toHaveLength(1);
  });
  it('removes exact tags and preserves tag order', async () => {
    rows.set('a', post({ tags: ['one', 'keep', 'two'] }));
    expect(await attempt({ items: [item('a', rows.get('a'))], tags: ['keep'], action: 'remove' })).toMatchObject({ status: 'complete' });
    expect(writes[0].patch.tags).toEqual(['one', 'two']);
  });
  it('refuses a visible final-row overflow before opening a transaction', async () => {
    const full = post({ tags: Array.from({ length: 10 }, (_, index) => `tag${index}`) });
    const result = await attempt({ items: [item('a'), item('b', full)] });
    expect(result).toMatchObject({ status: 'stopped', writePrepared: false });
    expect(runTransaction).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it.each(['uid', 'clientId', 'client', 'status', 'updatedAt', 'tags'])('refuses fresh %s drift in the final selected row without any update', async field => {
    const drift = { uid: 'other-owner', clientId: 'beta', client: 'Beta', status: 'posted', updatedAt: '2026-10-03T12:00:01.000Z', tags: ['other'] };
    rows.set('b', post({ [field]: drift[field] }));
    expect(await attempt({ items: [item('a'), item('b')] })).toMatchObject({ status: 'stopped', error: { code: 'bulk_tag_conflict' } });
    expect(writes).toEqual([]);
  });
  it('refuses a missing final row without changing earlier rows', async () => {
    rows.delete('b'); expect(await attempt({ items: [item('a'), item('b')] })).toMatchObject({ status: 'stopped' });
    expect(writes).toEqual([]);
  });
  it.each([null, 'keep', [' keep '], ['keep', 'keep'], [''], [2], Array(11).fill('extra'), ['x'.repeat(21)]])('does not repair malformed raw tags %j hidden by display normalization', async tags => {
    rows.set('a', post({ tags }));
    expect(await attempt()).toMatchObject({ status: 'stopped', writePrepared: false }); expect(writes).toEqual([]);
  });
  it('accepts absent legacy tags as empty, without rewriting any other field', async () => {
    rows.set('a', post({ tags: undefined }));
    expect(await attempt({ items: [item('a', rows.get('a'))] })).toMatchObject({ status: 'complete' });
    expect(writes[0].patch.tags).toEqual(['new']);
  });
  it.each(['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'])('refuses fresh %s null presence', async field => {
    rows.set('b', post({ [field]: null })); expect(await attempt({ items: [item('a'), item('b')] })).toMatchObject({ status: 'stopped' });
    expect(writes).toEqual([]);
  });
  it.each([{ source: 'suggestion' }, { forClientId: 'acme' }, { isTemplate: true }, { uid: 'foreign' }])('refuses incompatible source %#', patch => {
    expect(bulkTagBaselineFor(post(patch))).toBeNull();
  });
  it('freezes a separate baseline, retains archived eligibility and future revision monotonicity', async () => {
    const source = post({ status: 'archived', updatedAt: '2090-01-01T00:00:00.000Z' });
    const captured = item('a', source); source.tags.push('later');
    expect(captured.baseline.tags).toEqual(['keep']); expect(Object.isFrozen(captured.baseline.tags)).toBe(true);
    rows.set('a', post({ status: 'archived', updatedAt: captured.baseline.updatedAt }));
    expect(await attempt({ items: [captured] })).toMatchObject({ status: 'complete' });
    expect(Date.parse(writes[0].patch.updatedAt)).toBeGreaterThan(Date.parse(captured.baseline.updatedAt));
  });
  it.each([[], Array.from({ length: 201 }, (_, index) => item(String(index))), [item(), item()], [item('nested/path')], [{ ...item(), postRef: { id: 'b' } }]])('refuses incomplete/oversized/duplicate/reference-invalid selection %#', async items => {
    expect(await attempt({ items })).toMatchObject({ status: 'stopped' }); expect(runTransaction).not.toHaveBeenCalled();
  });
  it('accepts exactly 200 synthetic selections in one transaction', async () => {
    const items = Array.from({ length: 200 }, (_, index) => { const id = String(index); rows.set(id, post()); return item(id); });
    expect(await attempt({ items })).toMatchObject({ status: 'complete', changedIds: items.map(entry => entry.id) });
    expect(runTransaction).toHaveBeenCalledTimes(1); expect(writes).toHaveLength(200);
    expect(calls.slice(0, 200).every(call => call.startsWith('read:'))).toBe(true);
  });
  it('refuses retirement while awaiting reads, before preparing any update', async () => {
    let current = true;
    runTransaction.mockImplementation(async (_db, callback) => callback({ ...transaction(), get: async ref => {
      current = false; return { exists: () => true, data: () => rows.get(ref.id) };
    } }));
    expect(await attempt({ assertAdmission: () => { if (!current) throw new Error('retired'); } })).toMatchObject({ status: 'stopped', writePrepared: false });
    expect(writes).toEqual([]);
  });
  it('keeps uncertainty after earlier callback writes even when retry detects conflict', async () => {
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); rows.set('a', post({ tags: ['changed'] })); return callback(transaction()); });
    expect(await attempt()).toMatchObject({ status: 'needs_checking', confirmed: false, writePrepared: true });
    expect(writes).toHaveLength(1);
  });
  it('uses the final callback outcome, not stale accumulated update counts', async () => {
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); return callback(transaction()); });
    expect(await attempt()).toMatchObject({ status: 'complete', changedIds: ['a'], unchangedIds: [] });
    expect(writes).toHaveLength(2);
  });
  it('holds after a lost commit response without claiming failure/cancellation', async () => {
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); throw new Error('response lost'); });
    expect(await attempt()).toMatchObject({ status: 'needs_checking', confirmed: false, writePrepared: true });
  });
  it('retains confirmed outcome separately from retired actor after fulfillment', async () => {
    let current = true;
    runTransaction.mockImplementation(async (_db, callback) => { const result = await callback(transaction()); current = false; return result; });
    expect(await attempt({ assertAdmission: () => { if (!current) throw new Error('retired'); } }))
      .toMatchObject({ status: 'needs_checking', confirmed: true, writePrepared: true });
  });
  it('cannot manufacture success without the transaction callback', async () => {
    runTransaction.mockResolvedValue(undefined);
    expect(await attempt()).toMatchObject({ status: 'stopped', error: { code: 'bulk_tag_control' } });
  });
});

describe('retained original tag operation inspection', () => {
  async function uncertain() {
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); throw new Error('lost response'); });
    return (await attempt({ items: [item('a'), item('b')] })).receipt;
  }
  const inspect = (receipt, patch = {}) => checkBulkTagReceipt({ db, receipt, actorUid: OPERATOR_UID, assertAdmission: () => {}, ...patch });
  const saveCandidate = receipt => receipt.candidates[0].forEach(({ id, baseline }) => rows.set(id, { ...rows.get(id), tags: [...baseline.tags], updatedAt: baseline.updatedAt }));
  it('retains frozen original IDs, patches and acknowledgement independently of caller mutation', async () => {
    const original = [item('a'), item('b')], tags = ['new'];
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); original.length = 0; tags[0] = 'changed'; throw new Error('lost'); });
    const result = await attempt({ items: original, tags });
    expect(result.receipt).toMatchObject({ actorUid: OPERATOR_UID, projectId: db.app.options.projectId, confirmed: false, tags: ['new'] });
    expect(result.receipt.items.map(row => row.id)).toEqual(['a', 'b']);
    expect(Object.isFrozen(result.receipt.candidates[0][0].baseline.tags)).toBe(true);
    expect(JSON.stringify(result.receipt)).not.toMatch(/caption|media\/keep|Keep feedback/i);
  });
  it('server-reads every original ID and confirms a whole expected candidate without replay', async () => {
    const receipt = await uncertain(); saveCandidate(receipt); const priorWrites = writes.length, priorRuns = runTransaction.mock.calls.length;
    expect(await inspect(receipt)).toEqual({ status: 'matched', count: 2 });
    expect(getDocFromServer.mock.calls.map(([ref]) => ref.id)).toEqual(['a', 'b']);
    expect(writes).toHaveLength(priorWrites); expect(runTransaction).toHaveBeenCalledTimes(priorRuns);
  });
  it.each(['original', 'partial', 'newer', 'missing', 'malformed', 'protected', 'tenant', 'identity'])('keeps the hold for %s server state', async mode => {
    const receipt = await uncertain();
    if (mode !== 'original') saveCandidate(receipt);
    if (mode === 'partial') rows.set('b', post());
    if (mode === 'newer') rows.set('b', { ...rows.get('b'), updatedAt: '2099-01-01T00:00:00.000Z' });
    if (mode === 'missing') rows.delete('b');
    if (mode === 'malformed') rows.set('b', { ...rows.get('b'), tags: [' padded '] });
    if (mode === 'protected') rows.set('b', { ...rows.get('b'), firstComment: null });
    if (mode === 'tenant') rows.set('b', { ...rows.get('b'), clientId: 'other' });
    if (mode === 'identity') getDocFromServer.mockImplementation(async ref => ({ id: 'wrong', exists: () => true, data: () => rows.get(ref.id) }));
    expect(await inspect(receipt)).toMatchObject({ status: 'needs_checking' });
    expect(getDocFromServer).toHaveBeenCalledTimes(2);
  });
  it('retains distinct complete SDK retry candidates without mixing their revisions', async () => {
    let clock = 0; vi.spyOn(Date, 'now').mockImplementation(() => Date.parse('2030-01-01T00:00:00.000Z') + ++clock);
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); await callback(transaction()); throw new Error('lost'); });
    const receipt = (await attempt({ items: [item('a'), item('b')] })).receipt;
    expect(receipt.candidates).toHaveLength(2);
    const [first, second] = receipt.candidates;
    rows.set('a', { ...rows.get('a'), tags: [...first[0].baseline.tags], updatedAt: first[0].baseline.updatedAt });
    rows.set('b', { ...rows.get('b'), tags: [...second[1].baseline.tags], updatedAt: second[1].baseline.updatedAt });
    expect(await inspect(receipt)).toMatchObject({ status: 'needs_checking' });
    vi.restoreAllMocks();
  });
  it('keeps confirmed IDs/acknowledgement when the fulfilled writer actor retires', async () => {
    let current = true;
    runTransaction.mockImplementation(async (_db, callback) => { const result = await callback(transaction()); current = false; return result; });
    const result = await attempt({ assertAdmission: () => { if (!current) throw new Error('retired'); } });
    expect(result).toMatchObject({ confirmed: true, changedIds: ['a'], unchangedIds: [], receipt: { confirmed: true } });
  });
  it('binds a second operator receipt to that actor, not the canonical post owner', async () => {
    runTransaction.mockImplementation(async (_db, callback) => { await callback(transaction()); throw new Error('lost'); });
    const receipt = (await attempt({ actorUid: 'second-super-admin' })).receipt; saveCandidate(receipt);
    expect(receipt.actorUid).toBe('second-super-admin');
    expect(await inspect(receipt)).toMatchObject({ status: 'needs_checking' });
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(await inspect(receipt, { actorUid: 'second-super-admin' })).toEqual({ status: 'matched', count: 1 });
  });
  it('does not infer an outcome from inaccessible server reads or an account change during a check', async () => {
    const receipt = await uncertain(); saveCandidate(receipt);
    getDocFromServer.mockRejectedValue(new Error('offline')); expect(await inspect(receipt)).toMatchObject({ status: 'needs_checking' });
    let current = true;
    getDocFromServer.mockImplementation(async ref => { current = false; return { id: ref.id, exists: () => true, data: () => rows.get(ref.id) }; });
    expect(await inspect(receipt, { assertAdmission: () => { if (!current) throw new Error('retired'); } })).toMatchObject({ status: 'needs_checking' });
  });
  it.each([null, { projectId: 'other' }, { actorUid: 'foreign' }, { items: [] }])('refuses an absent or foreign receipt %# without reads', async patch => {
    const receipt = await uncertain();
    expect(await inspect(patch === null ? null : { ...receipt, ...patch })).toMatchObject({ status: 'needs_checking' });
    expect(getDocFromServer).not.toHaveBeenCalled();
  });
});
