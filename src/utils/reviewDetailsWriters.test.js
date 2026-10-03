import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('firebase/firestore', () => ({ runTransaction: vi.fn() }));
import { runTransaction } from 'firebase/firestore';
import { applyReviewActionAtomically, saveExistingPostAtomically, promoteSuggestionAtomically,
  REVIEW_ACTION, reviewBaselineFor } from './postSave';
import { postEditingAccess } from './postEditingAccess';
import { convertToCSV, normalizeImportedPost, parseJSON, postsToJSON } from './csv';

const legacy = { id: 'p', uid: 'owner', clientId: 'acme', client: 'Acme', platform: 'linkedin', content: 'Caption',
  status: 'draft', reviewStage: 'in_review', approvalStatus: 'pending' };
const extended = { ...legacy, reviewDetailsVersion: 1, firstComment: 'Comment' };
const reservedCases = [
  ['reviewDetailsAck', null], ['reviewDetailsAck', {}],
  ['reviewMediaLinks', null], ['reviewMediaLinks', []], ['reviewMediaLinks', ''],
];
describe('disabled authoring and direct-review compatibility', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['operator', 'member'])('keeps %s editor read-only for any supplemental marker', role => {
    const options = role === 'operator' ? { isOperator: true } : { isClientMember: true, clientId: 'acme' };
    expect(postEditingAccess(extended, options).canEdit).toBe(false);
    expect(postEditingAccess({ ...legacy, firstComment: null }, options).canEdit).toBe(false);
  });
  it.each(reservedCases)('keeps ack/alias-only %s records read-only %#', (field, value) => {
    const protectedPost = { ...legacy, [field]: value };
    for (const options of [{ isOperator: true }, { isClientMember: true, clientId: 'acme' }]) {
      expect(postEditingAccess(protectedPost, options)).toEqual({
        canEdit: false, reason: 'Review details are read-only in this Spool version.',
      });
    }
  });
  it.each(Object.values(REVIEW_ACTION).flatMap(action =>
    reservedCases.map(([field, value]) => [action, field, value])))('refuses %s after fresh transaction reads %s on a legacy-looking listener baseline %#', async (action, field, value) => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, fn) => fn({ get: async () => ({ exists: () => true,
      data: () => ({ ...legacy, [field]: value }) }), update }));
    await expect(applyReviewActionAtomically({ db: {}, postRef: { id: 'p' }, baseline: reviewBaselineFor(legacy),
      action, feedback: 'Changes' })).rejects.toMatchObject({ code: 'review_details_authoring_disabled' });
    expect(update).not.toHaveBeenCalled();
  });
  it.each(reservedCases)('refuses saving or promoting fresh ack/alias-only %s rows %#', async (field, value) => {
    const update = vi.fn(), set = vi.fn();
    runTransaction.mockImplementation(async (_db, fn) => fn({ get: async () => ({ exists: () => true,
      data: () => ({ ...legacy, source: 'suggestion', clientId: '', [field]: value }) }), update, set }));
    await expect(saveExistingPostAtomically({ db: {}, postRef: { id: 'p' }, postData: { content: 'Next' } }))
      .rejects.toMatchObject({ code: 'review_details_authoring_disabled' });
    await expect(promoteSuggestionAtomically({ db: {}, postRef: { id: 'p' }, ownerUid: 'owner', resolveTarget: () => 'acme' }))
      .rejects.toMatchObject({ code: 'review_details_authoring_disabled' });
    expect(update).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
  it.each(reservedCases)('refuses lossy %s transfer while raw JSON preserves it %#', (field, value) => {
    const reserved = { ...legacy, [field]: value };
    expect(() => convertToCSV([reserved])).toThrow('CSV cannot preserve');
    expect(() => normalizeImportedPost(reserved)).toThrow('not enabled');
    expect(() => parseJSON(JSON.stringify([legacy, reserved]))).toThrow('not enabled');
    expect(JSON.parse(postsToJSON([reserved])).posts[0]).toEqual(reserved);
  });
  it.each(Object.values(REVIEW_ACTION))('refuses direct %s on the actual live extended row', async action => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, fn) => fn({ get: async () => ({ exists: () => true, data: () => extended }), update }));
    await expect(applyReviewActionAtomically({ db: {}, postRef: { id: 'p' }, baseline: reviewBaselineFor(legacy),
      action, feedback: 'Changes' })).rejects.toMatchObject({ code: 'review_details_authoring_disabled' });
    expect(update).not.toHaveBeenCalled();
  });
  it('refuses existing saves and suggestion promotion from live supplemental records', async () => {
    const update = vi.fn(), set = vi.fn();
    runTransaction.mockImplementation(async (_db, fn) => fn({ get: async () => ({ exists: () => true,
      data: () => ({ ...extended, source: 'suggestion', clientId: '' }) }), update, set }));
    await expect(saveExistingPostAtomically({ db: {}, postRef: { id: 'p' }, postData: { content: 'Next' } }))
      .rejects.toMatchObject({ code: 'review_details_authoring_disabled' });
    await expect(promoteSuggestionAtomically({ db: {}, postRef: { id: 'p' }, ownerUid: 'owner', resolveTarget: () => 'acme' }))
      .rejects.toMatchObject({ code: 'review_details_authoring_disabled' });
    expect(update).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
  it('refuses imports/CSV that would silently drop metadata, while JSON retains it exactly', () => {
    expect(() => convertToCSV([extended])).toThrow('CSV cannot preserve');
    expect(() => normalizeImportedPost(extended)).toThrow('not enabled');
    expect(() => parseJSON(JSON.stringify([legacy, extended]))).toThrow('not enabled');
    expect(JSON.parse(postsToJSON([extended])).posts[0]).toEqual(extended);
    expect(convertToCSV([legacy])).toContain('Caption');
    expect(normalizeImportedPost(legacy).content).toBe('Caption');
  });
});
