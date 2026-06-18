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

/** Generate an image from a prompt. Resolves to a hosted image URL. */
export async function generateImage(prompt) {
  const { url } = await postJSON('/api/generate', { prompt });
  return url;
}

/**
 * Generate text/copy from a prompt. Resolves to the generated string.
 * `opts` may include { system, temperature, maxTokens, imageUrl } — imageUrl
 * makes it a multimodal call (e.g. alt text from the actual image).
 */
export async function generateText(prompt, opts = {}) {
  const { text } = await postJSON('/api/text', { prompt, ...opts });
  return text;
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
