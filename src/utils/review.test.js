import { describe, it, expect } from 'vitest';
import { reviewStageOf, isStaged, reviewStateOf, hasFeedback, daysAwaiting } from './review';
import { REVIEW_STAGE, REVIEW_STATE } from '../constants';

describe('reviewStageOf', () => {
  it('treats an ABSENT reviewStage as in_review (legacy back-compat)', () => {
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
