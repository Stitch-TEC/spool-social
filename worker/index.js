// Spool Worker — serves the SPA and the generation API from one deployment.
//
//   POST /api/generate  { prompt }            -> { url, key }   (image to R2)
//   POST /api/text      { prompt }            -> { text }
//   GET  /api/ideas?client=X                   -> { ok, slug, signals }  (site/repo idea signals)
//   GET  /media/v2/<key>                       -> the byte-validated stored image
//   GET  /media/<key>                          -> no-store redirect to the v2 cache key
//   GET  /api/health                           -> { ok: true }
//   POST /api/client-rename | /api/client-purge -> internal-key only (broker client lifecycle)
//   *                                          -> static assets (the Vite SPA)

import { authenticate } from './auth.js';
import { exposedGenerationError, generateText, generateImage } from './aiGateway.js';
import { checkRateLimit } from './ratelimit.js';
import {
  createPost,
  getPost,
  listDraftPage,
  DRAFT_PAGE_MAX_BYTES,
  encodeDraftCursor,
  decodeDraftCursor,
  countDraftSummary,
  deletePost,
  listAllImageUrls,
  getUserRecord,
  setUserRecord,
  deleteUserRecord,
  getDocRaw,
  mutatePostAtomically,
  requireAutoId,
  requireShareToken,
} from './firestore.js';
import { mintCustomToken, createShareDoc, getShareDoc, listShareDocs, deleteShareDoc } from './firestore.js';
import { createAutomation, getAutomation, listAutomations, updateAutomation, deleteAutomation, resolveClientId } from './firestore.js';
import { listDocsWhere, batchUpdateDocs, batchDeleteDocs, mergeDocRaw } from './firestore.js';
import {
  decodeImageBase64,
  inspectRasterImage,
  MAX_IMAGE_BYTES,
  mediaOriginConfig,
  mediaKeyFromUrl,
  mediaUrl,
  RASTER_VALIDATION_VERSION,
  storeImage,
  resolveDraftImage,
  versionMediaMarkdownReferences,
  versionMediaReference,
} from './media.js';
import {
  BodyTooLargeError,
  DEFAULT_JSON_BYTES,
  IMAGE_JSON_BYTES,
  MULTIMODAL_JSON_BYTES,
  readBytesBounded,
  readJsonBounded,
} from './httpBody.js';
import {
  buildDraftMutation,
  draftPublicationTitle,
  draftPublicationSlug,
  publicationPathMatchesSlug,
  assertIsolatedDraftReviewIntent,
  assertDraftBaseline,
  sameLegacyImageBytes,
  versionDraftMedia,
} from './draftUpdate.js';
import { applySecurityHeaders, forceMediaDownload, withSecurityHeaders } from './security.js';
import { STALE_ASSET_RECOVERY_PARAM } from '../src/staleAssetRecovery.js';
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
// a schedule can't spam a channel or run away with the shared AI budget. Falls back to the
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
    // Advertise every method this Worker actually implements. Browsers reject
    // PATCH/DELETE/HEAD preflights before routing when this list lies.
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type'
  };
  if (allowed) h['Access-Control-Allow-Origin'] = allowed;
  // When a specific origin is reflected (not '*'), caches must key on Origin or
  // one origin's CORS response could be served to a different origin.
  if (allowed && allow !== '*') h['Vary'] = 'Origin';
  return h;
}

function json(obj, status, extra) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(extra || {}) });
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(obj), {
    status,
    headers
  });
}

/** Machine-stable API error contract. `error` is always a symbolic code;
 * `message` remains safe to show to an operator or reviewer. */
export function symbolicErrorPayload(error, message, extra = {}) {
  return { error: String(error), message: String(message), ...extra };
}

function apiError(error, message, status, cors, extra) {
  return json(symbolicErrorPayload(error, message, extra), status, cors);
}

function generationErrorResponse(err, cors, operation = 'generation') {
  const exposed = exposedGenerationError(err);
  if (!exposed) return null;
  if (!err?.quotaExceeded) {
    console.error(`[ai] ${operation} ${err?.code || 'unavailable'}: ${err?.internalReason || 'optional action unavailable'}`);
  }
  return json(exposed.body, exposed.status, cors);
}

export function serializedJsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function draftListResponseBody(page, nextCursor = null) {
  return {
    drafts: page.drafts,
    count: page.drafts.length,
    total: page.total,
    truncated: page.truncated,
    nextCursor: page.truncated ? nextCursor : null,
  };
}

function jsonBodyError(err, cors, withOk = false) {
  const payload = { ...(withOk ? { ok: false } : {}), error: err instanceof BodyTooLargeError ? 'Request body is too large' : 'Invalid JSON' };
  return json(payload, err instanceof BodyTooLargeError ? 413 : 400, cors);
}

async function parseJson(request, maxBytes = DEFAULT_JSON_BYTES) {
  return readJsonBounded(request, maxBytes);
}

export function decodeAutoId(encoded, kind) {
  let decoded;
  try { decoded = decodeURIComponent(encoded); }
  catch {
    const err = new Error(`Malformed ${kind} id`);
    err.code = 'invalid_document_id';
    throw err;
  }
  return requireAutoId(decoded, kind);
}

export function decodeShareToken(encoded) {
  let decoded;
  try { decoded = decodeURIComponent(encoded); }
  catch {
    const err = new Error('Malformed share token');
    err.code = 'invalid_document_id';
    throw err;
  }
  return requireShareToken(decoded);
}

function clampMaxTokens(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 4096);
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
export async function listR2ObjectsCompletely(binding, options) {
  const objects = [];
  const seenCursors = new Set();
  const expectedPrefix = typeof options?.prefix === 'string' ? options.prefix : '';
  let cursor = '';
  while (cursor !== null) {
    const listed = await binding.list({ ...options, ...(cursor ? { cursor } : {}) });
    if (!listed || typeof listed !== 'object' || Array.isArray(listed)
      || !Array.isArray(listed.objects) || typeof listed.truncated !== 'boolean') {
      throw new Error('R2 list returned a malformed result');
    }
    for (const object of listed.objects) {
      if (!object || typeof object !== 'object' || Array.isArray(object)
        || typeof object.key !== 'string' || !object.key) {
        throw new Error('R2 list returned a malformed object');
      }
      // R2 promises that list({prefix}) cannot escape that namespace. Treat a
      // contrary response as corrupt/uncertain inventory: destructive callers
      // must never delete a key from another tenant or storage class.
      if (expectedPrefix && !object.key.startsWith(expectedPrefix)) {
        throw new Error(`R2 list returned an object outside prefix ${expectedPrefix}`);
      }
      if (object.uploaded !== undefined && !Number.isFinite(new Date(object.uploaded).getTime())) {
        throw new Error(`R2 list returned an invalid upload time for ${object.key}`);
      }
      objects.push(object);
    }
    if (!listed.truncated) { cursor = null; continue; }
    if (typeof listed.cursor !== 'string' || !listed.cursor || seenCursors.has(listed.cursor)) {
      throw new Error('R2 list returned a missing/repeated continuation cursor');
    }
    seenCursors.add(listed.cursor);
    cursor = listed.cursor;
  }
  return objects;
}

async function listMediaPrefix(env, origin, prefix) {
  const items = [];
  const objects = await listR2ObjectsCompletely(env.MEDIA, { prefix, include: ['customMetadata'], limit: 1000 });
  for (const o of objects) {
    const cm = o.customMetadata || {};
    if (cm.type === 'video') items.push({ key: o.key, type: 'video', url: cm.url, provider: cm.provider, uploaded: o.uploaded });
    else items.push({ key: o.key, type: 'image', url: mediaUrl(origin, o.key), size: o.size, uploaded: o.uploaded });
  }
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
export async function runGC(env, {
  listReferences = listAllImageUrls,
  listObjects = (binding, options) => listR2ObjectsCompletely(binding, options),
} = {}) {
  if (!env.MEDIA || !env.FIREBASE_SERVICE_ACCOUNT) return;
  const graceDays = parseInt(env.GC_GRACE_DAYS || '365', 10);
  const cutoff = Date.now() - (Number.isFinite(graceDays) ? graceDays : 365) * 24 * 60 * 60 * 1000;

  const referenced = new Set();
  let objects;
  try {
    for (const u of await listReferences(env)) {
      const key = mediaKeyFromUrl(u);
      if (key) referenced.add(key);
    }
    // Two-phase sweep: finish and validate the ENTIRE R2 listing before the
    // first delete. A malformed page/cursor or later-page outage therefore
    // turns this run into a no-op instead of deleting from an incomplete view.
    objects = await listObjects(env.MEDIA, { prefix: 'generated/', limit: 1000 });
  } catch (err) {
    console.error('GC: inventory failed; no objects deleted:', err?.message || err);
    return;
  }

  let deleted = 0, kept = 0;
  for (const o of objects) {
    const inUse = referenced.has(o.key);
    const old = o.uploaded ? new Date(o.uploaded).getTime() < cutoff : false;
    if (!inUse && old) { await env.MEDIA.delete(o.key); deleted++; }
    else kept++;
  }
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
export async function deleteWhere(env, collection, field, clientId, skip, {
  list = listDocsWhere,
  remove = batchDeleteDocs,
} = {}) {
  const { names, skipped } = await planDeleteWhere(env, collection, field, clientId, skip, list);
  const deleted = await remove(env, names);
  return { deleted, skipped };
}

async function planDeleteWhere(env, collection, field, clientId, skip, list = listDocsWhere) {
  const docs = await list(env, collection, field, clientId, { select: ['clientId', 'roles'] });
  if (docs.truncated) {
    const error = new Error(`${collection}: purge listing capped — no documents deleted`);
    error.committed = 0;
    throw error;
  }
  const mine = ownedBy(docs, field, clientId);
  const doomed = skip ? mine.filter(d => !skip(d)) : mine;
  return { names: doomed.map(d => d.name), skipped: mine.length - doomed.length };
}

async function deleteR2Keys(binding, keys) {
  let committed = 0;
  try {
    // R2's multi-delete limit is 1,000 keys. Inventory is already complete;
    // chunk only the mutation phase and retain an honest committed count.
    for (let i = 0; i < keys.length; i += 1000) {
      await binding.delete(keys.slice(i, i + 1000));
      committed += Math.min(1000, keys.length - i);
    }
    return committed;
  } catch (error) {
    error.committed = committed;
    throw error;
  }
}

// Purge is deliberately two-phase: obtain and validate EVERY Firestore and R2
// inventory before the first mutation. A capped/malformed later store can never
// leave an earlier store deleted while the route still lacked a complete plan.
export async function purgeClient(env, clientId, {
  list = listDocsWhere,
  remove = batchDeleteDocs,
  listObjects = (binding, options) => listR2ObjectsCompletely(binding, options),
  removeObjects = deleteR2Keys,
} = {}) {
  const results = { counts: {}, errors: [], notes: [] };
  const specs = [
    ['posts', 'posts', 'clientId'],
    ['suggestions', 'posts', 'forClientId'],
    ['shares', 'shares', 'clientId'],
    ['automations', 'automations', 'clientId'],
  ];
  // A super_admin doc pinned to this slug is the OPERATOR's own record (bootstrap --client-id) —
  // deleting it would lock a co-operator out. Same "privileged = hand-managed" line people-sync draws.
  specs.push(['users', 'users', 'clientId', d => (Array.isArray(d.fields.roles) ? d.fields.roles : []).includes('super_admin')]);
  specs.push(['branding', 'clients', 'clientId']);

  const plans = new Map();
  for (const [store, collection, field, skip] of specs) {
    try {
      plans.set(store, await planDeleteWhere(env, collection, field, clientId, skip, list));
      results.counts[store] = 0;
    } catch (err) {
      results.counts[store] = 0;
      results.errors.push({ store, error: err?.message || String(err) });
    }
  }

  let mediaKeys = [];
  if (!env.MEDIA) {
    results.notes.push('media: no MEDIA binding — R2 library not purged');
    results.counts.media = 0;
  } else {
    try {
      // The prefix uses the slug VERBATIM — a non-canonical slug (`a--b`) must never normalize onto
      // another tenant's folder (`a-b`); the route rejects such ids before we get here (belt).
      if (slugifyClient(clientId) !== clientId) throw new Error(`media: non-canonical slug "${clientId}" — refusing to purge a normalized prefix`);
      mediaKeys = (await listObjects(env.MEDIA, {
        prefix: `library/${env.OWNER_UID}/${clientId}/`, limit: 1000,
      })).map(object => object.key);
      results.counts.media = 0;
    } catch (err) {
      results.counts.media = 0;
      results.errors.push({ store: 'media', error: err?.message || String(err) });
    }
  }

  // Any uncertain inventory aborts the ENTIRE purge. Counts are zero because
  // no mutation has begun; the caller returns a hard failure, never a partial
  // success envelope.
  if (results.errors.length) return results;

  for (const [store] of specs) {
    const plan = plans.get(store);
    if (plan.skipped) results.notes.push(`${store}: left ${plan.skipped} hand-managed super_admin doc(s) in place`);
    await lifecycleStep(results, store, () => remove(env, plan.names));
  }
  if (env.MEDIA) await lifecycleStep(results, 'media', () => removeObjects(env.MEDIA, mediaKeys));
  return results;
}

const ASSET_PATH = /^\/assets\//;
const JAVASCRIPT_ASSET_PATH = /^\/assets\/[^/]+\.js$/;
const STYLESHEET_ASSET_PATH = /^\/assets\/[^/]+\.css$/;
const HTML_CONTENT_TYPE = /text\/html/i;

// A stale Vite entry module cannot run any code from the current bundle, so its
// recovery has to come from the exact old URL it is already requesting. Keep
// this deliberately ES5-shaped: it is the last-resort path for older iPhones.
export function staleAssetRecoveryScript() {
  const marker = JSON.stringify(STALE_ASSET_RECOVERY_PARAM);
  return `(function(){
var marker=${marker};
function showFallback(){
  var root=document.getElementById('root')||document.body;
  if(!root){return;}
  while(root.firstChild){root.removeChild(root.firstChild);}
  var box=document.createElement('div');
  box.style.cssText='font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:30rem;margin:12vh auto;padding:2rem;text-align:center;color:#334155';
  var title=document.createElement('h1');
  title.textContent='Spool needs a fresh start';
  title.style.cssText='font-size:1.25rem;margin:0 0 .75rem';
  var copy=document.createElement('p');
  copy.textContent='The app updated while this copy was open. Close and reopen Spool, or try again below.';
  copy.style.cssText='line-height:1.5;margin:0 0 1rem';
  var button=document.createElement('button');
  button.textContent='Try again';
  button.style.cssText='border:0;border-radius:.75rem;background:#0f172a;color:white;padding:.75rem 1rem;font-weight:700';
  button.onclick=function(){
    var retry=new URL(window.location.href);
    retry.searchParams.delete(marker);
    retry.searchParams.set('__spool_asset_retry',String(Date.now()));
    window.location.replace(retry.toString());
  };
  box.appendChild(title);box.appendChild(copy);box.appendChild(button);root.appendChild(box);
}
try{
  var url=new URL(window.location.href);
  if(url.searchParams.has(marker)){showFallback();return;}
  url.searchParams.set(marker,String(Date.now()));
  window.location.replace(url.toString());
}catch(error){showFallback();}
})();`;
}

export async function serveSpaAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const isAssetPath = ASSET_PATH.test(url.pathname);
  const isHtmlFallback = HTML_CONTENT_TYPE.test(response.headers.get('Content-Type') || '');

  // `single-page-application` fallback normally turns a missing hashed asset
  // into index.html with HTTP 200. A module loader rejects that MIME before
  // React can render an error boundary. Only reinterpret HTML under /assets/;
  // real assets and ordinary client-side routes keep their original bodies.
  if (isAssetPath && isHtmlFallback && (request.method === 'GET' || request.method === 'HEAD')) {
    try { await response.body?.cancel(); } catch { /* response is being replaced */ }
    const noStoreHeaders = {
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache',
    };

    if (JAVASCRIPT_ASSET_PATH.test(url.pathname)) {
      const headers = applySecurityHeaders(new Headers({
        ...noStoreHeaders,
        'Content-Type': 'application/javascript; charset=utf-8',
        'X-Spool-Asset-Recovery': '1',
      }));
      return new Response(request.method === 'HEAD' ? null : staleAssetRecoveryScript(), {
        status: 200,
        headers,
      });
    }

    // Old HTML commonly references both an expired entry module and stylesheet.
    // An empty stylesheet is MIME-correct and harmless while the recovery entry
    // reloads the current shell; returning HTML here adds a noisy Safari error.
    if (STYLESHEET_ASSET_PATH.test(url.pathname)) {
      const headers = applySecurityHeaders(new Headers({
        ...noStoreHeaders,
        'Content-Type': 'text/css; charset=utf-8',
        'X-Spool-Asset-Recovery': 'style',
      }));
      return new Response(request.method === 'HEAD' ? null : '/* stale Spool stylesheet */', {
        status: 200,
        headers,
      });
    }

    // The SPA fallback is useful only for navigations. Images, maps, fonts, and
    // other missing asset URLs must remain honest 404s instead of HTML-shaped
    // successes that poison browser caches and hide broken references.
    return new Response(request.method === 'HEAD' ? null : 'Not found', {
      status: 404,
      headers: applySecurityHeaders(new Headers({
        ...noStoreHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
      })),
    });
  }

  return withSecurityHeaders(response);
}

export default {
  async fetch(request, env) {
    let cors = {};
    try {
      const url = new URL(request.url);
      cors = corsHeaders(env, request);
      const { publicOrigin, legacyOrigins } = mediaOriginConfig(env);

    if (request.method === 'OPTIONS') {
      const headers = applySecurityHeaders(new Headers(cors));
      return new Response(null, { status: 204, headers });
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
      const visibleImages = canSeeAllIdx ? out.images : out.images.filter((i) => !i.pageUrl || !repoPageUrls.has(i.pageUrl));
      const images = visibleImages.map((i) => ({
        ...i,
        ...(i.spoolUrl ? { spoolUrl: versionMediaReference(publicOrigin, i.spoolUrl, legacyOrigins) } : {}),
      }));
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
        impBody = await parseJson(request);
      } catch (err) {
        return jsonBodyError(err, cors);
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
      return json({
        ok: true,
        slug,
        url: versionMediaReference(publicOrigin, out.url, legacyOrigins),
        alreadySynced: out.alreadySynced,
      }, 200, cors);
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
      try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors, true); }
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
      try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors, true); }
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
      return json({
        ok: r.errors.length === 0, clientId, counts: r.counts, notes: r.notes,
        ...(r.errors.length ? { error: 'purge_failed', errors: r.errors } : {}),
      }, r.errors.length ? 502 : 200, cors);
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
        body = await parseJson(request, url.pathname === '/api/text' ? MULTIMODAL_JSON_BYTES : IMAGE_JSON_BYTES);
      } catch (err) {
        return jsonBodyError(err, cors);
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
          // Keep image input explicit without reading/decoding the bytes. aiGateway
          // rejects the marker with the safe multimodal-unavailable contract until
          // ai-worker accepts image content; resolving it here would waste R2/CPU
          // immediately before the truthful refusal.
          const image = body?.imageUrl ? { requested: true } : undefined;
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
        const stored = await storeImage(env, publicOrigin, decodeImageBase64(b64), mime, owner, genClientId);
        return json({ url: stored.url, key: stored.key }, 200, cors);
      } catch (err) {
        // Quota denials and optional-AI availability failures have a bounded,
        // user-safe contract. They never mutate or discard the draft the user
        // was editing, and they never fall through to a direct provider.
        const aiResponse = generationErrorResponse(err, cors);
        if (aiResponse) return aiResponse;
        if (err?.code === 'image_too_large') return json({ error: err.message }, 413, cors);
        // Log upstream detail server-side, but do not reflect provider or
        // credential details back to API callers.
        console.error('Generation failed:', err?.internalReason || err?.message || err);
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
        let key;
        try { key = decodeURIComponent(url.pathname.slice('/api/media/'.length)); }
        catch { return json({ error: 'Malformed media key' }, 400, cors); }
        if (!key) return json({ error: 'Missing key' }, 400, cors);
        if (!canManageKey(auth, env, key, caller)) return json({ error: 'Not found' }, 404, cors);
        await env.MEDIA.delete(key);
        return json({ deleted: key }, 200, cors);
      }

      // POST /api/media — add an image or video to a client's curated library, or (with
      // no client) store a post-attachment image in the content-addressed reuse pool.
      if (request.method === 'POST') {
        let body;
        try { body = await parseJson(request, IMAGE_JSON_BYTES); } catch (err) { return jsonBodyError(err, cors); }
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
          const mime = m ? m[1] : (body.image.mime || '');
          let bytes;
          try { bytes = decodeImageBase64(m ? m[2] : String(body.image.base64)); }
          catch (err) {
            return err?.code === 'image_too_large'
              ? json({ error: err.message }, 413, cors)
              : json({ error: 'Invalid base64 image' }, 400, cors);
          }
          try { inspectRasterImage(bytes, mime); }
          catch { return json({ error: 'Only valid JPEG, PNG, WebP, or GIF image bytes are accepted' }, 415, cors); }
          if (m && body.image.mime) {
            try { inspectRasterImage(bytes, body.image.mime); }
            catch { return json({ error: 'Image MIME does not match its bytes' }, 415, cors); }
          }
          const poolOwner = auth.mode === 'apikey' ? env.OWNER_UID : auth.principal;
          // `forClient` (distinct from `client`) tags the pooled attachment with the client it belongs
          // to — for the picker's per-client scoping — WITHOUT routing it into the curated library or
          // counting it against the per-client cap. A member is pinned to their own slug.
          const forClient = memberSlug || slugifyClient(body?.forClient || '');
          const stored = await storeImage(env, publicOrigin, bytes, mime, poolOwner, forClient);
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
          const mime = m ? m[1] : (body.image.mime || '');
          let bytes;
          try { bytes = decodeImageBase64(m ? m[2] : String(b64)); }
          catch (err) {
            return err?.code === 'image_too_large'
              ? json({ error: err.message }, 413, cors)
              : json({ error: 'Invalid base64 image' }, 400, cors);
          }
          let raster;
          try { raster = inspectRasterImage(bytes, mime); }
          catch { return json({ error: 'Only valid JPEG, PNG, WebP, or GIF image bytes are accepted' }, 415, cors); }
          if (m && body.image.mime) {
            try { inspectRasterImage(bytes, body.image.mime); }
            catch { return json({ error: 'Image MIME does not match its bytes' }, 415, cors); }
          }
          // Content-addressed like the pool: re-saving the same bytes lands on the SAME
          // key (an idempotent overwrite), so "Save to library" / repeat uploads can never
          // fill the library with duplicates. Only a genuinely new image counts at the cap.
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          const hash = Array.from(new Uint8Array(digest), (bt) => bt.toString(16).padStart(2, '0')).join('');
          const key = `${base}${hash}.${raster.ext}`;
          const already = existing.objects.some(o => o.key === key);
          if (!already && existing.objects.length >= cap) {
            return json({ error: `Library is full (${cap} items per client) — delete some first.` }, 409, cors);
          }
          await env.MEDIA.put(key, bytes, {
            httpMetadata: { contentType: raster.mime },
            customMetadata: {
              rasterValidated: RASTER_VALIDATION_VERSION,
              rasterMime: raster.mime,
            },
          });
          return json({ key, type: 'image', url: mediaUrl(publicOrigin, key), deduped: already }, 201, cors);
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
          const media = await listMediaPrefix(env, publicOrigin, `library/${env.OWNER_UID}/${client}/`);
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
              media.push({ key: o.key, type: 'image', url: mediaUrl(publicOrigin, o.key), size: o.size, uploaded: o.uploaded });
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
      try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors); }
      let postId;
      try { postId = requireAutoId(String(body?.postId || '').trim(), 'draft'); }
      catch { return json({ error: 'valid postId is required' }, 400, cors); }
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

      const html = postToEmailHtml({
        ...post,
        imageUrl: versionMediaReference(publicOrigin, post.imageUrl, legacyOrigins),
        content: versionMediaMarkdownReferences(publicOrigin, post.content, legacyOrigins),
      });
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
      try { body = await parseJson(request, IMAGE_JSON_BYTES); } catch (err) { return jsonBodyError(err, cors); }
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
        imageUrl = versionMediaReference(publicOrigin, imageUrl, legacyOrigins).slice(0, 2048); // hosted/https URLs are short
      }
      const draft = {
        content: versionMediaMarkdownReferences(publicOrigin, String(body?.content || ''), legacyOrigins).slice(0, 120000),
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
      try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors); }
      let postId;
      try { postId = requireAutoId(String(body?.postId || '').trim(), 'draft'); }
      catch { return json({ error: 'valid postId is required' }, 400, cors); }
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
      const md = versionMediaMarkdownReferences(publicOrigin, post.content, legacyOrigins).replace(/\r\n?/g, '\n').trim();
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

      const title = draftPublicationTitle(post);
      // Target path: caller-supplied wins (re-publish / operator override); else derive the
      // content-collection DIRECTORY + EXTENSION from the durable content index — repo-sourced
      // rows carry the repo file path of every existing post, so a new post lands where the
      // site's build actually reads (e.g. lyf-fit = content/posts/*.mdx, not a guessed
      // content/blog/*.md). Fail-open to the generic default when the index has no repo rows.
      let postSlug;
      try {
        postSlug = draftPublicationSlug(post);
      } catch {
        return apiError('draft_publication_slug_invalid', 'The approved publication path is invalid', 409, cors);
      }
      if (!postSlug) postSlug = `post-${postId.slice(0, 8).toLowerCase()}`;
      let path = String(body?.path || '').trim();
      if (path && !publicationPathMatchesSlug(path, postSlug)) {
        return apiError(
          'publication_target_mismatch',
          'The requested file path does not match the approved publication slug',
          409,
          cors,
        );
      }
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
        let id;
        try { id = decodeAutoId(url.pathname.slice('/api/drafts/'.length), 'draft'); }
        catch { return json({ error: 'Invalid draft id' }, 400, cors); }

        const existing = await getPost(env, id);
        if (!existing || existing.uid !== env.OWNER_UID) return json({ error: 'Draft not found' }, 404, cors);

        if (request.method === 'GET') {
          return json({ draft: await versionDraftMedia(publicOrigin, existing, legacyOrigins) }, 200, cors);
        }

        if (request.method === 'DELETE') {
          await deletePost(env, id);
          return json({ deleted: id }, 200, cors);
        }

        if (request.method === 'PATCH') {
          let body;
          try { body = await parseJson(request, IMAGE_JSON_BYTES); } catch (err) { return jsonBodyError(err, cors); }
          // Every internal caller must bind its update to the tenant + approved
          // payload it actually rendered. A missing baseline is not equivalent
          // to "latest"; callers GET/list the draft first and receive both
          // revisions. Review verbs additionally bind current review/history so
          // two reviewer/operator actions cannot silently last-write each other.
          if (typeof body.baseClientId !== 'string'
            || typeof body.basePayloadRevision !== 'string'
            || !/^[a-f0-9]{64}$/.test(body.basePayloadRevision)) {
            return apiError(
              'review_baseline_required',
              'baseClientId and basePayloadRevision from the latest draft are required',
              428,
              cors,
            );
          }
          try {
            await assertDraftBaseline(publicOrigin, existing, {
              clientId: body.baseClientId,
              payloadRevision: body.basePayloadRevision,
            }, legacyOrigins);
          } catch {
            return apiError('review_conflict', 'Draft tenant or content changed; reload before updating', 409, cors);
          }
          const fields = {};
          const hasPlatform = Object.prototype.hasOwnProperty.call(body, 'platform');
          let nextPlatform = existing.platform;
          if (hasPlatform) {
            if (typeof body.platform !== 'string'
              || !Object.prototype.hasOwnProperty.call(PLATFORM_MAX, body.platform)) {
              return json({ error: `Unknown platform '${String(body.platform)}'` }, 400, cors);
            }
            nextPlatform = body.platform;
            fields.platform = body.platform;
          }
          const max = rawIntakeCap(nextPlatform);
          if (typeof body.content === 'string') {
            fields.content = versionMediaMarkdownReferences(publicOrigin, body.content.trim().slice(0, max), legacyOrigins);
          } else if (hasPlatform && String(existing.content || '').length > max) {
            return json({ error: `Existing content exceeds the ${nextPlatform} intake limit; update content with platform` }, 400, cors);
          }
          if (typeof body.title === 'string') fields.title = body.title.trim().slice(0, 200);
          if (typeof body.altText === 'string') fields.altText = body.altText.trim().slice(0, 300);
          if (typeof body.metaDescription === 'string') fields.metaDescription = body.metaDescription.trim().slice(0, 200);
          if (Object.prototype.hasOwnProperty.call(body, 'slug')) {
            if (typeof body.slug !== 'string') {
              return json({ error: 'slug must be a string' }, 400, cors);
            }
            const slug = body.slug.trim();
            if (slug && (slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) {
              return json({ error: 'slug must be empty or a canonical lowercase publication path (max 80 characters)' }, 400, cors);
            }
            fields.slug = slug;
          }
          if (Array.isArray(body.tags)) fields.tags = body.tags.slice(0, 10).map(t => String(t).trim().slice(0, 20)).filter(Boolean);
          if (body.scheduledDate === null || typeof body.scheduledDate === 'string') {
            fields.scheduledDate = body.scheduledDate ? String(body.scheduledDate).slice(0, 40) : null;
          }
          const hasStatus = ['draft', 'scheduled', 'posted', 'archived'].includes(body.status);
          const hasReviewStage = ['private', 'in_review'].includes(body.reviewStage);
          // Staging axis (src/utils/review.js): 'private' keeps the draft off the client's
          // review link, 'in_review' publishes it there. Sending also (re)arms the round —
          // an undecided draft goes back to pending and gets a fresh sentForReviewAt, so
          // POM's "waiting N days" is measured from the send, not from creation. An already
          // APPROVED draft keeps its approval: that was the client's decision, not ours.
          // sentForReviewAt/pending are derived from the LIVE draft inside the
          // compare-and-swap builder, never from this potentially stale read.
          // Review verbs (POM's Content card via the feedback-worker broker): approvalStatus
          // transitions with an optional reviewer note. The note is appended SERVER-SIDE and
          // in the same update-time-precondition commit so a concurrent in-app / guest note on the
          // same draft is never clobbered by a snapshot rebuild. Shape mirrors the
          // UI's request-changes entries ({text, by, at}), so POM feedback renders like in-app feedback.
          const hasApproval = body.approvalStatus !== undefined;
          let feedback = '';
          if (hasApproval) {
            if (!['pending', 'approved', 'changes_requested'].includes(body.approvalStatus)) {
              return json({ error: `Unknown approvalStatus '${body.approvalStatus}'` }, 400, cors);
            }
            feedback = typeof body.feedback === 'string' ? body.feedback : '';
            if (body.approvalStatus === 'changes_requested'
              && (!feedback.trim() || feedback.length > 500)) {
              return apiError(
                'feedback_invalid',
                'feedback must contain text and be no more than 500 characters when requesting changes',
                400,
                cors,
              );
            }
            if (hasStatus && !(body.approvalStatus === 'approved' && body.status === 'scheduled')) {
              return apiError(
                'mixed_review_edit',
                'A review action may change status only when approval advances draft to scheduled',
                400,
                cors,
              );
            }
            if (hasReviewStage && body.reviewStage !== 'in_review') {
              return apiError(
                'mixed_review_edit',
                'Approval/resubmit actions cannot move a draft to private staging',
                400,
                cors,
              );
            }
          }
          const isReviewIntent = hasApproval || hasReviewStage;
          const reviewAction = hasApproval
            ? body.approvalStatus === 'approved' ? 'approve'
              : body.approvalStatus === 'changes_requested' ? 'request_changes'
                : 'resubmit'
            : hasReviewStage
              ? body.reviewStage === 'in_review' ? 'send' : 'hold'
              : '';
          try {
            assertIsolatedDraftReviewIntent(body, { hasApproval, hasReviewStage, hasStatus });
          } catch (err) {
            return apiError(err?.code || 'mixed_review_edit', err.message, err?.status || 400, cors);
          }
          if (isReviewIntent && (typeof body.baseReviewRevision !== 'string'
            || !/^[a-f0-9]{64}$/.test(body.baseReviewRevision))) {
            return apiError(
              'review_baseline_required',
              'baseReviewRevision from the latest draft is required for review actions',
              428,
              cors,
            );
          }
          if (isReviewIntent) {
            try {
              await assertDraftBaseline(publicOrigin, existing, {
                clientId: body.baseClientId,
                payloadRevision: body.basePayloadRevision,
                reviewRevision: body.baseReviewRevision,
              }, legacyOrigins, { review: true });
            } catch {
              return apiError('review_conflict', 'Draft review state changed; reload before acting', 409, cors);
            }
          }

          let migratedImageFrom = '';
          const imageInput = body.image || (typeof body.imageUrl === 'string' && body.imageUrl.startsWith('data:')
            ? { base64: body.imageUrl }
            : null);
          if (imageInput && sameLegacyImageBytes(existing.imageUrl, imageInput)) {
            migratedImageFrom = existing.imageUrl;
          }
          if (body.image) {
            try {
              // Thread the DRAFT's own tenant slug into the image generation for usage metering —
              // server-resolved, overriding any caller-supplied image.clientId (never trust raw input).
              const u = await resolveDraftImage(env, publicOrigin, { ...body.image, clientId: existing.clientId || undefined }, legacyOrigins);
              if (u) fields.imageUrl = versionMediaReference(publicOrigin, u, legacyOrigins).slice(0, 2000);
            } catch (err) {
              const aiResponse = generationErrorResponse(err, cors, 'draft patch image');
              if (aiResponse) return aiResponse;
              if (err?.code === 'image_too_large') return json({ error: err.message }, 413, cors);
              if (err?.code === 'unsupported_image') {
                return json({ error: 'Only valid JPEG, PNG, WebP, or GIF image bytes are accepted' }, 415, cors);
              }
              console.error('Patch image failed:', err?.message || err);
              return json({ error: 'Image processing failed' }, 502, cors);
            }
          } else if (typeof body.imageUrl === 'string') {
            try {
              const u = body.imageUrl.startsWith('data:')
                ? await resolveDraftImage(env, publicOrigin, { base64: body.imageUrl, clientId: existing.clientId || undefined }, legacyOrigins)
                : versionMediaReference(publicOrigin, body.imageUrl, legacyOrigins);
              fields.imageUrl = u ? u.slice(0, 2000) : '';
            } catch (err) {
              if (err?.code === 'image_too_large') return json({ error: err.message }, 413, cors);
              if (err?.code === 'unsupported_image') return json({ error: 'Only valid JPEG, PNG, WebP, or GIF image bytes are accepted' }, 415, cors);
              console.error('Patch image failed:', err?.message || err);
              return json({ error: 'Image processing failed' }, 502, cors);
            }
          }
          if (!Object.keys(fields).length && !hasStatus && !hasReviewStage && !hasApproval) {
            return json({ error: 'No updatable fields provided' }, 400, cors);
          }

          const intent = {
            fields,
            hasStatus,
            status: body.status,
            baseStatus: existing.status,
            hasReviewStage,
            reviewStage: body.reviewStage,
            hasApproval,
            approvalStatus: body.approvalStatus,
            feedback,
            reviewedBy: body.reviewedBy === 'client' ? 'client' : 'you',
            migratedImageFrom,
            baseClientId: body.baseClientId,
            basePayloadRevision: body.basePayloadRevision,
            baseReviewRevision: isReviewIntent ? body.baseReviewRevision : '',
            isReviewIntent,
            reviewAction,
          };
          try {
            const result = await mutatePostAtomically(env, id, async (live) => {
              if (live.uid !== env.OWNER_UID) {
                const err = new Error('Draft not found');
                err.status = 404;
                throw err;
              }
              await assertDraftBaseline(publicOrigin, live, {
                clientId: intent.baseClientId,
                payloadRevision: intent.basePayloadRevision,
                reviewRevision: intent.baseReviewRevision,
              }, legacyOrigins, { review: intent.isReviewIntent });
              return buildDraftMutation(publicOrigin, live, intent, Date.now(), legacyOrigins);
            });
            return json({ draft: await versionDraftMedia(publicOrigin, result.document, legacyOrigins) }, 200, cors);
          } catch (err) {
            console.error('Draft update failed:', err?.message || err);
            if (err?.status === 404 || err?.code === 'not_found') return json({ error: 'Draft not found' }, 404, cors);
            if (err?.code === 'feedback_thread_full') {
              return apiError('feedback_thread_full', 'Feedback history is full', 409, cors);
            }
            if (err?.code === 'feedback_invalid') {
              return apiError(
                'feedback_invalid',
                'feedback must contain text and be no more than 500 characters when requesting changes',
                400,
                cors,
              );
            }
            if (err?.code === 'feedback_thread_invalid') {
              return apiError(
                'feedback_thread_invalid',
                'Feedback history needs repair before another note can be added',
                409,
                cors,
              );
            }
            if (err?.code === 'review_conflict') {
              return apiError(
                'review_conflict',
                'Draft tenant, content, or review state changed; reload before updating',
                409,
                cors,
              );
            }
            if (err?.code === 'update_conflict') {
              return apiError('update_conflict', 'Draft changed concurrently; retry the update', 409, cors);
            }
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
          const q = url.searchParams;
          const rawLimit = q.get('limit') || '300';
          if (!/^\d{1,4}$/.test(rawLimit)) return json({ error: 'limit must be an integer from 1 to 1000' }, 400, cors);
          const reqLimit = Number(rawLimit);
          if (reqLimit < 1 || reqLimit > 1000) return json({ error: 'limit must be an integer from 1 to 1000' }, 400, cors);

          const rawClient = q.get('client');
          const fc = rawClient === null ? null : rawClient.trim();
          const fcid = (q.get('clientId') || '').trim();
          const fp = (q.get('platform') || '').trim();
          const fst = (q.get('status') || '').trim();
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
          if (fcid && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fcid) || fcid.length > 64)) {
            return json({ error: 'clientId must be a canonical client slug' }, 400, cors);
          }
          if (!fcid && fc !== null && (!fc || fc.length > 50)) {
            return json({ error: 'client must be 1 to 50 characters' }, 400, cors);
          }
          if (fp && !Object.prototype.hasOwnProperty.call(PLATFORM_MAX, fp)) {
            return json({ error: `Unknown platform '${fp}'` }, 400, cors);
          }
          if (fst && !['draft', 'scheduled', 'posted', 'archived'].includes(fst)) {
            return json({ error: `Unknown status '${fst}'` }, 400, cors);
          }
          if (frs && !['private', 'in_review'].includes(frs)) {
            return json({ error: `Unknown reviewStage '${frs}'` }, 400, cors);
          }

          const filters = {
            ...(fcid ? { clientId: fcid } : (fc ? { client: fc } : {})),
            ...(fp ? { platform: fp } : {}),
            ...(fst ? { status: fst } : {}),
            ...(frs ? { reviewStage: frs } : {}),
          };
          const filterKey = JSON.stringify(filters);
          let cursorId = '';
          let cursorUpdatedAt = '';
          let cursorSeen = 0;
          let cursorReadTime = '';
          if (q.has('cursor')) {
            try {
              const cursor = decodeDraftCursor(q.get('cursor'), filterKey);
              cursorId = cursor.id;
              cursorUpdatedAt = cursor.updatedAt;
              cursorSeen = cursor.seen;
              cursorReadTime = cursor.readTime;
            }
            catch {
              return apiError('draft_cursor_invalid', 'Invalid or mismatched draft cursor', 400, cors);
            }
          }

          const page = await listDraftPage(env, env.OWNER_UID, {
            filters,
            cursorId,
            cursorUpdatedAt,
            cursorSeen,
            readTime: cursorReadTime,
            limit: reqLimit,
            transformRow: (draft) => versionDraftMedia(publicOrigin, draft, legacyOrigins),
          });
          const nextCursor = page.truncated
            ? encodeDraftCursor(page.nextId, page.nextUpdatedAt, page.seen, filterKey, page.readTime)
            : null;
          const responseBody = draftListResponseBody(page, nextCursor);
          if (serializedJsonBytes(responseBody) > DRAFT_PAGE_MAX_BYTES) {
            throw Object.assign(new Error('Final draft response exceeded its serialized byte limit'), {
              code: 'draft_response_too_large',
            });
          }
          return json(responseBody, 200, cors);
        } catch (err) {
          console.error('Draft list failed:', err?.message || err);
          if (err?.code === 'draft_row_too_large') {
            return apiError(
              'draft_row_too_large',
              'A draft is too large to return within the response limit; quarantine or repair it before retrying',
              413,
              cors,
            );
          }
          if (err?.code === 'invalid_document_id') {
            return apiError('draft_cursor_invalid', 'Invalid or mismatched draft cursor', 400, cors);
          }
          return apiError('draft_list_failed', 'Draft list could not be produced safely', 502, cors);
        }
      }

      if (request.method === 'POST') {
        let body;
        try { body = await parseJson(request, IMAGE_JSON_BYTES); } catch (err) { return jsonBodyError(err, cors); }

        const platform = String(body?.platform || 'gmb');
        // Own-property check, not `in` (which walks the prototype chain — 'constructor'/'toString'/… would
        // wrongly validate and let a junk platform through). PLATFORM_MAX is a plain object literal.
        if (!Object.prototype.hasOwnProperty.call(PLATFORM_MAX, platform)) return json({ error: `Unknown platform '${platform}'` }, 400, cors);

        const content = versionMediaMarkdownReferences(
          publicOrigin,
          (body?.content || '').toString().trim().slice(0, rawIntakeCap(platform)),
          legacyOrigins,
        );
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
          imageUrl = (await resolveDraftImage(env, publicOrigin, body?.image ? { ...body.image, clientId: clientId || undefined } : null, legacyOrigins)) || '';
        } catch (err) {
          const aiResponse = generationErrorResponse(err, cors, 'draft create image');
          if (aiResponse) return aiResponse;
          if (err?.code === 'image_too_large') return json({ error: err.message }, 413, cors);
          if (err?.code === 'unsupported_image') {
            return json({ error: 'Only valid JPEG, PNG, WebP, or GIF image bytes are accepted' }, 415, cors);
          }
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
          // Do not return the retired anonymous ?uid=&client= review URL. Review
          // access exists only after the operator deliberately creates a
          // tokenized share link through /api/share.
          return json({ id, status: 'draft' }, 201, cors);
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
        try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors); }
        let token;
        try { token = requireShareToken(String(body?.token || '').trim()); }
        catch { return json({ error: 'valid token is required' }, 400, cors); }

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
        let token;
        try { token = decodeShareToken(url.pathname.slice('/api/share/'.length)); }
        catch { return json({ error: 'Invalid share token' }, 400, cors); }
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
        try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors); }
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
        let id;
        try { id = decodeAutoId(isRun ? rest.slice(0, -'/run'.length) : rest, 'automation'); }
        catch { return json({ error: 'Invalid automation id' }, 400, cors); }

        const existing = await getAutomation(env, id);
        if (!existing || existing.ownerUid !== env.OWNER_UID) return json({ error: 'Automation not found' }, 404, cors);

        // POST /api/automations/:id/run — generate one draft now (preview).
        // Records the run but deliberately does NOT advance nextRunAt.
        if (isRun) {
          if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
          try {
            // Separate budget principal so manual previews can't drain the cron's daily budget.
            const result = await generateForAutomation(env, publicOrigin, existing, 'automation:preview');
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
            if (err?.budgetExhausted) return json({ error: err.message }, 429, cors);
            const aiResponse = generationErrorResponse(err, cors, 'automation preview');
            if (aiResponse) return aiResponse;
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
          try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors); }
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
        try { body = await parseJson(request); } catch (err) { return jsonBodyError(err, cors); }

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

        // Caps protect the owner's shared AI budget and keep the dashboard sane.
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
      // v2 is a cache-key break. Old /media/<key> responses were browser-immutable
      // for one year, so changing origin logic cannot revoke an already-fresh
      // browser copy. Cache misses on the old route redirect without caching; the
      // rollout runbook proves edge-cache applicability (zero-cache today, purge
      // if that ever changes) and records the browser residual. New app reads
      // rewrite stored legacy refs to this v2 URL.
      const v2Prefix = '/media/v2/';
      const isV2 = url.pathname === '/media/v2' || url.pathname.startsWith(v2Prefix);
      const encodedKey = url.pathname === '/media/v2'
        ? ''
        : url.pathname.slice((isV2 ? v2Prefix : '/media/').length);
      let key;
      try { key = decodeURIComponent(encodedKey); }
      catch { return json({ error: 'Malformed media key' }, 400, cors); }
      if (!key) return json({ error: 'Missing media key' }, 400, cors);

      if (!isV2) {
        const headers = applySecurityHeaders(new Headers(cors));
        headers.set('Location', mediaUrl(publicOrigin, key));
        headers.set('Cache-Control', 'no-store');
        return new Response(null, { status: 308, headers });
      }

      const isHead = request.method === 'HEAD';
      const obj = isHead ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
      if (!obj) {
        const headers = applySecurityHeaders(new Headers(cors));
        return new Response(null, { status: 404, headers });
      }
      const headers = new Headers(cors);
      obj.writeHttpMetadata(headers);
      let body = null;
      let safeInline = false;

      if (isHead) {
        // HEAD has no bytes to inspect. Old Content-Type metadata is untrusted;
        // only objects written through the new byte gate carry this validation
        // stamp. Every legacy HEAD is attachment/no-store until it is audited
        // and deliberately rewritten through a validated ingestion path.
        const custom = obj.customMetadata || {};
        const canonical = String(custom.rasterMime || '').toLowerCase();
        safeInline = custom.rasterValidated === RASTER_VALIDATION_VERSION
          && (!Number.isFinite(obj.size) || obj.size <= MAX_IMAGE_BYTES)
          && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(canonical);
        if (safeInline) headers.set('Content-Type', canonical);
      } else {
        // Re-inspect legacy objects on read too. That protects objects written
        // before this gate, including HTML stored under a forged image MIME.
        if (Number.isFinite(obj.size) && obj.size > MAX_IMAGE_BYTES) {
          // Do not allocate a legacy oversize object merely to classify it. It
          // remains retrievable as a no-store attachment for audit/remediation.
          body = obj.body;
        } else {
          let bytes;
          try {
            bytes = await readBytesBounded(
              obj.body,
              Number.isFinite(obj.size) ? new Headers({ 'Content-Length': String(obj.size) }) : new Headers(),
              MAX_IMAGE_BYTES,
            );
          } catch (err) {
            if (err instanceof BodyTooLargeError) return json({ error: 'Stored media exceeds the safe read limit' }, 413, cors);
            throw err;
          }
          body = bytes;
          try {
            // Reads classify solely from bytes. A stale/wrong legacy R2 MIME must
            // not hide an otherwise valid raster; claim matching remains strict
            // on every WRITE, where the claim is supplied by the caller/upstream.
            const raster = inspectRasterImage(bytes);
            headers.set('Content-Type', raster.mime);
            safeInline = true;
          } catch {
            safeInline = false;
          }
        }
      }

      if (safeInline) {
        // Stored metadata may also carry a stale attachment disposition. Once
        // bytes (GET) or the new validation stamp (HEAD) prove this is a raster,
        // remove it so the canonical inline response cannot inherit that claim.
        headers.delete('Content-Disposition');
        headers.delete('Content-Encoding');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else forceMediaDownload(headers, key);
      applySecurityHeaders(headers);
      // Conditional-request support: keys are content-addressed/immutable, so a
      // revalidating client gets a bodyless 304 instead of a full R2 read-through.
      headers.set('ETag', obj.httpEtag);
      if (safeInline && request.headers.get('If-None-Match') === obj.httpEtag) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(body, { headers });
    }

    // --- Everything else: the SPA / static assets ---
      return await serveSpaAsset(request, env);
    } catch (err) {
      // One final boundary for dependencies and static assets. Individual
      // routes still map expected errors precisely; an unexpected throw must
      // not fall through to Cloudflare's unhashed/un-CORSed default 500 page.
      console.error('Unhandled Worker request failure:', err?.message || err);
      return json({ error: 'Internal server error' }, 500, cors);
    }
  },

  // Cron triggers (see wrangler.toml [triggers]). Each cron expression fires its
  // OWN scheduled event, so we branch on event.cron: the nightly "0 4 * * *"
  // runs the orphan-image sweep; the frequent tick runs due content automations.
  async scheduled(event, env, ctx) {
    if (event.cron === '0 4 * * *') {
      ctx.waitUntil(runGC(env));
    } else {
      const { publicOrigin } = mediaOriginConfig(env);
      ctx.waitUntil(runDueAutomations(env, publicOrigin));
    }
  }
};
