import {
  decodeImageBase64,
  inspectRasterImage,
  normalizeSpoolMediaContentIdentity,
  sameSpoolMediaReference,
  versionMediaMarkdownReferences,
  versionMediaReference,
} from './media.js';

function dataImageParts(value, fallbackMime = '') {
  const text = String(value || '').trim();
  const match = text.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (match) return { mime: match[1], b64: match[2].replace(/\s+/g, '') };
  if (!text) return null;
  return { mime: fallbackMime, b64: text.replace(/\s+/g, '') };
}

// A legacy data URL becoming a content-addressed /media URL is a storage move,
// not a client-visible edit. Compare decoded raster bytes before hosting so a
// no-op migration cannot revoke approval. Invalid/oversized inputs fail closed
// here and are rejected by the normal image ingestion path immediately after.
export function sameLegacyImageBytes(currentImageUrl, imageInput) {
  if (!String(currentImageUrl || '').startsWith('data:') || !imageInput?.base64) return false;
  try {
    const current = dataImageParts(currentImageUrl);
    const incoming = dataImageParts(imageInput.base64, imageInput.mime || '');
    if (!current || !incoming) return false;
    const a = decodeImageBase64(current.b64);
    const b = decodeImageBase64(incoming.b64);
    // Existing legacy metadata is not trusted; identity comes from bytes.
    inspectRasterImage(a);
    inspectRasterImage(b, incoming.mime);
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  } catch {
    return false;
  }
}

const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export function draftPayloadIdentity(origin, draft, legacyOrigins = []) {
  const image = String(draft?.imageUrl || '');
  const normalizedImage = versionMediaReference(origin, image, legacyOrigins);
  return JSON.stringify([
    normalizeSpoolMediaContentIdentity(origin, String(draft?.content || ''), legacyOrigins),
    String(draft?.title || ''),
    // Canonical versioning collapses v1/v2/legacy host variants without
    // normalizing arbitrary external media URLs.
    normalizedImage || image,
    String(draft?.platform || ''),
  ]);
}

export function draftReviewIdentity(draft) {
  return JSON.stringify([
    String(draft?.status || ''),
    String(draft?.approvalStatus || ''),
    String(draft?.reviewStage || ''),
    String(draft?.sentForReviewAt || ''),
    String(draft?.feedback || ''),
    Array.isArray(draft?.feedbackThread) ? draft.feedbackThread : null,
    String(draft?.reviewedBy || ''),
    String(draft?.reviewedAt || ''),
  ]);
}

export const draftPayloadRevision = (origin, draft, legacyOrigins = []) =>
  sha256(draftPayloadIdentity(origin, draft, legacyOrigins));

export const draftReviewRevision = (draft) => sha256(draftReviewIdentity(draft));

const REVIEW_EDITORIAL_FIELDS = Object.freeze([
  'content', 'title', 'platform', 'altText', 'metaDescription', 'tags', 'scheduledDate',
  'image', 'imageUrl',
]);

/** A review verb is consent about the exact payload represented by the caller's
 * baseline digest. Combining it with an edit would approve/send bytes that
 * baseline never identified, so callers must save first, refresh, then review. */
export function assertIsolatedDraftReviewIntent(body, { hasApproval, hasReviewStage, hasStatus }) {
  if (!hasApproval && !hasReviewStage) return true;
  const editedField = REVIEW_EDITORIAL_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(body || {}, field));
  if (editedField) {
    const error = new Error(`Review actions cannot include an editorial change (${editedField}); save and refresh first`);
    error.code = 'mixed_review_edit';
    error.status = 400;
    throw error;
  }
  // Approve+scheduled is the one intentional workflow coupling. Send/Hold are
  // stage-only verbs and cannot carry a second stale workflow instruction.
  if (hasReviewStage && !hasApproval && hasStatus) {
    const error = new Error('Send/Hold actions cannot also change workflow status');
    error.code = 'mixed_review_edit';
    error.status = 400;
    throw error;
  }
  return true;
}

export async function assertDraftBaseline(origin, live, baseline, legacyOrigins = [], { review = false } = {}) {
  const payloadRevision = await draftPayloadRevision(origin, live, legacyOrigins);
  const reviewRevision = review ? await draftReviewRevision(live) : '';
  if (
    typeof baseline?.clientId !== 'string'
    || live?.clientId !== baseline.clientId
    || payloadRevision !== baseline.payloadRevision
    || (review && reviewRevision !== baseline.reviewRevision)
  ) {
    const error = new Error('Draft tenant, content, or review state changed; reload before updating');
    error.code = 'review_conflict';
    error.status = 409;
    throw error;
  }
  return true;
}

export async function versionDraftMedia(origin, draft, legacyOrigins = []) {
  if (!draft) return draft;
  const { _updateTime: _discardedUpdateTime, ...publicDraft } = draft;
  return {
    ...publicDraft,
    content: versionMediaMarkdownReferences(origin, publicDraft.content, legacyOrigins),
    imageUrl: versionMediaReference(origin, publicDraft.imageUrl, legacyOrigins),
    payloadRevision: await draftPayloadRevision(origin, draft, legacyOrigins),
    reviewRevision: await draftReviewRevision(draft),
  };
}

export function draftApprovedPayloadChanged(origin, live, next, legacyOrigins = []) {
  return normalizeSpoolMediaContentIdentity(origin, live?.content, legacyOrigins)
      !== normalizeSpoolMediaContentIdentity(origin, next?.content, legacyOrigins)
    || String(live?.title || '') !== String(next?.title || '')
    || !sameSpoolMediaReference(origin, live?.imageUrl, next?.imageUrl, legacyOrigins)
    || String(live?.platform || '') !== String(next?.platform || '');
}

export function nextDraftUpdatedAt(live, nowMs = Date.now()) {
  const floors = [live?.updatedAt, live?.createdAt]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
  const floor = floors.length ? Math.max(...floors) + 1 : 0;
  return new Date(Math.max(nowMs, floor)).toISOString();
}

/** Build one compare-and-swap attempt from the current live draft.
 *
 * `intent.fields` contains only explicitly submitted editable fields, already
 * sanitized/hosted. Review/history fields are derived here on EVERY retry so a
 * concurrent client action is preserved rather than overwritten.
 */
export function buildDraftMutation(origin, live, intent, nowMs = Date.now(), legacyOrigins = []) {
  const patch = { ...(intent.fields || {}) };
  const updatedAt = nextDraftUpdatedAt(live, nowMs);

  // Review verbs have one centralized state machine. The caller's review
  // revision handles races; these guards reject an action that was invalid even
  // for the exact baseline it supplied.
  if (intent.reviewAction === 'send' && live.reviewStage !== 'private') {
    const error = new Error('Draft is already in review'); error.code = 'review_conflict'; error.status = 409; throw error;
  }
  if (intent.reviewAction === 'hold' && live.reviewStage !== 'in_review') {
    const error = new Error('Draft is already private'); error.code = 'review_conflict'; error.status = 409; throw error;
  }
  if (['approve', 'request_changes'].includes(intent.reviewAction) && live.reviewStage !== 'in_review') {
    const error = new Error('Draft is not currently in review'); error.code = 'review_conflict'; error.status = 409; throw error;
  }
  if (intent.reviewAction === 'resubmit' && live.approvalStatus !== 'changes_requested') {
    const error = new Error('Draft is not awaiting revisions'); error.code = 'review_conflict'; error.status = 409; throw error;
  }

  if (intent.hasStatus) {
    // A coupled approval may advance only a still-draft item. If a concurrent
    // action already moved it to posted/archived, a stale `scheduled` must not
    // rewind workflow. A status-only API edit remains explicit operator intent.
    const staleOrdinaryStatus = intent.baseStatus !== undefined
      && live.status !== intent.baseStatus
      && intent.status === intent.baseStatus;
    const coupledReviewAdvance = intent.hasApproval && intent.status === 'scheduled';
    if (!coupledReviewAdvance && !staleOrdinaryStatus) {
      patch.status = intent.status;
    } else if (intent.approvalStatus === 'approved' && live.status === 'draft') {
      patch.status = intent.status;
    }
  }

  if (intent.hasReviewStage) {
    patch.reviewStage = intent.reviewStage;
    if (intent.reviewStage === 'in_review') {
      patch.sentForReviewAt = updatedAt;
      if (!intent.hasApproval && live.approvalStatus !== 'approved') {
        patch.approvalStatus = 'pending';
      }
    }
  }

  const nextPayload = { ...live, ...patch };
  const storageOnlyImageMigration = intent.migratedImageFrom
    && String(live.imageUrl || '') === String(intent.migratedImageFrom);
  const comparisonPayload = storageOnlyImageMigration
    ? { ...nextPayload, imageUrl: live.imageUrl }
    : nextPayload;
  const payloadChanged = draftApprovedPayloadChanged(origin, live, comparisonPayload, legacyOrigins);
  if (!intent.hasApproval && live.approvalStatus === 'approved' && payloadChanged) {
    patch.approvalStatus = 'pending';
  }

  let append = null;
  if (intent.hasApproval) {
    if (intent.reviewAction === 'resubmit') {
      patch.approvalStatus = 'pending';
      patch.feedback = '';
      patch.reviewStage = 'in_review';
      patch.sentForReviewAt = updatedAt;
    } else {
      patch.approvalStatus = intent.approvalStatus;
      patch.reviewedBy = intent.reviewedBy === 'client' ? 'client' : 'you';
      patch.reviewedAt = updatedAt;
    }
    if (intent.reviewAction === 'request_changes' && intent.feedback) {
      if (live.feedbackThread !== undefined && !Array.isArray(live.feedbackThread)) {
        const err = new Error('Feedback history is malformed');
        err.code = 'feedback_thread_invalid';
        err.status = 409;
        throw err;
      }
      const history = Array.isArray(live.feedbackThread) ? live.feedbackThread : [];
      if (history.length >= 200) {
        const err = new Error('Feedback history is full');
        err.code = 'feedback_thread_full';
        err.status = 409;
        throw err;
      }
      patch.feedback = intent.feedback;
      append = {
        field: 'feedbackThread',
        entry: {
          text: intent.feedback,
          by: intent.reviewedBy === 'client' ? 'client' : 'you',
          at: updatedAt,
        },
      };
    }
  }

  // Timestamp is deliberately last and recomputed on every transaction retry,
  // after any image hosting. It cannot predate live createdAt/updatedAt.
  patch.updatedAt = updatedAt;
  return { patch, append, payloadChanged };
}
