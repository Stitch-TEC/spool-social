import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('firebase/firestore', () => ({ runTransaction: vi.fn() }));
import { runTransaction } from 'firebase/firestore';
import { archiveBaselineFor, runArchiveStatusAttempt } from './archivePost';

const original = patch => ({ uid: 'operator', clientId: 'acme', client: 'Acme', status: 'draft',
  updatedAt: '2026-10-03T12:00:00.000Z', createdAt: '2026-10-02T12:00:00.000Z',
  content: 'Exact  caption', title: 'Keep title', imageUrl: '/media/keep.png', scheduledDate: null,
  approvalStatus: 'approved', feedback: 'Keep feedback', feedbackThread: [{ text: 'Keep review', by: 'client' }],
  reviewStage: 'in_review', tags: ['keep'], ...patch });
const snapshot = value => ({ exists: () => value !== null, data: () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const start = (patch = {}) => runArchiveStatusAttempt({ db: {}, postRef: { id: 'synthetic-thread' },
  baseline: archiveBaselineFor(original()), action: 'archive', assertAdmission: () => {}, ...patch });
let update;
beforeEach(() => {
  vi.clearAllMocks(); update = vi.fn();
  runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(original()), update }));
});

describe('operator archive fresh transaction contract', () => {
  it.each(['draft', 'scheduled', 'posted'])('archives ordinary %s without changing any other stored field', async status => {
    const stored = original({ status });
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(stored), update }));
    const before = structuredClone(stored);
    const result = await start({ baseline: archiveBaselineFor(stored) });
    expect(result).toMatchObject({ status: 'complete', confirmed: true, patch: { status: 'archived' } });
    expect(Object.keys(result.patch).sort()).toEqual(['status', 'updatedAt']);
    expect(result.patch.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(result.patch.updatedAt)).toBeGreaterThan(Date.parse(stored.updatedAt));
    expect(update).toHaveBeenCalledWith({ id: 'synthetic-thread' }, result.patch);
    expect(stored).toEqual(before);
  });
  it('restores only an archived thread to Draft, retaining dates, approval and history', async () => {
    const stored = original({ status: 'archived', scheduledDate: '2026-10-10T12:00:00.000Z' });
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(stored), update }));
    const result = await start({ baseline: archiveBaselineFor(stored), action: 'restore' });
    expect(result).toMatchObject({ status: 'complete', patch: { status: 'draft' } });
    expect(Object.keys(result.patch).sort()).toEqual(['status', 'updatedAt']);
    expect(stored.approvalStatus).toBe('approved'); expect(stored.scheduledDate).toBe('2026-10-10T12:00:00.000Z');
  });
  it('uses a monotonic timestamp beyond future-dated revisions', async () => {
    const stored = original({ updatedAt: '2090-01-01T00:00:00.000Z' });
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(stored), update }));
    expect((await start({ baseline: archiveBaselineFor(stored) })).patch.updatedAt).toBe('2090-01-01T00:00:00.001Z');
  });
  it.each(['uid', 'clientId', 'client', 'status', 'updatedAt'])('refuses fresh %s changes before preparing an update', async field => {
    const values = { uid: 'other-owner', clientId: 'beta', client: 'Renamed', status: 'posted', updatedAt: '2026-10-03T12:00:01.000Z' };
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(original({ [field]: values[field] })), update }));
    expect(await start()).toMatchObject({ status: 'stopped', confirmed: false, writePrepared: false });
    expect(update).not.toHaveBeenCalled();
  });
  it('refuses a deleted thread', async () => {
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(null), update }));
    expect(await start()).toMatchObject({ status: 'stopped', error: { code: 'archive_conflict' } });
    expect(update).not.toHaveBeenCalled();
  });
  it.each(['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'])('refuses fresh own-presence %s even when null', async field => {
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: async () => snapshot(original({ [field]: null })), update }));
    expect(await start()).toMatchObject({ status: 'stopped', error: { code: 'archive_protected' } });
    expect(update).not.toHaveBeenCalled();
  });
  it.each([undefined, null, '', 'not-a-date', '2026-02-30T12:00:00.000Z', '2026-10-03T12:00:00', new Date(), 1])('does not invent revision proof for %j', async updatedAt => {
    expect(archiveBaselineFor(original({ updatedAt }))).toBeNull();
    expect(await start({ baseline: original({ updatedAt }) })).toMatchObject({ status: 'stopped', error: { code: 'archive_baseline' } });
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it.each(['2026-10-03T12:00:00Z', '2026-10-03T12:00:00.1Z', '2026-10-03T12:00:00.12Z'])('preserves exact legitimate UTC revision %s', updatedAt => {
    expect(archiveBaselineFor(original({ updatedAt })).updatedAt).toBe(updatedAt);
  });
  it.each([{ action: 'restore' }, { action: 'invalid' }, { action: 'archive', baseline: archiveBaselineFor(original({ status: 'archived' })) }])('refuses obsolete/unsupported transition %#', async patch => {
    expect(await start(patch)).toMatchObject({ status: 'stopped' }); expect(runTransaction).not.toHaveBeenCalled();
  });
  it('captures a copy rather than a mutable source object', () => {
    const post = original(), baseline = archiveBaselineFor(post);
    post.clientId = 'beta'; expect(baseline.clientId).toBe('acme'); expect(Object.isFrozen(baseline)).toBe(true);
  });
  it.each(['uid', 'clientId', 'client', 'status', 'updatedAt'])('requires an own stored %s baseline rather than inherited proof', field => {
    const data = original(), inherited = Object.create({ [field]: data[field] });
    for (const [key, value] of Object.entries(data)) if (key !== field) inherited[key] = value;
    expect(archiveBaselineFor(inherited)).toBeNull();
  });
  it('checks admission before starting, after the server read and before each attempted write', async () => {
    const assertAdmission = vi.fn();
    expect(await start({ assertAdmission })).toMatchObject({ status: 'complete' });
    expect(assertAdmission).toHaveBeenCalledTimes(5);
  });
  it('stops before a transaction when initial admission is retired', async () => {
    expect(await start({ assertAdmission: () => { throw new Error('retired'); } })).toMatchObject({ status: 'stopped', writePrepared: false });
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it('stops after a delayed read when admission retires before any write', async () => {
    const pending = deferred(); let current = true;
    runTransaction.mockImplementation(async (_db, callback) => callback({ get: () => pending.promise, update }));
    const attempt = start({ assertAdmission: () => { if (!current) throw new Error('retired'); } });
    current = false; pending.resolve(snapshot(original()));
    expect(await attempt).toMatchObject({ status: 'stopped', writePrepared: false }); expect(update).not.toHaveBeenCalled();
  });
  it('rechecks a retried callback and holds after an earlier prepared write without claiming cancellation', async () => {
    runTransaction.mockImplementation(async (_db, callback) => {
      await callback({ get: async () => snapshot(original()), update });
      await callback({ get: async () => snapshot(original({ status: 'posted' })), update });
    });
    expect(await start()).toMatchObject({ status: 'needs_checking', confirmed: false, writePrepared: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('rechecks protected presence on callback retry', async () => {
    runTransaction.mockImplementation(async (_db, callback) => {
      await callback({ get: async () => snapshot(original()), update });
      await callback({ get: async () => snapshot(original({ reviewDetailsAck: {} })), update });
    });
    expect(await start()).toMatchObject({ status: 'needs_checking', error: { code: 'archive_protected' } });
    expect(update).toHaveBeenCalledTimes(1);
  });
  it('retains an unknown-result hold after a prepared write loses its response', async () => {
    runTransaction.mockImplementation(async (_db, callback) => {
      await callback({ get: async () => snapshot(original()), update }); throw new Error('unknown transport');
    });
    expect(await start()).toMatchObject({ status: 'needs_checking', confirmed: false, writePrepared: true });
  });
  it('records a fulfilled commit separately from a retired initiating session', async () => {
    let current = true;
    runTransaction.mockImplementation(async (_db, callback) => { await callback({ get: async () => snapshot(original()), update }); current = false; });
    expect(await start({ assertAdmission: () => { if (!current) throw new Error('retired'); } }))
      .toMatchObject({ status: 'needs_checking', confirmed: true, writePrepared: true });
  });
  it('does not fabricate completion when the transaction callback was not invoked', async () => {
    runTransaction.mockResolvedValue(undefined);
    expect(await start()).toMatchObject({ status: 'stopped', error: { code: 'archive_control' } });
    expect(update).not.toHaveBeenCalled();
  });
});
