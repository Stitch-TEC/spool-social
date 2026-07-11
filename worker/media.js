// R2 image helpers shared by the HTTP routes (worker/index.js) and the
// content-automation runner (worker/automation.js). Generated images live under
// the `generated/<owner>/<uuid>.<ext>` prefix and are served by the /media route.

import { generateImage } from './gemini.js';

// Image-generation prompts are capped at the same length as the text API's.
const MAX_IMG_PROMPT = 2000;

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

// Encode per path-segment so the URL round-trips through the /media route's
// decodeURIComponent back to the exact (raw) R2 key — needed for keys that
// contain spaces/special chars (e.g. a client name in the library prefix).
export function mediaUrl(origin, key) {
  return `${origin}/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function storeImage(env, origin, bytes, mime, owner) {
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : 'bin';
  // Content-addressed key: identical bytes hash to the same key, so the same image
  // is stored ONCE and every caller (this API, the editor, the automation runner)
  // gets the same /media URL back — no duplicate R2 objects when a photo is reused
  // across posts. put() over an existing key just re-writes identical bytes. Safe
  // with the nightly orphan GC, which is reference-based: a shared key is deleted
  // only once NO post references it. (AI-generated images have unique bytes, so
  // they're unaffected — they simply get a hash name instead of a random UUID.)
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `generated/${owner}/${hash}.${ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  return { url: mediaUrl(origin, key), key };
}

// Resolve a draft image input to a /media URL: { prompt } generates, { base64 }
// uploads to R2, { url } references. Returns the URL, or null when no image.
// img.clientId (optional, suite slug) attributes a generation to a client for usage metering.
export async function resolveDraftImage(env, origin, img) {
  if (!img) return null;
  if (img.prompt) {
    const { b64, mime } = await generateImage(env, String(img.prompt).slice(0, MAX_IMG_PROMPT), { clientId: img.clientId });
    return (await storeImage(env, origin, b64ToBytes(b64), mime, 'internal')).url;
  }
  if (img.base64) {
    const m = String(img.base64).match(/^data:([^;]+);base64,(.+)$/);
    const mime = m ? m[1] : (img.mime || 'image/png');
    const data = m ? m[2] : String(img.base64);
    return (await storeImage(env, origin, b64ToBytes(data), mime, 'internal')).url;
  }
  if (typeof img.url === 'string') return img.url.slice(0, 2000);
  return null;
}
