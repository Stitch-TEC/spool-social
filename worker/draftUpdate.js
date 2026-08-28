import {
  decodeImageBase64,
  inspectRasterImage,
  normalizeSpoolMediaContentIdentity,
  sameSpoolMediaReference,
  versionMediaMarkdownReferences,
  versionMediaReference,
} from './media.js';
import { reviewScheduledDateIdentity } from '../src/utils/reviewIdentity.js';

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

// The drafts API is a deliberate contract, not a dump of the Firestore
// document. The same paths drive the list-query projection and GET/PATCH output
// so future operator-only fields cannot accidentally expand responses or cross
// the broker seam.
export const DRAFT_PUBLIC_FIELD_PATHS = Object.freeze([
  'uid', 'clientId', 'client', 'content', 'title', 'altText',
  'metaDescription', 'slug', 'platform', 'status', 'approvalStatus',
  'feedback', 'feedbackThread', 'reviewStage', 'imageUrl', 'tags',
  'isTemplate', 'scheduledDate', 'createdAt', 'updatedAt', 'source',
  'automationId', 'forClientId', 'sentForReviewAt', 'reviewedBy', 'reviewedAt',
]);

export function publicDraftFields(draft) {
  const output = {};
  if (Object.prototype.hasOwnProperty.call(draft || {}, 'id')) output.id = draft.id;
  for (const field of DRAFT_PUBLIC_FIELD_PATHS) {
    if (Object.prototype.hasOwnProperty.call(draft || {}, field)) output[field] = draft[field];
  }
  return output;
}

const PUBLICATION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function draftPublicationTitle(draft) {
  const firstLine = String(draft?.content || '').replace(/\r\n?/g, '\n').trim()
    .split('\n')[0]
    .replace(/^#+\s*/, '');
  return String(draft?.title || firstLine).trim().slice(0, 200) || 'Untitled post';
}

export function draftPublicationSlug(draft) {
  const explicit = String(draft?.slug || '').trim();
  let value = explicit;
  if (!value && ['blog', 'job'].includes(String(draft?.platform || ''))) {
    const title = draftPublicationTitle(draft);
    value = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled-post';
  }
  if (value && (value.length > 80 || !PUBLICATION_SLUG_RE.test(value))) {
    const error = new Error('Draft publication slug is malformed');
    error.code = 'draft_publication_slug_invalid';
    throw error;
  }
  return value;
}

export function publicationPathMatchesSlug(path, slug) {
  const match = String(path || '').match(/(?:^|\/)([a-z0-9]+(?:-[a-z0-9]+)*)\.(?:md|mdx)$/);
  return !!match && match[1] === String(slug || '');
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
    String(draft?.altText || ''),
    String(draft?.metaDescription || ''),
    // Long-form publication target. Missing legacy values and explicit empty
    // strings intentionally hash alike; callers never invent a fallback.
    draftPublicationSlug(draft),
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
    reviewScheduledDateIdentity(draft?.scheduledDate),
  ]);
}

export const draftPayloadRevision = (origin, draft, legacyOrigins = []) =>
  sha256(draftPayloadIdentity(origin, draft, legacyOrigins));

export const draftReviewRevision = (draft) => sha256(draftReviewIdentity(draft));

const REVIEW_EDITORIAL_FIELDS = Object.freeze([
  'content', 'title', 'platform', 'altText', 'metaDescription', 'slug', 'tags', 'scheduledDate',
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
  const publicDraft = publicDraftFields(draft);
  return {
    ...publicDraft,
    // The broker validates these approval-bearing preview fields strictly. Old
    // rows may omit optional fields, so normalize them here rather than asking
    // a downstream caller to invent consent-bearing values.
    content: versionMediaMarkdownReferences(origin, String(publicDraft.content || ''), legacyOrigins),
    title: String(publicDraft.title || ''),
    imageUrl: versionMediaReference(origin, String(publicDraft.imageUrl || ''), legacyOrigins),
    platform: String(publicDraft.platform || ''),
    altText: String(publicDraft.altText || ''),
    metaDescription: String(publicDraft.metaDescription || ''),
    slug: draftPublicationSlug(publicDraft),
    payloadRevision: await draftPayloadRevision(origin, draft, legacyOrigins),
    reviewRevision: await draftReviewRevision(draft),
  };
}

export function draftApprovedPayloadChanged(origin, live, next, legacyOrigins = []) {
  return normalizeSpoolMediaContentIdentity(origin, live?.content, legacyOrigins)
      !== normalizeSpoolMediaContentIdentity(origin, next?.content, legacyOrigins)
    || String(live?.title || '') !== String(next?.title || '')
    || !sameSpoolMediaReference(origin, live?.imageUrl, next?.imageUrl, legacyOrigins)
    || String(live?.platform || '') !== String(next?.platform || '')
    || String(live?.altText || '') !== String(next?.altText || '')
    || String(live?.metaDescription || '') !== String(next?.metaDescription || '')
    || draftPublicationSlug(live) !== draftPublicationSlug(next);
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
  if (intent.reviewAction && live.status === 'archived') {
    const error = new Error('Archived drafts cannot take review actions'); error.code = 'review_conflict'; error.status = 409; throw error;
  }
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
    if (intent.reviewAction === 'request_changes') {
      if (typeof intent.feedback !== 'string' || !intent.feedback.trim() || intent.feedback.length > 500) {
        const err = new Error('Feedback must contain text and be no more than 500 characters');
        err.code = 'feedback_invalid';
        err.status = 400;
        throw err;
      }
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
