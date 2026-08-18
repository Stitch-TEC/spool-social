// Spool Worker — serves the SPA and the generation API from one deployment.
//
//   POST /api/generate  { prompt }            -> { url, key }   (image to R2)
//   POST /api/text      { prompt }            -> { text }
//   GET  /api/ideas?client=X                   -> { ok, slug, signals }  (site/repo idea signals)
//   GET  /media/<key>                          -> the stored image
//   GET  /api/health                           -> { ok: true }
//   POST /api/client-rename | /api/client-purge -> internal-key only (broker client lifecycle)
//   *                                          -> static assets (the Vite SPA)

import { authenticate } from './auth.js';
import { generateText, generateImage } from './gemini.js';
import { checkRateLimit } from './ratelimit.js';
import { createPost, getPost, listPosts, countDraftSummary, updatePost, updatePostWithAppend, deletePost, listAllImageUrls, getUserRecord, setUserRecord, deleteUserRecord , getDocRaw } from './firestore.js';
import { mintCustomToken, createShareDoc, getShareDoc, listShareDocs, deleteShareDoc } from './firestore.js';
import { createAutomation, getAutomation, listAutomations, updateAutomation, deleteAutomation, resolveClientId } from './firestore.js';
import { listDocsWhere, batchUpdateDocs, batchDeleteDocs, mergeDocRaw } from './firestore.js';
import { b64ToBytes, bytesToB64, mediaUrl, storeImage, resolveDraftImage } from './media.js';
import { runDueAutomations, generateForAutomation } from './automation.js';
import { fetchClientProfile, probeClientProfile, fetchClientRoster, fetchClientSignals, fetchClientPage, fetchContentIndex, fetchContentIndexPage, importSiteImage, pushSenderTemplate, renderSenderPreview, publishDraftToSite, rosterNameLookup } from './suiteContext.js';
// Shared with the SPA editor (pure string helpers — no DOM at module scope).
import { stripLeadingDuplicateH1 } from '../src/utils/markdownEditing.js';

// ---- Post → email-safe HTML fragment (the Sender template push + email preview) ----------------
// Shared with the SPA + vitest via src/utils/emailHtml.js — ONE converter, so the
// email-preview tab can never lie about what a push would produce.
import { postToEmailHtml } from '../src/utils/emailHtml.js';
import { PLATFORM_META, PLATFORM_CADENCE, contextTierForPlatform, renderPomContextLine, renderPomAssetsLine, renderPomBrandPart, renderPomBrandKitPart, renderPomBrandStyleLine, renderPomRecentLine, renderPomSeoLine } from '../src/generation/prompts.js';

const MAX_PROMPT = 2000;
// Per-platform character caps, derived from the shared PLATFORM_META so the
// Worker and the app can never disagree on a limit.
const PLATFORM_MAX = Object.fromEntries(
  Object.values(PLATFORM_META).map(p => [p.id, p.maxChars])
);

// Intake bound for draft content. X's REAL limit is weighted (URLs count 23,
// emoji 2 — see src/utils/markdownEditing.js twitterLength), so slicing tweets
// at the raw 280 can cut a URL in half on content the editor would accept
// whole. Drafts are human-reviewed — the editor enforces the weighted limit at
// save — so intake only bounds twitter with a generous raw backstop.
const rawIntakeCap = (platform) => (platform === 'twitter' ? 1000 : (PLATFORM_MAX[platform] || 100000));

// --- Automation config validation (shared by POST create + PATCH update) -----
const AUTO_CONTENT_TYPES = ['text', 'image', 'text+image'];
const AUTO_TONES = ['professional', 'friendly', 'bold', 'educational'];
const AUTO_LENGTHS = ['short', 'medium', 'long'];
const AUTO_IMAGE_STYLES = ['photo', 'studio', 'illustration', 'minimal', 'bold'];
// 'site' grounds each run in one real page of the client's site (rotating via pageCursor);
// 'none' is the original prompt-only behavior. 'suggest' parks each run as an operator-only
// suggestion the operator promotes/dismisses; 'auto' drops it straight into the review queue.
const AUTO_GROUNDINGS = ['none', 'site'];
const AUTO_MODES = ['auto', 'suggest'];

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
  if (AUTO_GROUNDINGS.includes(body?.grounding)) patch.grounding = body.grounding;
  if (AUTO_MODES.includes(body?.mode)) patch.mode = body.mode;
  // pageCursor is runner-managed rotation state, but PATCH-able so the operator/API can reset a
  // rotation; only a usable non-negative number counts (same posture as intervalHours below).
  if (body?.pageCursor !== undefined && Number.isFinite(parseInt(body.pageCursor, 10))) {
    patch.pageCursor = Math.max(0, parseInt(body.pageCursor, 10));
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

// Canonicalize a client identifier to the SLUG used as the R2 library folder. Mirrors
// src/config/roles.js `slugifyClientId` EXACTLY (kept inline so the worker bundle stays
// self-contained; the algorithm is stable — if roles.js ever changes, change both). Both a
// display name ("OMNI NDE") and a slug ("omni-nde") map to the same slug, so the in-app editor
// (which passes the display name) and the POM Assets card via the broker (which passes the slug)
// share ONE slug-keyed library — the suite's universal join key, never the mutable name. Idempotent
// on an already-slug input.
function slugifyClient(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
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
// The internal key (apikey mode — the broker/tools) may only manage objects under the OWNER's
// namespace, NOT any `library/`/`generated/` key. Scoping to `library/${OWNER_UID}/` closes a
// cross-owner reach: a client-member's own uploads live under `library/<theirUid>/…`, so a bare
// `library/` allowance would let a brokered delete (whose tenant gate only checks the client
// segment) land in another owner's namespace. The broker's per-request tenant gate + this owner
// gate are belt-and-braces.
function canManageKey(auth, env, key, caller) {
  if (auth.mode === 'apikey') return key.startsWith(`library/${env.OWNER_UID}/`) || key.startsWith(`generated/${env.OWNER_UID}/`) || key.startsWith('generated/internal/');
  if (key.startsWith(`library/${auth.principal}/`) || key.startsWith(`generated/${auth.principal}/`)) return true;
  if (auth.principal === env.OWNER_UID && key.startsWith('generated/internal/')) return true;
  // The curated library lives under the OWNER namespace for every caller (one shared,
  // slug-keyed folder — see the media routes). An operator manages all of it; a client
  // member only their own client's slug folder inside it (the tenant boundary).
  if (caller?.isOperator) return key.startsWith(`library/${env.OWNER_UID}/`);
  if (caller?.clientId) return key.startsWith(`library/${env.OWNER_UID}/${slugifyClient(caller.clientId)}/`);
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

// --- Client lifecycle (rename propagation + purge) — driven by the broker's /clients/lifecycle -----
// Everything here is keyed by the SLUG field (clientId / forClientId) — the suite join key — never
// by display name, so a doc from another tenant is never touched. Each store is a best-effort step
// that reports its own count or error (never a silent success), mirroring the broker's
// /people/propagate posture. Both flows are idempotent: a re-run finds nothing left to change.
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

// Run one store step; record `count` on success or `count`-so-far + `error` on failure.
async function lifecycleStep(results, store, fn) {
  try { results.counts[store] = await fn(); }
  catch (err) {
    results.counts[store] = Number.isFinite(err?.committed) ? err.committed : 0;
    results.errors.push({ store, error: err?.message || String(err) });
    console.error(`[client-lifecycle] ${store} failed:`, err?.message || err);
  }
}

// Tenant filter on a `field == slug` query result. For the clientId field the query already
// guarantees the match (kept as a belt). For forClientId — suggestions (App.jsx:252-260 tenant
// semantics: EMPTY clientId + forClientId = the client it's parked for) — only true suggestions
// qualify; a promoted post carries clientId and is handled by the clientId pass, so nothing is
// counted or touched twice.
function ownedBy(docs, field, clientId) {
  return docs.filter(d => (field === 'forClientId' ? !d.fields.clientId : d.fields.clientId === clientId));
}

// Relabel every owned doc in `collection` whose display name isn't already `to`.
async function relabelWhere(env, collection, field, clientId, patch) {
  const docs = await listDocsWhere(env, collection, field, clientId, { select: ['client', 'clientId'] });
  const stale = ownedBy(docs, field, clientId).filter(d => d.fields.client !== patch.client).map(d => d.name);
  const n = await batchUpdateDocs(env, stale, patch);
  // A capped listing is a partial result — say so (the broker shows it), never claim completeness.
  if (docs.truncated) { const e = new Error(`${collection}: listing capped — ${n} relabeled, re-run to continue`); e.committed = n; throw e; }
  return n;
}

async function propagateClientRename(env, clientId, to) {
  const results = { counts: {}, errors: [] };
  const now = new Date().toISOString();
  await lifecycleStep(results, 'posts', () => relabelWhere(env, 'posts', 'clientId', clientId, { client: to, updatedAt: now }));
  await lifecycleStep(results, 'suggestions', () => relabelWhere(env, 'posts', 'forClientId', clientId, { client: to, updatedAt: now }));
  await lifecycleStep(results, 'shares', () => relabelWhere(env, 'shares', 'clientId', clientId, { client: to }));
  await lifecycleStep(results, 'automations', () => relabelWhere(env, 'automations', 'clientId', clientId, { client: to, updatedAt: now }));
  // Branding docs are NAME-keyed (`${OWNER_UID}__${encodeURIComponent(name)}`, ClientSettingsModal)
  // but found by the clientId FIELD (getClientSettings). Move every OWNER-workspace doc for this
  // slug onto the new name key: lossless raw copy merged over any existing target, then delete
  // the old key. A doc already on the target key only gets its `name` field corrected.
  await lifecycleStep(results, 'branding', async () => {
    const targetId = `${env.OWNER_UID}__${encodeURIComponent(to)}`;
    // TENANT GUARD on the name-keyed target: another slug may already own `${OWNER}__${to}` (POM only
    // advises on duplicate display names). Never merge over a doc whose clientId is a different slug.
    const existingTarget = await getDocRaw(env, 'clients', targetId);
    const targetOwner = existingTarget?.clientId?.stringValue || '';
    if (existingTarget && targetOwner && targetOwner !== clientId) {
      const e = new Error(`branding: target "${to}" is owned by ${targetOwner} — not moved (rename the other client or pick a distinct name)`);
      e.committed = 0; throw e;
    }
    const docs = await listDocsWhere(env, 'clients', 'clientId', clientId);
    let changed = 0;
    for (const d of docs) {
      if (!d.id.startsWith(`${env.OWNER_UID}__`)) continue; // another workspace's doc — not ours to move
      if (d.id === targetId) {
        if (d.fields.name !== to) { await batchUpdateDocs(env, [d.name], { name: to }); changed++; }
        continue;
      }
      // If a target for THIS slug already exists, its (newer) fields win: merge the stale doc UNDER
      // it (only keys the target lacks), then drop the stale key. Else a lossless move.
      const under = existingTarget && targetOwner === clientId
        ? Object.fromEntries(Object.entries(d.raw).filter(([k]) => !(k in existingTarget)))
        : d.raw;
      await mergeDocRaw(env, 'clients', targetId, { ...under, name: { stringValue: to }, clientId: { stringValue: clientId } });
      await batchDeleteDocs(env, [d.name]);
      changed++;
    }
    return changed;
  });
  return results;
}

// Delete every owned doc in `collection` (same tenant filter as relabelWhere).
// `skip(doc)` may exclude a doc — the caller reports the skips as a note, never silently.
async function deleteWhere(env, collection, field, clientId, skip) {
  const docs = await listDocsWhere(env, collection, field, clientId, { select: ['clientId', 'roles'] });
  const mine = ownedBy(docs, field, clientId);
  const doomed = skip ? mine.filter(d => !skip(d)) : mine;
  const deleted = await batchDeleteDocs(env, doomed.map(d => d.name));
  return { deleted, skipped: mine.length - doomed.length };
}

// Delete every object under an R2 prefix (paged list, batched delete). Returns the count.
async function purgeMediaPrefix(env, prefix) {
  let deleted = 0, cursor;
  do {
    const listed = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map(o => o.key);
    if (keys.length) { await env.MEDIA.delete(keys); deleted += keys.length; }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}

async function purgeClient(env, clientId) {
  const results = { counts: {}, errors: [], notes: [] };
  const wipe = (store, collection, field, skip) => lifecycleStep(results, store, async () => {
    const { deleted, skipped } = await deleteWhere(env, collection, field, clientId, skip);
    if (skipped) results.notes.push(`${store}: left ${skipped} hand-managed super_admin doc(s) in place`);
    return deleted;
  });
  await wipe('posts', 'posts', 'clientId');
  await wipe('suggestions', 'posts', 'forClientId');
  await wipe('shares', 'shares', 'clientId');
  await wipe('automations', 'automations', 'clientId');
  // A super_admin doc pinned to this slug is the OPERATOR's own record (bootstrap --client-id) —
  // deleting it would lock a co-operator out. Same "privileged = hand-managed" line people-sync draws.
  await wipe('users', 'users', 'clientId', d => (Array.isArray(d.fields.roles) ? d.fields.roles : []).includes('super_admin'));
  await wipe('branding', 'clients', 'clientId');
  await lifecycleStep(results, 'media', async () => {
    if (!env.MEDIA) { results.notes.push('media: no MEDIA binding — R2 library not purged'); return 0; }
    // The prefix uses the slug VERBATIM — a non-canonical slug (`a--b`) must never normalize onto
    // another tenant's folder (`a-b`); the route rejects such ids before we get here (belt).
    if (slugifyClient(clientId) !== clientId) throw new Error(`media: non-canonical slug "${clientId}" — refusing to purge a normalized prefix`);
    return purgeMediaPrefix(env, `library/${env.OWNER_UID}/${clientId}/`);
  });
  return results;
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
      // Operator-only (like /api/clients): the probe reflects any client's name + brand
      // kit, so an arbitrary signed-in Google account must not be able to enumerate them.
      if (auth.mode !== 'apikey') {
        const caller = await resolveShareCaller(auth, env);
        if (!caller || !caller.isOperator) return json({ error: 'Not authorized' }, 403, cors);
      }
      const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
      if (!slug) return json({ error: 'slug is required' }, 400, cors);
      const probe = await probeClientProfile(env, slug);
      const probeKit = probe.ok ? probe.profile.brandKit : null;
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
              // Structured-brand + auto-context observability (presence/counts, no secret):
              // theme text + logoUrl presence + palette size from the structured kit, and
              // whether/when the broker-side auto-context digest last refreshed — so an
              // operator can see the whole seam is live from Spool's side.
              theme: typeof probeKit?.theme === 'string' ? probeKit.theme : '',
              hasLogoUrl: !!probeKit?.logoUrl,
              colors: Array.isArray(probeKit?.colors) ? probeKit.colors.length : 0,
              recentActivity: probe.profile.recentActivity
                ? { updatedAt: probe.profile.recentActivity.updatedAt || '' }
                : null,
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

    // --- Content ideas from the client's own sources (authed) — backs the editor's Ideas panel. ---
    // Brokered read of feedback-worker /client-signals (site pages + repo releases/commits, crawled
    // and cached broker-side): the CONTEXT_KEY round-trip happens HERE so the secret never reaches
    // the SPA. Same auth stack as generation (authenticate + rate limit + provisioned-caller gate);
    // a client member is tenant-pinned to their OWN slug, an operator/internal key picks any client
    // via ?client= (display name or slug — canonicalized by slugifyClient, the suite join key).
    // Fail-open posture for the UI: `ok:false not_configured` (200) when the seam key is absent so
    // the panel simply hides; a real upstream failure is an honest 502 the panel also hides on.
    if (url.pathname === '/api/ideas') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      // Rate-limit like every other authed route — a cache miss makes feedback-worker do live
      // site/GitHub fetches, so an authed caller mustn't be able to loop it and hammer the broker.
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      // Provisioned users only (same reasoning as generation: ALLOWED_EMAILS is empty, so
      // authenticate() alone would admit any signed-in Google account to another client's signals).
      let ideasCaller = null;
      if (auth.mode !== 'apikey') {
        ideasCaller = await resolveShareCaller(auth, env);
        if (!ideasCaller) return json({ error: 'Not authorized' }, 403, cors);
      }
      const requested = slugifyClient(url.searchParams.get('client') || '');
      let slug = ideasCaller && !ideasCaller.isOperator ? slugifyClient(ideasCaller.clientId) : requested;
      if (!slug) return json({ error: 'client is required' }, 400, cors);
      // Canonicalize an operator/internal request against the ROSTER: the Editor's client field is
      // free text, so slugifyClient can mint a slug the roster never issued (drifted display name
      // vs a hand-authored short slug) — the broker then 404s and the panel dies silently for
      // exactly those clients. A name→slug roster match repairs it; roster unreachable = keep the
      // requested value (fail-open, same posture as generation's context injection).
      if (!ideasCaller || ideasCaller.isOperator) {
        const roster = await fetchClientRoster(env);
        if (roster.length && !roster.some((c) => c.slug === slug)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(roster).get(slug);
          if (byName) slug = byName;
        }
      }
      // Operators/internal callers additionally get the auto-refreshed recentActivity digest (POM's
      // AI summary of what the client has been doing) — the richest single ideation signal, and today
      // invisible in every UI. It is repo-DERIVABLE prose, so it is gated exactly like `repos` below:
      // client members never receive it. Fetched in PARALLEL with the signals so it adds no latency,
      // and fetchClientProfile fail-opens to null on any miss, so it never blocks or breaks the panel.
      const canSeeAll = !ideasCaller || ideasCaller.isOperator;
      const [out, profile] = await Promise.all([
        fetchClientSignals(env, slug),
        canSeeAll ? fetchClientProfile(env, slug, 'standard') : Promise.resolve(null),
      ]);
      if (!out.ok) {
        if (out.reason === 'not_configured') return json({ ok: false, error: 'not_configured' }, 200, cors);
        // Unknown slug is NORMAL here (free-text client names that never joined the roster) —
        // quiet 200 so the panel hides without burning an error-log line per keystroke-settled name.
        if (out.reason === 'not_found') return json({ ok: false, error: 'unknown_client' }, 200, cors);
        // Presence-safe server-side detail (via `wrangler tail`); the caller only learns "upstream".
        console.error(`[ideas] ${slug}: signals fetch failed (${out.reason}${out.status ? ` ${out.status}` : ''})`);
        return json({ ok: false, error: 'upstream_failed' }, 502, cors);
      }
      // Client-role members get SITE signals only: repo items carry the agency's commit messages
      // and release notes — engineering prose that was never part of the client-facing surface.
      // Operators and the internal key see everything (repos + the recentActivity digest).
      const signals = canSeeAll ? out.signals : { ...out.signals, repos: [] };
      if (canSeeAll && profile?.recentActivity?.text) signals.recent = profile.recentActivity;
      return json({ ok: true, slug, signals }, 200, cors);
    }

    // --- Pull ONE selected page on demand (authed) — backs the Ideas panel's page picker. ---
    // Same auth stack + tenant pinning as /api/ideas; the broker domain-pins the URL to the
    // client's own site, so this can't be turned into an open fetch proxy. The CONTEXT_KEY
    // round-trip happens broker-side.
    if (url.pathname === '/api/page') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      let pageCaller = null;
      if (auth.mode !== 'apikey') {
        pageCaller = await resolveShareCaller(auth, env);
        if (!pageCaller) return json({ error: 'Not authorized' }, 403, cors);
      }
      const requested = slugifyClient(url.searchParams.get('client') || '');
      let slug = pageCaller && !pageCaller.isOperator ? slugifyClient(pageCaller.clientId) : requested;
      if (!slug) return json({ error: 'client is required' }, 400, cors);
      if (!pageCaller || pageCaller.isOperator) {
        const roster = await fetchClientRoster(env);
        if (roster.length && !roster.some((c) => c.slug === slug)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(roster).get(slug);
          if (byName) slug = byName;
        }
      }
      const target = url.searchParams.get('url') || '';
      if (!target) return json({ error: 'url is required' }, 400, cors);
      const out = await fetchClientPage(env, slug, target);
      if (!out.ok) {
        if (out.reason === 'not_configured') return json({ ok: false, error: 'not_configured' }, 200, cors);
        if (out.reason === 'off_site') return json({ ok: false, error: 'off_site' }, 200, cors);
        if (out.reason === 'not_found') return json({ ok: false, error: 'unknown_client' }, 200, cors);
        console.error(`[page] ${slug}: page fetch failed (${out.reason}${out.status ? ` ${out.status}` : ''})`);
        return json({ ok: false, error: 'upstream_failed' }, 502, cors);
      }
      return json({ ok: true, slug, page: out.page }, 200, cors);
    }

    // --- The durable content index (authed) — picker summaries + the media picker's site images. ---
    // Same auth stack + tenant pinning as /api/page; the broker serves its D1-backed index (pages
    // w/ SEO fields + AI summaries; ?images=1 adds the image inventory). Client-role members get
    // SITE-sourced rows only: repo-sourced pages can include DRAFT/unpublished content pulled from
    // the agency's repos — same gating rationale as /api/ideas hiding repo signals from clients.
    if (url.pathname === '/api/content-index') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      let idxCaller = null;
      if (auth.mode !== 'apikey') {
        idxCaller = await resolveShareCaller(auth, env);
        if (!idxCaller) return json({ error: 'Not authorized' }, 403, cors);
      }
      const requested = slugifyClient(url.searchParams.get('client') || '');
      let slug = idxCaller && !idxCaller.isOperator ? slugifyClient(idxCaller.clientId) : requested;
      if (!slug) return json({ error: 'client is required' }, 400, cors);
      if (!idxCaller || idxCaller.isOperator) {
        const roster = await fetchClientRoster(env);
        if (roster.length && !roster.some((c) => c.slug === slug)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(roster).get(slug);
          if (byName) slug = byName;
        }
      }
      const canSeeAllIdx = !idxCaller || idxCaller.isOperator;

      // Detail mode (?url=): ONE page's full row from the durable index — incl. the extracted
      // text /client-page structurally can't serve for repo-sourced pages (domain-pinned live
      // scrape). Client-role callers never see a repo-sourced row here either.
      const detailUrl = url.searchParams.get('url') || '';
      if (detailUrl) {
        const out = await fetchContentIndexPage(env, slug, detailUrl);
        if (!out.ok) {
          if (out.reason === 'not_configured') return json({ ok: false, error: 'not_configured' }, 200, cors);
          if (out.reason === 'not_found') return json({ ok: false, error: 'unknown_page' }, 200, cors);
          console.error(`[content-index] ${slug}: detail fetch failed (${out.reason}${out.status ? ` ${out.status}` : ''})`);
          return json({ ok: false, error: 'upstream_failed' }, 502, cors);
        }
        if (!canSeeAllIdx && out.page.source === 'repo') return json({ ok: false, error: 'unknown_page' }, 200, cors);
        return json({ ok: true, slug, page: out.page }, 200, cors);
      }

      const withImages = url.searchParams.get('images') === '1';
      const out = await fetchContentIndex(env, slug, withImages);
      if (!out.ok) {
        if (out.reason === 'not_configured') return json({ ok: false, error: 'not_configured' }, 200, cors);
        if (out.reason === 'not_found') return json({ ok: false, error: 'unknown_client' }, 200, cors);
        console.error(`[content-index] ${slug}: fetch failed (${out.reason}${out.status ? ` ${out.status}` : ''})`);
        return json({ ok: false, error: 'upstream_failed' }, 502, cors);
      }
      // The client-role repo gate covers EVERY payload section, not just pages: counts are
      // recomputed from the filtered slice (the broker aggregate counts hidden repo rows — even
      // the COUNT of unpublished draft pages shouldn't leak), and images drop any row attributed
      // to a repo-sourced page (empty today by construction, but the plumbing is source-generic —
      // an additive broker change must not start leaking draft-content imagery here).
      const pages = canSeeAllIdx ? out.pages : out.pages.filter((p) => p.source !== 'repo');
      const repoPageUrls = canSeeAllIdx ? null : new Set(out.pages.filter((p) => p.source === 'repo').map((p) => p.url));
      const images = canSeeAllIdx ? out.images : out.images.filter((i) => !i.pageUrl || !repoPageUrls.has(i.pageUrl));
      const counts = canSeeAllIdx ? out.counts : {
        total: pages.length,
        crawled: pages.filter((p) => p.lastCrawled).length,
        summarized: pages.filter((p) => p.summary).length,
        missingDescription: out.counts.missingDescription || 0, // already site-only broker-side
      };
      return json({ ok: true, slug, counts, pages, images }, 200, cors);
    }

    // --- Import one indexed site image into the client's curated library (authed). ---
    // The broker is the authority (URL must be in the D1 image index for THIS slug) and does the
    // SSRF-guarded download + type/size gates; this route only maps auth + tenant pinning, exactly
    // like /api/page. Idempotent — an already-imported image returns its existing library URL.
    if (url.pathname === '/api/site-image-import') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      let impCaller = null;
      if (auth.mode !== 'apikey') {
        impCaller = await resolveShareCaller(auth, env);
        if (!impCaller) return json({ error: 'Not authorized' }, 403, cors);
      }
      let impBody = {};
      try {
        impBody = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }
      const requested = slugifyClient(String(impBody.client || ''));
      let slug = impCaller && !impCaller.isOperator ? slugifyClient(impCaller.clientId) : requested;
      if (!slug) return json({ error: 'client is required' }, 400, cors);
      if (!impCaller || impCaller.isOperator) {
        const roster = await fetchClientRoster(env);
        if (roster.length && !roster.some((c) => c.slug === slug)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(roster).get(slug);
          if (byName) slug = byName;
        }
      }
      const imageUrl = String(impBody.url || '').trim();
      if (!imageUrl) return json({ error: 'url is required' }, 400, cors);
      const out = await importSiteImage(env, slug, imageUrl);
      if (!out.ok) {
        if (out.reason === 'not_configured') return json({ ok: false, error: 'not_configured' }, 200, cors);
        if (out.reason === 'library_full') return json({ ok: false, error: 'library_full', message: out.message }, 409, cors);
        if (out.reason === 'unknown_image') return json({ ok: false, error: 'unknown_image' }, 404, cors);
        if (out.reason === 'unsupported_type') return json({ ok: false, error: 'unsupported_type' }, 415, cors);
        console.error(`[site-image-import] ${slug}: import failed (${out.reason}${out.status ? ` ${out.status}` : ''})`);
        return json({ ok: false, error: 'upstream_failed' }, 502, cors);
      }
      return json({ ok: true, slug, url: out.url, alreadySynced: out.alreadySynced }, 200, cors);
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
      // Lowercase the slug (Sender's receiver already does) so a mixed-case clientId can't produce a
      // users doc Spool's login lookup — which lowercases — then fails to match. Slugs are lowercase by
      // convention; this is a fail-safe backstop.
      const clientId = String(body?.clientId || '').trim().toLowerCase();
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

    // --- Client lifecycle (rename propagation + purge) — INTERNAL KEY ONLY (broker /clients/lifecycle). ---
    // Same gate as /api/people-sync: internal key or nothing (401 unauthenticated / 403 non-key),
    // rate-limited. Slug-keyed, tenant-isolated, idempotent, per-store reported (see the helpers).
    //   POST /api/client-rename { clientId, from?, to }  → { ok, counts:{posts,suggestions,shares,automations,branding}, errors? }
    //   POST /api/client-purge  { clientId }             → { ok, counts:{…, users, media}, notes[], errors? }
    if (url.pathname === '/api/client-rename' || url.pathname === '/api/client-purge') {
      const isPurge = url.pathname === '/api/client-purge';
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ ok: false, error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'apikey') return json({ ok: false, error: 'internal key required' }, 403, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ ok: false, error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      if (!env.OWNER_UID) return json({ ok: false, error: 'OWNER_UID is not configured' }, 500, cors);

      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400, cors); }
      // Lowercase like people-sync (fail-safe backstop), then insist on a real slug — a display
      // name here would silently match nothing (rename) or, worse, be slugified into a folder.
      const clientId = String(body?.clientId || '').trim().toLowerCase();
      if (!SLUG_RE.test(clientId)) return json({ ok: false, error: 'clientId must be a slug ([a-z0-9-], 1–64 chars)' }, 400, cors);
      // Canonical form only: `a--b` / `-a` pass the regex but would normalize onto ANOTHER slug's
      // R2 folder in the purge — refuse rather than guess.
      if (slugifyClient(clientId) !== clientId) return json({ ok: false, error: 'clientId must be a canonical slug (no leading/trailing/double hyphens)' }, 400, cors);

      const summarize = (r) => Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')
        + (r.errors.length ? ` errors=${r.errors.map(e => e.store).join(',')}` : '');
      const stores = (r) => Object.keys(r.counts).length;

      if (!isPurge) {
        const to = String(body?.to || '').trim();
        const from = String(body?.from || '').trim().slice(0, 120);
        if (!to || to.length > 120) return json({ ok: false, error: 'to must be 1–120 chars' }, 400, cors);
        const r = await propagateClientRename(env, clientId, to);
        console.log(`[client-rename] ${clientId}: ${JSON.stringify(from)} → ${JSON.stringify(to)} ${summarize(r)}`);
        const allFailed = r.errors.length && r.errors.length === stores(r);
        return json({
          ok: r.errors.length === 0, clientId, to, counts: r.counts,
          ...(r.errors.length ? { error: allFailed ? 'rename_failed' : 'partial_failure', errors: r.errors } : {}),
        }, allFailed ? 502 : 200, cors);
      }

      const r = await purgeClient(env, clientId);
      console.log(`[client-purge] ${clientId}: ${summarize(r)}${r.notes.length ? ` notes=${r.notes.length}` : ''}`);
      const allFailed = r.errors.length && r.errors.length === stores(r);
      return json({
        ok: r.errors.length === 0, clientId, counts: r.counts, notes: r.notes,
        ...(r.errors.length ? { error: allFailed ? 'purge_failed' : 'partial_failure', errors: r.errors } : {}),
      }, allFailed ? 502 : 200, cors);
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
      let genCaller = null;
      if (auth.mode !== 'apikey') {
        genCaller = await resolveShareCaller(auth, env);
        if (!genCaller) return json({ error: 'Not authorized' }, 403, cors);
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
      // A client MEMBER is tenant-pinned: their generations always meter (and pull POM
      // context/brand for) their OWN client, never a body-supplied one.
      let genClientId = genCaller && !genCaller.isOperator
        ? (slugifyClient(genCaller.clientId) || undefined)
        : ((body?.clientId || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64) || undefined);

      // Canonicalize against the ROSTER — the same repair /api/ideas does (see the comment there),
      // and for the same reason: the Editor's client field is free text, so a drifted display name
      // produces a slug the roster never issued. Un-repaired, that phantom slug costs twice on the
      // path that matters most — fetchClientProfile 404s so generation silently runs with NO client
      // context, AND the gateway meters usage against a slug that has no aiQuota row, so the 429
      // never fires for exactly those clients (the suite's documented roster violation). Operator /
      // internal callers only; a client member is already tenant-pinned. Fail-open: an unreachable
      // roster keeps the requested value.
      if (genClientId && (!genCaller || genCaller.isOperator)) {
        const roster = await fetchClientRoster(env);
        if (roster.length && !roster.some((c) => c.slug === genClientId)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(roster).get(genClientId);
          if (byName) genClientId = byName;
        }
      }

      // POM per-client context + brand + asset manifest (the cross-app seam) — the SAME injection
      // the automation path does, now for interactive generation. The SPA builds the base
      // system/prompt; the profile is fetched and appended SERVER-side so CONTEXT_KEY never
      // reaches the browser. `platform` (optional in the body) sizes the fetch tier via the
      // shared contextTierForPlatform rule (long-form earns the full context; absent/unknown →
      // 'standard'). Fail-OPEN by design: fetchClientProfile returns null on any miss (no key,
      // unknown slug, timeout — it carries its own 5s cap, no retries) and generation proceeds
      // without it. A quota denial downstream still surfaces as 429 — that logic is untouched.
      const genPlatform = typeof body?.platform === 'string' ? body.platform : '';
      const profile = genClientId ? await fetchClientProfile(env, genClientId, contextTierForPlatform(genPlatform)) : null;
      // Presence-safe observability (no secret/content), same as the automation path — so
      // `wrangler tail` shows whether the seam fed an interactive call or silently degraded.
      if (genClientId && env.CONTEXT_KEY) {
        console.log(
          profile
            ? `[suite-context] ${genClientId}: profile injected (${url.pathname}, ctx=${(profile.aiContext || '').length} chars, brand=${profile.brand ? 'yes' : 'no'}, assets=${profile.assets ? (profile.assets.count ?? 0) : 'n/a'})`
            : `[suite-context] ${genClientId}: no profile — generating without it (${url.pathname})`,
        );
      }

      try {
        if (url.pathname === '/api/text') {
          const image = body?.imageUrl ? await resolveImage(body.imageUrl, env) : undefined;
          // Append the brand theme + client context + recent activity + asset manifest to the
          // caller-built system instruction — the shared renderers keep the framing (and the
          // directive-before-untrusted-data ordering) identical to buildTextContext's own output.
          let system = body?.system ? String(body.system).slice(0, 4000) : undefined;
          if (profile) {
            const extras = [
              renderPomBrandStyleLine(profile.brandKit),
              renderPomSeoLine(profile.seoKit),
              renderPomContextLine(profile.aiContext),
              renderPomRecentLine(profile.recentActivity),
              renderPomAssetsLine(profile.assets),
            ]
              .filter(Boolean)
              .join('\n');
            if (extras) system = system ? `${system}\n${extras}` : extras;
          }
          const text = await generateText(env, prompt, {
            system,
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

        // Image: generate -> store in R2 -> return a URL. The POM brand palette is appended the
        // same way buildImagePrompt does for automation drafts (space-joined sentence): the
        // structured kit (exact palette hexes + theme) when the broker sent one, else the lossy
        // one-line `brand` string fallback.
        const brandPart = profile ? (renderPomBrandKitPart(profile.brandKit) || renderPomBrandPart(profile.brand)) : '';
        const imgPrompt = brandPart ? `${prompt} ${brandPart}` : prompt;
        const { b64, mime } = await generateImage(env, imgPrompt, { clientId: genClientId });
        const owner = auth.mode === 'firebase' ? auth.principal : 'internal';
        const stored = await storeImage(env, url.origin, b64ToBytes(b64), mime, owner, genClientId);
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
    //   GET    /api/media              generated/uploaded reuse pool (in-editor reuse)
    //   GET    /api/media?client=X     curated per-client library (images + videos)
    //   POST   /api/media              { client, image:{base64} | videoUrl } → curated library
    //                                  { image:{base64} } (no client) → content-addressed pool
    //   DELETE /api/media/:key         remove one item (owner/tenant-scoped)
    if (url.pathname === '/api/media' || url.pathname.startsWith('/api/media/')) {
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) {
        return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      }
      // Provisioned users only (or the internal key) — the media library writes/serves R2 + AI-cached
      // assets, so don't let an arbitrary signed-in Google account read or grow it (ALLOWED_EMAILS empty).
      let caller = null;
      if (auth.mode !== 'apikey') {
        caller = await resolveShareCaller(auth, env);
        if (!caller) return json({ error: 'Not authorized' }, 403, cors);
      }
      // The curated per-client library lives under ONE namespace — the owner's — so the
      // operator, client members, and the POM broker (apikey) all see the same slug-keyed
      // folder. A client member is tenant-pinned to their own client slug; previously the
      // library was keyed by the caller's uid, so members always saw an empty folder.
      const memberSlug = caller && !caller.isOperator ? slugifyClient(caller.clientId) : null;

      // DELETE /api/media/:key
      if (url.pathname.startsWith('/api/media/')) {
        if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405, cors);
        const key = decodeURIComponent(url.pathname.slice('/api/media/'.length));
        if (!key) return json({ error: 'Missing key' }, 400, cors);
        if (!canManageKey(auth, env, key, caller)) return json({ error: 'Not found' }, 404, cors);
        await env.MEDIA.delete(key);
        return json({ deleted: key }, 200, cors);
      }

      // POST /api/media — add an image or video to a client's curated library, or (with
      // no client) store a post-attachment image in the content-addressed reuse pool.
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
        if (!env.OWNER_UID) return json({ error: 'OWNER_UID is not configured' }, 500, cors);
        // Key the library by the canonical SLUG (a display name or a slug both resolve here), so the
        // in-app editor and the POM Assets card share one folder and two orgs can never collide.
        const client = slugifyClient(body?.client || '');

        // No client → editor post-image upload. Content-addressed (storeImage hashes the
        // bytes), so re-attaching the same photo to many posts yields ONE object and ONE
        // URL — this is what keeps Firestore posts small and the reuse picker dedupable.
        // Doesn't count against the curated per-client cap; the nightly reference-based
        // GC reclaims it once no post references it.
        if (!client && !body?.videoUrl && body?.image?.base64) {
          const m = String(body.image.base64).match(/^data:([^;]+);base64,(.+)$/);
          const mime = m ? m[1] : (body.image.mime || 'image/jpeg');
          let bytes;
          try { bytes = b64ToBytes(m ? m[2] : String(body.image.base64)); }
          catch { return json({ error: 'Invalid base64 image' }, 400, cors); }
          if (bytes.length > 5_000_000) return json({ error: 'Image too large after optimization (max 5 MB)' }, 413, cors);
          const poolOwner = auth.mode === 'apikey' ? env.OWNER_UID : auth.principal;
          // `forClient` (distinct from `client`) tags the pooled attachment with the client it belongs
          // to — for the picker's per-client scoping — WITHOUT routing it into the curated library or
          // counting it against the per-client cap. A member is pinned to their own slug.
          const forClient = memberSlug || slugifyClient(body?.forClient || '');
          const stored = await storeImage(env, url.origin, bytes, mime, poolOwner, forClient);
          return json({ key: stored.key, type: 'image', url: stored.url }, 201, cors);
        }

        if (!client) return json({ error: 'client is required' }, 400, cors);
        if (memberSlug && client !== memberSlug) return json({ error: 'Not authorized for this client' }, 403, cors);

        const base = `library/${env.OWNER_UID}/${client}/`;
        const cap = parseInt(env.MEDIA_PER_CLIENT || '50', 10);
        const existing = await env.MEDIA.list({ prefix: base, limit: 1000 });

        if (body?.videoUrl) {
          if (existing.objects.length >= cap) {
            return json({ error: `Library is full (${cap} items per client) — delete some first.` }, 409, cors);
          }
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
          let bytes;
          try { bytes = b64ToBytes(m ? m[2] : String(b64)); }
          catch { return json({ error: 'Invalid base64 image' }, 400, cors); }
          if (bytes.length > 5_000_000) return json({ error: 'Image too large after optimization (max 5 MB)' }, 413, cors);
          const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
          // Content-addressed like the pool: re-saving the same bytes lands on the SAME
          // key (an idempotent overwrite), so "Save to library" / repeat uploads can never
          // fill the library with duplicates. Only a genuinely new image counts at the cap.
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const hash = Array.from(new Uint8Array(digest), (bt) => bt.toString(16).padStart(2, '0')).join('');
          const key = `${base}${hash}.${ext}`;
          const already = existing.objects.some(o => o.key === key);
          if (!already && existing.objects.length >= cap) {
            return json({ error: `Library is full (${cap} items per client) — delete some first.` }, 409, cors);
          }
          await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
          return json({ key, type: 'image', url: mediaUrl(url.origin, key), deduped: already }, 201, cors);
        }
        return json({ error: 'image.base64 or videoUrl is required' }, 400, cors);
      }

      // GET /api/media — curated library (?client=) or the generated AI-cache pool.
      if (request.method === 'GET') {
        const clientParam = url.searchParams.get('client');
        if (clientParam) {
          if (!env.OWNER_UID) return json({ error: 'OWNER_UID is not configured' }, 500, cors);
          // Same slug canonicalization as POST — list the shared slug-keyed folder.
          const client = slugifyClient(clientParam);
          if (memberSlug && client !== memberSlug) return json({ error: 'Not authorized for this client' }, 403, cors);
          const media = await listMediaPrefix(env, url.origin, `library/${env.OWNER_UID}/${client}/`);
          return json({ media, count: media.length }, 200, cors);
        }
        // No client → the generated AI-cache pool (in-editor "Choose from library").
        let prefixes;
        if (auth.mode === 'apikey') prefixes = ['generated/'];
        else if (auth.principal === env.OWNER_UID) prefixes = [`generated/${auth.principal}/`, 'generated/internal/'];
        else prefixes = [`generated/${auth.principal}/`];
        // `?forClient=<slug>` scopes the OPERATOR's cross-client pool to images tagged with that client
        // (customMetadata written by storeImage) so the picker shows ONLY the client you're working on
        // — not every client's images. A member's pool is already a single tenant (their uid prefix
        // holds only their own client's images), so we DON'T filter them — that would wrongly hide
        // their legacy untagged images. This is a VIEW filter on top of the unchanged uid-prefix
        // authorization boundary; untagged legacy images never match, the privacy-safe default.
        const forClient = memberSlug ? '' : slugifyClient(url.searchParams.get('forClient') || '');
        const paginate = auth.mode === 'apikey' || !!forClient; // filtering needs the full walk, not just page 1
        const media = [];
        for (const prefix of prefixes) {
          let cursor;
          do {
            const listed = await env.MEDIA.list({ prefix, cursor, limit: 1000, ...(forClient ? { include: ['customMetadata'] } : {}) });
            for (const o of listed.objects) {
              if (forClient) {
                // storeImage tags a merged SET of clientIds (comma-joined); accept the legacy
                // single `clientId` field too. Untagged legacy objects match nothing → excluded.
                const ids = (o.customMetadata?.clientIds || o.customMetadata?.clientId || '').split(',');
                if (!ids.includes(forClient)) continue;
              }
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
    // --- Push a post to Sender as an email template (operator-only) ---
    //   POST /api/sender-template  { postId } → { ok, templateId, builderUrl, updated }
    // Server-side hop: this worker converts the post to an email-safe HTML FRAGMENT and calls the
    // broker's /sender/template relay (CONTEXT_KEY); the broker alone holds SENDER_INTERNAL_KEY and
    // forwards to Sender, which sanitizes + stores tenant-scoped. Re-push of the same post UPDATES
    // the existing template (provenance = spoolPostId), never duplicates. Honest passthrough:
    // 409 = the client has no Sender tenant yet; 503 = a seam key missing somewhere.
    if (url.pathname === '/api/sender-template') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      // Human super-admins only — pushing content into a client's email tool is an operator act.
      if (auth.mode !== 'firebase') return json({ error: 'Sign in as an operator' }, 403, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      const caller = await resolveShareCaller(auth, env);
      if (!caller || !caller.isOperator) return json({ error: 'Not authorized' }, 403, cors);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const postId = String(body?.postId || '').trim();
      if (!postId) return json({ error: 'postId is required' }, 400, cors);
      const post = await getPost(env, postId);
      if (!post) return json({ error: 'Post not found' }, 404, cors);
      // A parked suggestion has no tenant — promote it first (the explicit gate stays load-bearing).
      if (post.source === 'suggestion') return json({ error: 'Promote the suggestion first — suggestions aren’t client content yet' }, 400, cors);
      // Review gate (operator decision 2026-08-13, closing the §8 asymmetry with the publish
      // lane): a DRAFT must finish the client review loop before it lands in the client's
      // email tool. Reusable templates are exempt BY NECESSITY, not leniency — the Templates
      // library is excluded from the drafts API / review queue by design, so a client can
      // never approve one; gating them would dead-end every template push.
      if (!post.isTemplate && post.approvalStatus !== 'approved') {
        return json({ error: 'Only approved drafts can be pushed to Sender — get the draft approved first' }, 409, cors);
      }

      // Resolve the ROSTER slug — never slugify a display name (the documented phantom-slug bug):
      // trust a stamped clientId only if the roster issued it; else match the display name.
      const roster = await fetchClientRoster(env);
      const bySlug = roster.find((c) => c.slug === (post.clientId || ''));
      const byName = roster.find((c) => (c.name || '').toLowerCase() === (post.client || '').toLowerCase());
      const slug = (bySlug || byName)?.slug || '';
      if (!slug) {
        // Distinguish the three empty-roster causes honestly: an unconfigured seam is permanent
        // (fix the secret), a transient roster failure is retryable — conflating them sent the
        // operator chasing configuration during a network blip.
        if (roster.length) return json({ error: 'This post’s client isn’t on the suite roster' }, 404, cors);
        return env.CONTEXT_KEY
          ? json({ error: 'Roster temporarily unavailable — try again in a moment' }, 503, cors)
          : json({ error: 'CONTEXT_KEY seam not configured' }, 503, cors);
      }

      const html = postToEmailHtml(post);
      if (!html) return json({ error: 'Post has no content to convert' }, 400, cors);
      const name = (post.title || `${post.client || slug} — ${post.platform || 'draft'}`).slice(0, 120);
      try {
        const out = await pushSenderTemplate(env, {
          slug,
          name,
          html,
          preheader: (post.metaDescription || '').slice(0, 200),
          spoolPostId: postId,
          // Sender refuses (409 sender_edited) when its copy was edited since
          // the last push; the SPA confirms with the operator and retries with
          // force — an explicit choice, never a silent overwrite.
          force: body?.force === true,
        });
        return json(out.body, out.status, cors);
      } catch (err) {
        console.error('sender-template push failed:', err?.message || err);
        return json({ ok: false, error: 'sender_unreachable' }, 502, cors);
      }
    }

    // --- Email preview: render a draft through Sender's REAL pipeline (operator-only) ---
    //   POST /api/email-preview  { content, title, imageUrl, altText, metaDescription, client, clientId }
    //     → { ok, html, tenant }
    // Takes the LIVE editor fields (not a saved post) so unsaved work previews truthfully.
    // Same converter as the push (postToEmailHtml — the preview can't lie), relayed via the
    // broker's /sender/render (CONTEXT_KEY; the broker alone holds SENDER_INTERNAL_KEY).
    // READ-ONLY end to end: Sender renders with the tenant's branding, writes nothing.
    if (url.pathname === '/api/email-preview') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      if (auth.mode !== 'firebase') return json({ error: 'Sign in as an operator' }, 403, cors);
      // Separate rate bucket ('preview:' principal): habitual Email-tab use
      // must not burn the shared per-operator budget that real AI generation
      // draws from (and a generation burst must not 429 the preview).
      const rl = await checkRateLimit(env, `preview:${auth.principal}`, auth.mode, Date.now());
      if (!rl.ok) return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      const caller = await resolveShareCaller(auth, env);
      if (!caller || !caller.isOperator) return json({ error: 'Not authorized' }, 403, cors);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      // Bound every field to the save path's own limits — this is preview-only,
      // but it still flows through the broker's 500KB relay cap. A data-URL
      // hero that would blow that cap is DROPPED whole (never truncated —
      // sliced base64 is a corrupt image), flagged so the preview can say so.
      let imageUrl = String(body?.imageUrl || '');
      let heroOmitted = false;
      if (imageUrl.startsWith('data:')) {
        if (imageUrl.length > 400000) {
          imageUrl = '';
          heroOmitted = true;
        }
      } else {
        imageUrl = imageUrl.slice(0, 2048); // hosted/https URLs are short
      }
      const draft = {
        content: String(body?.content || '').slice(0, 120000),
        title: String(body?.title || '').slice(0, 200),
        imageUrl,
        altText: String(body?.altText || '').slice(0, 300),
        metaDescription: String(body?.metaDescription || '').slice(0, 200),
      };

      // Same roster resolution as the push: stamped id if the roster issued it,
      // else display-name match — never slugify (the phantom-slug bug).
      const roster = await fetchClientRoster(env);
      const bySlug = roster.find((c) => c.slug === String(body?.clientId || ''));
      const byName = roster.find((c) => (c.name || '').toLowerCase() === String(body?.client || '').toLowerCase());
      const slug = (bySlug || byName)?.slug || '';
      if (!slug) {
        if (roster.length) return json({ error: 'This post’s client isn’t on the suite roster' }, 404, cors);
        return env.CONTEXT_KEY
          ? json({ error: 'Roster temporarily unavailable — try again in a moment' }, 503, cors)
          : json({ error: 'CONTEXT_KEY seam not configured' }, 503, cors);
      }

      const html = postToEmailHtml(draft);
      if (!html) return json({ error: 'Nothing to preview yet — add some content' }, 400, cors);
      // Typed refusal instead of a relayed 413 — the broker cap is our known
      // bound, so say so before the round trip.
      if (html.length > 490000) return json({ ok: false, error: 'preview_too_large' }, 413, cors);
      try {
        const out = await renderSenderPreview(env, {
          slug,
          html,
          preheader: draft.metaDescription.slice(0, 200),
        });
        // heroOmitted rides alongside Sender's response — the preview pane
        // tells the operator the hero was left out rather than lying by omission.
        return json({ ...out.body, ...(heroOmitted ? { heroOmitted: true } : {}) }, out.status, cors);
      } catch (err) {
        console.error('email-preview render failed:', err?.message || err);
        return json({ ok: false, error: 'sender_unreachable' }, 502, cors);
      }
    }

    //   POST /api/publish-to-site  { postId, path?, repo? } → { ok, ticketId, repo, path }
    // The DETERMINISTIC publish lane's Spool entry: stage an APPROVED blog draft for publication
    // to the client's site repo. This worker only gates + composes (operator auth, approval
    // check, roster slug, frontmatter); the broker validates the target, pins the sha256, writes
    // the spine ticket + server-side publish object. The operator then dispatches from POM and a
    // human merges the PR — content bytes never touch a prompt anywhere in the lane.
    if (url.pathname === '/api/publish-to-site') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
      const auth = await authenticate(request, env);
      if (!auth) return json({ error: 'Unauthorized' }, 401, cors);
      // Human super-admins only — publishing to a client's live site is an operator act.
      if (auth.mode !== 'firebase') return json({ error: 'Sign in as an operator' }, 403, cors);
      const rl = await checkRateLimit(env, auth.principal, auth.mode, Date.now());
      if (!rl.ok) return json({ error: `Rate limit exceeded (max ${rl.limit}/${rl.scope}).` }, 429, { ...cors, 'Retry-After': String(rl.retryAfter) });
      const caller = await resolveShareCaller(auth, env);
      if (!caller || !caller.isOperator) return json({ error: 'Not authorized' }, 403, cors);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
      const postId = String(body?.postId || '').trim();
      if (!postId) return json({ error: 'postId is required' }, 400, cors);
      const post = await getPost(env, postId);
      if (!post) return json({ error: 'Post not found' }, 404, cors);
      if (post.source === 'suggestion') return json({ error: 'Promote the suggestion first — suggestions aren’t client content yet' }, 400, cors);
      // Same review gate as the Sender push (aligned 2026-08-13): only content that
      // finished the review loop may stage — site publication is the client's public voice.
      if (post.approvalStatus !== 'approved') {
        return json({ error: 'Only approved drafts can be published to the site — get the draft approved first' }, 409, cors);
      }
      // v1 scope: long-form blog drafts (a social caption isn't a site page).
      if (post.platform !== 'blog') return json({ error: 'Only blog drafts can be published to the site (v1)' }, 400, cors);
      // Normalize line endings FIRST: keeps the frontmatter detection below honest for CRLF
      // content and makes the sha the broker pins independent of paste/import line-ending luck.
      const md = String(post.content || '').replace(/\r\n?/g, '\n').trim();
      if (!md) return json({ error: 'Post has no content' }, 400, cors);

      // Resolve the ROSTER slug — never slugify a display name (the documented phantom-slug bug).
      const roster = await fetchClientRoster(env);
      const bySlug = roster.find((c) => c.slug === (post.clientId || ''));
      const byName = roster.find((c) => (c.name || '').toLowerCase() === (post.client || '').toLowerCase());
      const slug = (bySlug || byName)?.slug || '';
      if (!slug) {
        if (roster.length) return json({ error: 'This post’s client isn’t on the suite roster' }, 404, cors);
        return env.CONTEXT_KEY
          ? json({ error: 'Roster temporarily unavailable — try again in a moment' }, 503, cors)
          : json({ error: 'CONTEXT_KEY seam not configured' }, 503, cors);
      }

      const title = (post.title || md.split('\n')[0].replace(/^#+\s*/, '')).trim().slice(0, 200) || 'Untitled post';
      // Target path: caller-supplied wins (re-publish / operator override); else derive the
      // content-collection DIRECTORY + EXTENSION from the durable content index — repo-sourced
      // rows carry the repo file path of every existing post, so a new post lands where the
      // site's build actually reads (e.g. lyf-fit = content/posts/*.mdx, not a guessed
      // content/blog/*.md). Fail-open to the generic default when the index has no repo rows.
      const postSlug = String(post.slug || '').trim()
        || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
        || `post-${postId.slice(0, 8).toLowerCase()}`;
      let path = String(body?.path || '').trim();
      if (!path) {
        let dir = 'content/blog';
        let ext = '.md';
        try {
          const idx = await fetchContentIndex(env, slug);
          if (idx.ok) {
            // Most common directory among repo-sourced content files (the site's real collection).
            const dirs = new Map();
            for (const p of idx.pages) {
              if (p.source !== 'repo') continue;
              const rp = String(p.path || '');
              const m = rp.match(/^(.*content\/[^/]+)\/[^/]+\.(md|mdx)$/i);
              if (!m) continue;
              const key = `${m[1]}|.${m[2].toLowerCase()}`;
              dirs.set(key, (dirs.get(key) || 0) + 1);
            }
            const top = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0];
            if (top) [dir, ext] = top[0].split('|');
          }
        } catch {
          // index unavailable — the generic default still opens a reviewable PR
        }
        path = `${dir}/${postSlug}${ext}`;
      }
      // Frontmatter: only when the draft doesn't already carry its own. yq additionally collapses
      // newlines — a raw newline inside a double-quoted YAML scalar is invalid and would fail the
      // client site's build (review fix 2026-07-23).
      const yq = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // Frontmatter carries the title — a body that OPENS by repeating it as an
      // H1 (AI drafts are told to start with one) would title the page twice.
      // Only applies on the frontmatter-we-compose branch; a draft that brought
      // its own frontmatter ships byte-identical.
      const bodyMd = stripLeadingDuplicateH1(md, title);
      const content = md.startsWith('---\n')
        ? md
        : [
            '---',
            `title: "${yq(title)}"`,
            ...(post.metaDescription ? [`description: "${yq(String(post.metaDescription).slice(0, 200))}"`] : []),
            `date: "${new Date().toISOString().slice(0, 10)}"`,
            '---',
            '',
            bodyMd,
          ].join('\n');

      try {
        const out = await publishDraftToSite(env, {
          slug,
          repo: String(body?.repo || '').trim().toLowerCase() || undefined,
          path,
          title,
          content,
          spoolPostId: postId,
        });
        return json(out.body, out.status, cors);
      } catch (err) {
        console.error('publish-to-site failed:', err?.message || err);
        return json({ ok: false, error: 'broker_unreachable' }, 502, cors);
      }
    }

    //   GET    /api/drafts       list (filters: ?clientId= [slug, preferred] &client= [name, legacy] &platform= &status= &reviewStage=)
    //   GET    /api/drafts/:id    fetch one
    //   PATCH  /api/drafts/:id    update (text, image, schedule, status, tags, approvalStatus+feedback, reviewStage)
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
          const max = rawIntakeCap(existing.platform);
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
          // Staging axis (src/utils/review.js): 'private' keeps the draft off the client's
          // review link, 'in_review' publishes it there. Sending also (re)arms the round —
          // an undecided draft goes back to pending and gets a fresh sentForReviewAt, so
          // POM's "waiting N days" is measured from the send, not from creation. An already
          // APPROVED draft keeps its approval: that was the client's decision, not ours.
          if (['private', 'in_review'].includes(body.reviewStage)) {
            patch.reviewStage = body.reviewStage;
            if (body.reviewStage === 'in_review') {
              patch.sentForReviewAt = new Date().toISOString();
              if (body.approvalStatus === undefined && existing.approvalStatus !== 'approved') {
                patch.approvalStatus = 'pending';
              }
            }
          }
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
        // Summary mode (internal key, whole-owner): review-state COUNTS across all clients,
        // INCLUDING the suggestion lane (which the list below strips). Counts only, no rows —
        // feeds the feedback-worker broker's cross-app "/attention" strip. This is the FREQUENT
        // poll, so use a projected count query (only the 4 count fields, no post bodies/threads)
        // instead of pulling every owner post's full document. Archived drafts are excluded.
        if (url.searchParams.get('summary') === '1') {
          try {
            const summary = await countDraftSummary(env, env.OWNER_UID);
            return json({ ok: true, summary }, 200, cors);
          } catch (err) {
            console.error('Draft summary failed:', err?.message || err);
            return json({ error: 'Summary failed' }, 502, cors);
          }
        }
        try {
          // Bound the response. This scanned every post the owner has ever created and
          // returned FULL documents — content, base64-era imageUrl, whole feedbackThread
          // arrays — so the payload grew without limit as the workspace did, on a route
          // POM polls. ?limit= (default 300, max 1000) caps it, and the response says
          // when it truncated so no caller can mistake a partial list for the whole set.
          const reqLimit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '300', 10) || 300, 1), 1000);
          let drafts = await listPosts(env, env.OWNER_UID);
          // Templates aren't drafts, and parked SUGGESTIONS aren't review content yet: legacy
          // name-keyed callers join this list by display name (which suggestions carry), so
          // without this filter a not-yet-promoted option would surface on a client's dashboard.
          // (Slug-keyed callers are safe either way — a suggestion's clientId is '' by design.)
          drafts = drafts.filter(d => !d.isTemplate && d.source !== 'suggestion');
          const q = url.searchParams;
          const fc = q.get('client'), fcid = (q.get('clientId') || '').trim(), fp = q.get('platform'), fst = q.get('status');
          // ?reviewStage=private|in_review — lets POM ask for "what's still on my desk"
          // vs "what's with the client". Absent = every stage (the pre-existing behaviour,
          // so no caller's list can shrink under it).
          const frs = (q.get('reviewStage') || '').trim();
          // Slug-keyed join (2026-07-29): a caller that knows the immutable suite slug sends
          // ?clientId= and we filter on the stamped d.clientId, IGNORING the mutable display-name
          // param entirely — a roster rename can no longer empty the POM Content card's join.
          // The ?client= name filter stays for legacy callers that only send the name (and a
          // dual-param caller hitting an older deploy of this worker gets the name filter = the
          // status quo, so the protocol is safe in both interim deploy states).
          if (fcid) drafts = drafts.filter(d => d.clientId === fcid);
          else if (fc) drafts = drafts.filter(d => d.client === fc);
          if (fp) drafts = drafts.filter(d => d.platform === fp);
          if (fst) drafts = drafts.filter(d => d.status === fst);
          // ABSENT reviewStage reads as 'in_review' — the same legacy default the SPA applies.
          if (frs) drafts = drafts.filter(d => (d.reviewStage || 'in_review') === frs);
          drafts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
          // Newest-first, so a truncated page is still the page a caller wants.
          const total = drafts.length;
          const truncated = total > reqLimit;
          if (truncated) drafts = drafts.slice(0, reqLimit);
          return json({ drafts, count: drafts.length, total, truncated }, 200, cors);
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

        const content = (body?.content || '').toString().trim().slice(0, rawIntakeCap(platform));
        if (!content) return json({ error: 'content is required' }, 400, cors);
        const client = (body?.client || '').toString().trim().replace(/\//g, '').slice(0, 50);
        if (!client) return json({ error: 'client is required' }, 400, cors);
        // The immutable tenant key (suite slug). Callers that know it send it (the broker / POM skill
        // do); otherwise resolve it from existing posts for the same display name. Display NAME is
        // mutable + not guaranteed unique, so the slug is what cross-app guards key on — a draft
        // without it falls back to name matching (legacy behavior).
        let clientId =
          (body?.clientId || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64) ||
          (await resolveClientId(env, client)) || '';
        // CANONICALIZE against the roster (same repair as the automations route above): both the
        // caller-supplied id and the posts-derived resolution are self-referential, so a drifted or
        // first-time display name mints a phantom slug (or no slug at all) the roster never issued —
        // and an unstamped/phantom draft is invisible to the slug-keyed GET ?clientId= filter, i.e.
        // it silently never reaches POM's Content & approvals card. Roster unreachable/empty = keep
        // the resolved value (fail-open, same posture as generation's context injection).
        const draftRoster = await fetchClientRoster(env);
        if (draftRoster.length && !draftRoster.some((c) => c.slug === clientId)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(draftRoster).get(slugifyClient(client));
          if (byName) clientId = byName;
        }

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
            // API-created drafts land in STAGING by default: a draft arriving from POM or a
            // skill is not something the client has been shown, and it used to appear on
            // their live review link the instant it was written. Callers that genuinely want
            // it in front of the client say so explicitly.
            reviewStage: body?.reviewStage === 'in_review' ? 'in_review' : 'private',
            ...(body?.reviewStage === 'in_review' ? { sentForReviewAt: nowIso } : {}),
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
              runCount: (parseInt(existing.runCount, 10) || 0) + 1, updatedAt: nowIso,
              // Persist the site-grounding rotation on previews too — repeated "Run now" clicks
              // should walk the site, not restate one page (nextRunAt stays untouched).
              ...(result.pageCursor !== undefined ? { pageCursor: result.pageCursor } : {})
            }).catch(() => {});
            return json({ ok: true, postId: result.postId }, 200, cors);
          } catch (err) {
            // Even a failed preview advanced the rotation if it picked a page — persist
            // (best-effort) so repeated "Run now" retries don't wedge on one broken page.
            if (err?.pageCursor !== undefined) {
              await updateAutomation(env, id, { pageCursor: err.pageCursor, updatedAt: new Date().toISOString() }).catch(() => {});
            }
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
        // Same slug alphabet every other clientId intake enforces (lowercase a-z0-9-): an
        // unsanitized fallback here was the one place a mixed-case/spaced id could slip into
        // the automations collection and then never join suite-side.
        const bodyClientId = String(body?.clientId || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
        const client = String(body?.client || '').trim().replace(/\//g, '').slice(0, 50);
        if (!bodyClientId || !client) return json({ error: 'client and clientId are required' }, 400, cors);
        const promptSeed = String(body?.promptSeed || '').trim().slice(0, MAX_PROMPT);
        if (!promptSeed) return json({ error: 'promptSeed is required' }, 400, cors);

        // Bind to the tenant key existing posts already use for this client name, falling back
        // to the supplied id for a brand-new client with no posts yet — then CANONICALIZE against
        // the roster (same repair as /api/ideas): both of those sources are self-referential, so a
        // drifted/first-time display name mints a phantom slug the roster never issued and the
        // automation joins to nothing suite-side (context seam 404s, the aiQuota 429 never fires).
        // Roster unreachable/empty = keep the resolved value (fail-open, same posture as
        // generation's context injection).
        let clientId = (await resolveClientId(env, client)) || bodyClientId;
        const roster = await fetchClientRoster(env);
        if (roster.length && !roster.some((c) => c.slug === clientId)) {
          // Collision-guarded lookup (suiteContext.rosterNameLookup): an ambiguous
          // display name refuses to repair rather than pick a tenant arbitrarily.
          const byName = rosterNameLookup(roster).get(slugifyClient(client));
          if (byName) clientId = byName;
        }

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
          // Grounding + delivery (defaults = exact pre-existing behavior). pageCursor is the
          // runner-advanced rotation index into the client's site page list ('site' only).
          grounding: fields.grounding || 'none',
          mode: fields.mode || 'auto',
          pageCursor: fields.pageCursor || 0,
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
      // Serve stored bytes as EXACTLY their stored type — R2 holds user/site-sourced content,
      // and content-sniffing an inline same-origin response is how a disguised HTML/SVG body
      // becomes stored XSS. New stores only accept raster types; the svg→attachment fallback
      // neutralizes any legacy svg object without breaking <img> rendering of raster images.
      headers.set('X-Content-Type-Options', 'nosniff');
      if ((headers.get('Content-Type') || '').toLowerCase().includes('svg')) {
        headers.set('Content-Disposition', 'attachment');
      }
      // Conditional-request support: keys are content-addressed/immutable, so a
      // revalidating client gets a bodyless 304 instead of a full R2 read-through.
      headers.set('ETag', obj.httpEtag);
      if (request.headers.get('If-None-Match') === obj.httpEtag) {
        return new Response(null, { status: 304, headers });
      }
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
