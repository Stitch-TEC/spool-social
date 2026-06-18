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
import { createPost } from './firestore.js';

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

function clampMaxTokens(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 4096);
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Resolve an image reference to inline base64 for a multimodal prompt.
// Only accepts data: URLs (client-supplied bytes) or our own /media/<key> R2
// objects (read straight from the bucket — no outbound fetch, no SSRF surface).
async function resolveImage(src, env) {
  if (typeof src !== 'string' || !src) return null;
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;]+);base64,(.+)$/);
    return m ? { mimeType: m[1], data: m[2] } : null;
  }
  const marker = '/media/';
  const idx = src.indexOf(marker);
  if (idx !== -1 && env.MEDIA) {
    const key = decodeURIComponent(src.slice(idx + marker.length).split('?')[0]);
    const obj = await env.MEDIA.get(key);
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length > 8_000_000) return null; // ~8MB cap
    return { mimeType: obj.httpMetadata?.contentType || 'image/png', data: bytesToB64(bytes) };
  }
  return null;
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function storeImage(env, origin, bytes, mime, owner) {
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : 'bin';
  const key = `generated/${owner}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  return { url: `${origin}/media/${key}`, key };
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
          const image = body?.imageUrl ? await resolveImage(body.imageUrl, env) : undefined;
          const text = await generateText(env, prompt, {
            system: body?.system ? String(body.system).slice(0, 4000) : undefined,
            temperature:
              typeof body?.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2
                ? body.temperature
                : undefined,
            maxTokens: clampMaxTokens(body?.maxTokens),
            image
          });
          return json({ text }, 200, cors);
        }

        // Image: generate -> store in R2 -> return a URL.
        const { b64, mime } = await generateImage(env, prompt);
        const owner = auth.mode === 'firebase' ? auth.principal : 'internal';
        const stored = await storeImage(env, url.origin, b64ToBytes(b64), mime, owner);
        return json({ url: stored.url, key: stored.key }, 200, cors);
      } catch (err) {
        // Log upstream detail server-side (visible via `wrangler tail`), but do
        // not reflect raw Gemini error text back to API callers.
        console.error('Generation failed:', err?.message || err);
        return json({ error: 'Generation failed' }, 502, cors);
      }
    }

    // --- Create a draft (server-to-server: Claude Code/Cowork, scripts) ---
    if (url.pathname === '/api/drafts') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'apikey') return json({ error: 'Drafts API requires the internal API key' }, 403, cors);

      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      if (!env.OWNER_UID) return json({ error: 'OWNER_UID is not configured' }, 500, cors);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

      const PLATFORM_MAX = { gmb: 1500, linkedin: 3000, twitter: 280, instagram: 2200, blog: 100000, job: 100000 };
      const platform = String(body?.platform || 'gmb');
      if (!(platform in PLATFORM_MAX)) return json({ error: `Unknown platform '${platform}'` }, 400, cors);

      const content = (body?.content || '').toString().trim().slice(0, PLATFORM_MAX[platform]);
      if (!content) return json({ error: 'content is required' }, 400, cors);
      const client = (body?.client || '').toString().trim().replace(/\//g, '').slice(0, 50);
      if (!client) return json({ error: 'client is required' }, 400, cors);

      const title = (body?.title || '').toString().trim().slice(0, 200);
      const altText = (body?.altText || '').toString().trim().slice(0, 300);
      const metaDescription = (body?.metaDescription || '').toString().trim().slice(0, 200);
      const tags = Array.isArray(body?.tags)
        ? body.tags.slice(0, 10).map(t => String(t).trim().slice(0, 20)).filter(Boolean)
        : [];
      const scheduledDate = body?.scheduledDate ? String(body.scheduledDate).slice(0, 40) : null;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

      // Image: { prompt } generates one, { base64 } stores bytes, { url } references.
      let imageUrl = '';
      try {
        const img = body?.image;
        if (img?.prompt) {
          const { b64, mime } = await generateImage(env, String(img.prompt).slice(0, MAX_PROMPT));
          imageUrl = (await storeImage(env, url.origin, b64ToBytes(b64), mime, 'internal')).url;
        } else if (img?.base64) {
          const m = String(img.base64).match(/^data:([^;]+);base64,(.+)$/);
          const mime = m ? m[1] : (img.mime || 'image/png');
          const data = m ? m[2] : String(img.base64);
          imageUrl = (await storeImage(env, url.origin, b64ToBytes(data), mime, 'internal')).url;
        } else if (img?.url) {
          imageUrl = String(img.url).slice(0, 2000);
        }
      } catch (err) {
        console.error('Draft image failed:', err?.message || err);
        return json({ error: 'Image processing failed' }, 502, cors);
      }

      const nowIso = new Date().toISOString();
      try {
        const id = await createPost(env, {
          uid: env.OWNER_UID,
          client, content, title, altText, metaDescription, slug,
          platform,
          status: 'draft',
          approvalStatus: 'pending',
          feedback: '',
          imageUrl,
          tags,
          scheduledDate,
          createdAt: nowIso,
          updatedAt: nowIso,
          source: 'api'
        });
        return json({
          id,
          status: 'draft',
          reviewUrl: `${url.origin}/?uid=${env.OWNER_UID}&client=${encodeURIComponent(client)}`
        }, 201, cors);
      } catch (err) {
        console.error('Draft create failed:', err?.message || err);
        return json({ error: 'Draft create failed' }, 502, cors);
      }
    }

    // --- Serve a stored image (GET for the bytes, HEAD for metadata only) ---
    if (url.pathname.startsWith('/media/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method not allowed' }, 405, cors);
      }
      const key = decodeURIComponent(url.pathname.slice('/media/'.length));
      const isHead = request.method === 'HEAD';
      const obj = isHead ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
      if (!obj) return new Response(null, { status: 404, headers: cors });
      const headers = new Headers(cors);
      obj.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(isHead ? null : obj.body, { headers });
    }

    // --- Everything else: the SPA / static assets ---
    return env.ASSETS.fetch(request);
  }
};
