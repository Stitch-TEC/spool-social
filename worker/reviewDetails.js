import {
  REVIEW_DETAILS_FIELDS,
  copyReviewDetailsFields,
  hasReviewDetailsFields,
  isValidReviewDetails,
  reviewDetailsAcknowledgmentMatches,
  reviewDetailsSnapshot,
} from '../src/utils/reviewDetails.js';

const own = (value, field) => Object.prototype.hasOwnProperty.call(value || {}, field);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function reviewDetailsError(code) {
  const errors = {
    review_details_invalid: [400, 'Review details need checking before this draft can be used.'],
    review_details_required: [428, 'Reload in an updated app and review the additional details before acting.'],
    review_details_authoring_disabled: [400, 'Writing additional review details is not enabled.'],
    review_details_handoff_unsupported: [409, 'Additional review details are not supported by this handoff.'],
  };
  const [status, message] = errors[code];
  return Object.assign(new Error(message), { code, status });
}

// Compatibility first: accepting a request and ignoring these fields would be
// indistinguishable from saving them. The stored ack is server-owned; only the
// exact observed three-field acknowledgment is admitted on a review verb.
export function assertReviewDetailsAuthoringDisabled(value, { allowObservedAck = false } = {}) {
  if (hasReviewDetailsFields(value)
    || own(value, 'reviewMediaLinks')
    || (!allowObservedAck && own(value, 'reviewDetailsAck'))) {
    throw reviewDetailsError('review_details_authoring_disabled');
  }
}

export function storedReviewDetailsAck(value) {
  if (!own(value, 'reviewDetailsAck')) return null;
  const ack = value.reviewDetailsAck;
  if (!hasReviewDetailsFields(value) || !object(ack)
    || Object.keys(ack).length !== 4
    || !['version', 'firstComment', 'reviewMedia', 'at'].every(key => own(ack, key))
    || typeof ack.at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ack.at)
    || !Number.isFinite(Date.parse(ack.at))
    || new Date(ack.at).toISOString() !== ack.at
    || ack.at !== value.reviewedAt
    || !isValidReviewDetails({ reviewDetailsVersion: ack.version,
      firstComment: ack.firstComment, reviewMedia: ack.reviewMedia })) {
    throw reviewDetailsError('review_details_invalid');
  }
  return {
    version: ack.version, firstComment: ack.firstComment,
    reviewMedia: copyReviewDetailsFields({ reviewDetailsVersion: ack.version,
      reviewMedia: ack.reviewMedia }).reviewMedia,
    at: ack.at,
  };
}

export function assertStoredReviewDetails(value) {
  if (!isValidReviewDetails(value)) throw reviewDetailsError('review_details_invalid');
  storedReviewDetailsAck(value);
  return true;
}

export function assertObservedReviewDetails(value, ack) {
  assertStoredReviewDetails(value);
  if (!hasReviewDetailsFields(value)) {
    if (ack !== undefined) throw reviewDetailsError('review_details_invalid');
    return null;
  }
  if (!reviewDetailsAcknowledgmentMatches(ack, value)) {
    throw reviewDetailsError('review_details_required');
  }
  // Snapshot server-owned bytes, rather than keeping a mutable request object.
  return reviewDetailsSnapshot(value);
}

export function assertReviewDetailsHandoffSupported(value) {
  if (hasReviewDetailsFields(value) || own(value, 'reviewDetailsAck') || own(value, 'reviewMediaLinks')) {
    throw reviewDetailsError('review_details_handoff_unsupported');
  }
}

export const REVIEW_DETAILS_PUBLIC_FIELDS = Object.freeze([...REVIEW_DETAILS_FIELDS, 'reviewDetailsAck']);
