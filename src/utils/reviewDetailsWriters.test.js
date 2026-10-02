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
describe('disabled authoring and direct-review compatibility', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['operator', 'member'])('keeps %s editor read-only for any supplemental marker', role => {
    const options = role === 'operator' ? { isOperator: true } : { isClientMember: true, clientId: 'acme' };
    expect(postEditingAccess(extended, options).canEdit).toBe(false);
    expect(postEditingAccess({ ...legacy, firstComment: null }, options).canEdit).toBe(false);
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
