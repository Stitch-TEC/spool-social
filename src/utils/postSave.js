import { runTransaction } from 'firebase/firestore';
import { APPROVAL_STATUS, REVIEW_STAGE, STATUS } from '../constants';
import {
  approvedPayloadIdentity,
  postWasRewritten,
  reviewStateIdentity,
  suggestionPromotionDocument,
} from './review';

const REVIEW_FIELDS = [
  'approvalStatus',
  'feedback',
  'feedbackThread',
  'reviewStage',
  'sentForReviewAt',
];

// These attribution fields are not part of the current UI schema, but older or
// external writers may have stamped them. A tenant move must not carry any of
// that prior client's review identity into the new tenant.
const LEGACY_REVIEW_ATTRIBUTION_FIELDS = [
  'reviewedBy',
  'reviewedAt',
  'approvedBy',
  'approvedAt',
];
const CLIENT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const REVIEW_ACTION = Object.freeze({
  SEND: 'send',
  RESUBMIT: 'resubmit',
  HOLD: 'hold',
  APPROVE: 'approve',
  REQUEST_CHANGES: 'request_changes',
});

const REVIEW_ACTIONS = new Set(Object.values(REVIEW_ACTION));

export const reviewBaselineFor = (post) => ({
  clientId: typeof post?.clientId === 'string' ? post.clientId : '',
  payloadRevision: approvedPayloadIdentity(post),
  reviewRevision: reviewStateIdentity(post),
});

function reviewConflict(message = 'Thread changed since this review action was opened; reload and try again') {
  const error = new Error(message);
  error.code = 'review_conflict';
  error.status = 409;
  return error;
}

/**
 * One transaction for every review-stage/reviewer verb in the SPA. The button's
 * baseline binds both tenant + approved payload and the review state itself.
 * Firestore retries re-read all three, so racing feedback/approval/content can
 * never be silently last-written by a stale operator or reviewer click.
 */
export async function applyReviewActionAtomically({
  db,
  postRef,
  baseline,
  action,
  feedback = '',
  actor = 'client',
}) {
  if (!REVIEW_ACTIONS.has(action)) throw new Error(`Unknown review action: ${action}`);
  const expected = baseline?.payloadRevision && baseline?.reviewRevision
    ? baseline
    : reviewBaselineFor(baseline);
  if (!expected.clientId || !CLIENT_ID_RE.test(expected.clientId)) {
    throw reviewConflict('Thread has no valid client boundary');
  }
  const note = String(feedback || '').trim().slice(0, 500);
  if (action === REVIEW_ACTION.REQUEST_CHANGES && !note) {
    const error = new Error('Feedback cannot be empty');
    error.code = 'feedback_required';
    throw error;
  }
  const reviewer = actor === 'client' ? 'client' : 'you';
  let outcome = null;

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(postRef);
    if (!snapshot.exists()) throw reviewConflict('Thread no longer exists');
    const live = snapshot.data();
    if (
      live.source === 'suggestion'
      || live.clientId !== expected.clientId
      || approvedPayloadIdentity(live) !== expected.payloadRevision
      || reviewStateIdentity(live) !== expected.reviewRevision
    ) throw reviewConflict();

    const updatedAt = nextSaveUpdatedAt(live);
    const patch = { updatedAt };

    if (action === REVIEW_ACTION.SEND) {
      if (live.reviewStage !== REVIEW_STAGE.PRIVATE) throw reviewConflict('Thread is already in review');
      patch.reviewStage = REVIEW_STAGE.IN_REVIEW;
      patch.sentForReviewAt = updatedAt;
      if (live.approvalStatus !== APPROVAL_STATUS.APPROVED) {
        patch.approvalStatus = APPROVAL_STATUS.PENDING;
      }
    } else if (action === REVIEW_ACTION.RESUBMIT) {
      if (live.approvalStatus !== APPROVAL_STATUS.CHANGES_REQUESTED) throw reviewConflict();
      patch.approvalStatus = APPROVAL_STATUS.PENDING;
      patch.feedback = '';
      patch.reviewStage = REVIEW_STAGE.IN_REVIEW;
      patch.sentForReviewAt = updatedAt;
    } else if (action === REVIEW_ACTION.HOLD) {
      if (live.reviewStage !== REVIEW_STAGE.IN_REVIEW) throw reviewConflict('Thread is already in staging');
      patch.reviewStage = REVIEW_STAGE.PRIVATE;
    } else {
      if (live.reviewStage !== REVIEW_STAGE.IN_REVIEW) throw reviewConflict('Thread is not currently in review');
      patch.reviewedBy = reviewer;
      patch.reviewedAt = updatedAt;
      if (action === REVIEW_ACTION.APPROVE) {
        patch.approvalStatus = APPROVAL_STATUS.APPROVED;
        if (live.status === STATUS.DRAFT) patch.status = STATUS.SCHEDULED;
      } else {
        if (live.feedbackThread !== undefined && !Array.isArray(live.feedbackThread)) {
          throw reviewConflict('Feedback history is malformed');
        }
        const history = Array.isArray(live.feedbackThread) ? live.feedbackThread : [];
        if (history.length >= 200) {
          const error = new Error('Feedback history is full');
          error.code = 'feedback_thread_full';
          error.status = 409;
          throw error;
        }
        patch.feedback = note;
        patch.feedbackThread = [...history, { text: note, by: reviewer, at: updatedAt }];
        patch.approvalStatus = APPROVAL_STATUS.CHANGES_REQUESTED;
      }
    }

    transaction.update(postRef, patch);
    outcome = { action, patch };
  });

  return outcome;
}

/** Bulk review verbs deliberately call the same per-document transaction.
 * Small chunks avoid an unbounded connection spike while still allowing useful
 * concurrency; each result remains attributable to its baseline post. */
export async function applyReviewActionBatch({ db, items, action, actor = 'you', chunkSize = 20 }) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    results.push(...await Promise.allSettled(chunk.map(({ postRef, baseline }) =>
      applyReviewActionAtomically({ db, postRef, baseline, action, actor }))));
  }
  return results;
}

export function nextSaveUpdatedAt(live, nowMs = Date.now()) {
  const floor = [live?.updatedAt, live?.createdAt]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value + 1), 0);
  return new Date(Math.max(nowMs, floor)).toISOString();
}

/**
 * Resolve an existing editor selection without ever deriving a tenant slug
 * from mutable display text. A known roster/stamped target is an intentional
 * move; otherwise a changed label remains on the post's immutable tenant ID.
 */
export function resolveExistingClientId({
  requestedClient,
  baselineClient,
  baselineClientId,
  knownClientId,
}) {
  if (typeof baselineClientId !== 'string') return typeof knownClientId === 'string' ? knownClientId : '';
  if (String(requestedClient || '') === String(baselineClient || '')) return baselineClientId;
  return typeof knownClientId === 'string' && knownClientId ? knownClientId : baselineClientId;
}

/**
 * Resolve an editor image before constructing the Firestore write.
 *
 * Keeping this order in a tested helper prevents the original existing-post
 * regression: approval comparison tried to read the hosted `imageUrl` binding
 * before it was initialized. An upload miss remains fail-open, but an oversized
 * data URL is removed rather than truncated into corrupt Firestore data.
 */
export async function preparePostImageForSave({
  submittedImageUrl,
  forClient,
  hostImage,
  onImageDropped,
}) {
  const submitted = typeof submittedImageUrl === 'string' ? submittedImageUrl : '';
  let imageUrl = await hostImage(submitted, forClient);
  imageUrl = typeof imageUrl === 'string' ? imageUrl : '';
  let imageDropped = false;

  if (imageUrl.startsWith('data:') && imageUrl.length > 500000) {
    imageUrl = '';
    imageDropped = !!submitted;
    onImageDropped?.();
  }

  return { submittedImageUrl: submitted, imageUrl, imageDropped };
}

/**
 * Atomically save an existing post without overwriting client review state.
 *
 * `submittedPayload.imageUrl` is the PRE-host value the editor actually
 * submitted. That makes data-URL → content-addressed URL a storage migration,
 * while a user-selected replacement still invalidates approval. The transaction
 * reads the server document and retries if an approval/feedback write races it.
 */
export async function saveExistingPostAtomically({
  db,
  postRef,
  postData,
  submittedPayload,
  baselineStatus,
  baselineClientId,
  baselineClient,
}) {
  let outcome = { approvalReset: false, tenantReset: false };

  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(postRef);
    if (!snapshot.exists()) throw new Error('Thread no longer exists');
    const live = snapshot.data();
    const patch = { ...postData };

    // Review fields belong to the live client/reviewer path. Never write values
    // captured when the editor opened; feedback/history are omitted entirely.
    for (const field of REVIEW_FIELDS) delete patch[field];

    const hasRequestedClientId = typeof postData.clientId === 'string';
    const requestedClientId = hasRequestedClientId ? postData.clientId : '';
    const hasRequestedClient = typeof postData.client === 'string';
    const requestedClient = hasRequestedClient ? postData.client : '';
    const liveClientId = typeof live.clientId === 'string' ? live.clientId : '';
    const liveClient = typeof live.client === 'string' ? live.client : '';
    const hasTenantBaseline = typeof baselineClientId === 'string';
    const hasClientLabelBaseline = typeof baselineClient === 'string';
    const editorRequestedTenantChange = hasRequestedClientId && (hasTenantBaseline
      ? requestedClientId !== baselineClientId
      : requestedClientId !== liveClientId);
    const editorRequestedLabelChange = hasRequestedClient && hasClientLabelBaseline
      && requestedClient !== baselineClient;

    // Any live tenant reassignment after this editor opened must ABORT, even if
    // another editor happened to choose the same requested destination. This
    // payload was prepared against the old tenant and must never be replayed
    // into a tenant whose move completed concurrently.
    if (
      hasTenantBaseline
      && liveClientId !== baselineClientId
    ) {
      const error = new Error('Thread client changed while you were editing; reload and try again');
      error.code = 'tenant_changed';
      throw error;
    }

    // The tenant is stable but its display label may be renamed independently.
    // Preserve a live same-ID rename when this editor left its label unchanged;
    // if both operators intentionally chose different new labels, fail instead
    // of silently selecting the last writer.
    if (
      hasTenantBaseline
      && liveClientId === baselineClientId
      && !editorRequestedTenantChange
      && hasClientLabelBaseline
      && liveClient !== baselineClient
    ) {
      if (editorRequestedLabelChange && liveClient !== requestedClient) {
        const error = new Error('Thread client label changed while you were editing; reload and try again');
        error.code = 'tenant_label_changed';
        throw error;
      }
      if (!editorRequestedLabelChange) delete patch.client;
    }

    // ID is authoritative. Do not rewrite an unchanged ID.
    if (hasTenantBaseline && !editorRequestedTenantChange) delete patch.clientId;

    const tenantReset = editorRequestedTenantChange && requestedClientId !== liveClientId;
    if (tenantReset) {
      // A client move is a new review lifecycle. Reset every prior-client review
      // fact atomically with clientId/client so no snapshot can expose feedback
      // or approval under the new tenant.
      patch.approvalStatus = APPROVAL_STATUS.PENDING;
      patch.reviewStage = 'private';
      patch.feedback = '';
      patch.feedbackThread = [];
      patch.sentForReviewAt = null;
      for (const field of LEGACY_REVIEW_ATTRIBUTION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(live, field)) patch[field] = null;
      }
    }

    // Guest approval advances a draft to scheduled. If that happened while an
    // editor loaded with `draft` was still open, its unchanged select value is
    // stale—not an operator request to rewind workflow. Preserve the live value
    // unless the operator actually changed status from the editor's baseline.
    if (
      typeof baselineStatus === 'string'
      && postData.status === baselineStatus
      && live.status !== baselineStatus
    ) delete patch.status;

    const liveApproval = Object.values(APPROVAL_STATUS).includes(live.approvalStatus)
      ? live.approvalStatus
      : APPROVAL_STATUS.PENDING;
    const rewritten = postWasRewritten(live, submittedPayload);
    const approvalReset = liveApproval === APPROVAL_STATUS.APPROVED && rewritten;

    if (!tenantReset && (approvalReset || !Object.values(APPROVAL_STATUS).includes(live.approvalStatus))) {
      patch.approvalStatus = APPROVAL_STATUS.PENDING;
    }

    // Hosting finished before this transaction starts. Recompute on every
    // Firestore retry and stay strictly after live review/creation timestamps.
    patch.updatedAt = nextSaveUpdatedAt(live);

    transaction.update(postRef, patch);
    outcome = { approvalReset, rewritten, tenantReset };
  });

  return outcome;
}

/**
 * The existing-post path used by App.jsx: host/version the submitted image,
 * prepare the final document patch, then perform the live review-state
 * transaction. Tests invoke this same boundary so ordering regressions in the
 * save preparation cannot hide behind a pure comparison-unit test.
 */
export async function saveExistingPostWithImageAtomically({
  db,
  postRef,
  postData,
  submittedImageUrl,
  baselineStatus,
  baselineClientId,
  baselineClient,
  forClient,
  hostImage,
  onImageDropped,
}) {
  const prepared = await preparePostImageForSave({
    submittedImageUrl,
    forClient,
    hostImage,
    onImageDropped,
  });
  const outcome = await saveExistingPostAtomically({
    db,
    postRef,
    postData: { ...postData, imageUrl: prepared.imageUrl.slice(0, 500000) },
    submittedPayload: {
      content: postData.content,
      title: postData.title,
      imageUrl: prepared.submittedImageUrl,
      platform: postData.platform,
      imageDropped: prepared.imageDropped,
    },
    baselineStatus,
    baselineClientId,
    baselineClient,
  });
  return { ...outcome, ...prepared };
}

/**
 * Promote from the LIVE suggestion document, never the stale card snapshot.
 * Firestore retries re-run source/target/tag validation; a replay after another
 * promotion conflicts without clearing the new tenant's review lifecycle.
 */
export async function promoteSuggestionAtomically({
  db,
  postRef,
  ownerUid,
  resolveTarget,
}) {
  let outcome = null;
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(postRef);
    if (!snapshot.exists()) {
      const error = new Error('Suggestion no longer exists');
      error.code = 'suggestion_not_found';
      throw error;
    }
    const live = snapshot.data();
    if (live.uid !== ownerUid) {
      const error = new Error('Suggestion owner changed');
      error.code = 'suggestion_not_found';
      throw error;
    }
    if (live.source !== 'suggestion' || live.clientId !== '') {
      const error = new Error('Suggestion was already promoted or changed; refresh and try again');
      error.code = 'suggestion_already_promoted';
      throw error;
    }
    const target = String(resolveTarget(live) || '');
    if (!target || target.length > 64 || !CLIENT_ID_RE.test(target)) {
      const error = new Error('Could not resolve a canonical client for this suggestion');
      error.code = 'suggestion_client_unresolved';
      throw error;
    }
    const document = suggestionPromotionDocument(live, target, nextSaveUpdatedAt(live));
    // Replace, do not merge: operator-only suggestion provenance and any future
    // unknown internal field must be deleted before clientId becomes non-empty.
    transaction.set(postRef, document);
    outcome = { target, client: live.client || '', document };
  });
  return outcome;
}
