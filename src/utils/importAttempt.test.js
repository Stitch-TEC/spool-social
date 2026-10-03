import { describe, expect, it, vi } from 'vitest';
import { runImportAttempt } from './importAttempt';

const entries = count => Array.from({ length: count }, (_, index) => ({ ref: { id: `fixed-${index}` }, data: { content: `Draft ${index}` }, size: 1 }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = (commit = async () => {}) => {
  const chunks = [];
  const createBatch = vi.fn(() => {
    const chunk = []; chunks.push(chunk);
    return { set: (ref, data) => chunk.push({ ref, data }), commit: () => commit(chunks.length) };
  });
  return { chunks, createBatch };
};

describe('page-memory import attempt', () => {
  it('uses the prepared identities once and confirms each fulfilled batch', async () => {
    const f = fixture(), plan = entries(3);
    expect(await runImportAttempt({ entries: plan, isCurrent: () => true, createBatch: f.createBatch, maxOps: 2 }))
      .toEqual({ status: 'complete', total: 3, confirmed: 3, ids: plan.map(e => e.ref.id) });
    expect(f.chunks.map(chunk => chunk.map(e => e.ref.id))).toEqual([['fixed-0', 'fixed-1'], ['fixed-2']]);
  });
  it('stops before dispatch without claiming an uncertain write', async () => {
    const f = fixture();
    const result = await runImportAttempt({ entries: entries(2), isCurrent: () => false, createBatch: f.createBatch });
    expect(result).toMatchObject({ status: 'stopped', reason: 'admission_changed', confirmed: 0, unconfirmedIds: [], notDispatchedIds: ['fixed-0', 'fixed-1'] });
    expect(f.createBatch).not.toHaveBeenCalled();
  });
  it('checks admission again after constructing a batch, before its dispatch', async () => {
    let current = true;
    const commit = vi.fn();
    const result = await runImportAttempt({ entries: entries(1), isCurrent: () => current,
      createBatch: () => ({ set: () => { current = false; }, commit }) });
    expect(result.status).toBe('stopped'); expect(commit).not.toHaveBeenCalled();
  });
  it('preserves first-batch uncertainty rather than reporting zero imported', async () => {
    const error = new Error('response lost'), f = fixture(async () => { throw error; });
    expect(await runImportAttempt({ entries: entries(3), isCurrent: () => true, createBatch: f.createBatch, maxOps: 2 }))
      .toMatchObject({ status: 'needs_checking', reason: 'unconfirmed_commit', confirmed: 0,
        unconfirmedIds: ['fixed-0', 'fixed-1'], notDispatchedIds: ['fixed-2'], error });
    expect(f.chunks).toHaveLength(1);
  });
  it('retains confirmed progress and the exact uncertain second batch', async () => {
    const f = fixture(async n => { if (n === 2) throw new Error('response lost'); });
    expect(await runImportAttempt({ entries: entries(5), isCurrent: () => true, createBatch: f.createBatch, maxOps: 2 }))
      .toMatchObject({ status: 'needs_checking', confirmed: 2, unconfirmedIds: ['fixed-2', 'fixed-3'], notDispatchedIds: ['fixed-4'] });
  });
  it('does not dispatch another batch after identity changes while a commit is pending', async () => {
    const wait = deferred(); let current = true; const f = fixture(() => wait.promise);
    const attempt = runImportAttempt({ entries: entries(3), isCurrent: () => current, createBatch: f.createBatch, maxOps: 2 });
    current = false; wait.resolve();
    expect(await attempt).toMatchObject({ status: 'needs_checking', reason: 'admission_changed', confirmed: 2,
      unconfirmedIds: [], notDispatchedIds: ['fixed-2'] });
    expect(f.chunks).toHaveLength(1);
  });
  it('keeps commit rejection uncertain even when admission also changes', async () => {
    const wait = deferred(); let current = true; const f = fixture(() => wait.promise);
    const attempt = runImportAttempt({ entries: entries(1), isCurrent: () => current, createBatch: f.createBatch });
    current = false; wait.reject(new Error('late rejection'));
    expect(await attempt).toMatchObject({ status: 'needs_checking', reason: 'unconfirmed_commit', confirmed: 0, unconfirmedIds: ['fixed-0'] });
  });
  it('distinguishes a local preparation failure before any dispatch', async () => {
    const result = await runImportAttempt({ entries: entries(1), isCurrent: () => true, createBatch: () => { throw new Error('local'); } });
    expect(result).toMatchObject({ status: 'stopped', reason: 'local_failure', unconfirmedIds: [], notDispatchedIds: ['fixed-0'] });
  });
  it('holds after a later local failure once prior writes were confirmed', async () => {
    let n = 0; const f = fixture();
    const result = await runImportAttempt({ entries: entries(2), isCurrent: () => true, maxOps: 1,
      createBatch: () => { if (++n === 2) throw new Error('local'); return f.createBatch(); } });
    expect(result).toMatchObject({ status: 'needs_checking', reason: 'local_failure', confirmed: 1, notDispatchedIds: ['fixed-1'] });
  });
  it('chunks by byte budget without changing identities or dropping rows', async () => {
    const f = fixture(); const plan = entries(3).map(e => ({ ...e, size: 5 }));
    const result = await runImportAttempt({ entries: plan, isCurrent: () => true, createBatch: f.createBatch, maxBytes: 6 });
    expect(result.confirmed).toBe(3); expect(f.chunks).toHaveLength(3);
  });
});
