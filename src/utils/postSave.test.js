import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase/firestore', () => ({ runTransaction: vi.fn() }));

import { runTransaction } from 'firebase/firestore';
import {
  applyReviewActionAtomically,
  applyReviewActionBatch,
  REVIEW_ACTION,
  reviewBaselineFor,
  resolveExistingClientId,
  promoteSuggestionAtomically,
  saveExistingPostAtomically,
  saveExistingPostWithImageAtomically,
} from './postSave';

const snapshot = (data) => ({ exists: () => true, data: () => data });

describe('saveExistingPostAtomically', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the real existing-post preparation/transaction path without a TDZ and preserves an identical rehost', async () => {
    const submittedImage = 'data:image/png;base64,iVBORw0KGgo=';
    const update = vi.fn();
    const hostImage = vi.fn().mockResolvedValue('/media/v2/generated/o/hash.png');
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        client: 'Acme',
        clientId: 'acme',
        content: 'Approved copy',
        title: 'Approved title',
        imageUrl: submittedImage,
        status: 'scheduled',
        approvalStatus: 'approved',
        feedback: 'Live client note',
        feedbackThread: [{ text: 'Live client note', by: 'client' }],
        reviewStage: 'in_review',
      })),
      update,
    }));

    const result = await saveExistingPostWithImageAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: {
        content: 'Approved copy',
        title: 'Approved title',
        status: 'draft',
        client: 'Acme',
        clientId: 'acme',
        // A defensive regression: even if a future caller passes stale fields,
        // the atomic path strips them before updating.
        approvalStatus: 'pending',
        feedback: 'stale',
        feedbackThread: [],
        reviewStage: 'private',
      },
      submittedImageUrl: submittedImage,
      baselineStatus: 'draft',
      baselineClient: 'Acme',
      baselineClientId: 'acme',
      forClient: 'acme',
      hostImage,
    });

    const written = update.mock.calls[0][1];
    expect(hostImage).toHaveBeenCalledWith(submittedImage, 'acme');
    expect(result.approvalReset).toBe(false);
    expect(written.imageUrl).toBe('/media/v2/generated/o/hash.png');
    expect(written).not.toHaveProperty('approvalStatus');
    expect(written).not.toHaveProperty('feedback');
    expect(written).not.toHaveProperty('feedbackThread');
    expect(written).not.toHaveProperty('reviewStage');
    expect(written).not.toHaveProperty('status');
  });

  it('re-reads a concurrent approval and resets it only when the saved payload changed', async () => {
    const firstUpdate = vi.fn();
    const retriedUpdate = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => {
      await callback({
        get: vi.fn().mockResolvedValue(snapshot({
          content: 'Old copy', title: 'Title', imageUrl: '', status: 'draft', approvalStatus: 'pending',
        })),
        update: firstUpdate,
      });
      return callback({
        get: vi.fn().mockResolvedValue(snapshot({
          content: 'Old copy',
          title: 'Title',
          imageUrl: '',
          status: 'scheduled',
          approvalStatus: 'approved',
          feedback: 'Arrived during save',
          feedbackThread: [{ text: 'Arrived during save', by: 'client' }],
          updatedAt: '2099-01-01T00:00:00.000Z',
        })),
        update: retriedUpdate,
      });
    });

    const result = await saveExistingPostAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { content: 'Changed copy', title: 'Title', imageUrl: '', status: 'draft' },
      submittedPayload: { content: 'Changed copy', title: 'Title', imageUrl: '', imageDropped: false },
      baselineStatus: 'draft',
    });

    expect(result.approvalReset).toBe(true);
    const retriedPatch = retriedUpdate.mock.calls[0][1];
    expect(retriedUpdate).toHaveBeenCalledWith(
      { id: 'p1' },
      expect.objectContaining({ content: 'Changed copy', title: 'Title', imageUrl: '', approvalStatus: 'pending' })
    );
    expect(Date.parse(retriedPatch.updatedAt)).toBeGreaterThan(Date.parse('2099-01-01T00:00:00.000Z'));
    expect(retriedPatch).not.toHaveProperty('feedback');
    expect(retriedPatch).not.toHaveProperty('feedbackThread');
  });

  it('clears a live approval when the actual save wrapper changes platform', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        client: 'Acme', clientId: 'acme', content: 'Same copy', title: 'Title', imageUrl: '',
        platform: 'gmb', status: 'scheduled', approvalStatus: 'approved', reviewStage: 'in_review',
      })),
      update,
    }));

    const result = await saveExistingPostWithImageAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: {
        client: 'Acme', clientId: 'acme', content: 'Same copy', title: 'Title',
        platform: 'linkedin', status: 'scheduled',
      },
      submittedImageUrl: '',
      baselineStatus: 'scheduled',
      baselineClient: 'Acme',
      baselineClientId: 'acme',
      forClient: 'acme',
      hostImage: vi.fn().mockResolvedValue(''),
    });

    expect(result.approvalReset).toBe(true);
    expect(update.mock.calls[0][1]).toMatchObject({
      platform: 'linkedin', approvalStatus: 'pending',
    });
  });

  it('atomically re-stages a tenant move and clears a review that races the real save wrapper', async () => {
    const firstUpdate = vi.fn();
    const retriedUpdate = vi.fn();
    const base = {
      client: 'Acme',
      clientId: 'acme',
      content: 'Same copy',
      title: 'Same title',
      imageUrl: '',
      status: 'draft',
      approvalStatus: 'pending',
      reviewStage: 'in_review',
      feedback: '',
      feedbackThread: [],
      sentForReviewAt: '2026-08-24T18:00:00.000Z',
    };
    runTransaction.mockImplementation(async (_db, callback) => {
      await callback({
        get: vi.fn().mockResolvedValue(snapshot(base)),
        update: firstUpdate,
      });
      return callback({
        get: vi.fn().mockResolvedValue(snapshot({
          ...base,
          client: 'Acme Holdings',
          approvalStatus: 'approved',
          feedback: 'Approved during upload',
          feedbackThread: [{ text: 'Approved during upload', by: 'client' }],
          reviewedBy: 'old-client@example.com',
          reviewedAt: '2026-08-24T19:00:00.000Z',
          updatedAt: '2026-08-24T19:00:00.000Z',
        })),
        update: retriedUpdate,
      });
    });

    const result = await saveExistingPostWithImageAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: {
        client: 'Beta',
        clientId: 'beta',
        content: 'Same copy',
        title: 'Same title',
        status: 'draft',
      },
      submittedImageUrl: '',
      baselineStatus: 'draft',
      baselineClient: 'Acme',
      baselineClientId: 'acme',
      forClient: 'beta',
      hostImage: vi.fn().mockResolvedValue(''),
    });

    expect(result.tenantReset).toBe(true);
    expect(retriedUpdate.mock.calls[0][1]).toMatchObject({
      client: 'Beta',
      clientId: 'beta',
      approvalStatus: 'pending',
      reviewStage: 'private',
      feedback: '',
      feedbackThread: [],
      sentForReviewAt: null,
      reviewedBy: null,
      reviewedAt: null,
    });
  });

  it('aborts before writing stale old-tenant payload when the live tenant changed unexpectedly', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        client: 'Beta', clientId: 'beta', content: 'Copy', title: '', imageUrl: '',
        approvalStatus: 'pending', reviewStage: 'private',
      })),
      update,
    }));

    await expect(saveExistingPostAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { client: 'Acme', clientId: 'acme', content: 'Edited', title: '', imageUrl: '' },
      submittedPayload: { content: 'Edited', title: '', imageUrl: '', imageDropped: false },
      baselineClientId: 'acme',
      baselineClient: 'Acme',
    })).rejects.toMatchObject({ code: 'tenant_changed' });

    expect(update).not.toHaveBeenCalled();
  });

  it('also aborts when a racing editor already completed the same requested tenant move', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        client: 'Beta', clientId: 'beta', content: 'New-tenant copy', title: '', imageUrl: '',
        approvalStatus: 'pending', reviewStage: 'private', feedbackThread: [{ text: 'new tenant' }],
      })),
      update,
    }));

    await expect(saveExistingPostAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { client: 'Beta', clientId: 'beta', content: 'Old-tenant edit', title: '', imageUrl: '' },
      submittedPayload: { content: 'Old-tenant edit', title: '', imageUrl: '', imageDropped: false },
      baselineClientId: 'acme',
      baselineClient: 'Acme',
    })).rejects.toMatchObject({ code: 'tenant_changed' });

    expect(update).not.toHaveBeenCalled();
  });

  it('preserves a concurrent same-ID client rename when the editor did not rename it', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        client: 'Acme Holdings', clientId: 'acme', content: 'Copy', title: '', imageUrl: '',
        approvalStatus: 'pending', reviewStage: 'private',
      })),
      update,
    }));

    await saveExistingPostAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { client: 'Acme', clientId: 'acme', content: 'Edited', title: '', imageUrl: '' },
      submittedPayload: { content: 'Edited', title: '', imageUrl: '', imageDropped: false },
      baselineClient: 'Acme',
      baselineClientId: 'acme',
    });

    expect(update.mock.calls[0][1]).not.toHaveProperty('client');
    expect(update.mock.calls[0][1]).not.toHaveProperty('clientId');
  });

  it('fails closed when two editors intentionally choose different labels for the same tenant', async () => {
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        client: 'Acme Holdings', clientId: 'acme', content: 'Copy', title: '', imageUrl: '',
        approvalStatus: 'pending', reviewStage: 'private',
      })),
      update: vi.fn(),
    }));

    await expect(saveExistingPostAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { client: 'Acme Co', clientId: 'acme', content: 'Edited', title: '', imageUrl: '' },
      submittedPayload: { content: 'Edited', title: '', imageUrl: '', imageDropped: false },
      baselineClient: 'Acme',
      baselineClientId: 'acme',
    })).rejects.toMatchObject({ code: 'tenant_label_changed' });
  });

  it('invalidates approval for an image-only edit through the real save path', async () => {
    const update = vi.fn();
    const replacement = 'data:image/png;base64,cmVwbGFjZW1lbnQ=';
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        content: 'Same copy',
        title: 'Same title',
        imageUrl: '/media/v2/generated/o/original.png',
        status: 'scheduled',
        approvalStatus: 'approved',
      })),
      update,
    }));

    const result = await saveExistingPostWithImageAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { content: 'Same copy', title: 'Same title', status: 'scheduled' },
      submittedImageUrl: replacement,
      baselineStatus: 'scheduled',
      forClient: 'acme',
      hostImage: vi.fn().mockResolvedValue('/media/v2/generated/o/replacement.png'),
    });

    expect(result.approvalReset).toBe(true);
    expect(update.mock.calls[0][1]).toMatchObject({
      imageUrl: '/media/v2/generated/o/replacement.png',
      approvalStatus: 'pending',
    });
  });

  it('keeps an intentional operator status edit even when live workflow moved', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        content: 'Copy',
        title: 'Title',
        imageUrl: '',
        status: 'scheduled',
        approvalStatus: 'approved',
      })),
      update,
    }));

    await saveExistingPostAtomically({
      db: {},
      postRef: { id: 'p1' },
      postData: { content: 'Copy', title: 'Title', imageUrl: '', status: 'posted' },
      submittedPayload: { content: 'Copy', title: 'Title', imageUrl: '', imageDropped: false },
      baselineStatus: 'draft',
    });

    expect(update.mock.calls[0][1]).toMatchObject({ status: 'posted' });
    expect(update.mock.calls[0][1]).not.toHaveProperty('approvalStatus');
  });
});

describe('resolveExistingClientId', () => {
  it('keeps the immutable slug when only an unknown display label changes', () => {
    expect(resolveExistingClientId({
      requestedClient: 'Acme Holdings',
      baselineClient: 'Acme',
      baselineClientId: 'acme-canonical',
      knownClientId: '',
    })).toBe('acme-canonical');
  });

  it('uses only an explicitly known roster/stamped ID for an intentional move', () => {
    expect(resolveExistingClientId({
      requestedClient: 'Beta Incorporated',
      baselineClient: 'Acme',
      baselineClientId: 'acme-canonical',
      knownClientId: 'beta',
    })).toBe('beta');
  });
});

describe('promoteSuggestionAtomically', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-reads live target and tags before resetting the review lifecycle', async () => {
    const set = vi.fn();
    const live = {
      uid: 'owner',
      source: 'suggestion',
      client: 'Beta Live Name',
      clientId: '',
      forClientId: 'beta',
      tags: ['live-tag', 'suggested'],
      approvalStatus: 'approved',
      reviewStage: 'in_review',
      status: 'scheduled',
      feedbackThread: [{ text: 'stale approval' }],
      updatedAt: '2026-08-24T20:00:00.000Z',
    };
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot(live)),
      set,
    }));
    const resolveTarget = vi.fn((post) => post.forClientId);

    const result = await promoteSuggestionAtomically({
      db: {}, postRef: { id: 'p1' }, ownerUid: 'owner', resolveTarget,
    });

    expect(resolveTarget).toHaveBeenCalledWith(live);
    expect(result.target).toBe('beta');
    expect(set.mock.calls[0][1]).toMatchObject({
      clientId: 'beta',
      tags: ['live-tag'],
      status: 'draft',
      reviewStage: 'private',
      approvalStatus: 'pending',
      feedbackThread: [],
    });
    expect(set.mock.calls[0][1]).not.toHaveProperty('forClientId');
    expect(set.mock.calls[0][1]).not.toHaveProperty('suggestSeed');
  });

  it('rejects a stale replay after the live document was already promoted', async () => {
    const set = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({
        uid: 'owner', source: 'automation', clientId: 'beta', tags: ['new-tenant-note'],
      })),
      set,
    }));

    await expect(promoteSuggestionAtomically({
      db: {}, postRef: { id: 'p1' }, ownerUid: 'owner', resolveTarget: () => 'beta',
    })).rejects.toMatchObject({ code: 'suggestion_already_promoted' });
    expect(set).not.toHaveBeenCalled();
  });
});

describe('applyReviewActionAtomically', () => {
  beforeEach(() => vi.clearAllMocks());

  const reviewPost = {
    uid: 'owner', clientId: 'acme', client: 'Acme', source: 'import',
    content: 'Approved payload', title: 'Title', imageUrl: '/media/v2/a.png', platform: 'gmb',
    status: 'draft', approvalStatus: 'pending', reviewStage: 'in_review',
    feedback: '', feedbackThread: [], sentForReviewAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };

  it('binds review intent to tenant and payload, rejecting a racing content edit', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({ ...reviewPost, content: 'Racing rewrite' })),
      update,
    }));

    await expect(applyReviewActionAtomically({
      db: {}, postRef: { id: 'p1' }, baseline: reviewPost, action: REVIEW_ACTION.APPROVE,
    })).rejects.toMatchObject({ code: 'review_conflict', status: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a review action when the platform changed after rendering', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({ ...reviewPost, platform: 'linkedin' })),
      update,
    }));

    await expect(applyReviewActionAtomically({
      db: {}, postRef: { id: 'p1' }, baseline: reviewPost, action: REVIEW_ACTION.APPROVE,
    })).rejects.toMatchObject({ code: 'review_conflict', status: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a racing tenant move even when the approved payload is identical', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({ ...reviewPost, clientId: 'beta', client: 'Beta' })),
      update,
    }));

    await expect(applyReviewActionAtomically({
      db: {}, postRef: { id: 'p1' }, baseline: reviewBaselineFor(reviewPost), action: REVIEW_ACTION.HOLD,
    })).rejects.toMatchObject({ code: 'review_conflict' });
    expect(update).not.toHaveBeenCalled();
  });

  it('appends feedback with reviewer attribution inside the transaction', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot(reviewPost)),
      update,
    }));

    await applyReviewActionAtomically({
      db: {}, postRef: { id: 'p1' }, baseline: reviewPost,
      action: REVIEW_ACTION.REQUEST_CHANGES, feedback: 'Tighten the CTA', actor: 'client',
    });
    const patch = update.mock.calls[0][1];
    expect(patch).toMatchObject({
      approvalStatus: 'changes_requested', feedback: 'Tighten the CTA',
      reviewedBy: 'client', reviewedAt: patch.updatedAt,
    });
    expect(patch.feedbackThread).toEqual([
      { text: 'Tighten the CTA', by: 'client', at: patch.updatedAt },
    ]);
  });

  it('rejects stale review-state intent even when tenant and content did not change', async () => {
    const update = vi.fn();
    runTransaction.mockImplementation(async (_db, callback) => callback({
      get: vi.fn().mockResolvedValue(snapshot({ ...reviewPost, approvalStatus: 'approved' })),
      update,
    }));

    await expect(applyReviewActionAtomically({
      db: {}, postRef: { id: 'p1' }, baseline: reviewPost, action: REVIEW_ACTION.HOLD,
    })).rejects.toMatchObject({ code: 'review_conflict' });
    expect(update).not.toHaveBeenCalled();
  });

  it('runs bulk send through the same per-post baseline transaction and reports drift per item', async () => {
    const staged = { ...reviewPost, reviewStage: 'private' };
    let call = 0;
    const updates = [];
    runTransaction.mockImplementation(async (_db, callback) => {
      const live = call++ === 0 ? staged : { ...staged, content: 'Racing bulk edit' };
      return callback({
        get: vi.fn().mockResolvedValue(snapshot(live)),
        update: (...args) => updates.push(args),
      });
    });
    const results = await applyReviewActionBatch({
      db: {},
      action: REVIEW_ACTION.SEND,
      items: [
        { postRef: { id: 'p1' }, baseline: staged },
        { postRef: { id: 'p2' }, baseline: staged },
      ],
    });
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toMatchObject({ reviewStage: 'in_review' });
  });
});
