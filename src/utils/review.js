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
// Operator-side derivation preserves the historical ABSENT === in_review meaning.
// Client/member queries and rules now fail missing stages closed; the guarded
// rollout backfills legacy rows before those boundaries deploy.
// New posts are created 'private', so the staging area is opt-OUT for legacy
// content and opt-IN for everything made from here on.
//
// reviewStateOf() folds the two client-facing axes into the FOUR mutually
// exclusive buckets an operator actually triages by. Approval facts win over
// stage: 'approved'/'changes_requested' record something the client DID, and
// pulling a post back to staging must not erase that.
// =============================================================================
import { APPROVAL_STATUS, REVIEW_STAGE, REVIEW_STATE, STATUS } from '../constants';
import {
  normalizeSpoolMediaContentIdentity,
  sameSpoolMediaReference,
  spoolMediaIdentity,
} from './helpers';
import { reviewScheduledDateIdentity } from './reviewIdentity';

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

const slugifyPublicationTitle = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

/** Effective public path segment. New rows persist `slug`; legacy long-form
 * rows derive the exact publisher fallback from other approval-bound fields so
 * the review UI never shows “empty” while publication silently targets a path. */
export const publicationSlugOf = (post) => {
  const explicit = String(post?.slug || '').trim();
  if (explicit) return explicit;
  if (!['blog', 'job'].includes(String(post?.platform || ''))) return '';
  const firstLine = String(post?.content || '').replace(/\r\n?/g, '\n').trim()
    .split('\n')[0]
    .replace(/^#+\s*/, '');
  const title = String(post?.title || firstLine).trim().slice(0, 200) || 'Untitled post';
  // A punctuation/emoji-only title must still resolve to the same visible,
  // approval-bound target that the publisher will use.
  return slugifyPublicationTitle(title) || 'untitled-post';
};

/** Stable identity of exactly the client-approved payload. Media cache-version
 * migrations collapse to the same object key, while ordinary external URLs and
 * copy remain byte-for-byte significant. This is also the baseline used by all
 * review-action transactions. */
export const approvedPayloadIdentity = (post) => {
  const image = String(post?.imageUrl || '');
  const mediaKey = spoolMediaIdentity(image);
  return JSON.stringify([
    normalizeSpoolMediaContentIdentity(String(post?.content || '')),
    String(post?.title || ''),
    mediaKey === null ? image : `spool-media:${mediaKey}`,
    String(post?.platform || ''),
    String(post?.altText || ''),
    String(post?.metaDescription || ''),
    // `slug` is the publication target for long-form content. Social drafts
    // deliberately carry the empty string, so legacy-missing and explicit
    // empty values remain the same approval identity.
    publicationSlugOf(post),
  ]);
};

/**
 * Remove storage-only canonicalization from a direct Firestore member write.
 * Security rules intentionally compare stored strings strictly; allowing every
 * v1/v2/host spelling in rules would require fragile path parsing and could
 * weaken genuine approval resets. The SPA therefore leaves equivalent stored
 * bytes untouched while continuing to render canonical v2 values on read.
 */
export const approvalSafeStoragePatch = (live, requestedPatch) => {
  const patch = { ...(requestedPatch || {}) };
  const requestedDocument = { ...(live || {}), ...patch };
  if (
    Object.prototype.hasOwnProperty.call(patch, 'content')
    && normalizeSpoolMediaContentIdentity(live?.content)
      === normalizeSpoolMediaContentIdentity(patch.content)
  ) delete patch.content;
  if (
    Object.prototype.hasOwnProperty.call(patch, 'imageUrl')
    && sameSpoolMediaReference(live?.imageUrl, patch.imageUrl)
  ) delete patch.imageUrl;
  if (
    Object.prototype.hasOwnProperty.call(patch, 'slug')
    && publicationSlugOf(live) === publicationSlugOf(requestedDocument)
  ) delete patch.slug;
  for (const field of ['title', 'altText', 'metaDescription']) {
    if (
      Object.prototype.hasOwnProperty.call(patch, field)
      && String(live?.[field] || '') === String(patch[field] || '')
    ) delete patch[field];
  }
  return patch;
};

/** The review state a button was rendered against. Including the history and
 * latest note prevents two reviewer/operator actions on unchanged copy from
 * silently last-writing each other. */
export const reviewStateIdentity = (post) => JSON.stringify([
  String(post?.status || ''),
  String(post?.approvalStatus || ''),
  String(post?.reviewStage || ''),
  String(post?.sentForReviewAt || ''),
  String(post?.feedback || ''),
  Array.isArray(post?.feedbackThread) ? post.feedbackThread : null,
  String(post?.reviewedBy || ''),
  String(post?.reviewedAt || ''),
  // Scheduling is workflow, not approved copy: changing it does not revoke an
  // approval, but a review button rendered before the change is stale.
  // usePosts retains the exact storage value alongside its Date read model.
  // That lets legacy datetime-local rows bind byte-for-byte to the live
  // transaction without teaching the strict canonicalizer to guess a zone.
  reviewScheduledDateIdentity(post?._raw_scheduledDate ?? post?.scheduledDate),
]);

// Replacement document (not a merge patch) for promotion. Suggestions can
// carry operator-only provenance/instructions and may gain more internal fields
// over time. Copying an explicit client-safe allowlist ensures suggestSeed,
// forClientId, automationId, unknown operator notes, and stale review facts are
// physically deleted before the document acquires a tenant id.
const PROMOTION_SAFE_FIELDS = Object.freeze([
  'uid', 'client', 'content', 'title', 'altText', 'metaDescription', 'slug',
  'platform', 'imageUrl', 'scheduledDate', 'createdAt',
]);

export const suggestionPromotionDocument = (post, clientId, updatedAt = new Date().toISOString()) => {
  const promoted = {};
  for (const field of PROMOTION_SAFE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(post || {}, field)) promoted[field] = post[field];
  }
  return {
    ...promoted,
    clientId,
    source: 'automation',
    status: STATUS.DRAFT,
    reviewStage: REVIEW_STAGE.PRIVATE,
    approvalStatus: APPROVAL_STATUS.PENDING,
    feedback: '',
    feedbackThread: [],
    sentForReviewAt: null,
    tags: (Array.isArray(post?.tags) ? post.tags : []).filter((tag) => tag !== 'suggested'),
    isTemplate: false,
    updatedAt,
  };
};

/**
 * Has an edit changed the client-approved payload?
 *
 * Keep this comparison pure and centralized: image-only edits are just as
 * approval-sensitive as copy edits, while status/scheduling/metadata changes
 * intentionally are not. Existing-post saves pass the PRE-host submitted image
 * identity, so data-URL rehosting is storage migration rather than a rewrite;
 * the tested preparation helper keeps upload/check ordering explicit.
 */
export const postWasRewritten = (post, next) => !!post && (
  // A v1 → v2 reference is the same R2 object behind a new cache key. That can
  // occur in either the cover field or long-form Markdown and is storage-only.
  normalizeSpoolMediaContentIdentity(post.content) !== normalizeSpoolMediaContentIdentity(next?.content) ||
  (post.title || '') !== (next?.title || '') ||
  !sameSpoolMediaReference(post.imageUrl, next?.imageUrl) ||
  String(post.platform || '') !== String(next?.platform || '') ||
  String(post.altText || '') !== String(next?.altText || '') ||
  String(post.metaDescription || '') !== String(next?.metaDescription || '') ||
  publicationSlugOf(post) !== publicationSlugOf(next) ||
  // When a failed upload forces the final saved image to be empty, that is a
  // real payload change even if the submitted pre-host image matched the live
  // post. Successful data-URL → /media migration is storage-only and does not
  // set this flag.
  (!!next?.imageDropped && !!next?.imageUrl)
);

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
