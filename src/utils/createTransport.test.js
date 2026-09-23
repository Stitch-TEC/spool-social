import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJournal, createScope, workCopy } from './createJournal';
import { intentRequest } from './createTransport';
import { intentIndexedDB } from '../test/intentIndexedDB';
import { OPERATOR_UID } from '../config/roles';

const scope = createScope({ principalId: 'fictional-user', clientId: 'acme', projectId: 'demo-spool' });
const work = workCopy({ content: 'Invented local draft', client: 'Acme', platform: 'gmb', status: 'draft', scheduledDate: '2026-09-23T12:00' });
const payload = { ...work, slug: '', uid: OPERATOR_UID, clientId: 'acme', approvalStatus: 'pending', feedback: '', reviewStage: 'private', createdAt: '2026-09-23T19:00:00.000Z', updatedAt: '2026-09-23T19:00:00.000Z' };
const field = value => Array.isArray(value) ? { arrayValue: { values: value.map(field) } } : typeof value === 'boolean' ? { booleanValue: value } : { stringValue: value };
const body = (record, overrides = {}) => ({ name: `projects/demo-spool/databases/(default)/documents/posts/${record.id}`, fields: Object.fromEntries(Object.entries({ ...record.payload, ...overrides }).map(([key, value]) => [key, field(value)])) });
async function fixture() {
  const journal = createJournal(intentIndexedDB());
  const record = await journal.prepare(await journal.begin(scope, work), payload, work);
  const user = { uid: scope.principalId, getIdToken: vi.fn().mockResolvedValue('invented-test-token') };
  return { journal, record, user };
}
afterEach(() => vi.restoreAllMocks());

describe('rules-token create-only request', () => {
  it('waits for durable submission before the only POST and returns exact identity', async () => {
    const { journal, record, user } = await fixture();
    const fetcher = vi.fn(async (url, init) => {
      expect((await journal.read(scope)).state).toBe('submitted');
      expect(url).toBe(`https://firestore.googleapis.com/v1/projects/demo-spool/databases/(default)/documents/posts?documentId=${record.id}`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer invented-test-token');
      expect(JSON.parse(init.body)).toEqual({ fields: body(record).fields });
      return { ok: true, json: async () => body(record) };
    });
    const result = await intentRequest({ record, getUser: () => user, create: true, beforeCreate: () => journal.claim(record), fetcher });
    expect(result).toEqual({ ...payload, id: record.id });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404, 409, 500])('keeps %i read results unresolved without POST fallback', async status => {
    const { journal, record, user } = await fixture();
    const submitted = await journal.claim(record);
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status });
    await expect(intentRequest({ record: submitted, getUser: () => user, fetcher })).rejects.toThrow('not confirmed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
    expect((await journal.read(scope)).state).toBe('submitted');
  });
  it('never dispatches after failed admission, unknown principal or same-UID replacement during token lookup', async () => {
    const { record, user } = await fixture(); const fetcher = vi.fn();
    await expect(intentRequest({ record, getUser: () => user, create: true, beforeCreate: async () => { throw new Error('transaction aborted'); }, fetcher })).rejects.toThrow('transaction aborted');
    await expect(intentRequest({ record, getUser: () => null, fetcher })).rejects.toThrow('sign-in changed');
    let current = user;
    user.getIdToken.mockImplementation(async () => { current = { ...user }; return 'invented-token'; });
    await expect(intentRequest({ record, getUser: () => current, create: true, beforeCreate: vi.fn(), fetcher })).rejects.toThrow('sign-in changed');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rechecks editor/session after admission and never sends if closed', async () => {
    const { journal, record, user } = await fixture(); let alive = true; const fetcher = vi.fn();
    await expect(intentRequest({ record, getUser: () => user, maySend: () => alive, create: true, beforeCreate: async () => { await journal.claim(record); alive = false; }, fetcher })).rejects.toThrow('editor or sign-in changed');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await journal.read(scope)).state).toBe('submitted');
  });
  it.each([{ content: 'Another editor changed this' }, { approvalStatus: 'approved' }, { clientId: 'foreign' }, { uid: 'foreign' }])('never overwrites a changed saved copy %j', async changed => {
    const { journal, record, user } = await fixture();
    const submitted = await journal.claim(record);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => body(record, changed) });
    await expect(intentRequest({ record: submitted, getUser: () => user, fetcher })).rejects.toThrow('differs');
    expect(fetcher.mock.calls.map(c => c[1].method)).toEqual(['GET']);
  });
  it('keeps acknowledgement loss unresolved and ignores a foreign response identity', async () => {
    const { journal, record, user } = await fixture();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('connection lost after commit'));
    await expect(intentRequest({ record, getUser: () => user, create: true, beforeCreate: () => journal.claim(record), fetcher })).rejects.toThrow('not confirmed');
    expect((await journal.read(scope)).state).toBe('submitted');
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...body(record), name: 'projects/foreign/databases/(default)/documents/posts/no' }) });
    await expect(intentRequest({ record, getUser: () => user, fetcher })).rejects.toThrow('differs');
  });
});
