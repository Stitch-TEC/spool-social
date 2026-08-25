import { describe, it, expect } from 'vitest';
import {
  reviewStageOf,
  isStaged,
  reviewStateOf,
  hasFeedback,
  daysAwaiting,
  postWasRewritten,
  approvedPayloadIdentity,
  suggestionPromotionDocument,
} from './review';
import { REVIEW_STAGE, REVIEW_STATE } from '../constants';

describe('reviewStageOf', () => {
  it('keeps the historical absent-stage meaning in operator-side derivation', () => {
    // Load-bearing: every post that predates this field must keep behaving
    // exactly as before, so no live review link silently empties out.
    expect(reviewStageOf({})).toBe(REVIEW_STAGE.IN_REVIEW);
    expect(reviewStageOf(undefined)).toBe(REVIEW_STAGE.IN_REVIEW);
    expect(isStaged({})).toBe(false);
  });

  it('honours an explicit private stage', () => {
    expect(reviewStageOf({ reviewStage: 'private' })).toBe(REVIEW_STAGE.PRIVATE);
    expect(isStaged({ reviewStage: 'private' })).toBe(true);
  });

  it('falls back to in_review for an unrecognised value', () => {
    expect(reviewStageOf({ reviewStage: 'nonsense' })).toBe(REVIEW_STAGE.IN_REVIEW);
  });
});

describe('reviewStateOf', () => {
  it('is NOT_SENT for a staged, unanswered post', () => {
    expect(reviewStateOf({ reviewStage: 'private', approvalStatus: 'pending' })).toBe(REVIEW_STATE.NOT_SENT);
  });

  it('is AWAITING once sent and still unanswered', () => {
    expect(reviewStateOf({ reviewStage: 'in_review', approvalStatus: 'pending' })).toBe(REVIEW_STATE.AWAITING);
    expect(reviewStateOf({ approvalStatus: 'pending' })).toBe(REVIEW_STATE.AWAITING); // legacy
  });

  it('lets an approval FACT outrank the stage', () => {
    // Pulling an approved post back into staging must not erase that the client
    // approved it — the approval is something they did, not a stage we control.
    expect(reviewStateOf({ reviewStage: 'private', approvalStatus: 'approved' })).toBe(REVIEW_STATE.APPROVED);
    expect(reviewStateOf({ reviewStage: 'private', approvalStatus: 'changes_requested' })).toBe(REVIEW_STATE.CHANGES);
  });
});

describe('hasFeedback', () => {
  it('detects both the threaded history and the legacy single field', () => {
    expect(hasFeedback({ feedbackThread: [{ text: 'x' }] })).toBe(true);
    expect(hasFeedback({ feedback: 'tighten the CTA' })).toBe(true);
    expect(hasFeedback({ feedbackThread: [], feedback: '' })).toBe(false);
    expect(hasFeedback({})).toBe(false);
  });
});

describe('suggestionPromotionDocument', () => {
  it('copies only client-safe fields and physically drops every suggestion/operator field', () => {
    const rawSuggestion = {
      uid: 'owner', client: 'Acme', content: 'Copy', title: 'Title', platform: 'gmb',
      source: 'suggestion', clientId: '', forClientId: 'acme', suggestSeed: 'private prompt',
      suggestPageUrl: 'https://internal.example', automationId: 'automation-secret',
      operatorNotes: 'never disclose', status: 'scheduled', approvalStatus: 'approved',
      reviewStage: 'in_review', feedback: 'old', feedbackThread: [{ text: 'old' }],
      reviewedBy: 'old-client', approvedAt: 'yesterday', tags: ['suggested', 'keep'],
      createdAt: '2026-08-20T00:00:00.000Z',
    };
    const document = suggestionPromotionDocument(rawSuggestion, 'acme', '2026-08-25T00:00:00.000Z');

    expect(document).toMatchObject({
      uid: 'owner', client: 'Acme', content: 'Copy', clientId: 'acme', source: 'automation',
      status: 'draft', reviewStage: 'private', approvalStatus: 'pending', feedback: '',
      feedbackThread: [], sentForReviewAt: null, tags: ['keep'], isTemplate: false,
    });
    expect(reviewStateOf(document)).toBe(REVIEW_STATE.NOT_SENT);
    for (const field of [
      'forClientId', 'suggestSeed', 'suggestPageUrl', 'automationId', 'operatorNotes',
      'reviewedBy', 'approvedAt',
    ]) expect(document).not.toHaveProperty(field);
  });
});

describe('approvedPayloadIdentity', () => {
  it('is stable across Spool media cache versions but changes with approved copy', () => {
    const before = { content: '![x](/media/a.png)', title: 'T', imageUrl: '/media/a.png', platform: 'gmb' };
    const migrated = { content: '![x](/media/v2/a.png)', title: 'T', imageUrl: '/media/v2/a.png', platform: 'gmb' };
    expect(approvedPayloadIdentity(migrated)).toBe(approvedPayloadIdentity(before));
    expect(approvedPayloadIdentity({ ...migrated, title: 'Changed' })).not.toBe(approvedPayloadIdentity(before));
    expect(approvedPayloadIdentity({ ...migrated, platform: 'linkedin' })).not.toBe(approvedPayloadIdentity(before));
  });
});

describe('postWasRewritten', () => {
  const approvedPayload = {
    content: 'Approved copy',
    title: 'Approved title',
    imageUrl: '/media/generated/owner/original.jpg',
    platform: 'gmb',
  };

  it('does not invalidate approval for a no-op save', () => {
    expect(postWasRewritten(approvedPayload, { ...approvedPayload })).toBe(false);
  });

  it('treats a media URL version change as storage-only', () => {
    expect(postWasRewritten(
      { ...approvedPayload, imageUrl: '/media/generated/owner/original.jpg' },
      { ...approvedPayload, imageUrl: '/media/v2/generated/owner/original.jpg' }
    )).toBe(false);
    expect(postWasRewritten(
      { ...approvedPayload, content: '![asset](/media/generated/owner/original.jpg)' },
      { ...approvedPayload, content: '![asset](/media/v2/generated/owner/original.jpg)' }
    )).toBe(false);
  });

  it('does not normalize external media namespaces or plain prose', () => {
    expect(postWasRewritten(
      { ...approvedPayload, imageUrl: 'https://cdn.example/media/a.png' },
      { ...approvedPayload, imageUrl: 'https://cdn.example/media/v2/a.png' }
    )).toBe(true);
    expect(postWasRewritten(
      { ...approvedPayload, content: 'Document the /media/path behavior.' },
      { ...approvedPayload, content: 'Document the /media/v2/path behavior.' }
    )).toBe(true);
  });

  it('detects an image-only edit (the existing-post save regression)', () => {
    expect(postWasRewritten(approvedPayload, {
      ...approvedPayload,
      imageUrl: '/media/generated/owner/replacement.jpg',
    })).toBe(true);
  });

  it('detects title or content edits but ignores a new-post payload', () => {
    expect(postWasRewritten(approvedPayload, { ...approvedPayload, title: 'Changed' })).toBe(true);
    expect(postWasRewritten(approvedPayload, { ...approvedPayload, content: 'Changed' })).toBe(true);
    expect(postWasRewritten(null, approvedPayload)).toBe(false);
  });

  it('treats a platform move as an approved-payload rewrite', () => {
    expect(postWasRewritten(approvedPayload, { ...approvedPayload, platform: 'linkedin' })).toBe(true);
  });

  it('detects an image that will be dropped after an upload failure', () => {
    expect(postWasRewritten(approvedPayload, { ...approvedPayload, imageDropped: true })).toBe(true);
  });
});

describe('daysAwaiting', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');

  it('counts whole days since the post was sent', () => {
    const post = { approvalStatus: 'pending', sentForReviewAt: '2026-08-12T00:00:00Z' };
    expect(daysAwaiting(post, now)).toBe(6);
  });

  it('falls back to createdAt for posts sent before the field existed', () => {
    const post = { approvalStatus: 'pending', createdAt: '2026-08-16T00:00:00Z' };
    expect(daysAwaiting(post, now)).toBe(2);
  });

  it('is null when the question does not apply', () => {
    expect(daysAwaiting({ reviewStage: 'private', sentForReviewAt: '2026-08-01T00:00:00Z' }, now)).toBeNull();
    expect(daysAwaiting({ approvalStatus: 'approved', sentForReviewAt: '2026-08-01T00:00:00Z' }, now)).toBeNull();
    expect(daysAwaiting({ approvalStatus: 'pending' }, now)).toBeNull(); // no usable timestamp
  });
});
