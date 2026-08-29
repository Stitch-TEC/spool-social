// R2 image helpers shared by the HTTP routes (worker/index.js) and the
// content-automation runner (worker/automation.js). Generated images live under
// the `generated/<owner>/<uuid>.<ext>` prefix and are served by the /media route.

import { generateImage } from './aiGateway.js';
import { transformMediaDestinations } from '../src/utils/mediaMarkup.js';

// Image-generation prompts are capped at the same length as the text API's.
const MAX_IMG_PROMPT = 2000;
export const MAX_IMAGE_BYTES = 5_000_000;
export const RASTER_VALIDATION_VERSION = 'v2';
export const DEFAULT_PUBLIC_ORIGIN = 'https://spool.stitchtec.dev';

// R2 is served from Spool's own origin, so a caller-supplied Content-Type can
// never be trusted as proof that bytes are an image. These are the raster
// formats already used by Spool (GIF is retained for grounded site imagery).
// SVG is intentionally absent: it is active XML and must never be served inline.
const RASTER_TYPES = Object.freeze({
  jpeg: Object.freeze({ mime: 'image/jpeg', ext: 'jpg' }),
  png: Object.freeze({ mime: 'image/png', ext: 'png' }),
  webp: Object.freeze({ mime: 'image/webp', ext: 'webp' }),
  gif: Object.freeze({ mime: 'image/gif', ext: 'gif' }),
});

const normalizeMime = (mime) => {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  return value === 'image/jpg' ? 'image/jpeg' : value;
};

function configuredOrigin(value, label) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
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
}

/**
 * Resolve the one origin Spool is allowed to emit and the explicit legacy
 * origins it may migrate. Request Host is intentionally absent: workers.dev,
 * previews, and hostile aliases must never become persisted media authorities.
 */
export function mediaOriginConfig(env = {}) {
  const publicOrigin = configuredOrigin(env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN, 'PUBLIC_ORIGIN');
  const legacyOrigins = [...new Set(String(env.LEGACY_MEDIA_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => configuredOrigin(value, 'LEGACY_MEDIA_ORIGINS')))]
    .filter((origin) => origin !== publicOrigin);
  return { publicOrigin, legacyOrigins };
}

export class UnsupportedRasterImageError extends Error {
  constructor(message = 'Unsupported raster image') {
    super(message);
    this.name = 'UnsupportedRasterImageError';
    this.code = 'unsupported_image';
    this.status = 415;
  }
}

export class ImageTooLargeError extends Error {
  constructor(message = 'Image exceeds the 5 MB limit') {
    super(message);
    this.name = 'ImageTooLargeError';
    this.code = 'image_too_large';
    this.status = 413;
  }
}

/**
 * Detect a supported raster from its magic bytes and return canonical metadata.
 * When a MIME claim is supplied it must agree with those bytes (image/jpg is
 * accepted as the common alias). This is the single gate for every R2 write.
 */
export function inspectRasterImage(input, claimedMime = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  let detected = null;

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) detected = RASTER_TYPES.png;
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    detected = RASTER_TYPES.jpeg;
  } else if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) detected = RASTER_TYPES.webp;
  else if (
    bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) detected = RASTER_TYPES.gif;

  if (!detected) throw new UnsupportedRasterImageError();

  const claim = normalizeMime(claimedMime);
  if (claim && claim !== detected.mime) {
    throw new UnsupportedRasterImageError('Image MIME does not match its bytes');
  }
  return detected;
}

export function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Reject oversized base64 before atob allocates the decoded buffer. The exact
// decoded-size check remains after decoding as a belt for odd padding/input.
export function decodeImageBase64(b64, maxBytes = MAX_IMAGE_BYTES) {
  const value = String(b64 || '').trim();
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new UnsupportedRasterImageError('Invalid image base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor(value.length * 3 / 4) - padding;
  if (estimatedBytes > maxBytes) throw new ImageTooLargeError();
  let bytes;
  try { bytes = b64ToBytes(value); }
  catch { throw new UnsupportedRasterImageError('Invalid image base64'); }
  if (bytes.length > maxBytes) throw new ImageTooLargeError();
  return bytes;
}

// Encode per path-segment so the URL round-trips through the /media route's
// decodeURIComponent back to the exact (raw) R2 key — needed for keys that
// contain spaces/special chars (e.g. a client name in the library prefix).
export function mediaUrl(origin, key) {
  return `${origin}/media/v2/${key.split('/').map(encodeURIComponent).join('/')}`;
}

// Extract the raw R2 key from either the legacy /media/<key> form or v2. Null
// means the path was empty/malformed; callers must fail closed rather than let
// decodeURIComponent throw a Worker 500.
export function mediaKeyFromUrl(value) {
  if (typeof value !== 'string') return null;
  const marker = '/media/';
  const index = value.indexOf(marker);
  if (index === -1) return null;
  let encoded = value.slice(index + marker.length).split(/[?#]/)[0];
  if (encoded.startsWith('v2/')) encoded = encoded.slice(3);
  if (!encoded) return null;
  try { return decodeURIComponent(encoded); }
  catch { return null; }
}

export function spoolMediaReferenceIdentity(origin, value, legacyOrigins = []) {
  if (typeof value !== 'string' || !value) return null;
  const targetOrigin = String(origin || '').replace(/\/$/, '');
  const allowedOrigins = new Set([targetOrigin, ...legacyOrigins.map((item) => String(item || '').replace(/\/$/, ''))]);
  const relative = value.startsWith('/media/');
  if (!relative) {
    let parsed;
    try { parsed = new URL(value.startsWith('//') ? `https:${value}` : value); } catch { return null; }
    if (!parsed.pathname.startsWith('/media/')) return null;
    if (!allowedOrigins.has(parsed.origin)) return null;
  }
  return mediaKeyFromUrl(value);
}

export function sameSpoolMediaReference(origin, a, b, legacyOrigins = []) {
  if (String(a || '') === String(b || '')) return true;
  const aKey = spoolMediaReferenceIdentity(origin, a, legacyOrigins);
  const bKey = spoolMediaReferenceIdentity(origin, b, legacyOrigins);
  return aKey !== null && bKey !== null && aKey === bKey;
}

export function normalizeSpoolMediaContentIdentity(origin, value, legacyOrigins = []) {
  return transformMediaDestinations(value, (candidate) => {
    const key = spoolMediaReferenceIdentity(origin, candidate, legacyOrigins);
    return key === null ? candidate : `spool-media:${key}`;
  });
}

export function versionMediaReference(origin, value, legacyOrigins = []) {
  if (typeof value !== 'string' || !value) return value;
  const key = spoolMediaReferenceIdentity(origin, value, legacyOrigins);
  return key ? mediaUrl(String(origin || '').replace(/\/$/, ''), key) : value;
}

// Version Spool-hosted image targets embedded in Markdown without touching a
// third-party host that happens to use its own /media/ path. Relative Markdown
// image targets become absolute because this helper also feeds Sender and the
// publish lane, where `/media/...` would otherwise resolve on the wrong domain.
export function versionMediaMarkdownReferences(origin, value, legacyOrigins = []) {
  const targetOrigin = String(origin || '').replace(/\/$/, '');
  const versionCandidate = (candidate) => {
    const key = spoolMediaReferenceIdentity(origin, candidate, legacyOrigins);
    // Canonicalize BOTH legacy and already-v2 relative references. Sender and
    // publish consume this helper outside Spool's page origin, so leaving
    // `/media/v2/...` relative would make a safe image resolve on the recipient
    // app/site instead of Spool.
    return key === null ? candidate : mediaUrl(targetOrigin, key);
  };
  return transformMediaDestinations(value, versionCandidate);
}

export async function storeImage(env, origin, bytes, mime, owner, clientId) {
  // Resolve before touching R2. Even if a future caller accidentally forwards
  // request.url origin here, output stays pinned to configured PUBLIC_ORIGIN;
  // an invalid configuration fails before any object is written.
  const { publicOrigin } = mediaOriginConfig(env);
  if (String(origin || '').replace(/\/$/, '') !== publicOrigin) {
    throw new Error('Media output origin must match PUBLIC_ORIGIN');
  }
  const imageBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (imageBytes.byteLength > MAX_IMAGE_BYTES) throw new ImageTooLargeError();
  // Determine both extension and Content-Type from bytes, never from the caller.
  // The claim is checked only for mismatch so disguised HTML/SVG or confused
  // raster types fail before any object is written.
  const raster = inspectRasterImage(imageBytes, mime);
  const { ext } = raster;
  // Content-addressed key: identical bytes hash to the same key, so the same image
  // is stored ONCE and every caller (this API, the editor, the automation runner)
  // gets the same /media URL back — no duplicate R2 objects when a photo is reused
  // across posts. put() over an existing key just re-writes identical bytes. Safe
  // with the nightly orphan GC, which is reference-based: a shared key is deleted
  // only once NO post references it. (AI-generated images have unique bytes, so
  // they're unaffected — they simply get a hash name instead of a random UUID.)
  const digest = await crypto.subtle.digest('SHA-256', imageBytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `generated/${owner}/${hash}.${ext}`;
  // Tag the pooled image with the client(s) it was generated/attached for (suite slugs) so the
  // in-editor picker can scope "Generated images" to the client you're working on instead of
  // leaking every client's images into one pool. The R2 KEY is unchanged (still content-addressed,
  // GC + delete-auth untouched); this is metadata only.
  //
  // Because the key is the CONTENT hash, the same bytes can be stored for more than one client (a
  // shared stock photo) AND re-stored later with no client (a no-client-selected re-upload). R2's
  // put() REPLACES metadata, so a single-valued tag would be last-writer-wins — a no-slug re-store
  // would WIPE the tag and the image would vanish from a client's scoped picker. So we keep a MERGED
  // SET of clientIds and never unset: read the existing tags, union the new slug in, write the set.
  const slug = String(clientId || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  let ids = [];
  try {
    const existing = await env.MEDIA.head(key); // metadata only (no body) — cheap
    const prior = existing?.customMetadata?.clientIds || existing?.customMetadata?.clientId || '';
    ids = prior.split(',').map((s) => s.trim()).filter(Boolean);
  } catch { /* first store / head miss — no prior tags */ }
  if (slug && !ids.includes(slug)) ids.push(slug);
  ids = ids.slice(0, 20); // bound the metadata size; a shared image spanning >20 clients is unreal
  const opts = {
    httpMetadata: { contentType: raster.mime },
    customMetadata: {
      rasterValidated: RASTER_VALIDATION_VERSION,
      rasterMime: raster.mime,
      ...(ids.length ? { clientIds: ids.join(',') } : {}),
    },
  };
  await env.MEDIA.put(key, imageBytes, opts);
  return { url: mediaUrl(publicOrigin, key), key };
}

// Resolve a draft image input to a /media URL: { prompt } generates, { base64 }
// uploads to R2, { url } references. Returns the URL, or null when no image.
// img.clientId (optional, suite slug) attributes a generation to a client for usage metering.
export async function resolveDraftImage(env, origin, img, legacyOrigins = []) {
  const configured = mediaOriginConfig(env);
  const publicOrigin = configured.publicOrigin;
  if (String(origin || '').replace(/\/$/, '') !== publicOrigin) {
    throw new Error('Media output origin must match PUBLIC_ORIGIN');
  }
  const allowedLegacyOrigins = legacyOrigins.length ? legacyOrigins : configured.legacyOrigins;
  if (!img) return null;
  if (img.prompt) {
    const { b64, mime } = await generateImage(env, String(img.prompt).slice(0, MAX_IMG_PROMPT), { clientId: img.clientId });
    return (await storeImage(env, publicOrigin, decodeImageBase64(b64), mime, 'internal', img.clientId)).url;
  }
  if (img.base64) {
    const m = String(img.base64).match(/^data:([^;]+);base64,(.+)$/);
    const mime = m ? m[1] : (img.mime || '');
    const data = m ? m[2] : String(img.base64);
    const bytes = decodeImageBase64(data);
    // When the caller supplies both a data-URL claim and a separate MIME, both
    // must agree with the bytes; neither claim is silently ignored.
    if (m && img.mime) inspectRasterImage(bytes, img.mime);
    return (await storeImage(env, publicOrigin, bytes, mime, 'internal', img.clientId)).url;
  }
  if (typeof img.url === 'string') return versionMediaReference(publicOrigin, img.url, allowedLegacyOrigins).slice(0, 2000);
  return null;
}
