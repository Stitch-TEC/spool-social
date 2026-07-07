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
import { createPost, getPost, listPosts, updatePost, updatePostWithAppend, deletePost, listAllImageUrls, getUserRecord, setUserRecord, deleteUserRecord } from './firestore.js';
import { mintCustomToken, createShareDoc, getShareDoc, listShareDocs, deleteShareDoc } from './firestore.js';
import { createAutomation, getAutomation, listAutomations, updateAutomation, deleteAutomation, resolveClientId } from './firestore.js';
import { b64ToBytes, bytesToB64, mediaUrl, storeImage, resolveDraftImage } from './media.js';
import { runDueAutomations, generateForAutomation } from './automation.js';
import { probeClientProfile, fetchClientRoster } from './suiteContext.js';
import { PLATFORM_META, PLATFORM_CADENCE } from '../src/generation/prompts.js';

const MAX_PROMPT = 2000;
// Per-platform character caps, derived from the shared PLATFORM_META so the
// Worker and the app can never disagree on a limit.
const PLATFORM_MAX = Object.fromEntries(
  Object.values(PLATFORM_META).map(p => [p.id, p.maxChars])
);

// --- Automation config validation (shared by POST create + PATCH update) -----
const AUTO_CONTENT_TYPES = ['text', 'image', 'text+image'];
const AUTO_TONES = ['professional', 'friendly', 'bold', 'educational'];
const AUTO_LENGTHS = ['short', 'medium', 'long'];
const AUTO_IMAGE_STYLES = ['photo', 'studio', 'illustration', 'minimal', 'bold'];

// Clamp a requested interval UP to the platform's minimum (and cap at 1 year) so
// a schedule can't spam a channel or runaway the Gemini quota. Falls back to the
// platform's sensible default when no/invalid value is given.
function clampInterval(value, platform) {
  const cad = PLATFORM_CADENCE[platform] || PLATFORM_CADENCE.gmb;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return cad.defaultHours;
  return Math.max(cad.minHours, Math.min(n, 24 * 365));
}

// Build a validated patch of the editable automation fields from a request body.
function sanitizeAutomationPatch(body, platform) {
  const patch = {};
  if (AUTO_CONTENT_TYPES.includes(body?.contentType)) patch.contentType = body.contentType;
  if (AUTO_TONES.includes(body?.tone)) patch.tone = body.tone;
  if (AUTO_LENGTHS.includes(body?.length)) patch.length = body.length;
  if (AUTO_IMAGE_STYLES.includes(body?.imageStyle)) patch.imageStyle = body.imageStyle;
  if (typeof body?.promptSeed === 'string') {
    const seed = body.promptSeed.trim().slice(0, MAX_PROMPT);
    if (seed) patch.promptSeed = seed;
  }
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
  // Only a usable numeric value counts as a change — null/""/garbage must NOT
  // silently reset the interval to the platform default on a partial PATCH.
  if (body?.intervalHours !== undefined && Number.isFinite(parseInt(body.intervalHours, 10))) {
    patch.intervalHours = clampInterval(body.intervalHours, platform);
  }
  return patch;
}

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

// Resolve a firebase caller's share-management context from users/{email}.
// Operator = super_admin role OR uid === OWNER_UID (the owner is never locked
// out, even pre-bootstrap). A client/client_admin is pinned to their clientId.
// Returns { isOperator, clientId } or null (not authorized to manage links).
async function resolveShareCaller(auth, env) {
  if (auth.principal === env.OWNER_UID) return { isOperator: true, clientId: null };
  let rec;
  try { rec = await getUserRecord(env, auth.email); }
  catch (err) { console.error('User lookup failed:', err?.message || err); return null; }
  if (!rec) return null;
  const roles = Array.isArray(rec.roles) ? rec.roles : [];
  if (roles.includes('super_admin')) return { isOperator: true, clientId: null };
  if ((roles.includes('client_admin') || roles.includes('client')) && rec.clientId) {
    return { isOperator: false, clientId: rec.clientId };
  }
  return null;
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

    // --- Seam presence (public, safe) — does Spool hold a CONTEXT_KEY? No slug, no data, no secret. ---
    // Lets POM's control plane show whether the *consumer* side of the context seam is configured. The
    // actual key VALUE and the round-trip match are never exposed here (use /api/context-check for that).
    if (url.pathname === '/api/seam-status') {
      return json({ ok: true, configured: !!env.CONTEXT_KEY }, 200, cors);
    }

    // --- Seam diagnostic: is the POM context/brand seam live for a client? (operator/tool auth) ---
    // Exercises the live CONTEXT_KEY round-trip to feedback-worker and reports presence-safe status —
    // never the key or any secret. `reason: 'unauthorized'` means the two workers' keys differ.
    if (url.pathname === '/api/context-check') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      // Rate-limit like every other authed route — probeClientProfile makes an upstream round-trip,
      // so an authed caller mustn't be able to loop it and hammer feedback-worker.
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
      if (!slug) return json({ error: 'slug is required' }, 400, cors);
      const probe = await probeClientProfile(env, slug);
      return json({
        ok: true,
        slug,
        configured: !!env.CONTEXT_KEY,
        feedbackUrl: env.SUITE_FEEDBACK_URL || 'https://feedback.stitchtec.dev',
        reached: probe.ok,
        reason: probe.reason || 'ok',
        profile: probe.ok
          ? {
              name: probe.profile.name,
              contextChars: (probe.profile.aiContext || '').length,
              hasBrand: !!probe.profile.brand,
              brand: probe.profile.brand,
            }
          : null,
      }, 200, cors);
    }

    // --- Canonical client roster from POM (authed) — backs Spool's "add users" client picker. ---
    // Server-side CONTEXT_KEY round-trip to feedback-worker /clients; the secret never reaches the SPA.
    // Degrades to an empty list on any upstream miss so the picker shows nothing rather than erroring.
    if (url.pathname === '/api/clients') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      // Operator-only: the roster spans EVERY client, so a client / client_admin must not enumerate it.
      // Trusted internal key passes (server-to-server); any human caller must be a super_admin operator.
      if (auth.mode !== 'apikey') {
        const caller = await resolveShareCaller(auth, env);
        if (!caller || !caller.isOperator) return json({ error: 'Not authorized' }, 403, cors);
      }
      const clients = await fetchClientRoster(env);
      return json({ ok: true, clients }, 200, cors);
    }

    // --- People-sync (identity Phase 2) — INTERNAL KEY ONLY (the feedback-worker broker). ---
    // Grants/revokes CLIENT access by upserting/deleting users/{email}. Privileged docs
    // (super_admin / client_admin) are hand-managed and NEVER touched by this path — a 409 tells
    // the broker "blocked" honestly instead of silently downgrading or deleting an admin.
    if (url.pathname === '/api/people-sync') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'apikey') return json({ ok: false, error: 'internal key required' }, 403, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ ok: false, error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }

      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, cors); }
      const email = String(body?.email || '').trim().toLowerCase();
      const action = body?.action === 'revoke' ? 'revoke' : body?.action === 'grant' ? 'grant' : '';
      const clientId = String(body?.clientId || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: 'valid email required' }, 400, cors);
      if (!action) return json({ ok: false, error: "action must be 'grant' or 'revoke'" }, 400, cors);

      try {
        const existing = await getUserRecord(env, email);
        const existingRoles = Array.isArray(existing?.roles) ? existing.roles : [];
        if (existingRoles.includes('super_admin') || existingRoles.includes('client_admin')) {
          return json({ ok: false, error: 'privileged account — hand-managed, not propagated' }, 409, cors);
        }
        if (action === 'grant') {
          if (!clientId) return json({ ok: false, error: 'clientId required for grant' }, 400, cors);
          await setUserRecord(env, email, {
            roles: ['client'], email, clientId,
            updatedAt: new Date().toISOString(), source: 'people-sync',
          });
          return json({ ok: true, status: 'granted' }, 200, cors);
        }
        // revoke: delete the doc (absent = idempotent success)
        await deleteUserRecord(env, email);
        return json({ ok: true, status: 'revoked' }, 200, cors);
      } catch (err) {
        console.error('people-sync failed:', err?.message || err);
        return json({ ok: false, error: 'sync failed' }, 502, cors);
      }
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

      // Authorization: only a PROVISIONED user (an operator, or a client with a users/{email} doc) may
      // spend AI + R2 budget. ALLOWED_EMAILS is empty, so authenticate() alone would admit ANY signed-in
      // Google account (the Firebase web key is public) — closing that open paid-generation hole here.
      // The trusted internal key (apikey mode) bypasses, same as the drafts/automation paths.
      if (auth.mode !== 'apikey') {
        const caller = await resolveShareCaller(auth, env);
        if (!caller) return json({ error: 'Not authorized' }, 403, cors);
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
      // Per-client usage metering (Phase 3): the UI sends the selected client's slug; sanitized here
      // (it's contextual attribution, not auth — the gateway meters 'unattributed' when absent).
      const genClientId = (body?.clientId || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64) || undefined;

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
            image,
            clientId: genClientId
          });
          return json({ text }, 200, cors);
        }

        // Image: generate -> store in R2 -> return a URL.
        const { b64, mime } = await generateImage(env, prompt, { clientId: genClientId });
        const owner = auth.mode === 'firebase' ? auth.principal : 'internal';
        const stored = await storeImage(env, url.origin, b64ToBytes(b64), mime, owner);
        return json({ url: stored.url, key: stored.key }, 200, cors);
      } catch (err) {
        // A quota denial is a POLICY outcome the user must see (raise the quota in POM) — pass its
        // message + 429 through instead of masking it as a generic failure.
        if (err?.quotaExceeded) return json({ error: err.message }, 429, cors);
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
      // Provisioned users only (or the internal key) — the media library writes/serves R2 + AI-cached
      // assets, so don't let an arbitrary signed-in Google account read or grow it (ALLOWED_EMAILS empty).
      if (auth.mode !== 'apikey') {
        const caller = await resolveShareCaller(auth, env);
        if (!caller) return json({ error: 'Not authorized' }, 403, cors);
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
    //   PATCH  /api/drafts/:id    update (text, image, schedule, status, tags, approvalStatus+feedback)
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
          // Review verbs (POM's Content card via the feedback-worker broker): approvalStatus
          // transitions with an optional reviewer note. The note is appended SERVER-SIDE and
          // ATOMICALLY (updatePostWithAppend — a :commit array transform) so a concurrent in-app /
          // guest note on the same draft is never clobbered by a snapshot rebuild. Shape mirrors the
          // UI's request-changes entries ({text, by, at}), so POM feedback renders like in-app feedback.
          let threadEntry = null;
          if (body.approvalStatus !== undefined) {
            if (!['pending', 'approved', 'changes_requested'].includes(body.approvalStatus)) {
              return json({ error: `Unknown approvalStatus '${body.approvalStatus}'` }, 400, cors);
            }
            const note = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, 500) : '';
            if (body.approvalStatus === 'changes_requested' && !note) {
              return json({ error: 'feedback is required when requesting changes' }, 400, cors);
            }
            patch.approvalStatus = body.approvalStatus;
            if (note) {
              // Attribution whitelist — never store an arbitrary caller string in the thread.
              const by = body.reviewedBy === 'client' ? 'client' : 'you';
              patch.feedback = note;
              threadEntry = { text: note, by, at: new Date().toISOString() };
            }
          }
          if (body.image) {
            try {
              // Thread the DRAFT's own tenant slug into the image generation for usage metering —
              // server-resolved, overriding any caller-supplied image.clientId (never trust raw input).
              const u = await resolveDraftImage(env, url.origin, { ...body.image, clientId: existing.clientId || undefined });
              if (u) patch.imageUrl = u;
            } catch (err) {
              // Quota denial = policy the caller must see (raise the quota in POM), not an infra 502.
              if (err?.quotaExceeded) return json({ error: err.message }, 429, cors);
              console.error('Patch image failed:', err?.message || err);
              return json({ error: 'Image processing failed' }, 502, cors);
            }
          } else if (typeof body.imageUrl === 'string') {
            patch.imageUrl = body.imageUrl.slice(0, 2000);
          }
          if (Object.keys(patch).length === 0) return json({ error: 'No updatable fields provided' }, 400, cors);
          patch.updatedAt = new Date().toISOString();
          try {
            const draft = threadEntry
              ? await updatePostWithAppend(env, id, patch, 'feedbackThread', threadEntry)
              : await updatePost(env, id, patch);
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
        // Own-property check, not `in` (which walks the prototype chain — 'constructor'/'toString'/… would
        // wrongly validate and let a junk platform through). PLATFORM_MAX is a plain object literal.
        if (!Object.prototype.hasOwnProperty.call(PLATFORM_MAX, platform)) return json({ error: `Unknown platform '${platform}'` }, 400, cors);

        const content = (body?.content || '').toString().trim().slice(0, PLATFORM_MAX[platform]);
        if (!content) return json({ error: 'content is required' }, 400, cors);
        const client = (body?.client || '').toString().trim().replace(/\//g, '').slice(0, 50);
        if (!client) return json({ error: 'client is required' }, 400, cors);
        // The immutable tenant key (suite slug). Callers that know it send it (the broker / POM skill
        // do); otherwise resolve it from existing posts for the same display name. Display NAME is
        // mutable + not guaranteed unique, so the slug is what cross-app guards key on — a draft
        // without it falls back to name matching (legacy behavior).
        const clientId =
          (body?.clientId || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64) ||
          (await resolveClientId(env, client)) || '';

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
          // Same server-resolved clientId threading as PATCH — the sanitized slug from above,
          // overriding any caller-supplied image.clientId.
          imageUrl = (await resolveDraftImage(env, url.origin, body?.image ? { ...body.image, clientId: clientId || undefined } : null)) || '';
        } catch (err) {
          // Quota denial = policy the caller must see (raise the quota in POM), not an infra 502.
          if (err?.quotaExceeded) return json({ error: err.message }, 429, cors);
          console.error('Draft image failed:', err?.message || err);
          return json({ error: 'Image processing failed' }, 502, cors);
        }

        const nowIso = new Date().toISOString();
        try {
          const id = await createPost(env, {
            uid: env.OWNER_UID,
            client, content, title, altText, metaDescription, slug,
            ...(clientId ? { clientId } : {}),
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
          // shareClientId is the secure key the rules match guest reads on.
          // Legacy share docs lack clientId → the minted claim is null and the
          // rules deny (the link is dead; re-issue it). shareClient (name) is
          // kept for display only.
          const customToken = await mintCustomToken(env, guestUid, {
            share: true, shareOwner: share.ownerUid, shareClient: share.client, shareClientId: share.clientId || null,
            // The share DOC ID — lets firestore.rules re-check the share EXISTS (and isn't revoked)
            // on EVERY request, so a revoked link dies on the guest's NEXT request (reads, writes,
            // stream re-auth) instead of after the ID token's ~1h expiry. (An idle already-open
            // listener keeps only its last-delivered snapshot until its next event.) It's the
            // guest's own bearer secret, so putting it on their token leaks nothing.
            shareToken: token
          });
          return json({ customToken, ownerUid: share.ownerUid, client: share.client, clientId: share.clientId || null, label: share.label || '' }, 200, cors);
        } catch (err) {
          console.error('Custom token mint failed:', err?.message || err);
          return json({ error: 'Could not start review session' }, 502, cors);
        }
      }

      // Everything else is owner / client-member only.
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'firebase') return json({ error: 'Sign in to manage share links' }, 403, cors);

      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });

      // Resolve role + clientId. An operator manages any client's links; a client
      // member manages ONLY their own clientId's links.
      const caller = await resolveShareCaller(auth, env);
      if (!caller) return json({ error: 'Not authorized to manage share links' }, 403, cors);

      // DELETE /api/share/:token — revoke (operator any; member own clientId only).
      if (url.pathname.startsWith('/api/share/')) {
        if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405, cors);
        const token = decodeURIComponent(url.pathname.slice('/api/share/'.length));
        if (!token) return json({ error: 'Missing token' }, 400, cors);
        const share = await getShareDoc(env, token);
        if (!share) return json({ error: 'Not found' }, 404, cors);
        if (!caller.isOperator && share.clientId !== caller.clientId) return json({ error: 'Not found' }, 404, cors);
        await deleteShareDoc(env, token);
        return json({ deleted: token }, 200, cors);
      }

      // GET /api/share[?client=] — list links (all carry ownerUid == OWNER_UID;
      // a client member sees only their own clientId).
      if (request.method === 'GET') {
        try {
          let shares = await listShareDocs(env, env.OWNER_UID);
          if (!caller.isOperator) shares = shares.filter(s => s.clientId === caller.clientId);
          const fc = url.searchParams.get('client');
          if (fc) shares = shares.filter(s => s.client === fc);
          shares = shares
            .filter(s => s.revoked !== true)
            .map(s => ({ token: s.id, client: s.client, clientId: s.clientId || '', label: s.label || '', createdAt: s.createdAt || '', url: `${url.origin}/?s=${s.id}` }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
          return json({ shares, count: shares.length }, 200, cors);
        } catch (err) {
          console.error('Share list failed:', err?.message || err);
          return json({ error: 'List failed' }, 502, cors);
        }
      }

      // POST /api/share — create a link. ownerUid is ALWAYS the operator (so the
      // one guest token resolves across multi-author client content); clientId is
      // the member's own (forced) or, for an operator, the requested client's.
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
        const client = String(body?.client || '').trim().replace(/\//g, '').slice(0, 50);
        if (!client) return json({ error: 'client is required' }, 400, cors);
        const clientId = caller.isOperator
          ? String(body?.clientId || '').trim().slice(0, 64)
          : caller.clientId;
        if (!clientId) return json({ error: 'clientId is required' }, 400, cors);
        const label = String(body?.label || '').trim().slice(0, 80);
        const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
        try {
          await createShareDoc(env, token, { ownerUid: env.OWNER_UID, client, clientId, label, revoked: false, createdAt: new Date().toISOString() });
          return json({ token, client, clientId, label, url: `${url.origin}/?s=${token}` }, 201, cors);
        } catch (err) {
          console.error('Share create failed:', err?.message || err);
          return json({ error: 'Could not create link' }, 502, cors);
        }
      }

      return json({ error: 'Method not allowed' }, 405, cors);
    }

    // --- Content automations (super-admin only) ------------------------------
    //   GET    /api/automations            list all
    //   POST   /api/automations            create
    //   GET    /api/automations/:id         fetch one
    //   PATCH  /api/automations/:id         update (pause/resume, edit fields)
    //   DELETE /api/automations/:id         delete
    //   POST   /api/automations/:id/run     generate one draft now (preview)
    if (url.pathname === '/api/automations' || url.pathname.startsWith('/api/automations/')) {
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      // Human super-admins only — the internal API key cannot manage automations.
      if (auth.mode !== 'firebase') return json({ error: 'Sign in as an operator to manage automations' }, 403, cors);

      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });

      // Same operator lock as /api/share — denies every client / client_admin / guest.
      const caller = await resolveShareCaller(auth, env);
      if (!caller || !caller.isOperator) return json({ error: 'Not authorized' }, 403, cors);
      if (!env.OWNER_UID) return json({ error: 'OWNER_UID is not configured' }, 500, cors);

      // /api/automations/:id (and /api/automations/:id/run)
      if (url.pathname.startsWith('/api/automations/')) {
        const rest = url.pathname.slice('/api/automations/'.length);
        const isRun = rest.endsWith('/run');
        const id = decodeURIComponent(isRun ? rest.slice(0, -'/run'.length) : rest);
        if (!id) return json({ error: 'Missing automation id' }, 400, cors);

        const existing = await getAutomation(env, id);
        if (!existing || existing.ownerUid !== env.OWNER_UID) return json({ error: 'Automation not found' }, 404, cors);

        // POST /api/automations/:id/run — generate one draft now (preview).
        // Records the run but deliberately does NOT advance nextRunAt.
        if (isRun) {
          if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
          try {
            // Separate budget principal so manual previews can't drain the cron's daily budget.
            const result = await generateForAutomation(env, url.origin, existing, 'automation:preview');
            const nowIso = new Date().toISOString();
            await updateAutomation(env, id, {
              lastRunAt: nowIso, lastStatus: 'ok', lastError: '',
              runCount: (parseInt(existing.runCount, 10) || 0) + 1, updatedAt: nowIso
            }).catch(() => {});
            return json({ ok: true, postId: result.postId }, 200, cors);
          } catch (err) {
            if (err?.quotaExceeded || err?.budgetExhausted) return json({ error: err.message }, 429, cors);
            console.error('Automation run failed:', err?.message || err);
            return json({ error: 'Generation failed' }, 502, cors);
          }
        }

        if (request.method === 'GET') return json({ automation: existing }, 200, cors);

        if (request.method === 'DELETE') {
          await deleteAutomation(env, id);
          return json({ deleted: id }, 200, cors);
        }

        if (request.method === 'PATCH') {
          let body;
          try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
          const patch = sanitizeAutomationPatch(body, existing.platform);
          if (Object.keys(patch).length === 0) return json({ error: 'No updatable fields provided' }, 400, cors);
          // A changed cadence must take effect now, not after the old (possibly
          // far-future) nextRunAt elapses — re-anchor the next run to now.
          if (patch.intervalHours !== undefined) {
            patch.nextRunAt = new Date(Date.now() + patch.intervalHours * 3_600_000).toISOString();
          }
          patch.updatedAt = new Date().toISOString();
          try {
            const automation = await updateAutomation(env, id, patch);
            return json({ automation }, 200, cors);
          } catch (err) {
            console.error('Automation update failed:', err?.message || err);
            return json({ error: 'Update failed' }, 502, cors);
          }
        }

        return json({ error: 'Method not allowed' }, 405, cors);
      }

      // /api/automations — list (GET) or create (POST).
      if (request.method === 'GET') {
        try {
          const automations = (await listAutomations(env, env.OWNER_UID))
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
          return json({ automations, count: automations.length }, 200, cors);
        } catch (err) {
          console.error('Automation list failed:', err?.message || err);
          return json({ error: 'List failed' }, 502, cors);
        }
      }

      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }

        const platform = String(body?.platform || 'gmb');
        // Own-property check, not `in` (which walks the prototype chain — 'constructor'/'toString'/… would
        // wrongly validate and let a junk platform through). PLATFORM_MAX is a plain object literal.
        if (!Object.prototype.hasOwnProperty.call(PLATFORM_MAX, platform)) return json({ error: `Unknown platform '${platform}'` }, 400, cors);
        const bodyClientId = String(body?.clientId || '').trim().slice(0, 64);
        const client = String(body?.client || '').trim().replace(/\//g, '').slice(0, 50);
        if (!bodyClientId || !client) return json({ error: 'client and clientId are required' }, 400, cors);
        const promptSeed = String(body?.promptSeed || '').trim().slice(0, MAX_PROMPT);
        if (!promptSeed) return json({ error: 'promptSeed is required' }, 400, cors);

        // Bind to the tenant key existing posts already use for this client name
        // (authoritative), not a possibly-stale client-supplied slug; fall back
        // to the supplied id for a brand-new client with no posts yet.
        const clientId = (await resolveClientId(env, client)) || bodyClientId;

        // Caps protect the owner's Gemini quota and keep the dashboard sane.
        let existing;
        try { existing = await listAutomations(env, env.OWNER_UID); }
        catch (err) { console.error('Automation list failed:', err?.message || err); return json({ error: 'Create failed' }, 502, cors); }
        // listAutomations caps at 200 rows; clamp the total cap to it so a
        // misconfigured AUTO_MAX_TOTAL > 200 can't silently disable the cap.
        const maxTotal = Math.min(parseInt(env.AUTO_MAX_TOTAL || '50', 10), 200);
        const maxPerClient = parseInt(env.AUTO_MAX_PER_CLIENT || '5', 10);
        if (existing.length >= maxTotal) return json({ error: `Automation limit reached (${maxTotal} total).` }, 409, cors);
        if (existing.filter(a => a.clientId === clientId).length >= maxPerClient) {
          return json({ error: `This client already has the maximum ${maxPerClient} automations.` }, 409, cors);
        }

        const fields = sanitizeAutomationPatch(body, platform);
        const intervalHours = fields.intervalHours || clampInterval(undefined, platform);
        const nowIso = new Date().toISOString();
        const doc = {
          ownerUid: env.OWNER_UID,
          clientId, client, platform,
          contentType: fields.contentType || 'text',
          tone: fields.tone || 'professional',
          length: fields.length || 'medium',
          imageStyle: fields.imageStyle || 'photo',
          promptSeed,
          intervalHours,
          enabled: typeof fields.enabled === 'boolean' ? fields.enabled : true,
          // First scheduled run is one interval out; "Run now" is for immediate.
          nextRunAt: new Date(Date.now() + intervalHours * 3_600_000).toISOString(),
          lastRunAt: '', lastStatus: '', lastError: '', runCount: 0,
          createdAt: nowIso, updatedAt: nowIso
        };
        try {
          const id = await createAutomation(env, doc);
          return json({ id, automation: { id, ...doc } }, 201, cors);
        } catch (err) {
          console.error('Automation create failed:', err?.message || err);
          return json({ error: 'Create failed' }, 502, cors);
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

  // Cron triggers (see wrangler.toml [triggers]). Each cron expression fires its
  // OWN scheduled event, so we branch on event.cron: the nightly "0 4 * * *"
  // runs the orphan-image sweep; the frequent tick runs due content automations.
  async scheduled(event, env, ctx) {
    if (event.cron === '0 4 * * *') {
      ctx.waitUntil(runGC(env));
    } else {
      const origin = (env.PUBLIC_ORIGIN || 'https://spool.stitchtec.dev').replace(/\/$/, '');
      ctx.waitUntil(runDueAutomations(env, origin));
    }
  }
};
