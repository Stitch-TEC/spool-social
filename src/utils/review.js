// =============================================================================
// The review pipeline — one derivation shared by every surface.
//
// Spool already had TWO independent axes and no way to tell them apart in the UI:
//   • STATUS          draft → scheduled → posted → archived   (the WORKFLOW axis)
//   • APPROVAL_STATUS pending / approved / changes_requested   (the CLIENT axis)
//
// The gap this module closes: `approvalStatus: 'pending'` was the default on
// EVERY post from the moment it was created, so it conflated two completely
// different situations — "the client has it and hasn't answered" and "I haven't
// shown this to anyone yet". With a live review link, a half-written draft was
// visible to the client the instant it was saved. There was no staging area.
//
// `reviewStage` is the missing third axis, and it is ADDITIVE (suite invariant):
//   'private'    → staging. Operator workspace only; kept off the review link.
//   'in_review'  → sent. The client sees it and can act on it.
// ABSENT === 'in_review' so every pre-existing post (and every live review link)
// behaves EXACTLY as it did before this change — no backfill, nothing vanishes.
// New posts are created 'private', so the staging area is opt-OUT for legacy
// content and opt-IN for everything made from here on.
//
// reviewStateOf() folds the two client-facing axes into the FOUR mutually
// exclusive buckets an operator actually triages by. Approval facts win over
// stage: 'approved'/'changes_requested' record something the client DID, and
// pulling a post back to staging must not erase that.
// =============================================================================
import { APPROVAL_STATUS, REVIEW_STAGE, REVIEW_STATE } from '../constants';

/** The post's stage, with the legacy default (absent = already in review). */
export const reviewStageOf = (post) =>
  post?.reviewStage === REVIEW_STAGE.PRIVATE ? REVIEW_STAGE.PRIVATE : REVIEW_STAGE.IN_REVIEW;

/** True when the post is parked in staging (never shown on a review link). */
export const isStaged = (post) => reviewStageOf(post) === REVIEW_STAGE.PRIVATE;

/**
 * The single triage bucket for a post: NOT_SENT | AWAITING | CHANGES | APPROVED.
 * Suggestions are NOT review content and are excluded upstream (their own lane).
 */
export const reviewStateOf = (post) => {
  if (post?.approvalStatus === APPROVAL_STATUS.APPROVED) return REVIEW_STATE.APPROVED;
  if (post?.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) return REVIEW_STATE.CHANGES;
  return isStaged(post) ? REVIEW_STATE.NOT_SENT : REVIEW_STATE.AWAITING;
};

/** Does this post carry any client feedback (threaded history or the legacy field)? */
export const hasFeedback = (post) =>
  (Array.isArray(post?.feedbackThread) && post.feedbackThread.length > 0) || !!post?.feedback;

/**
 * Whole days a post has been sitting with the client unanswered, or null when
 * that question doesn't apply (not sent, or already answered). `sentForReviewAt`
 * is stamped by the operator's send action; posts that predate it fall back to
 * createdAt so the age is approximate rather than missing.
 */
export const daysAwaiting = (post, now = Date.now()) => {
  if (reviewStateOf(post) !== REVIEW_STATE.AWAITING) return null;
  const raw = post?.sentForReviewAt || post?._raw_createdAt || post?.createdAt;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(raw || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
};
