import { parseVideoReference } from './videoReferences.js';

// This is a compatibility contract, not an authoring switch. Review references
// are mutable external destinations, not copied files or proof of access.
export const REVIEW_DETAILS_FIELDS = ['reviewDetailsVersion', 'reviewMedia', 'firstComment'];
export const REVIEW_MEDIA_LIMIT = 5;
export const FIRST_COMMENT_LIMIT = 4000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const itemKeys = ['id', 'url', 'label', 'version'];

export function hasReviewDetailsFields(value) {
  return object(value) && REVIEW_DETAILS_FIELDS.some(key => own(value, key));
}

export function isValidReviewMedia(value) {
  if (!Array.isArray(value) || value.length > REVIEW_MEDIA_LIMIT) return false;
  const ids = new Set();
  const urls = new Set();
  for (const item of value) {
    if (!object(item) || Object.keys(item).length !== itemKeys.length
      || itemKeys.some(key => !own(item, key))
      || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{20,80}$/.test(item.id)
      || typeof item.label !== 'string' || item.label.length > 120
      || typeof item.version !== 'string' || item.version.length > 80) return false;
    const parsed = parseVideoReference(item.url);
    if (!parsed || parsed.url !== item.url || ids.has(item.id) || urls.has(item.url)) return false;
    ids.add(item.id);
    urls.add(item.url);
  }
  return true;
}

// Presence is intentional: a legacy object stays legacy. Once extensions are
// present, their marker cannot be missing, even when both controls are empty.
export function isValidReviewDetails(value) {
  if (!object(value)) return false;
  if (!hasReviewDetailsFields(value)) return true;
  return own(value, 'reviewDetailsVersion') && value.reviewDetailsVersion === 1
    && (!own(value, 'firstComment') || (typeof value.firstComment === 'string'
      && value.firstComment.length <= FIRST_COMMENT_LIMIT))
    && (!own(value, 'reviewMedia') || isValidReviewMedia(value.reviewMedia));
}

export function copyReviewDetailsFields(value) {
  if (!isValidReviewDetails(value)) throw new Error('Review details need checking.');
  const copy = {};
  for (const key of REVIEW_DETAILS_FIELDS) {
    if (!own(value, key)) continue;
    copy[key] = key === 'reviewMedia' ? value[key].map(item => ({
      id: item.id, url: item.url, label: item.label, version: item.version,
    })) : value[key];
  }
  return copy;
}

export function reviewDetailsSnapshot(value) {
  if (!isValidReviewDetails(value)) throw new Error('Review details need checking.');
  return hasReviewDetailsFields(value) ? {
    version: 1,
    firstComment: own(value, 'firstComment') ? value.firstComment : '',
    reviewMedia: own(value, 'reviewMedia') ? copyReviewDetailsFields(value).reviewMedia : [],
  } : null;
}

// A separate versioned suffix preserves every legacy consent identity exactly.
export function reviewDetailsIdentity(value) {
  return JSON.stringify(reviewDetailsSnapshot(value));
}

export function reviewDetailsAcknowledgmentMatches(ack, value) {
  if (!object(ack) || Object.keys(ack).length !== 3
    || !['version', 'firstComment', 'reviewMedia'].every(key => own(ack, key))) return false;
  if (!isValidReviewDetails({ reviewDetailsVersion: ack.version,
    firstComment: ack.firstComment, reviewMedia: ack.reviewMedia })) return false;
  const snapshot = reviewDetailsSnapshot(value);
  return snapshot !== null && ack.version === 1 && ack.firstComment === snapshot.firstComment
    && JSON.stringify(ack.reviewMedia.map(item => ({
      id: item.id, url: item.url, label: item.label, version: item.version,
    }))) === JSON.stringify(snapshot.reviewMedia);
}

export function assertLegacyReviewWriter(value) {
  if (!hasReviewDetailsFields(value)) return;
  const error = new Error('This thread has review details. Editing and direct review are not enabled in this Spool version.');
  error.code = 'review_details_authoring_disabled';
  throw error;
}
