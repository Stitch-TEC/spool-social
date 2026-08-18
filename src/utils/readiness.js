// =============================================================================
// Post readiness — "is this actually finishable, and what's missing?"
//
// Pure + dependency-light (PLATFORM_META, not the icon-carrying PLATFORMS map) so
// it can run over the whole queue on every keystroke without dragging React or
// lucide into the hot path.
//
// BLOCKERS are things that make the post unpublishable as it stands (nothing to
// post, over the platform's hard limit, no image on an image-only channel).
// WARNINGS are things worth fixing before a client sees it. The split matters:
// the "Send for review" bulk action refuses blockers but never nags about
// warnings — an operator who wants feedback ON an unfinished idea can still
// send it.
// =============================================================================
import { PLATFORM_META } from '../generation/prompts';
import { twitterLength } from './markdownEditing';

// How much each channel depends on the image.
//   required    → the post is meaningless without one (Instagram is image-first)
//   recommended → it will underperform badly without one
//   optional    → text stands on its own
export const IMAGE_POLICY = {
  instagram: 'required',
  gmb: 'recommended',
  facebook: 'recommended',
  blog: 'recommended',
  linkedin: 'optional',
  twitter: 'optional',
  job: 'optional',
};

// Stable codes → short human labels. Kept here (not in the component) so the
// card, the filter bar and any future export all name a gap the same way.
export const READINESS_LABELS = {
  empty: 'No content',
  over_limit: 'Over the character limit',
  image_missing: 'Needs an image',
  image_suggested: 'No image',
  no_date: 'Not scheduled',
  no_alt: 'Image has no alt text',
  no_title: 'No title',
  no_meta: 'No meta description',
};

const isLong = (platformId) => !!PLATFORM_META[platformId]?.longForm;

/** Weighted length for X, raw length everywhere else (matches the editor's counter). */
export const effectiveLength = (content, platformId) =>
  platformId === 'twitter' ? twitterLength(content || '') : String(content || '').length;

/**
 * { blockers: string[], warnings: string[] } for one post — codes from
 * READINESS_LABELS, most important first. Never throws on a malformed doc.
 */
export function postReadiness(post) {
  const blockers = [];
  const warnings = [];
  if (!post) return { blockers, warnings };

  const platformId = post.platform || 'gmb';
  const meta = PLATFORM_META[platformId] || PLATFORM_META.gmb;
  const content = post.content || '';
  const hasImage = !!post.imageUrl;

  if (!content.trim()) blockers.push('empty');
  else if (effectiveLength(content, platformId) > meta.maxChars) blockers.push('over_limit');

  const policy = IMAGE_POLICY[platformId] || 'optional';
  if (!hasImage) {
    if (policy === 'required') blockers.push('image_missing');
    else if (policy === 'recommended') warnings.push('image_suggested');
  } else if (!String(post.altText || '').trim()) {
    // Alt text is the accessibility floor, and the publish lane writes it into
    // the client's site verbatim — a missing one ships a broken <img> to prod.
    warnings.push('no_alt');
  }

  // Templates are evergreen by definition — an unscheduled one is correct, not a gap.
  if (!post.isTemplate && !post.scheduledDate) warnings.push('no_date');

  if (isLong(platformId)) {
    if (!String(post.title || '').trim()) warnings.push('no_title');
    if (platformId === 'blog' && !String(post.metaDescription || '').trim()) warnings.push('no_meta');
  }

  return { blockers, warnings };
}

// Per-post memo keyed on the post OBJECT. usePosts hands out referentially stable
// post objects (docChanges() reuses the object for any doc that didn't change), so
// identity changes exactly when content changes — which makes the object a sound
// cache key and keeps readiness effectively free across re-filters and re-renders.
// A WeakMap means evicted posts are collected with their entries.
const _cache = new WeakMap();

/** postReadiness(), memoized on post identity. Use this on any hot path. */
export function readinessOf(post) {
  if (!post || typeof post !== 'object') return postReadiness(post);
  const hit = _cache.get(post);
  if (hit) return hit;
  const val = postReadiness(post);
  _cache.set(post, val);
  return val;
}

/** True when the post has at least one blocker (can't go out as-is). */
export const hasBlockers = (post) => readinessOf(post).blockers.length > 0;

/** True when the channel wants an image and the post has none. */
export const needsImage = (post) => {
  if (!post || post.imageUrl) return false;
  const policy = IMAGE_POLICY[post.platform || 'gmb'] || 'optional';
  return policy === 'required' || policy === 'recommended';
};

/**
 * Scheduled in the past and not yet marked posted — the thing an operator most
 * wants surfaced and currently has to spot by eye in a 400-card grid.
 */
export const isOverdue = (post, now = Date.now()) => {
  if (!post || post.isTemplate) return false;
  if (post.status === 'posted' || post.status === 'archived') return false;
  const d = post.scheduledDate;
  const t = d instanceof Date ? d.getTime() : Date.parse(d || '');
  return Number.isFinite(t) && t < now;
};
