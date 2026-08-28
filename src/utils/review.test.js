import { describe, it, expect } from 'vitest';
import {
  reviewStageOf,
  isStaged,
  reviewStateOf,
  hasFeedback,
  daysAwaiting,
  postWasRewritten,
  approvedPayloadIdentity,
  approvalSafeStoragePatch,
  publicationSlugOf,
  reviewStateIdentity,
  suggestionPromotionDocument,
} from './review';
import {
  canonicalReviewScheduledDate,
  displayReviewScheduledDateAsDate,
  reviewScheduledDateAsDate,
  reviewScheduledDateForStorage,
  reviewScheduledDateIdentity,
} from './reviewIdentity';
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
  it('is stable across Spool media cache versions and missing/empty optional values', () => {
    const before = { content: '![x](/media/a.png)', title: 'T', imageUrl: '/media/a.png', platform: 'gmb' };
    const migrated = {
      content: '![x](/media/v2/a.png)', title: 'T', imageUrl: '/media/v2/a.png', platform: 'gmb',
      altText: '', metaDescription: '', slug: '',
    };
    expect(approvedPayloadIdentity(migrated)).toBe(approvedPayloadIdentity(before));
    expect(approvedPayloadIdentity({ ...migrated, title: 'Changed' })).not.toBe(approvedPayloadIdentity(before));
  });

  it.each([
    ['platform', 'linkedin'],
    ['altText', 'Descriptive image text'],
    ['metaDescription', 'Search preview copy'],
    ['slug', 'approved-publication-path'],
  ])('changes when approval-bearing %s changes', (field, value) => {
    const before = {
      content: 'Copy', title: 'T', imageUrl: '', platform: 'gmb',
      altText: '', metaDescription: '', slug: '',
    };
    expect(approvedPayloadIdentity({ ...before, [field]: value })).not.toBe(approvedPayloadIdentity(before));
  });

  it('binds the same non-empty fallback path the publisher uses for punctuation-only titles', () => {
    const draft = { platform: 'blog', title: '🔥🔥', content: '', imageUrl: '' };
    expect(publicationSlugOf(draft)).toBe('untitled-post');
    expect(approvedPayloadIdentity(draft)).toContain('untitled-post');
  });
});

describe('reviewStateIdentity workflow semantics', () => {
  it('binds schedule drift but deliberately ignores internal tags', () => {
    const before = { status: 'draft', scheduledDate: '', tags: ['internal-a'] };
    expect(reviewStateIdentity({ ...before, tags: ['internal-b'] })).toBe(reviewStateIdentity(before));
    expect(reviewStateIdentity({ ...before, scheduledDate: '2026-09-01T12:00:00.000Z' }))
      .not.toBe(reviewStateIdentity(before));
  });

  it('canonicalizes usePosts Date, Firestore ISO, and Timestamp-like schedules identically', () => {
    const iso = '2026-09-01T12:00:00.123Z';
    const state = { status: 'draft', approvalStatus: 'pending', reviewStage: 'in_review' };
    expect(reviewStateIdentity({ ...state, scheduledDate: new Date(iso) }))
      .toBe(reviewStateIdentity({ ...state, scheduledDate: iso }));
    expect(reviewStateIdentity({ ...state, scheduledDate: { toDate: () => new Date(iso) } }))
      .toBe(reviewStateIdentity({ ...state, scheduledDate: iso }));
    expect(canonicalReviewScheduledDate('2026-09-01T05:00:00.123-07:00')).toBe(iso);
    expect(canonicalReviewScheduledDate({ seconds: 1788264000, nanoseconds: 123000000 }))
      .toBe(iso);
    expect(reviewScheduledDateAsDate({ toDate: () => new Date(iso) }))
      .toEqual(new Date(iso));
  });

  it('fails closed on malformed non-empty schedules', () => {
    for (const value of [
      'September 1', 'not-a-date', '2026-02-31T12:00:00.000Z',
      new Date('invalid'), { seconds: 1, nanoseconds: -1 },
    ]) {
      expect(() => reviewStateIdentity({ scheduledDate: value }))
        .toThrow(expect.objectContaining({ code: 'review_date_invalid' }));
    }
    expect(() => reviewScheduledDateAsDate({ toDate: () => new Date('invalid') }))
      .toThrow(expect.objectContaining({ code: 'review_date_invalid' }));
    expect(reviewStateIdentity({ scheduledDate: null })).toBe(reviewStateIdentity({ scheduledDate: '' }));
  });

  it('loads exact legacy datetime-local schedules without weakening approval identity', () => {
    const legacy = '2026-09-01T12:34';
    const displayed = displayReviewScheduledDateAsDate(legacy);

    expect(displayed).toBeInstanceOf(Date);
    expect(displayed.getFullYear()).toBe(2026);
    expect(displayed.getMonth()).toBe(8);
    expect(displayed.getDate()).toBe(1);
    expect(displayed.getHours()).toBe(12);
    expect(displayed.getMinutes()).toBe(34);
    expect(() => canonicalReviewScheduledDate(legacy))
      .toThrow(expect.objectContaining({ code: 'review_date_invalid' }));
    expect(reviewScheduledDateIdentity(legacy)).toBe(`legacy-local:${legacy}`);
    expect(reviewStateIdentity({
      status: 'draft', scheduledDate: displayed, _raw_scheduledDate: legacy,
    })).toBe(reviewStateIdentity({ status: 'draft', scheduledDate: legacy }));
  });

  it('degrades malformed display schedules and canonicalizes future Editor saves', () => {
    expect(displayReviewScheduledDateAsDate('not-a-date')).toBeNull();
    expect(displayReviewScheduledDateAsDate('2026-02-31T12:34')).toBeNull();

    const stored = reviewScheduledDateForStorage('2026-09-01T12:34');
    expect(stored).toBe(new Date(2026, 8, 1, 12, 34).toISOString());
    expect(canonicalReviewScheduledDate(stored)).toBe(stored);
  });
});

describe('approvalSafeStoragePatch', () => {
  it('omits read-time media versioning and an absent-to-effective slug write', () => {
    const live = {
      platform: 'blog', title: 'Approved title',
      content: '![inline](/media/generated/o/a.png)',
      imageUrl: '/media/generated/o/cover.png',
    };
    const patch = approvalSafeStoragePatch(live, {
      content: '![inline](https://spool.stitchtec.dev/media/v2/generated/o/a.png)',
      imageUrl: 'https://spool.stitchtec.dev/media/v2/generated/o/cover.png',
      slug: 'approved-title', tags: ['metadata'],
    });
    expect(patch).toEqual({ tags: ['metadata'] });
  });

  it('keeps genuine content, media-object, and publication-target changes', () => {
    const live = {
      platform: 'blog', title: 'Approved title', content: 'Copy',
      imageUrl: '/media/generated/o/cover.png',
    };
    expect(approvalSafeStoragePatch(live, {
      content: 'Different copy', imageUrl: '/media/v2/generated/o/other.png', slug: 'different-path',
    })).toEqual({
      content: 'Different copy', imageUrl: '/media/v2/generated/o/other.png', slug: 'different-path',
    });
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

  it.each([
    ['altText', 'New alt text'],
    ['metaDescription', 'New SEO description'],
    ['slug', 'new-publication-path'],
  ])('treats a %s edit as an approved-payload rewrite', (field, value) => {
    expect(postWasRewritten(approvedPayload, { ...approvedPayload, [field]: value })).toBe(true);
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
