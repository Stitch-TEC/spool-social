import { describe, expect, it } from 'vitest';
import { intentIndexedDB } from '../test/intentIndexedDB';
import { OPERATOR_UID } from '../config/roles';
import { createJournal, createScope, validateIntent, workCopy } from './createJournal';

export const testScope = createScope({ principalId: 'fictional-user', clientId: 'acme', projectId: 'demo-spool' });
export const testWork = workCopy({ content: 'Invented local draft', client: 'Acme', platform: 'gmb', status: 'draft', scheduledDate: '2026-09-23T12:00' });
export const testPayload = { ...testWork, slug: '', uid: OPERATOR_UID, clientId: 'acme', approvalStatus: 'pending', feedback: '', reviewStage: 'private', createdAt: '2026-09-23T19:00:00.000Z', updatedAt: '2026-09-23T19:00:00.000Z' };

describe('new editor create journal', () => {
  it('requires an actual principal, canonical client and project', () => {
    for (const input of [{ principalId: '' }, { clientId: 'Display Name' }, { projectId: '' }]) expect(createScope({ ...testScope, ...input })).toBeNull();
    expect(createScope({ ...testScope, principalId: 'other' }).key).not.toBe(testScope.key);
    expect(createScope({ ...testScope, isTemplate: true }).key).not.toBe(testScope.key);
  });
  it('persists one reserved ID and frozen submission separately from newer revisions', async () => {
    const db = intentIndexedDB(); const journal = createJournal(db);
    let r = await journal.begin(testScope, testWork);
    expect(r.id).toMatch(/^[a-f0-9]{32}$/);
    r = await journal.prepare(r, testPayload, testWork);
    r = await journal.claim(r);
    r = await journal.writeWork(r, { ...testWork, content: 'Newer' });
    const reread = await createJournal(db).read(testScope);
    expect(reread).toMatchObject({ id: r.id, state: 'submitted', revision: 2, payload: testPayload, submittedWork: testWork, work: { content: 'Newer' } });
    await expect(journal.claim(r)).rejects.toThrow('Check previous save');
    await expect(journal.begin(testScope, testWork)).rejects.toThrow('previous save');
  });
  it('rejects a second tab and stale acknowledgement/cleanup without changing newer work', async () => {
    const db = intentIndexedDB(); const a = createJournal(db); const b = createJournal(db);
    const claims = await Promise.allSettled([a.begin(testScope, testWork), b.begin(testScope, testWork)]);
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    let original = claims.find(r => r.status === 'fulfilled').value;
    original = await a.prepare(original, testPayload, testWork);
    original = await a.claim(original);
    const newer = await b.writeWork(original, { ...testWork, content: 'Other tab newer copy' });
    await expect(a.acknowledge(original, { ...testPayload, id: original.id })).rejects.toThrow('Another tab');
    await expect(a.complete(original)).rejects.toThrow('Another tab');
    expect((await a.read(testScope)).work.content).toBe('Other tab newer copy');
    const confirmed = await b.acknowledge(newer, { ...testPayload, id: original.id });
    await b.complete(confirmed);
    const next = await b.begin(testScope, testWork);
    expect(next.id).not.toBe(original.id);
    await expect(a.writeWork(original, testWork)).rejects.toThrow('Another tab');
  });
  it.each([{ abortAfterPut: true }, { failPut: true }, { blocked: true }, { denyOpen: true }])('fails closed for native transaction failure model %j', async flags => {
    const db = intentIndexedDB(flags);
    await expect(createJournal(db).begin(testScope, testWork)).rejects.toThrow();
    expect(db.rows.size).toBe(0);
  });
  it('does not read another account/client or accept corrupt payload before submission', async () => {
    const db = intentIndexedDB(); const j = createJournal(db);
    const draft = await j.begin(testScope, testWork);
    expect(await j.read(createScope({ ...testScope, principalId: 'other' }))).toBeNull();
    await expect(j.prepare(draft, { ...testPayload, imageUrl: {} }, testWork)).rejects.toThrow('identity');
    expect((await j.read(testScope)).state).toBe('draft');
    for (const patch of [{ clientId: 'foreign' }, { uid: 'foreign' }, { isTemplate: true }, { injected: 'bad' }]) expect(() => validateIntent({ ...draft, state: 'prepared', submittedWork: testWork, payload: { ...testPayload, ...patch } }, testScope)).toThrow();
  });
  it('fails before committing an oversized draft and never deletes other namespaces', async () => {
    const db = intentIndexedDB(); const j = createJournal(db);
    await expect(j.begin(testScope, { ...testWork, content: 'x'.repeat(2_000_001) })).rejects.toThrow('too large');
    expect(db.rows.size).toBe(0);
  });
  it('retains an edit made during retirement on the same ID, but never revives across a replacement intent', async () => {
    const j = createJournal(intentIndexedDB());
    let r = await j.begin(testScope, testWork);
    r = await j.prepare(r, testPayload, testWork);
    r = await j.claim(r);
    r = await j.acknowledge(r, { ...testPayload, id: r.id });
    const retired = await j.complete(r);
    const retained = await j.writeWork(retired, { ...testWork, content: 'Typed during retirement' });
    expect(retained).toMatchObject({ id: r.id, state: 'confirmed', revision: 2, work: { content: 'Typed during retirement' } });
    const closed = await j.complete(retained);
    await j.begin(testScope, testWork);
    await expect(j.writeWork(closed, { ...testWork, content: 'Late stale copy' })).rejects.toThrow('Another tab');
  });
  it('lets an owner discard only the exact never-submitted revision', async () => {
    const j = createJournal(intentIndexedDB());
    const initial = await j.begin(testScope, { ...testWork, content: '' });
    const changed = await j.writeWork(initial, testWork);
    await expect(j.discard(initial)).rejects.toThrow('Another tab');
    const discarded = await j.discard(changed);
    expect(discarded.state).toBe('discarded');
    await expect(j.writeWork(discarded, testWork)).rejects.toThrow('discarded');
    let next = await j.begin(testScope, testWork);
    expect(next.id).not.toBe(initial.id);
    next = await j.prepare(next, testPayload, testWork);
    await expect(j.discard(next)).rejects.toThrow('may have been sent');
    next = await j.claim(next);
    await expect(j.discard(next)).rejects.toThrow('may have been sent');
  });
  it('rejects a corrupt confirmed baseline before returning it for transport or rendering', async () => {
    const db = intentIndexedDB(); const j = createJournal(db);
    let r = await j.prepare(await j.begin(testScope, testWork), testPayload, testWork);
    r = await j.claim(r);
    r = await j.acknowledge(r, { ...testPayload, id: r.id });
    for (const patch of [{ clientId: 'foreign' }, { content: {} }, { imageUrl: [] }, { id: 'wrong' }]) expect(() => validateIntent({ ...r, baseline: { ...r.baseline, ...patch } }, testScope)).toThrow('identity');
  });
});
