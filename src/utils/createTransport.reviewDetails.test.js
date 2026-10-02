import { describe, expect, it, vi } from 'vitest';
import { intentIndexedDB } from '../test/intentIndexedDB';
import { OPERATOR_UID } from '../config/roles';
import { createJournal, createScope, workCopy } from './createJournal';
import { intentRequest } from './createTransport';

const scope = createScope({ principalId: 'synthetic-user', clientId: 'synthetic-client', projectId: 'demo-spool' });
const legacyWork = workCopy({ platform: 'linkedin', content: 'Synthetic caption', client: 'Synthetic Client', status: 'draft', scheduledDate: '' });
const media = { id: 'media01234567890123456789', url: 'https://youtu.be/synthetic?token=a%2Fb', label: 'Cut one', version: 'v2' };
const details = { reviewDetailsVersion: 1, firstComment: 'Separate text\nhttps://example.com/', reviewMedia: [media] };
const field = value => value === null ? { nullValue: null } : typeof value === 'string' ? { stringValue: value }
  : typeof value === 'boolean' ? { booleanValue: value } : typeof value === 'number' ? { integerValue: String(value) }
    : Array.isArray(value) ? { arrayValue: { values: value.map(field) } }
      : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, field(entry)])) } };
const bodyFor = record => ({ name: `projects/demo-spool/databases/(default)/documents/posts/${record.id}`,
  fields: Object.fromEntries(Object.entries(record.payload).map(([key, value]) => [key, field(value)])) });
async function fixture(optional = details) {
  const journal = createJournal(intentIndexedDB()); const work = { ...legacyWork, ...optional };
  const payload = { ...work, scheduledDate: null, slug: '', uid: OPERATOR_UID, clientId: scope.clientId,
    approvalStatus: 'pending', feedback: '', reviewStage: 'in_review',
    createdAt: '2026-10-02T17:00:00.000Z', updatedAt: '2026-10-02T17:00:00.000Z' };
  const record = await journal.prepare(await journal.begin(scope, work), payload, work);
  const user = { uid: scope.principalId, getIdToken: async () => 'synthetic-token' };
  return { journal, record, user };
}

describe('review details: narrow create transport and exact acknowledgement', () => {
  it('encodes the version as canonical integer and only review-media items as flat maps', async () => {
    const { journal, record, user } = await fixture();
    const fetcher = vi.fn(async (url, init) => {
      expect((await journal.read(scope)).state).toBe('submitted');
      expect(url.endsWith(`?documentId=${record.id}`)).toBe(true);
      const body = JSON.parse(init.body);
      expect(body.fields.reviewDetailsVersion).toEqual({ integerValue: '1' });
      expect(body.fields.reviewMedia).toEqual({ arrayValue: { values: [{ mapValue: { fields: {
        id: { stringValue: media.id }, url: { stringValue: media.url }, label: { stringValue: media.label }, version: { stringValue: media.version },
      } } }] } });
      expect(body.fields.firstComment).toEqual({ stringValue: details.firstComment });
      expect(body.fields.scheduledDate).toEqual({ nullValue: null });
      return { ok: true, json: async () => ({ name: bodyFor(record).name, fields: body.fields }) };
    });
    const post = await intentRequest({ record, getUser: () => user, create: true, beforeCreate: () => journal.claim(record), fetcher });
    expect(post).toEqual({ ...record.payload, id: record.id });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await journal.acknowledge(await journal.read(scope), post)).baselineWork).toMatchObject(details);
  });
  it('accepts reordered map-member keys without changing array order or frozen payload shape', async () => {
    const { record, user } = await fixture(); const body = bodyFor(record);
    const fields = body.fields.reviewMedia.arrayValue.values[0].mapValue.fields;
    body.fields.reviewMedia.arrayValue.values[0].mapValue.fields = Object.fromEntries(Object.entries(fields).reverse());
    const result = await intentRequest({ record, getUser: () => user, fetcher: async () => ({ ok: true, json: async () => body }) });
    expect(result.reviewMedia).toEqual([media]);
    expect(record.payload.reviewMedia).toEqual([media]);
  });
  it.each([{ integerValue: 1 }, { integerValue: '01' }, { integerValue: '2' },
    { integerValue: '1', stringValue: '1' }, { doubleValue: 1 }, { integerValue: null }])('rejects malformed version acknowledgement %# without re-create', async marker => {
    const { journal, record, user } = await fixture(); const body = bodyFor(record); body.fields.reviewDetailsVersion = marker;
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => body }));
    await expect(intentRequest({ record, getUser: () => user, fetcher })).rejects.toThrow('invalid field');
    expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual(['GET']);
    expect((await journal.read(scope)).state).toBe('prepared');
  });
  it.each([
    { mapValue: { fields: {} } },
    { arrayValue: { values: 'not-an-array' } },
    { arrayValue: { values: [], extra: true } },
    { arrayValue: { values: [field({ ...media, injected: 'bad' })] } },
    { arrayValue: { values: [{ mapValue: { fields: { ...field(media).mapValue.fields, url: { stringValue: media.url, nullValue: null } } } }] } },
    { arrayValue: { values: [{ mapValue: { fields: { ...field(media).mapValue.fields, url: { mapValue: { fields: {} } } } } }] } },
    { arrayValue: { values: [field(media)] }, stringValue: 'conflicting' },
  ])('refuses malformed or nested media acknowledgement %#', async reviewMedia => {
    const { record, user } = await fixture(); const body = bodyFor(record); body.fields.reviewMedia = reviewMedia;
    await expect(intentRequest({ record, getUser: () => user, fetcher: async () => ({ ok: true, json: async () => body }) })).rejects.toThrow('invalid field');
  });
  it.each(['content', 'isTemplate', 'tags', 'firstComment'])('requires exact value-kind unions for %s too', async key => {
    const { record, user } = await fixture(); const body = bodyFor(record);
    body.fields[key] = { ...body.fields[key], nullValue: null };
    await expect(intentRequest({ record, getUser: () => user, fetcher: async () => ({ ok: true, json: async () => body }) })).rejects.toThrow('invalid field');
  });
  it.each(['missing-comment', 'new-version', 'different-url', 'different-label', 'duplicate-url', 'missing-marker'])('rejects changed or malformed review details %s', async change => {
    const { record, user } = await fixture(); const body = bodyFor(record);
    if (change === 'missing-comment') delete body.fields.firstComment;
    if (change === 'missing-marker') delete body.fields.reviewDetailsVersion;
    if (change === 'new-version') body.fields.reviewMedia = field([{ ...media, version: 'v3' }]);
    if (change === 'different-url') body.fields.reviewMedia = field([{ ...media, url: 'https://youtu.be/other' }]);
    if (change === 'different-label') body.fields.reviewMedia = field([{ ...media, label: 'Other' }]);
    if (change === 'duplicate-url') body.fields.reviewMedia = field([media, { ...media, id: 'another0123456789012345' }]);
    await expect(intentRequest({ record, getUser: () => user, fetcher: async () => ({ ok: true, json: async () => body }) })).rejects.toThrow(/differs|invalid field/);
  });
  it('retains exact optional absence, accepts empty Firestore arrays, and rejects new unseen metadata on a legacy attempt', async () => {
    const { record, user } = await fixture({ reviewDetailsVersion: 1, reviewMedia: [] }); const body = bodyFor(record);
    body.fields.reviewMedia = { arrayValue: {} };
    const post = await intentRequest({ record, getUser: () => user, fetcher: async () => ({ ok: true, json: async () => body }) });
    expect(post.reviewMedia).toEqual([]); expect(post).not.toHaveProperty('firstComment');
    const legacy = await fixture({}); const changed = bodyFor(legacy.record);
    Object.assign(changed.fields, { reviewDetailsVersion: { integerValue: '1' }, firstComment: { stringValue: '' } });
    await expect(intentRequest({ record: legacy.record, getUser: () => legacy.user, fetcher: async () => ({ ok: true, json: async () => changed }) })).rejects.toThrow('differs');
  });
  it('does not widen integer encoding for required strings or treat unrelated legacy response metadata as required fields', async () => {
    const { journal, record, user } = await fixture({}); const body = bodyFor(record);
    body.fields.legacyTimestamp = { timestampValue: '2026-10-02T17:00:00Z' };
    body.fields.legacyCounter = { integerValue: '7' };
    const fetcher = async () => ({ ok: true, json: async () => body });
    const post = await intentRequest({ record, getUser: () => user, fetcher });
    const confirmed = await journal.acknowledge(record, post);
    expect(await intentRequest({ record: confirmed, getUser: () => user, fetcher })).toEqual(post);
    const wrong = bodyFor(record); wrong.fields.content = { integerValue: '1' };
    await expect(intentRequest({ record, getUser: () => user, fetcher: async () => ({ ok: true, json: async () => wrong }) })).rejects.toThrow('invalid field');
  });
});
