import { describe, expect, it, vi } from 'vitest';
import { intentIndexedDB } from '../test/intentIndexedDB';
import { OPERATOR_UID } from '../config/roles';
import { CREATE_JOURNAL_DATABASE, CREATE_JOURNAL_NATIVE_VERSION, createJournal, createScope,
  isEmptyDraftIntent, validateCreatePayload, validateIntent, workCopy } from './createJournal';

const scope = createScope({ principalId: 'synthetic-user', clientId: 'synthetic-client', projectId: 'demo-spool' });
const legacyWork = workCopy({ platform: 'linkedin', content: 'Synthetic caption', client: 'Synthetic Client', status: 'draft', scheduledDate: '' });
const payloadFor = work => ({ ...work, scheduledDate: null, slug: '', uid: OPERATOR_UID, clientId: scope.clientId,
  approvalStatus: 'pending', feedback: '', reviewStage: 'in_review',
  createdAt: '2026-10-02T17:00:00.000Z', updatedAt: '2026-10-02T17:00:00.000Z' });
const media = { id: 'media01234567890123456789', url: 'https://youtu.be/synthetic?token=a%2Fb', label: 'Cut one', version: 'v2' };
const extended = { ...legacyWork, reviewDetailsVersion: 1, firstComment: 'Separate comment\nhttps://example.com/', reviewMedia: [media] };

describe('review details: reserved-ID compatibility foundation', () => {
  it('opens native version 2 under the unchanged database and scope key', async () => {
    const factory = intentIndexedDB(); factory.open = vi.fn(factory.open);
    const j = createJournal(factory); const r = await j.begin(scope, legacyWork);
    expect(factory.open).toHaveBeenCalledWith('spool-create-recovery-v3', 2);
    expect(CREATE_JOURNAL_DATABASE).toBe('spool-create-recovery-v3');
    expect(CREATE_JOURNAL_NATIVE_VERSION).toBe(2);
    expect(scope.version).toBe(3);
    expect(r.scope.key).toBe(scope.key);
  });
  it('preserves legacy work and frozen null payload without injected optional properties in every state', async () => {
    const factory = intentIndexedDB(); const j = createJournal(factory);
    let r = await j.begin(scope, legacyWork); const id = r.id;
    const payload = payloadFor(legacyWork); const originalBytes = JSON.stringify(payload);
    for (const advance of [() => j.prepare(r, payload, legacyWork), () => j.claim(r),
      () => j.acknowledge(r, { ...payload, id }), () => j.complete(r)]) {
      r = await advance();
      const before = JSON.stringify([...factory.rows]);
      const read = await createJournal(factory).read(scope);
      expect(JSON.stringify(read.payload)).toBe(originalBytes);
      expect(JSON.stringify(read.submittedWork)).toBe(JSON.stringify(legacyWork));
      expect(read.id).toBe(id); expect(read.revision).toBe(1);
      expect(read.work).not.toHaveProperty('reviewDetailsVersion');
      expect(JSON.stringify([...factory.rows])).toBe(before);
    }
  });
  it('copies bounded optional fields deeply and exactly without normalizing their absence', () => {
    expect(workCopy(legacyWork)).toEqual(legacyWork);
    const copy = workCopy(extended);
    expect(copy).toEqual(extended);
    expect(copy.reviewMedia).not.toBe(extended.reviewMedia);
    expect(copy.reviewMedia[0]).not.toBe(media);
    expect(workCopy({ ...legacyWork, reviewDetailsVersion: 1 })).toEqual({ ...legacyWork, reviewDetailsVersion: 1 });
    expect(copy.firstComment).toBe(extended.firstComment);
  });
  it('lets newer extended work coexist with an immutable legacy submitted payload under the same ID', async () => {
    const j = createJournal(intentIndexedDB()); const payload = payloadFor(legacyWork);
    let r = await j.prepare(await j.begin(scope, legacyWork), payload, legacyWork);
    r = await j.claim(r); const id = r.id;
    r = await j.writeWork(r, extended);
    expect(r).toMatchObject({ id, revision: 2, state: 'submitted', work: extended, payload, submittedWork: legacyWork });
    expect(r.payload).not.toHaveProperty('reviewDetailsVersion');
    r = await j.acknowledge(r, { ...payload, id });
    expect(r.baselineWork).not.toHaveProperty('reviewDetailsVersion');
    expect(r.work).toEqual(extended);
  });
  it('keeps a sticky extension marker and preserves the exact ID/revision on rejected omission', async () => {
    const j = createJournal(intentIndexedDB()); const r = await j.begin(scope, extended);
    await expect(j.writeWork(r, legacyWork)).rejects.toThrow('review details version');
    await expect(j.prepare(r, payloadFor(legacyWork), legacyWork)).rejects.toThrow('review details version');
    expect(await j.read(scope)).toEqual({ ...r, key: scope.key });
    const cleared = await j.writeWork(r, { ...legacyWork, reviewDetailsVersion: 1, firstComment: '', reviewMedia: [] });
    expect(cleared).toMatchObject({ id: r.id, revision: 2, state: 'draft', work: { reviewDetailsVersion: 1 } });
  });
  it('binds optional submission and baseline shapes exactly, including absent versus empty', async () => {
    const j = createJournal(intentIndexedDB()); let r = await j.begin(scope, extended);
    const payload = payloadFor(extended);
    await expect(j.prepare(r, { ...payload, firstComment: '' }, extended)).rejects.toThrow('identity');
    expect((await j.read(scope)).state).toBe('draft');
    r = await j.claim(await j.prepare(r, payload, extended));
    const { firstComment: omitted, ...withoutComment } = payload;
    expect(omitted).toBe(extended.firstComment);
    await expect(j.acknowledge(r, { ...withoutComment, id: r.id })).rejects.toThrow('identity');
    expect((await j.read(scope)).state).toBe('submitted');
    const confirmed = await j.acknowledge(r, { ...payload, id: r.id });
    expect(validateIntent(confirmed, scope)).toBe(confirmed);
  });
  it.each([{ firstComment: '' }, { reviewMedia: [] }, { reviewDetailsVersion: '1' },
    { reviewDetailsVersion: 1, firstComment: 'x'.repeat(4001) },
    { reviewDetailsVersion: 1, reviewMedia: [{ ...media, injected: 'bad' }] },
    { reviewDetailsVersion: 1, reviewMedia: [media, media] }])('refuses malformed extension before work or payload preparation %#', patch => {
    expect(() => workCopy({ ...legacyWork, ...patch })).toThrow('Review details');
    expect(() => validateCreatePayload({ ...payloadFor(legacyWork), ...patch }, scope)).toThrow('could not be prepared');
  });
  it('never treats authored first-comment or media-only work as empty recovery', async () => {
    const j = createJournal(intentIndexedDB());
    const r = await j.begin(scope, { ...legacyWork, content: '', reviewDetailsVersion: 1, firstComment: '', reviewMedia: [] });
    expect(isEmptyDraftIntent(r)).toBe(true);
    expect(isEmptyDraftIntent({ ...r, work: { ...r.work, firstComment: ' ' } })).toBe(false);
    expect(isEmptyDraftIntent({ ...r, work: { ...r.work, reviewMedia: [media] } })).toBe(false);
  });
});
