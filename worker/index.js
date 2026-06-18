// Spool Worker — serves the SPA and the generation API from one deployment.
//
//   POST /api/generate  { prompt }            -> { url, key }   (image to R2)
//   POST /api/text      { prompt }            -> { text }
//   GET  /media/<key>                          -> the stored image
//   GET  /api/health                           -> { ok: true }
//   *                                          -> static assets (the Vite SPA)

import { authenticate } from './auth.js';
import { generateText, generateImage } from './gemini.js';
import { checkRateLimit } from './ratelimit.js';

const MAX_PROMPT = 2000;

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allow = env.ALLOWED_ORIGINS || '*';
  const allowed =
    allow === '*' ? '*' : allow.split(',').map(s => s.trim()).includes(origin) ? origin : '';
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type'
  };
  if (allowed) h['Access-Control-Allow-Origin'] = allowed;
  // When a specific origin is reflected (not '*'), caches must key on Origin or
  // one origin's CORS response could be served to a different origin.
  if (allowed && allow !== '*') h['Vary'] = 'Origin';
  return h;
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extra || {}) }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true }, 200, cors);
    }

    // --- Generation endpoints ---
    if (url.pathname === '/api/generate' || url.pathname === '/api/text') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);

      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json(
          { error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}). Slow down and retry shortly.` },
          429,
          { ...cors, 'Retry-After': String(rl.retryAfter) }
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }

      const prompt = (body?.prompt || '').toString().trim();
      if (!prompt) return json({ error: 'prompt is required' }, 400, cors);
      if (prompt.length > MAX_PROMPT) {
        return json({ error: `prompt exceeds ${MAX_PROMPT} chars` }, 400, cors);
      }

      try {
        if (url.pathname === '/api/text') {
          const text = await generateText(env, prompt);
          return json({ text }, 200, cors);
        }

        // Image: generate -> store in R2 -> return a URL.
        const { b64, mime } = await generateImage(env, prompt);
        const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : 'bin';
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const owner = auth.mode === 'firebase' ? auth.principal : 'internal';
        const key = `generated/${owner}/${crypto.randomUUID()}.${ext}`;
        await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
        return json({ url: `${url.origin}/media/${key}`, key }, 200, cors);
      } catch (err) {
        // Log upstream detail server-side (visible via `wrangler tail`), but do
        // not reflect raw Gemini error text back to API callers.
        console.error('Generation failed:', err?.message || err);
        return json({ error: 'Generation failed' }, 502, cors);
      }
    }

    // --- Serve a stored image ---
    if (url.pathname.startsWith('/media/')) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
      const key = decodeURIComponent(url.pathname.slice('/media/'.length));
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response('Not found', { status: 404, headers: cors });
      const headers = new Headers(cors);
      obj.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(obj.body, { headers });
    }

    // --- Everything else: the SPA / static assets ---
    return env.ASSETS.fetch(request);
  }
};
