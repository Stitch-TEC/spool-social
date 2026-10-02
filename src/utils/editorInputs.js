import { PLATFORMS, STATUS } from '../constants';

export const TAG_LIMIT = 10;
export const TAG_LENGTH_LIMIT = 20;

// Reject, never truncate: a saved tag must mean what its author entered.
export function validatedTags(value = []) {
  if (!Array.isArray(value) || value.length > TAG_LIMIT) throw new Error('Use no more than 10 tags.');
  const tags = value.map(tag => {
    if (typeof tag !== 'string' || !tag.trim() || tag.trim().length > TAG_LENGTH_LIMIT) {
      throw new Error('Each tag must contain 1–20 characters.');
    }
    return tag.trim();
  });
  if (new Set(tags).size !== tags.length) throw new Error('Remove duplicate tags before saving.');
  return tags;
}

// Observed content preference, not platform access or publishing readiness.
// Stable ties use the existing platform order. Unknown/foreign tenants never count.
export function defaultPlatformForClient(posts, clientId) {
  if (!clientId) return 'gmb';
  const counts = Object.fromEntries(Object.keys(PLATFORMS).map(key => [key, 0]));
  for (const post of Array.isArray(posts) ? posts : []) {
    if (post?.clientId === clientId && !post.isTemplate && post.source !== 'suggestion'
      && post.status !== STATUS.ARCHIVED && Object.prototype.hasOwnProperty.call(counts, post.platform)) counts[post.platform]++;
  }
  return Object.keys(counts).reduce((best, key) => counts[key] > counts[best] ? key : best, 'gmb');
}
