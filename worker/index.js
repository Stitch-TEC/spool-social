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
import { createPost, getPost, listPosts, updatePost, deletePost, listAllImageUrls } from './firestore.js';
import { mintCustomToken, createShareDoc, getShareDoc, listShareDocs, deleteShareDoc } from './firestore.js';

const MAX_PROMPT = 2000;
const PLATFORM_MAX = { gmb: 1500, linkedin: 3000, twitter: 280, instagram: 2200, blog: 100000, job: 100000 };

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

// Encode per path-segment so the URL round-trips through the /media route's
// decodeURIComponent back to the exact (raw) R2 key — needed for keys that
// contain spaces/special chars (e.g. a client name in the library prefix).
function mediaUrl(origin, key) {
  return `${origin}/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function storeImage(env, origin, bytes, mime, owner) {
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : 'bin';
  const key = `generated/${owner}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  return { url: mediaUrl(origin, key), key };
}

// Resolve a draft image input to a /media URL: { prompt } generates, { base64 }
// uploads to R2, { url } references. Returns the URL, or null when no image.
async function resolveDraftImage(env, origin, img) {
  if (!img) return null;
  if (img.prompt) {
    const { b64, mime } = await generateImage(env, String(img.prompt).slice(0, MAX_PROMPT));
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

// Accept only YouTube / Vimeo / direct video-file URLs as references.
function validateVideoUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.replace(/^www\./, '');
  if (h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com') return { url: u.href, provider: 'youtube' };
  if (h === 'vimeo.com' || h === 'player.vimeo.com') return { url: u.href, provider: 'vimeo' };
  if (/\.(mp4|webm|mov|m4v)$/i.test(u.pathname)) return { url: u.href, provider: 'file' };
  return null;
}

// List a curated library prefix (images + video-reference pointers via customMetadata).
async function listMediaPrefix(env, origin, prefix) {
  const items = [];
  let cursor;
  do {
    const listed = await env.MEDIA.list({ prefix, cursor, include: ['customMetadata'], limit: 1000 });
    for (const o of listed.objects) {
      const cm = o.customMetadata || {};
      if (cm.type === 'video') items.push({ key: o.key, type: 'video', url: cm.url, provider: cm.provider, uploaded: o.uploaded });
      else items.push({ key: o.key, type: 'image', url: mediaUrl(origin, o.key), size: o.size, uploaded: o.uploaded });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  items.sort((a, b) => String(b.uploaded || '').localeCompare(String(a.uploaded || '')));
  return items;
}

// Owner-scoped delete authorization for an R2 key.
function canManageKey(auth, env, key) {
  if (auth.mode === 'apikey') return key.startsWith('library/') || key.startsWith('generated/');
  if (key.startsWith(`library/${auth.principal}/`) || key.startsWith(`generated/${auth.principal}/`)) return true;
  if (auth.principal === env.OWNER_UID && key.startsWith('generated/internal/')) return true;
  return false;
}

// Nightly garbage collection: delete R2 images that no post references AND that
// are older than a grace window. Mark-and-sweep is safe — it never deletes an
// in-use or freshly created image, and it catches orphans from both app- and
// API-side deletes.
async function runGC(env) {
  if (!env.MEDIA || !env.FIREBASE_SERVICE_ACCOUNT) return;
  const graceDays = parseInt(env.GC_GRACE_DAYS || '365', 10);
  const cutoff = Date.now() - (Number.isFinite(graceDays) ? graceDays : 365) * 24 * 60 * 60 * 1000;

  const referenced = new Set();
  try {
    for (const u of await listAllImageUrls(env)) {
      const i = u.indexOf('/media/');
      if (i !== -1) referenced.add(u.slice(i + '/media/'.length).split('?')[0]);
    }
  } catch (err) {
    console.error('GC: reference query failed:', err?.message || err);
    return;
  }

  let deleted = 0, kept = 0, cursor;
  do {
    const listed = await env.MEDIA.list({ prefix: 'generated/', cursor });
    for (const o of listed.objects) {
      const inUse = referenced.has(o.key);
      const old = o.uploaded ? new Date(o.uploaded).getTime() < cutoff : false;
      if (!inUse && old) { await env.MEDIA.delete(o.key); deleted++; }
      else kept++;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  console.log(`GC: deleted ${deleted} orphaned image(s), kept ${kept}.`);
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

    // --- Media library (browser: Firebase token; tools: internal key) ---
    //   GET    /api/media              generated AI-cache pool (in-editor reuse)
    //   GET    /api/media?client=X     curated per-client library (images + videos)
    //   POST   /api/media              add to a client's library { client, image:{base64} | videoUrl }
    //   DELETE /api/media/:key         remove one item (owner-scoped)
    if (url.pathname === '/api/media' || url.pathname.startsWith('/api/media/')) {
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }

      // DELETE /api/media/:key
      if (url.pathname.startsWith('/api/media/')) {
        if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405, cors);
        const key = decodeURIComponent(url.pathname.slice('/api/media/'.length));
        if (!key) return json({ error: 'Missing key' }, 400, cors);
        if (!canManageKey(auth, env, key)) return json({ error: 'Not found' }, 404, cors);
        await env.MEDIA.delete(key);
        return json({ deleted: key }, 200, cors);
      }

      // POST /api/media — add an image or video to a client's curated library.
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
        const owner = auth.mode === 'apikey' ? env.OWNER_UID : auth.principal;
        if (!owner) return json({ error: 'OWNER_UID is not configured' }, 500, cors);
        const client = (body?.client || '').toString().trim().replace(/\//g, '').slice(0, 50);
        if (!client) return json({ error: 'client is required' }, 400, cors);

        const base = `library/${owner}/${client}/`;
        const cap = parseInt(env.MEDIA_PER_CLIENT || '50', 10);
        const existing = await env.MEDIA.list({ prefix: base, limit: 1000 });
        if (existing.objects.length >= cap) {
          return json({ error: `Library is full (${cap} items per client) — delete some first.` }, 409, cors);
        }

        if (body?.videoUrl) {
          const v = validateVideoUrl(body.videoUrl);
          if (!v) return json({ error: 'Unsupported video URL (use YouTube, Vimeo, or a direct .mp4/.webm/.mov link)' }, 400, cors);
          const key = `${base}v-${crypto.randomUUID()}`;
          await env.MEDIA.put(key, 'video', { customMetadata: { type: 'video', url: v.url, provider: v.provider, addedAt: new Date().toISOString() } });
          return json({ key, type: 'video', url: v.url, provider: v.provider }, 201, cors);
        }

        const b64 = body?.image?.base64;
        if (b64) {
          const m = String(b64).match(/^data:([^;]+);base64,(.+)$/);
          const mime = m ? m[1] : (body.image.mime || 'image/jpeg');
          const bytes = b64ToBytes(m ? m[2] : String(b64));
          if (bytes.length > 5_000_000) return json({ error: 'Image too large after optimization (max 5 MB)' }, 413, cors);
          const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
          const key = `${base}${crypto.randomUUID()}.${ext}`;
          await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
          return json({ key, type: 'image', url: mediaUrl(url.origin, key) }, 201, cors);
        }
        return json({ error: 'image.base64 or videoUrl is required' }, 400, cors);
      }

      // GET /api/media — curated library (?client=) or the generated AI-cache pool.
      if (request.method === 'GET') {
        const clientParam = url.searchParams.get('client');
        if (clientParam) {
          const owner = auth.mode === 'apikey' ? env.OWNER_UID : auth.principal;
          if (!owner) return json({ error: 'OWNER_UID is not configured' }, 500, cors);
          const client = clientParam.trim().replace(/\//g, '').slice(0, 50);
          const media = await listMediaPrefix(env, url.origin, `library/${owner}/${client}/`);
          return json({ media, count: media.length }, 200, cors);
        }
        // No client → the generated AI-cache pool (in-editor "Choose from library").
        let prefixes;
        if (auth.mode === 'apikey') prefixes = ['generated/'];
        else if (auth.principal === env.OWNER_UID) prefixes = [`generated/${auth.principal}/`, 'generated/internal/'];
        else prefixes = [`generated/${auth.principal}/`];
        const paginate = auth.mode === 'apikey';
        const media = [];
        for (const prefix of prefixes) {
          let cursor;
          do {
            const listed = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
            for (const o of listed.objects) {
              media.push({ key: o.key, type: 'image', url: mediaUrl(url.origin, o.key), size: o.size, uploaded: o.uploaded });
            }
            cursor = paginate && listed.truncated ? listed.cursor : undefined;
          } while (cursor);
        }
        media.sort((a, b) => String(b.uploaded || '').localeCompare(String(a.uploaded || '')));
        return json({ media, count: media.length }, 200, cors);
      }

      return json({ error: 'Method not allowed' }, 405, cors);
    }

    // --- Drafts management API (server-to-server: internal key) ---
    //   POST   /api/drafts       create
    //   GET    /api/drafts       list (filters: ?client= &platform= &status=)
    //   GET    /api/drafts/:id    fetch one
    //   PATCH  /api/drafts/:id    update (text, image, schedule, status, tags)
    //   DELETE /api/drafts/:id    delete
    if (url.pathname === '/api/drafts' || url.pathname.startsWith('/api/drafts/')) {
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'apikey') return json({ error: 'This API requires the internal API key' }, 403, cors);

      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      if (!env.OWNER_UID) return json({ error: 'OWNER_UID is not configured' }, 500, cors);

      // /api/drafts/:id — fetch one / patch / delete.
      if (url.pathname.startsWith('/api/drafts/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/drafts/'.length));
        if (!id) return json({ error: 'Missing draft id' }, 400, cors);

        const existing = await getPost(env, id);
        if (!existing || existing.uid !== env.OWNER_UID) return json({ error: 'Draft not found' }, 404, cors);

        if (request.method === 'GET') return json({ draft: existing }, 200, cors);

        if (request.method === 'DELETE') {
          await deletePost(env, id);
          return json({ deleted: id }, 200, cors);
        }

        if (request.method === 'PATCH') {
          let body;
          try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
          const max = PLATFORM_MAX[existing.platform] || 100000;
          const patch = {};
          if (typeof body.content === 'string') patch.content = body.content.trim().slice(0, max);
          if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 200);
          if (typeof body.altText === 'string') patch.altText = body.altText.trim().slice(0, 300);
          if (typeof body.metaDescription === 'string') patch.metaDescription = body.metaDescription.trim().slice(0, 200);
          if (Array.isArray(body.tags)) patch.tags = body.tags.slice(0, 10).map(t => String(t).trim().slice(0, 20)).filter(Boolean);
          if (body.scheduledDate === null || typeof body.scheduledDate === 'string') {
            patch.scheduledDate = body.scheduledDate ? String(body.scheduledDate).slice(0, 40) : null;
          }
          if (['draft', 'scheduled', 'posted', 'archived'].includes(body.status)) patch.status = body.status;
          if (body.image) {
            try {
              const u = await resolveDraftImage(env, url.origin, body.image);
              if (u) patch.imageUrl = u;
            } catch (err) {
              console.error('Patch image failed:', err?.message || err);
              return json({ error: 'Image processing failed' }, 502, cors);
            }
          } else if (typeof body.imageUrl === 'string') {
            patch.imageUrl = body.imageUrl.slice(0, 2000);
          }
          if (Object.keys(patch).length === 0) return json({ error: 'No updatable fields provided' }, 400, cors);
          patch.updatedAt = new Date().toISOString();
          try {
            const draft = await updatePost(env, id, patch);
            return json({ draft }, 200, cors);
          } catch (err) {
            console.error('Draft update failed:', err?.message || err);
            return json({ error: 'Update failed' }, 502, cors);
          }
        }

        return json({ error: 'Method not allowed' }, 405, cors);
      }

      // /api/drafts — list (GET) or create (POST).
      if (request.method === 'GET') {
        try {
          let drafts = await listPosts(env, env.OWNER_UID);
          const q = url.searchParams;
          const fc = q.get('client'), fp = q.get('platform'), fst = q.get('status');
          if (fc) drafts = drafts.filter(d => d.client === fc);
          if (fp) drafts = drafts.filter(d => d.platform === fp);
          if (fst) drafts = drafts.filter(d => d.status === fst);
          drafts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
          return json({ drafts, count: drafts.length }, 200, cors);
        } catch (err) {
          console.error('Draft list failed:', err?.message || err);
          return json({ error: 'List failed' }, 502, cors);
        }
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

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

        let imageUrl = '';
        try {
          imageUrl = (await resolveDraftImage(env, url.origin, body?.image)) || '';
        } catch (err) {
          console.error('Draft image failed:', err?.message || err);
          return json({ error: 'Image processing failed' }, 502, cors);
        }

        const nowIso = new Date().toISOString();
        try {
          const id = await createPost(env, {
            uid: env.OWNER_UID,
            client, content, title, altText, metaDescription, slug,
            platform, status: 'draft', approvalStatus: 'pending', feedback: '',
            imageUrl, tags, scheduledDate,
            createdAt: nowIso, updatedAt: nowIso, source: 'api'
          });
          return json({
            id, status: 'draft',
            reviewUrl: `${url.origin}/?uid=${env.OWNER_UID}&client=${encodeURIComponent(client)}`
          }, 201, cors);
        } catch (err) {
          console.error('Draft create failed:', err?.message || err);
          return json({ error: 'Draft create failed' }, 502, cors);
        }
      }

      return json({ error: 'Method not allowed' }, 405, cors);
    }

    // --- Share links (per-client, token-scoped client review) ---
    //   POST   /api/share/session   { token }            -> mint guest custom token  (PUBLIC)
    //   POST   /api/share           { client, label }    -> create a link            (owner)
    //   GET    /api/share[?client=]                       -> list owner's links       (owner)
    //   DELETE /api/share/:token                          -> revoke a link            (owner)
    if (url.pathname === '/api/share' || url.pathname.startsWith('/api/share/')) {
      // Public token → guest session exchange. Rate-limited per client IP.
      if (url.pathname === '/api/share/session') {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
        const ip = request.headers.get('CF-Connecting-IP') || 'anon';
        const rl = await checkRateLimit(env, `share:${ip}`, 'firebase', Date.now());
        if (!rl.ok) return json({ error: 'Too many attempts — try again shortly.' }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });

        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
        const token = String(body?.token || '').trim().slice(0, 128);
        if (!token) return json({ error: 'token is required' }, 400, cors);

        let share;
        try { share = await getShareDoc(env, token); }
        catch (err) { console.error('Share lookup failed:', err?.message || err); return json({ error: 'Lookup failed' }, 502, cors); }
        if (!share || share.revoked === true) return json({ error: 'This review link is no longer valid.' }, 404, cors);

        try {
          const guestUid = `g_${token.slice(0, 40)}`;
          const customToken = await mintCustomToken(env, guestUid, {
            share: true, shareOwner: share.ownerUid, shareClient: share.client
          });
          return json({ customToken, ownerUid: share.ownerUid, client: share.client, label: share.label || '' }, 200, cors);
        } catch (err) {
          console.error('Custom token mint failed:', err?.message || err);
          return json({ error: 'Could not start review session' }, 502, cors);
        }
      }

      // Everything else is owner-only.
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'firebase') return json({ error: 'Sign in to manage share links' }, 403, cors);
      const owner = auth.principal;

      const rl = await checkRateLimit(env, owner, auth.mode, Date.now());
      if (!rl.ok) return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });

      // DELETE /api/share/:token — revoke (owner-scoped).
      if (url.pathname.startsWith('/api/share/')) {
        if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405, cors);
        const token = decodeURIComponent(url.pathname.slice('/api/share/'.length));
        if (!token) return json({ error: 'Missing token' }, 400, cors);
        const share = await getShareDoc(env, token);
        if (!share || share.ownerUid !== owner) return json({ error: 'Not found' }, 404, cors);
        await deleteShareDoc(env, token);
        return json({ deleted: token }, 200, cors);
      }

      // GET /api/share[?client=] — list this owner's links.
      if (request.method === 'GET') {
        try {
          let shares = await listShareDocs(env, owner);
          const fc = url.searchParams.get('client');
          if (fc) shares = shares.filter(s => s.client === fc);
          shares = shares
            .filter(s => s.revoked !== true)
            .map(s => ({ token: s.id, client: s.client, label: s.label || '', createdAt: s.createdAt || '', url: `${url.origin}/?s=${s.id}` }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
          return json({ shares, count: shares.length }, 200, cors);
        } catch (err) {
          console.error('Share list failed:', err?.message || err);
          return json({ error: 'List failed' }, 502, cors);
        }
      }

      // POST /api/share — create a link for a client.
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
        const client = String(body?.client || '').trim().replace(/\//g, '').slice(0, 50);
        if (!client) return json({ error: 'client is required' }, 400, cors);
        const label = String(body?.label || '').trim().slice(0, 80);
        const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
        try {
          await createShareDoc(env, token, { ownerUid: owner, client, label, revoked: false, createdAt: new Date().toISOString() });
          return json({ token, client, label, url: `${url.origin}/?s=${token}` }, 201, cors);
        } catch (err) {
          console.error('Share create failed:', err?.message || err);
          return json({ error: 'Could not create link' }, 502, cors);
        }
      }

      return json({ error: 'Method not allowed' }, 405, cors);
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
  },

  // Cron trigger (see wrangler.toml [triggers]) — nightly orphan-image sweep.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runGC(env));
  }
};
