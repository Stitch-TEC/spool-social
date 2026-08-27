// ⚡ OPTIMIZATION: Shared Intl.DateTimeFormat instances are ~50x faster than
// repeated toLocaleString() calls because they avoid re-compiling formatting patterns.
import { transformMediaDestinations } from './mediaMarkup';

export const DATE_FORMATTERS = {
  short: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  full: new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
  monthYear: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }),
  time: new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' })
};

// Post sort orders offered in the grid toolbar. `_sortTs` is the pre-computed
// (scheduledDate || createdAt) epoch ms set in usePosts; posts arrive already in
// SCHEDULED_DESC order, so that case is a cheap no-op re-sort.
export const SORT_ORDERS = {
  SCHEDULED_DESC: 'scheduled_desc',
  SCHEDULED_ASC: 'scheduled_asc',
  CREATED_DESC: 'created_desc',
  CREATED_ASC: 'created_asc',
  CLIENT_AZ: 'client_az',
  PLATFORM: 'platform',
};

const _ts = (p) => p._sortTs ?? 0;
const _created = (p) =>
  (p.createdAt instanceof Date ? p.createdAt.getTime() : new Date(p.createdAt || 0).getTime()) || 0;

/**
 * Returns a NEW array of posts ordered by `sortBy` (a SORT_ORDERS value).
 * Secondary tiebreak is always most-recent-first so groups stay stable. Pure —
 * never mutates the input (callers pass memoized arrays).
 */
export const sortPosts = (posts, sortBy) => {
  const arr = (posts || []).slice();
  switch (sortBy) {
    case SORT_ORDERS.SCHEDULED_ASC: return arr.sort((a, b) => _ts(a) - _ts(b));
    case SORT_ORDERS.CREATED_DESC: return arr.sort((a, b) => _created(b) - _created(a));
    case SORT_ORDERS.CREATED_ASC: return arr.sort((a, b) => _created(a) - _created(b));
    case SORT_ORDERS.CLIENT_AZ: return arr.sort((a, b) => (a.client || '').localeCompare(b.client || '') || _ts(b) - _ts(a));
    case SORT_ORDERS.PLATFORM: return arr.sort((a, b) => (a.platform || '').localeCompare(b.platform || '') || _ts(b) - _ts(a));
    case SORT_ORDERS.SCHEDULED_DESC:
    default: return arr.sort((a, b) => _ts(b) - _ts(a));
  }
};

// Canonical identity for an image URL: the R2 object key for /media URLs (any
// origin or percent-encoding), else the URL string itself. Two UI sections can
// surface the SAME stored object under superficially different URLs — comparing
// keys is what lets pickers collapse them into one thumbnail.
export const imageKey = (u) => {
  if (typeof u !== 'string') return u;
  const i = u.indexOf('/media/');
  if (i === -1) return u;
  let raw = u.slice(i + '/media/'.length).split(/[?#]/)[0];
  if (raw.startsWith('v2/')) raw = raw.slice(3);
  try { return decodeURIComponent(raw); } catch { return raw; }
};

const DEFAULT_SPOOL_ORIGIN = 'https://spool.stitchtec.dev';
const DEFAULT_LEGACY_MEDIA_ORIGINS = 'https://spool.kist.workers.dev';

const configuredMediaOrigin = (raw, label) => {
  let parsed;
  try { parsed = new URL(String(raw || '')); }
  catch { throw new Error(`${label} must be an absolute HTTPS origin`); }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw new Error(`${label} must be an absolute HTTPS origin with no path`);
  return parsed.origin;
};

// The browser's current Host is deliberately irrelevant. Preview/alias hosts
// may serve Spool, but every persisted/rendered media output belongs to this
// exact public origin. Legacy origins are input-only migration authorities.
export const PUBLIC_SPOOL_ORIGIN = configuredMediaOrigin(
  import.meta.env.VITE_PUBLIC_ORIGIN || DEFAULT_SPOOL_ORIGIN,
  'VITE_PUBLIC_ORIGIN',
);
export const LEGACY_SPOOL_MEDIA_ORIGINS = Object.freeze([...new Set(
  String(import.meta.env.VITE_LEGACY_MEDIA_ORIGINS || DEFAULT_LEGACY_MEDIA_ORIGINS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => configuredMediaOrigin(value, 'VITE_LEGACY_MEDIA_ORIGINS')),
)].filter((origin) => origin !== PUBLIC_SPOOL_ORIGIN));

// A cache-version equivalence is valid only for Spool's own media origin (or a
// same-origin relative reference). An external CDN's `/media/v2/...` is its own
// namespace and ordinary prose mentioning that path is content, not metadata.
export const spoolMediaIdentity = (
  u,
  origin = PUBLIC_SPOOL_ORIGIN,
  legacyOrigins = LEGACY_SPOOL_MEDIA_ORIGINS,
) => {
  if (typeof u !== 'string' || !u) return null;
  const publicOrigin = String(origin || '').replace(/\/$/, '');
  const allowedOrigins = new Set([publicOrigin, ...legacyOrigins]);
  const relative = u.startsWith('/media/');
  if (!relative) {
    let parsed;
    try { parsed = new URL(u.startsWith('//') ? `https:${u}` : u); } catch { return null; }
    if (!parsed.pathname.startsWith('/media/')) return null;
    if (!allowedOrigins.has(parsed.origin)) return null;
  }
  const i = u.indexOf('/media/');
  let raw = u.slice(i + '/media/'.length).split(/[?#]/)[0];
  if (raw.startsWith('v2/')) raw = raw.slice(3);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
};

export const sameSpoolMediaReference = (a, b) => {
  if (String(a || '') === String(b || '')) return true;
  const aKey = spoolMediaIdentity(a);
  const bKey = spoolMediaIdentity(b);
  return aKey !== null && bKey !== null && aKey === bKey;
};

export const normalizeSpoolMediaContentIdentity = (value) => {
  const content = String(value || '');
  // Almost every post is ordinary copy. Running the full CommonMark + HTML
  // parser over all ~400 posts during the first Firestore snapshot (twice per
  // post before this fix) can exhaust mobile Safari before it paints the feed.
  // Every reference this function can canonicalize contains the case-sensitive
  // path segment `media/`, including numeric-entity HTML such as `&#47media/`.
  if (!content.includes('media/')) return content;
  try {
    return transformMediaDestinations(content, (url) => {
      const key = spoolMediaIdentity(url);
      return key === null ? url : `spool-media:${key}`;
    });
  } catch (error) {
    // Read/display normalization is compatibility work, never an authority
    // boundary. A parser/runtime incompatibility must leave the stored copy
    // visible rather than take down the entire dashboard.
    console.warn('Spool media identity normalization skipped:', error);
    return content;
  }
};

// Move stored legacy Spool references onto the v2 cache key at read time. This
// is deliberately host-scoped: a third-party image may legitimately contain a
// /media/ path and must not be rewritten. The legacy Worker route also redirects
// cache misses, but browser entries already cached as immutable never reach it.
export const versionMediaUrl = (u) => {
  if (typeof u !== 'string' || !u) return u;
  const key = spoolMediaIdentity(u);
  if (key === null) return u;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${PUBLIC_SPOOL_ORIGIN}/media/v2/${encodedKey}`;
};

export const versionSpoolMediaContent = (value) => {
  const content = String(value || '');
  if (!content.includes('media/')) return content;
  try {
    return transformMediaDestinations(content, (url) => versionMediaUrl(url));
  } catch (error) {
    console.warn('Spool media URL normalization skipped:', error);
    return content;
  }
};

// Content identity: content-addressed /media keys end in the bytes' SHA-256, so
// the SAME image stored in two folders (the generated pool and a client's curated
// library) still collapses to one identity. Non-hashed keys fall back to imageKey.
export const imageContentId = (u) => {
  const k = imageKey(u);
  if (typeof k !== 'string') return k;
  const base = k.slice(k.lastIndexOf('/') + 1);
  const m = base.match(/^([0-9a-f]{64})\.\w+$/);
  return m ? m[1] : k;
};

// Image Compression Logic. Accepts a high-res file and returns an optimized
// JPEG data URL (only the optimized version is ever kept/uploaded).
// Defaults match the legacy in-editor dropzone; the media library passes larger
// values (e.g. maxWidth 2048) for crisper hero images.
export const processImageFile = (file, { maxWidth = 800, quality = 0.6 } = {}) => {
  return new Promise((resolve, reject) => {
    if (!file) reject("No file provided");
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scaleSize = maxWidth / img.width;

        if (scaleSize < 1) {
          canvas.width = maxWidth;
          canvas.height = img.height * scaleSize;
        } else {
          canvas.width = img.width;
          canvas.height = img.height;
        }

        const ctx = canvas.getContext('2d');

        // Fill white background to preserve transparent PNGs
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
};
