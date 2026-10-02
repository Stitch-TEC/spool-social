import { describe, expect, it, vi } from 'vitest';
import { OPERATOR_UID } from '../config/roles';
import { intentIndexedDB } from '../test/intentIndexedDB';
import { createJournal, createScope, isEmptyDraftIntent, validateCreatePayload, validateIntent, workCopy } from './createJournal';
import { intentRequest } from './createTransport';

const scope = createScope({ principalId: 'feedback-test', clientId: 'synthetic-client', projectId: 'demo-spool' });
const work = workCopy({ platform: 'linkedin', client: 'Synthetic Client', content: 'Synthetic unscheduled draft', status: 'draft', scheduledDate: '' });
const payload = { ...work, scheduledDate: null, slug: '', uid: OPERATOR_UID, clientId: scope.clientId,
  approvalStatus: 'pending', feedback: '', reviewStage: 'in_review',
  createdAt: '2026-10-02T17:00:00.000Z', updatedAt: '2026-10-02T17:00:00.000Z' };
const fields = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
  value === null ? { nullValue: null } : Array.isArray(value) ? { arrayValue: { values: value.map(v => ({ stringValue: v })) } }
    : typeof value === 'boolean' ? { booleanValue: value } : { stringValue: value },
]));
const response = (id, values = payload) => ({ ok: true, json: async () => ({
  name: `projects/demo-spool/databases/(default)/documents/posts/${id}`, fields: fields(values),
}) });

describe('client feedback: unscheduled create and narrow empty recovery', () => {
  it('keeps an unscheduled null payload separate from blank datetime-local work through all states', async () => {
    const j = createJournal(intentIndexedDB());
    let record = await j.begin(scope, work);
    record = await j.prepare(record, payload, work);
    record = await j.claim(record);
    record = await j.acknowledge(record, { ...payload, id: record.id });
    expect(record.baselineWork.scheduledDate).toBe('');
    expect(record.baseline.scheduledDate).toBeNull();
    record = await j.complete(record);
    expect(validateIntent(record, scope).payload.scheduledDate).toBeNull();
    expect((await j.read(scope)).state).toBe('complete');
  });

  it('sends the only explicit null date through the exact reserved-ID REST POST and reads it without retries', async () => {
    const j = createJournal(intentIndexedDB());
    const record = await j.prepare(await j.begin(scope, work), payload, work);
    const user = { uid: scope.principalId, getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe(`https://firestore.googleapis.com/v1/projects/demo-spool/databases/(default)/documents/posts?documentId=${record.id}`);
      expect(init.method).toBe('POST');
      expect((await j.read(scope)).state).toBe('submitted');
      expect(JSON.parse(init.body).fields.scheduledDate).toEqual({ nullValue: null });
      return response(record.id);
    });
    expect(await intentRequest({ record, getUser: () => user, create: true, beforeCreate: () => j.claim(record), fetcher }))
      .toMatchObject({ id: record.id, scheduledDate: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async (url, init) => {
      expect(url).toBe(`https://firestore.googleapis.com/v1/projects/demo-spool/databases/(default)/documents/posts/${record.id}`);
      expect(init.method).toBe('GET');
      return response(record.id);
    });
    expect(await intentRequest({ record: await j.read(scope), getUser: () => user, fetcher }))
      .toMatchObject({ id: record.id, scheduledDate: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['content', 'title', 'imageUrl', 'altText', 'metaDescription', 'tags', 'uid', 'clientId'])('does not make %s nullable', key => {
    expect(() => validateCreatePayload({ ...payload, [key]: null }, scope)).toThrow('could not be prepared');
  });

  it('rejects wrong null acknowledgement or absent date rather than guessing an unscheduled value', async () => {
    const j = createJournal(intentIndexedDB());
    const record = await j.prepare(await j.begin(scope, work), payload, work);
    const user = { uid: scope.principalId, getIdToken: async () => 'synthetic-token' };
    for (const changed of [{ ...payload, scheduledDate: '' }, { ...payload, scheduledDate: '2026-10-02T17:00:00.000Z' },
      Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'scheduledDate'))]) {
      const fetcher = vi.fn(async () => response(record.id, changed));
      await expect(intentRequest({ record, getUser: () => user, fetcher })).rejects.toThrow('differs');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1].method).toBe('GET');
    }
  });

  it.each([{ nullValue: false }, { nullValue: 'NULL_VALUE' }, { nullValue: null, stringValue: '' }, { nullValue: null, booleanValue: false }])('refuses malformed null acknowledgement %j', async scheduledDate => {
    const j = createJournal(intentIndexedDB());
    const record = await j.prepare(await j.begin(scope, work), payload, work);
    const user = { uid: scope.principalId, getIdToken: async () => 'synthetic-token' };
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({
      name: `projects/demo-spool/databases/(default)/documents/posts/${record.id}`,
      fields: { ...fields(payload), scheduledDate },
    }) }));
    await expect(intentRequest({ record, getUser: () => user, fetcher })).rejects.toThrow('invalid field');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
    expect((await j.read(scope)).state).toBe('prepared');
  });

  it('accepts only empty never-prepared ordinary draft slots, including a legacy default date preference', async () => {
    const j = createJournal(intentIndexedDB());
    const record = await j.begin(scope, { ...work, content: '', scheduledDate: '2026-10-01T21:22' });
    expect(isEmptyDraftIntent(record)).toBe(true);
    for (const key of ['content', 'title', 'imageUrl', 'altText', 'metaDescription']) {
      expect(isEmptyDraftIntent({ ...record, work: { ...record.work, [key]: ' ' } })).toBe(false);
    }
    expect(isEmptyDraftIntent({ ...record, work: { ...record.work, tags: ['hold'] } })).toBe(false);
    expect(isEmptyDraftIntent({ ...record, work: { ...record.work, status: 'posted' } })).toBe(false);
    expect(isEmptyDraftIntent({ ...record, work: { ...record.work, isTemplate: true } })).toBe(false);
    for (const state of ['prepared', 'submitted', 'confirmed', 'complete', 'discarded']) {
      expect(isEmptyDraftIntent({ ...record, state })).toBe(false);
    }
    expect(isEmptyDraftIntent({ ...record, payload })).toBe(false);
    expect(isEmptyDraftIntent({ ...record, submittedWork: work })).toBe(false);
  });
});
