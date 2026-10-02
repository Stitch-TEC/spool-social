import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_UID } from '../config/roles';
import { intentIndexedDB } from '../test/intentIndexedDB';
import { createJournal, createScope, workCopy } from '../utils/createJournal';
import useCreateRecovery from './useCreateRecovery';

const scope = createScope({ principalId: 'feedback-test', clientId: 'synthetic-client', projectId: 'demo-spool' });
const work = workCopy({ client: 'Synthetic Client', content: 'Synthetic new work', platform: 'linkedin', status: 'draft', scheduledDate: '' });
const payload = { ...work, scheduledDate: null, slug: '', uid: OPERATOR_UID, clientId: scope.clientId,
  approvalStatus: 'pending', feedback: '', reviewStage: 'in_review',
  createdAt: '2026-10-02T17:00:00.000Z', updatedAt: '2026-10-02T17:00:00.000Z' };
const user = { uid: scope.principalId, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
let db;
const mount = (options = {}) => renderHook(() => useCreateRecovery({ enabled: true, scope,
  getUser: () => user, getWork: () => work, isAlive: () => true, ...options }));
const loaded = async hook => waitFor(() => expect(hook.result.current.loading).toBe(false));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  db = intentIndexedDB(); vi.stubGlobal('indexedDB', db);
  user.getIdToken.mockReset().mockResolvedValue('synthetic-token');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('client feedback: recovery does not wedge correctable input', () => {
  it('continues only the same empty unsent ID and persists a new revision without deleting anything', async () => {
    const j = createJournal(db);
    const empty = await j.begin(scope, { ...work, content: '', scheduledDate: '2026-10-01T21:22' });
    const hook = mount(); await loaded(hook);
    expect(hook.result.current).toMatchObject({ restored: true, failed: false, record: { id: empty.id, revision: 1, state: 'draft' } });
    expect(hook.result.current.saveBlockReason()).toBe('');
    await act(async () => { await hook.result.current.persist(work); });
    expect(await j.read(scope)).toMatchObject({ id: empty.id, revision: 2, work, state: 'draft', payload: null });
    expect(db.rows.size).toBe(1);
  });

  it('refuses a concurrent tab change to an admitted empty slot and preserves its authored work', async () => {
    const j = createJournal(db);
    const empty = await j.begin(scope, { ...work, content: '' });
    const hook = mount(); await loaded(hook);
    const other = await j.writeWork(empty, { ...work, content: 'Other tab authored copy' });
    await act(async () => { await expect(hook.result.current.persist(work)).rejects.toThrow('Another tab'); });
    expect(hook.result.current.failed).toBe(true);
    expect(hook.result.current.saveBlockReason()).toContain('Another tab');
    expect(await j.read(scope)).toEqual({ ...other, key: scope.key });
  });

  it.each(['content', 'title', 'altText', 'metaDescription', 'imageUrl', 'tags'])('requires deliberate restore when %s was authored', async field => {
    const record = await createJournal(db).begin(scope, { ...work, content: '', [field]: field === 'tags' ? ['hold'] : 'Authored work' });
    const hook = mount(); await loaded(hook);
    expect(hook.result.current.restored).toBe(false);
    expect(hook.result.current.saveBlockReason()).toContain('Restore or discard');
    expect(hook.result.current.record.id).toBe(record.id);
    expect(await hook.result.current.persist(work)).toBe(false);
    expect((await createJournal(db).read(scope)).revision).toBe(1);
  });

  it.each(['prepared', 'submitted', 'confirmed'])('never bypasses a %s identity even if later work is empty', async state => {
    const j = createJournal(db);
    let record = await j.prepare(await j.begin(scope, work), payload, work);
    if (state !== 'prepared') record = await j.claim(record);
    if (state === 'confirmed') record = await j.acknowledge(record, { ...payload, id: record.id });
    record = await j.writeWork(record, { ...work, content: '' });
    const hook = mount(); await loaded(hook);
    expect(hook.result.current.restored).toBe(false);
    expect(hook.result.current.record).toMatchObject({ id: record.id, state });
    expect(await hook.result.current.persist(work)).toBe(false);
    expect((await j.read(scope)).payload).toEqual(payload);
  });

  it('does not adopt an empty foreign account/client slot', async () => {
    const j = createJournal(db);
    const otherScope = createScope({ ...scope, principalId: 'other-user', clientId: 'foreign-client' });
    const foreign = await j.begin(otherScope, { ...work, content: '' });
    const hook = mount(); await loaded(hook);
    expect(hook.result.current.record).toBeNull();
    await act(async () => { await hook.result.current.persist(work); });
    expect((await j.read(otherScope)).id).toBe(foreign.id);
    expect((await j.read(scope)).id).not.toBe(foreign.id);
    expect(db.rows.size).toBe(2);
  });

  it('keeps malformed record reads blocked instead of classifying their blank fields as empty', async () => {
    const j = createJournal(db); const record = await j.begin(scope, { ...work, content: '' });
    db.rows.set(scope.key, { ...record, key: scope.key, revision: 0 });
    const hook = mount(); await loaded(hook);
    expect(hook.result.current.failed).toBe(true);
    expect(hook.result.current.saveBlockReason()).toContain('could not be verified');
    expect(await hook.result.current.persist(work)).toBe(false);
    expect(db.rows.get(scope.key).revision).toBe(0);
  });

  it.each([{ scheduledDate: {} }, { imageUrl: null }])('rejects correctable input %j without poisoning unsent discard', async patch => {
    const hook = mount(); await loaded(hook);
    await act(async () => { await hook.result.current.persist(work); });
    const id = hook.result.current.record.id;
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      await expect(hook.result.current.submit({ ...payload, ...patch }, work, user)).rejects.toThrow('No request was sent');
    });
    expect(hook.result.current).toMatchObject({ failed: false, restored: true, record: { id, state: 'draft' } });
    expect(hook.result.current.saveBlockReason()).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.discard(); });
    expect(await createJournal(db).read(scope)).toMatchObject({ id, state: 'discarded' });
    expect(hook.result.current.record).toBeNull();
  });

  it('reports missing scope and held-save reasons truthfully', async () => {
    const hook = mount({ scope: null }); await loaded(hook);
    expect(hook.result.current.saveBlockReason()).toContain('Select a known client');
    hook.unmount();
    const j = createJournal(db);
    await j.claim(await j.prepare(await j.begin(scope, work), payload, work));
    const pending = mount(); await loaded(pending);
    await act(async () => { pending.result.current.restore(); });
    expect(pending.result.current.saveBlockReason()).toContain('Check the previous save');
  });
});

describe('new-create captured admission lifetime', () => {
  it('rejects stale admission without changing or poisoning a reserved unsent draft', async () => {
    const hook = mount(); await loaded(hook);
    await act(async () => { await hook.result.current.persist(work); });
    const original = await createJournal(db).read(scope);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      await expect(hook.result.current.submit(payload, work, user, () => { throw new Error('Captured admission retired'); }))
        .rejects.toThrow('No new request was sent');
    });
    expect(hook.result.current).toMatchObject({ failed: false, record: { id: original.id, state: 'draft' } });
    expect(await createJournal(db).read(scope)).toEqual(original);
    expect(user.getIdToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.discard(); });
    expect(await createJournal(db).read(scope)).toMatchObject({ id: original.id, state: 'discarded' });
  });

  it('rechecks captured admission after a queued work write, preserving its same draft ID and newer work', async () => {
    const entered = deferred(), gate = deferred(); let armed = false;
    db = intentIndexedDB({ beforeComplete: async ({ rows }) => {
      if (armed && rows.get(scope.key)?.state === 'draft') { armed = false; entered.resolve(); await gate.promise; }
    } });
    vi.stubGlobal('indexedDB', db);
    const hook = mount(); await loaded(hook);
    await act(async () => { await hook.result.current.persist(work); });
    const original = await createJournal(db).read(scope);
    const newer = { ...work, title: 'Newer queued work' };
    let epoch = 1; const captured = epoch;
    const assertAdmission = () => { if (epoch !== captured) throw new Error('Captured epoch retired'); };
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      armed = true;
      const pendingWrite = hook.result.current.persist(newer);
      await entered.promise;
      const rejectedSave = hook.result.current.submit(payload, work, user, assertAdmission).catch(error => error);
      epoch = 2; epoch = 3; // Same actor returns, but this submission's epoch is gone.
      gate.resolve(); await pendingWrite;
      expect((await rejectedSave).message).toContain('No new request was sent');
    });
    expect(hook.result.current.failed).toBe(false);
    expect(await createJournal(db).read(scope)).toMatchObject({ id: original.id, revision: 2, state: 'draft', payload: null, work: newer });
    expect(user.getIdToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.discard(); });
    expect(await createJournal(db).read(scope)).toMatchObject({ id: original.id, state: 'discarded' });
  });

  it.each(['draft', 'prepared', 'submitted'])('keeps a delayed %s journal completion honest after captured admission retires', async state => {
    const entered = deferred(), gate = deferred(); let armed = false;
    db = intentIndexedDB({ beforeComplete: async ({ rows }) => {
      if (armed && rows.get(scope.key)?.state === state) { armed = false; entered.resolve(); await gate.promise; }
    } });
    vi.stubGlobal('indexedDB', db);
    const hook = mount(); await loaded(hook);
    if (state !== 'draft') await act(async () => { await hook.result.current.persist(work); });
    const original = await createJournal(db).read(scope);
    let epoch = 1; const captured = epoch;
    const assertAdmission = () => { if (epoch !== captured) throw new Error('Captured epoch retired'); };
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      armed = true;
      const rejectedSave = hook.result.current.submit(payload, work, user, assertAdmission).catch(error => error);
      await entered.promise;
      epoch = 2; epoch = 3;
      gate.resolve();
      expect((await rejectedSave).message).toContain('No new request was sent');
    });
    const saved = await createJournal(db).read(scope);
    expect(saved.state).toBe(state);
    if (original) expect(saved.id).toBe(original.id);
    expect(hook.result.current).toMatchObject({ failed: false, record: { id: saved.id, state } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(user.getIdToken).toHaveBeenCalledTimes(state === 'submitted' ? 1 : 0);
    if (state === 'draft') {
      await act(async () => { await hook.result.current.discard(); });
      expect(await createJournal(db).read(scope)).toMatchObject({ id: saved.id, state: 'discarded' });
    } else {
      expect(saved.payload).toEqual(payload);
      await expect(createJournal(db).discard(saved)).rejects.toThrow('may have been sent');
      expect((await createJournal(db).read(scope)).state).toBe(state);
    }
    if (state === 'submitted') expect(hook.result.current.saveBlockReason()).toContain('Check the previous save');
  });

  it('never claims or dispatches after same-user A→B→A during token acquisition', async () => {
    const token = deferred(), tokenStarted = deferred();
    user.getIdToken.mockImplementation(() => { tokenStarted.resolve(); return token.promise; });
    const hook = mount(); await loaded(hook);
    let epoch = 1; const captured = epoch;
    const assertAdmission = vi.fn(() => { if (epoch !== captured) throw new Error('Captured epoch retired'); });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await act(async () => {
      const rejectedSave = hook.result.current.submit(payload, work, user, assertAdmission).catch(error => error);
      // Polling with waitFor inside act temporarily disables the act environment
      // while the hook publishes. Wait for the actual transport boundary instead.
      await tokenStarted.promise;
      expect(user.getIdToken).toHaveBeenCalledTimes(1);
      epoch = 2; epoch = 3; token.resolve('synthetic-token');
      expect((await rejectedSave).message).toContain('No new request was sent');
    });
    expect(hook.result.current).toMatchObject({ failed: false, record: { state: 'prepared', payload } });
    expect(fetcher).not.toHaveBeenCalled(); expect(assertAdmission.mock.calls.length).toBeGreaterThan(4);
    const saved = await createJournal(db).read(scope);
    await expect(createJournal(db).discard(saved)).rejects.toThrow('may have been sent');
    expect((await createJournal(db).read(scope)).id).toBe(saved.id);
  });

  it('retains submitted uncertainty when captured admission retires after actual dispatch', async () => {
    const response = deferred(), dispatched = deferred();
    const fetcher = vi.fn(() => { dispatched.resolve(); return response.promise; }); vi.stubGlobal('fetch', fetcher);
    const hook = mount(); await loaded(hook);
    let epoch = 1; const captured = epoch;
    const assertAdmission = () => { if (epoch !== captured) throw new Error('Captured epoch retired'); };
    await act(async () => {
      const rejectedSave = hook.result.current.submit(payload, work, user, assertAdmission).catch(error => error);
      await dispatched.promise;
      expect(fetcher).toHaveBeenCalledTimes(1);
      epoch = 2; epoch = 3;
      response.resolve({ ok: true, json: async () => ({}) });
      expect((await rejectedSave).message).toContain('original save still needs checking');
    });
    const saved = await createJournal(db).read(scope);
    expect(hook.result.current).toMatchObject({ failed: false, record: { id: saved.id, state: 'submitted', payload } });
    expect(hook.result.current.saveBlockReason()).toContain('Check the previous save');
    expect(fetcher.mock.calls[0][1].method).toBe('POST');
    expect(db.rows.size).toBe(1);
    await expect(createJournal(db).discard(saved)).rejects.toThrow('may have been sent');
  });

  it('admits a current captured lifetime through one exact-ID null-schedule POST and acknowledgement', async () => {
    const assertAdmission = vi.fn();
    const fetcher = vi.fn(async (url, request) => {
      const record = await createJournal(db).read(scope);
      expect(record.state).toBe('submitted');
      expect(new URL(url).searchParams.get('documentId')).toBe(record.id);
      expect(JSON.parse(request.body).fields.scheduledDate).toEqual({ nullValue: null });
      return { ok: true, json: async () => ({ name: `projects/${scope.projectId}/databases/(default)/documents/posts/${record.id}`,
        fields: JSON.parse(request.body).fields }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const hook = mount(); await loaded(hook);
    let result;
    await act(async () => { result = await hook.result.current.submit(payload, work, user, assertAdmission); });
    expect(hook.result.current).toMatchObject({ failed: false, record: { id: result.post.id, state: 'confirmed' } });
    expect(result.submitted).toEqual(work); expect(result.post.scheduledDate).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(user.getIdToken).toHaveBeenCalledTimes(1);
    expect(assertAdmission.mock.calls.length).toBeGreaterThan(6);
  });
});
