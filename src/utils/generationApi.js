// Client for the Spool generation API (the Cloudflare Worker).
//
// In production the Worker serves the app, so /api is same-origin and no base
// URL is needed. In `vite dev`, requests to /api and /media are proxied to the
// local `wrangler dev` server (see vite.config.js).

import { auth } from '../config/firebase';

const API_BASE = import.meta.env.VITE_API_BASE || '';

async function authHeaders() {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in to use AI generation');
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function postJSON(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/** Generate an image from a prompt. Resolves to a hosted image URL.
 *  `opts` may include { clientId, platform } — clientId (the suite slug) attributes usage at the
 *  gateway meter AND triggers the server-side POM brand injection; platform sizes the profile
 *  fetch tier (long-form → full context). */
export async function generateImage(prompt, opts = {}) {
  const { url } = await postJSON('/api/generate', { prompt, ...opts });
  return url;
}

/**
 * Generate text/copy from a prompt. Resolves to the generated string.
 * `opts` may include { system, temperature, maxTokens, imageUrl, clientId, platform } — imageUrl
 * makes it a multimodal call (e.g. alt text from the actual image); clientId (suite slug)
 * attributes the usage to that client at the gateway meter AND triggers the server-side POM
 * client-context injection; platform sizes the profile fetch tier (long-form → full context).
 */
export async function generateText(prompt, opts = {}) {
  const { text } = await postJSON('/api/text', { prompt, ...opts });
  return text;
}

/**
 * Content-idea signals for a client — site pages + repo releases/commits, brokered server-side
 * (Worker → feedback-worker /client-signals; the CONTEXT_KEY never reaches the browser). Resolves
 * to { slug, signals: { fetchedAt, cached, site: { pages }, repos } }. THROWS on any miss —
 * including the seam being unconfigured ({ ok:false, error:'not_configured' }) — so the Ideas
 * panel can treat every failure the same way: quietly disappear.
 */
export async function fetchIdeas(client) {
  const res = await fetch(`${API_BASE}/api/ideas?client=${encodeURIComponent(client)}`, { headers: await authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/**
 * Pull ONE selected page's content + media on demand (the Ideas picker's "I want this page").
 * Brokered server-side; the broker domain-pins the URL to the client's own site. Resolves to
 * { slug, page: { url, title, excerpt, images } }. THROWS on any miss so the picker can surface it.
 */
export async function fetchPage(client, pageUrl) {
  const res = await fetch(`${API_BASE}/api/page?client=${encodeURIComponent(client)}&url=${encodeURIComponent(pageUrl)}`, { headers: await authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** List the reusable generated/uploaded images (the media pool). When `forClient` (a suite slug) is
 *  given, the operator's cross-client pool is scoped to just that client's images — so the picker
 *  shows only what belongs to the client you're working on, not every client's generated media. */
export async function listMedia(forClient = '') {
  const qs = forClient ? `?forClient=${encodeURIComponent(forClient)}` : '';
  const res = await fetch(`${API_BASE}/api/media${qs}`, { headers: await authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const { media } = await res.json();
  return media || [];
}

/** List a client's curated media library (images + video references). */
export async function listClientMedia(client) {
  const res = await fetch(`${API_BASE}/api/media?client=${encodeURIComponent(client)}`, { headers: await authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const { media } = await res.json();
  return media || [];
}

/** Upload an optimized image (data URL) to a client's library. */
export async function uploadMedia(client, base64) {
  return postJSON('/api/media', { client, image: { base64 } });
}

/**
 * Store a post-attachment image (data URL) in the content-addressed R2 pool and
 * resolve to its hosted /media URL. Identical bytes always map to the same URL,
 * so the same photo attached to many posts is stored once and never duplicates
 * in the reuse picker.
 */
export async function uploadPostImage(base64, forClient = '') {
  const { url } = await postJSON('/api/media', { image: { base64 }, ...(forClient ? { forClient } : {}) });
  return url;
}

/**
 * Best-effort swap of a base64 data URL for a small hosted /media URL. Non-data
 * URLs pass through untouched; on any upload failure (offline, worker down,
 * guest session) the original data URL is returned so saving never breaks.
 * `forClient` (a suite slug) tags the pooled image with the client it belongs to,
 * so the reuse picker can scope "Generated images" per client.
 */
export async function ensureHostedImage(imageUrl, forClient = '') {
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('data:image/')) return imageUrl;
  try {
    return await uploadPostImage(imageUrl, forClient);
  } catch {
    return imageUrl;
  }
}

/** Add a video URL reference (YouTube / Vimeo / direct file) to a client's library. */
export async function addVideoUrl(client, videoUrl) {
  return postJSON('/api/media', { client, videoUrl });
}

/** Delete a media item by its R2 key. */
export async function deleteMedia(key) {
  const res = await fetch(`${API_BASE}/api/media/${encodeURIComponent(key)}`, { method: 'DELETE', headers: await authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/** Generate concise alt text for an image (data URL or hosted /media URL). */
export async function describeImage(imageUrl) {
  const { text } = await postJSON('/api/text', {
    prompt:
      'Write concise, descriptive alt text for this image in one sentence. ' +
      'Do not start with "image of" or "a picture of". Plain text only.',
    imageUrl,
    maxTokens: 120
  });
  return text;
}
