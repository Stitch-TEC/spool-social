#!/usr/bin/env node
// =============================================================================
// Spool admin CLI — RBAC bootstrap, clientId backfill, and orphan audit.
//
// Zero dependencies: Node 18+ built-in `fetch` + `node:crypto`. Talks to the
// Firestore REST API with a service-account JWT, mirroring worker/firestore.js.
// Service-account access BYPASSES security rules — that is exactly why the very
// first super_admin doc can be created here before the new rules are live.
//
// SETUP — get a service-account key (you already use one as the Worker's
//   FIREBASE_SERVICE_ACCOUNT secret; download a fresh one if you don't have the
//   file locally): Firebase console → Project settings → Service accounts →
//   "Generate new private key". Save it OUTSIDE the repo (it is a secret).
//
// AUTH — provide the key via any one of:
//   --key /path/to/service-account.json
//   FIREBASE_SERVICE_ACCOUNT_FILE=/path/...    (or GOOGLE_APPLICATION_CREDENTIALS)
//   FIREBASE_SERVICE_ACCOUNT='{...json...}'    (inline, same as the Worker secret)
//
// INITIAL RBAC ORDER (see RBAC_DEPLOY_RUNBOOK.md):
//   1) node scripts/admin.mjs bootstrap --email dillon@stitchtec.dev --key sa.json
//   2) firebase deploy --only firestore:rules
//   3) node scripts/admin.mjs backfill --key sa.json            # dry-run, review
//      node scripts/admin.mjs backfill --key sa.json --apply
//   4) node scripts/admin.mjs audit --key sa.json               # must be clean
//   5) provision client users (bootstrap-style writes, role client/client_admin)
//
// REVIEW-STAGE SECURITY REVISION (see REVIEW_STAGE_ROLLOUT.md; do not reorder):
//   1) id-inventory MUST be clean while OLD app/rules are live
//   2) review-stage/order dry-run → --apply → audit while OLD app/rules are live;
//      all three require the same canonical roster snapshot
//   3) deploy firestore.indexes.json and wait until the ordered-post index is READY
//   4) freeze review actions; deploy feedback-worker → POM → final Spool
//   5) immediately deploy firestore.rules; verify contract/access, then R2/cache
//
// COMMANDS
//   bootstrap --email <e> [--role super_admin] [--client-id <id>] [--force]
//   grant     --email <e> --role <client|client_admin|super_admin> [--client-id <id>] [--force]
//   backfill  [--apply] [--map map.json]      # add clientId to posts + clients
//   id-inventory                              # strict post/automation/share id rollout gate
//   review-stage [--apply] [--roster <clients.json> | --context-key <key>]
//                                              # missing stages + canonical updatedAt ordering key
//   restamp   [--apply] [--roster <clients.json> | --context-key <key> [--roster-url <url>]]
//                                              # repair posts/branding/automations/shares to canonical roster slugs
//   audit     [--roster <clients.json> | --context-key <key>]
//                                              # fail-closed roster/owner/stage/order/slug audit
//
// FLAGS (global): --key <path> --project <id> --owner-uid <uid>
// =============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  auditWorkspace,
  buildRosterRepairMap,
  classifyPostRows,
  fieldString,
  listAllDocuments,
  parseRosterSnapshot,
  requestJsonObject,
  reviewStageBackfillPlan,
  rosterClaimAudit,
  stringClaimAudit,
} from './adminCore.mjs';

// ----- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const bools = new Set(['apply', 'force']);
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  if (bools.has(key)) { flags[key] = true; continue; }
  flags[key] = argv[++i];
}

const OWNER_UID = flags['owner-uid'] || process.env.OWNER_UID || 'sLcLtGsm9SOKkR82a6cDoLCOOVO2';
const VALID_ROLES = new Set(['super_admin', 'client_admin', 'client']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIRESTORE_AUTO_ID_RE = /^[A-Za-z0-9]{20}$/;
const SHARE_TOKEN_RE = /^[a-f0-9]{64}$/;

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
const slugify = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); // 64 = POM canonical cap (see src/config/roles.js)

// ----- service account / token ----------------------------------------------
function loadSA() {
  const path = flags.key || process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let raw;
  if (path) {
    try { raw = fs.readFileSync(path, 'utf8'); } catch { die(`Cannot read service-account key at ${path}`); }
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  } else {
    die('No service-account key. Pass --key <path>, or set FIREBASE_SERVICE_ACCOUNT_FILE / GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT.');
  }
  let sa;
  try { sa = JSON.parse(raw); } catch { die('Service-account key is not valid JSON.'); }
  const privateKey = (sa.private_key || '').replace(/\\n/g, '\n');
  if (!sa.client_email || !privateKey) die('Service-account key missing client_email / private_key.');
  return { clientEmail: sa.client_email, privateKey, projectId: sa.project_id };
}

// Loaded lazily (ensureSA) so `--help` / unknown commands don't demand a key.
let sa, PROJECT_ID, BASE;
function ensureSA() {
  if (sa) return;
  sa = loadSA();
  PROJECT_ID = flags.project || process.env.FIREBASE_PROJECT_ID || sa.projectId || 'spool-social';
  BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');

let tokenCache = { exp: 0, token: null };
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && now < tokenCache.exp - 60) return tokenCache.token;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.privateKey).toString('base64url');
  const jwt = `${unsigned}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) die(data.error_description || `OAuth token exchange failed (${res.status})`);
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

// ----- Firestore REST helpers ------------------------------------------------
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
    else fields[k] = { stringValue: String(v) };
  }
  return fields;
}
const str = (f) => (f && 'stringValue' in f ? f.stringValue : undefined);

async function api(method, urlPath, body) {
  const token = await accessToken();
  const url = urlPath.startsWith('http') ? urlPath : `${BASE}/${urlPath}`;
  return requestJsonObject({
    fetchImpl: fetch,
    url,
    init: {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    context: `${method} ${urlPath}`,
  });
}

// List every doc in a collection, fetching only `fields` (mask). Paginates fully.
async function listAll(collection, fields) {
  return listAllDocuments({
    collection,
    fields,
    fetchPage: (path) => api('GET', path),
  });
}

// The hardened Worker accepts only the IDs its own SDK/token generators mint.
// Inventory all legacy rows before deploying that boundary so an old custom ID
// cannot silently become unreachable through the API. Share IDs are bearer
// credentials, so reports show only a short suffix.
async function collectStrictIdInventory(posts) {
  // IDs live in resource names; project one tiny ownership field so the gate
  // never downloads full post bodies or feedback histories just to inspect IDs.
  const postRows = posts || await listAll('posts', ['uid']);
  // Empty/missing collections naturally list as an empty page. Any actual API,
  // auth, or decoding failure is a rollout-blocking unknown—not an empty set.
  const automations = await listAll('automations', ['ownerUid', 'client', 'clientId']);
  const shares = await listAll('shares', ['ownerUid', 'client', 'clientId']);
  return {
    posts: postRows,
    automations,
    shares,
    invalidPosts: postRows.filter((row) => !FIRESTORE_AUTO_ID_RE.test(row.id)),
    invalidAutomations: automations.filter((row) => !FIRESTORE_AUTO_ID_RE.test(row.id)),
    invalidShares: shares.filter((row) => !SHARE_TOKEN_RE.test(row.id)),
  };
}

function reportStrictIdInventory(inventory) {
  const { posts, automations, shares, invalidPosts, invalidAutomations, invalidShares } = inventory;
  console.log('Strict ID inventory (required before hardened Worker rollout):');
  console.log(`   posts .............. ${posts.length} (${invalidPosts.length} incompatible)`);
  console.log(`   automations ........ ${automations.length} (${invalidAutomations.length} incompatible)`);
  console.log(`   shares ............. ${shares.length} (${invalidShares.length} incompatible)`);
  for (const row of invalidPosts.slice(0, 20)) console.log(`     incompatible post id: ${JSON.stringify(row.id)}`);
  for (const row of invalidAutomations.slice(0, 20)) console.log(`     incompatible automation id: ${JSON.stringify(row.id)}`);
  for (const row of invalidShares.slice(0, 20)) console.log(`     incompatible share id: …${row.id.slice(-8)}`);
  return invalidPosts.length + invalidAutomations.length + invalidShares.length;
}

async function cmdIdInventory() {
  console.log('\nStrict ID inventory for the configured Firebase project\n');
  const incompatible = reportStrictIdInventory(await collectStrictIdInventory());
  if (incompatible) {
    die(`Found ${incompatible} legacy id${incompatible === 1 ? '' : 's'} incompatible with the strict Worker boundary. Stop rollout and migrate/re-issue deliberately; do not deploy the hardened validator yet.`);
  }
  console.log('\n✓ Every post/automation/share id is compatible with the strict Worker boundary.\n');
}

// Every inventory-derived repair is update-time guarded. Service-account REST
// bypasses rules, so an omitted CAS would silently merge over a concurrent edit.
async function patchFields(resourceName, values, updateTime) {
  if (typeof updateTime !== 'string' || !updateTime) {
    throw new Error(`Missing updateTime for ${resourceName}; refusing an unguarded repair`);
  }
  const fields = Object.keys(values);
  if (!fields.length) return;
  const params = new URLSearchParams();
  for (const field of fields) params.append('updateMask.fieldPaths', field);
  params.set('currentDocument.updateTime', updateTime);
  await api('PATCH', `https://firestore.googleapis.com/v1/${resourceName}?${params}`,
    { fields: toFields(values) });
}

async function patchField(resourceName, field, value, updateTime) {
  return patchFields(resourceName, { [field]: value }, updateTime);
}

// ----- commands --------------------------------------------------------------
async function cmdGrant({ defaultRole }) {
  const email = String(flags.email || '').toLowerCase().trim();
  const role = String(flags.role || defaultRole || '').trim();
  const clientId = flags['client-id'] ? slugify(flags['client-id']) : undefined;

  if (!EMAIL_RE.test(email)) die(`Invalid email: ${flags.email}`);
  if (!VALID_ROLES.has(role)) die(`Invalid role "${role}". One of: ${[...VALID_ROLES].join(', ')}`);
  if ((role === 'client' || role === 'client_admin') && !clientId) die(`Role "${role}" requires --client-id <slug>.`);
  if (role === 'super_admin' && clientId) console.warn('• Note: --client-id is ignored for super_admin.');

  const docPath = `users/${encodeURIComponent(email)}`;
  const existing = await api('GET', docPath);
  if (existing._status !== 404 && !flags.force) {
    const cur = existing.fields || {};
    die(`users/${email} already exists (roles=${JSON.stringify((cur.roles?.arrayValue?.values || []).map((v) => v.stringValue))}, clientId=${str(cur.clientId) ?? '—'}). Re-run with --force to overwrite.`);
  }

  const payload = { roles: [role], email, updatedAt: new Date().toISOString(), source: 'admin-cli' };
  if (role !== 'super_admin') payload.clientId = clientId;

  await api('PATCH', docPath, { fields: toFields(payload) });
  console.log(`\n✓ ${existing._status === 404 ? 'Created' : 'Updated'} users/${email}`);
  console.log(`   roles: [${role}]${payload.clientId ? `   clientId: ${payload.clientId}` : ''}`);
  if (role === 'super_admin') console.log('   → This account now passes isSuperAdmin() once the new rules are deployed.');
  console.log('');
}

// Build the client-name → clientId map from the union of post.client and
// clients.name, slugified, with optional --map overrides. Returns { map, collisions }.
function buildClientMap(names) {
  const override = flags.map ? JSON.parse(fs.readFileSync(flags.map, 'utf8')) : {};
  const map = {};
  const slugToNames = {};
  for (const name of names) {
    const slug = override[name] ? slugify(override[name]) : slugify(name);
    map[name] = slug;
    (slugToNames[slug] ||= []).push(name);
  }
  const collisions = Object.entries(slugToNames).filter(([, ns]) => ns.length > 1);
  return { map, collisions, override };
}

async function cmdBackfill() {
  console.log(`\nProject: ${PROJECT_ID}   OWNER_UID: ${OWNER_UID}   mode: ${flags.apply ? 'APPLY' : 'dry-run'}\n`);
  const posts = await listAll('posts', ['client', 'clientId', 'uid', 'source', 'forClientId', 'reviewStage']);
  const clients = await listAll('clients', ['name', 'clientId', 'uid']);
  const { ordinaryPosts, suggestions, malformedSources, unsafeSuggestionTenants } = classifyPostRows(posts);

  const names = new Set();
  for (const p of ordinaryPosts) { const c = str(p.fields.client); if (c) names.add(c); }
  for (const c of clients) { const n = str(c.fields.name); if (n) names.add(n); }

  const { map, collisions, override } = buildClientMap([...names]);

  // Report the effective mapping.
  console.log('Client name → clientId:');
  for (const [name, slug] of Object.entries(map).sort()) {
    const fromPosts = ordinaryPosts.filter((p) => str(p.fields.client) === name).length;
    console.log(`   ${JSON.stringify(name).padEnd(28)} → ${slug.padEnd(24)} (${fromPosts} posts)${override[name] ? '  [override]' : ''}`);
  }

  const orphanPosts = ordinaryPosts.filter((p) => !str(p.fields.client));
  const uidAnomalies = posts.filter((p) => str(p.fields.uid) && str(p.fields.uid) !== OWNER_UID);
  const postsToFill = ordinaryPosts.filter((p) => str(p.fields.client) && !str(p.fields.clientId));
  const postsHave = ordinaryPosts.filter((p) => str(p.fields.clientId)).length;
  const clientsToFill = clients.filter((c) => str(c.fields.name) && !str(c.fields.clientId));
  const suggestionTenantClaims = unsafeSuggestionTenants;

  console.log('\nSummary:');
  console.log(`   posts total ............ ${posts.length}`);
  console.log(`   ordinary posts ......... ${ordinaryPosts.length}`);
  console.log(`   suggestions (never fill) ${suggestions.length}`);
  console.log(`   posts already w/ clientId ${postsHave}`);
  console.log(`   posts to backfill ...... ${postsToFill.length}`);
  console.log(`   posts with NO client ... ${orphanPosts.length}  ${orphanPosts.length ? '⚠ cannot map → would be invisible to client users' : ''}`);
  console.log(`   uid != OWNER_UID ....... ${uidAnomalies.length}  ${uidAnomalies.length ? '⚠ unexpected owner — investigate before client logins' : ''}`);
  console.log(`   clients docs ........... ${clients.length} (${clientsToFill.length} to backfill)`);
  console.log(`   suggestions w/ clientId  ${suggestionTenantClaims.length}  ${suggestionTenantClaims.length ? '⚠ must remain empty/private' : ''}`);
  console.log(`   malformed source fields  ${malformedSources.length}  ${malformedSources.length ? '⚠ cannot classify safely' : ''}`);

  if (collisions.length) {
    console.log('\n⚠ SLUG COLLISIONS — distinct names map to the same clientId:');
    for (const [slug, ns] of collisions) console.log(`   ${slug}: ${ns.map((n) => JSON.stringify(n)).join(', ')}`);
    console.log('   Resolve with --map map.json ({"Client Name":"desired-slug", ...}) before applying.');
    if (flags.apply) die('Refusing to apply with unresolved slug collisions.');
  }
  if (uidAnomalies.length) {
    for (const p of uidAnomalies.slice(0, 10)) console.log(`     post ${p.id}: uid=${str(p.fields.uid)}`);
  }
  if (suggestionTenantClaims.length) {
    for (const post of suggestionTenantClaims.slice(0, 10)) {
      console.log(`     suggestion ${post.id}: clientId=${JSON.stringify(fieldString(post, 'clientId') ?? null)}`);
    }
    die('Refusing backfill while a suggestion has a non-empty/malformed clientId. Repair and audit it explicitly; backfill never makes suggestions tenant-readable.');
  }
  if (malformedSources.length) {
    die('Refusing backfill with a non-string source field: the row cannot be safely classified as an ordinary post or suggestion.');
  }

  if (!flags.apply) {
    console.log('\n(dry-run) Re-run with --apply to write clientId. Nothing was changed.\n');
    return;
  }

  console.log('\nApplying…');
  let n = 0;
  for (const p of postsToFill) {
    await patchField(p.name, 'clientId', map[str(p.fields.client)], p.updateTime);
    if (++n % 25 === 0) console.log(`   …${n}/${postsToFill.length} posts`);
  }
  let m = 0;
  for (const c of clientsToFill) {
    await patchField(c.name, 'clientId', map[str(c.fields.name)], c.updateTime);
    m++;
  }
  console.log(`\n✓ Backfilled clientId on ${n} ordinary posts and ${m} clients docs; ${suggestions.length} suggestions were left tenant-private.`);
  if (orphanPosts.length) console.log(`⚠ ${orphanPosts.length} posts have no client field and were skipped — run "audit" and fix.`);
  console.log('Next: node scripts/admin.mjs audit\n');
}

// reviewStage becomes a rules-enforced visibility boundary and updatedAt drives
// the stable newest-first API cursor. Older documents may predate either field;
// this additive backfill makes both meanings explicit before the ordered,
// stage-constrained query/rules ship.
// Every write carries the document's updateTime so a concurrent edit aborts the
// run instead of being silently merged against a stale audit snapshot.
async function cmdReviewStage() {
  console.log(`\nReview-stage inventory for the configured Firebase project; mode: ${flags.apply ? 'APPLY' : 'dry-run'}\n`);
  const incompatible = reportStrictIdInventory(await collectStrictIdInventory());
  if (incompatible) {
    die('Strict ID inventory is not clean. Stop rollout before review-stage backfill or application merge.');
  }
  console.log('');
  const roster = await loadRoster();
  const rosterIds = new Set(roster.map((client) => client.slug));
  const posts = await listAll('posts', [
    'reviewStage', 'source', 'clientId', 'forClientId', 'uid', 'updatedAt',
  ]);
  const suggestions = posts.filter((post) => fieldString(post, 'source') === 'suggestion');
  const suggestionTargets = rosterClaimAudit(suggestions, 'forClientId', rosterIds);
  const suggestionOwners = stringClaimAudit(suggestions, 'uid', OWNER_UID);
  const suggestionClientIds = suggestions.filter((post) => fieldString(post, 'clientId') !== '');
  const plan = reviewStageBackfillPlan(posts);
  const ordinaryChanges = plan.changes.filter(({ row }) => fieldString(row, 'source') !== 'suggestion');
  const suggestionChanges = plan.changes.filter(({ row }) => fieldString(row, 'source') === 'suggestion');
  const invalidSuggestionTargets = Object.values(suggestionTargets).reduce((count, rows) => count + rows.length, 0);
  const invalidSuggestionOwners = Object.values(suggestionOwners).reduce((count, rows) => count + rows.length, 0);

  console.log(`posts total ............. ${posts.length}`);
  console.log(`ordinary missing stage .. ${ordinaryChanges.length} (target: in_review)`);
  console.log(`suggestions missing stage ${suggestionChanges.length} (target: private)`);
  console.log(`invalid reviewStage ..... ${plan.invalid.length}`);
  console.log(`unsafe staged suggestions ${plan.unsafeSuggestions.length}`);
  console.log(`malformed source fields . ${plan.malformedSources.length}`);
  console.log(`invalid suggestion tenant ${suggestionClientIds.length + invalidSuggestionTargets}`);
  console.log(`invalid suggestion owner  ${invalidSuggestionOwners}`);
  console.log(`missing updatedAt ........ ${plan.updatedAtChanges.length} (target: document updateTime)`);
  console.log(`invalid updatedAt ........ ${plan.invalidUpdatedAt.length}`);
  console.log(`invalid document time .... ${plan.invalidUpdateTimes.length}`);
  if (plan.invalid.length) {
    for (const p of plan.invalid.slice(0, 20)) console.log(`   ${p.id}: ${JSON.stringify(str(p.fields.reviewStage) ?? null)}`);
    die('Refusing to guess an explicit invalid reviewStage. Correct those documents first.');
  }
  if (plan.malformedSources.length) {
    for (const post of plan.malformedSources.slice(0, 20)) console.log(`   ${post.id}: source is not a string`);
    die('A non-string source cannot be safely classified for stage backfill. Correct it explicitly first.');
  }
  if (plan.invalidUpdatedAt.length) {
    for (const post of plan.invalidUpdatedAt.slice(0, 20)) {
      console.log(`   ${post.id}: updatedAt=${JSON.stringify(fieldString(post, 'updatedAt') ?? null)}`);
    }
    die('An explicit updatedAt is not a canonical ISO millisecond string. Correct it deliberately before pagination rollout.');
  }
  if (plan.invalidUpdateTimes.length) {
    for (const post of plan.invalidUpdateTimes.slice(0, 20)) {
      console.log(`   ${post.id}: updateTime=${JSON.stringify(post.updateTime ?? null)}`);
    }
    die('A missing updatedAt cannot be derived from its Firestore updateTime. Stop rollout and repair the inventory source.');
  }
  if (plan.unsafeSuggestions.length) {
    for (const post of plan.unsafeSuggestions.slice(0, 20)) {
      console.log(`   suggestion ${post.id}: reviewStage=${JSON.stringify(fieldString(post, 'reviewStage') ?? null)}`);
    }
    die('A suggestion is already tenant-readable. Move it to private or deliberately promote it before running this migration.');
  }
  if (suggestionClientIds.length || invalidSuggestionTargets || invalidSuggestionOwners) {
    die('Suggestion ownership/tenant provenance is not clean. Empty clientId is allowed only with canonical forClientId, owner uid, and private/missing reviewStage.');
  }
  if (!flags.apply) {
    console.log('\n(dry-run) Missing stages would be classified as above; missing updatedAt values would receive their canonical Firestore updateTime. Nothing was changed.\n');
    return;
  }

  const updates = new Map();
  for (const { row: p, value } of plan.changes) {
    updates.set(p, { ...(updates.get(p) || {}), reviewStage: value });
  }
  for (const { row: p, value } of plan.updatedAtChanges) {
    updates.set(p, { ...(updates.get(p) || {}), updatedAt: value });
  }

  let applied = 0;
  let appliedFields = 0;
  for (const [p, values] of updates) {
    if (!p.updateTime) die(`Missing updateTime for posts/${p.id}; refusing an unguarded write.`);
    // Stage + ordering backfills share one updateTime precondition. Two
    // sequential patches would make the second CAS stale by construction.
    await patchFields(p.name, values, p.updateTime);
    appliedFields += Object.keys(values).length;
    if (++applied % 25 === 0) console.log(`   …${applied}/${updates.size}`);
  }

  const verify = await listAll('posts', [
    'reviewStage', 'source', 'clientId', 'forClientId', 'uid', 'updatedAt',
  ]);
  const verifyPlan = reviewStageBackfillPlan(verify);
  if (
    verifyPlan.changes.length
    || verifyPlan.invalid.length
    || verifyPlan.unsafeSuggestions.length
    || verifyPlan.malformedSources.length
    || verifyPlan.updatedAtChanges.length
    || verifyPlan.invalidUpdatedAt.length
    || verifyPlan.invalidUpdateTimes.length
  ) {
    die('Post-write audit found missing/invalid stage or updatedAt values. Do NOT deploy the app, indexes, or strict rules.');
  }
  console.log(`\n✓ Applied ${appliedFields} field backfill${appliedFields === 1 ? '' : 's'} across ${applied} post${applied === 1 ? '' : 's'} and verified all ${verify.length} stage/order values.`);
  console.log('Next: deploy the required Firestore indexes and wait until READY, then follow the frozen broker → POM → Spool → rules sequence in REVIEW_STAGE_ROLLOUT.md.\n');
}

// ----- roster (restamp) --------------------------------------------------------
// The canonical roster is the suite broker's GET /clients (feedback-worker). Load it
// from a saved JSON file (--roster; the raw response or a bare [{slug,name},…] array)
// or fetch it live with --context-key (or the CONTEXT_KEY env var).
async function loadRoster() {
  let raw;
  if (flags.roster) {
    try { raw = JSON.parse(fs.readFileSync(flags.roster, 'utf8')); }
    catch (e) { throw new Error(`Cannot read/parse roster file ${flags.roster}: ${e.message}`); }
  } else {
    const key = flags['context-key'] || process.env.CONTEXT_KEY;
    if (!key) throw new Error('This command needs the canonical roster. Pass --roster <clients.json> (a saved GET /clients response) or --context-key <CONTEXT_KEY> to fetch it from the broker.');
    const url = flags['roster-url'] || 'https://feedback.stitchtec.dev/clients';
    raw = await requestJsonObject({
      fetchImpl: fetch,
      url,
      init: { headers: { Authorization: `Bearer ${key}` } },
      context: `Roster fetch from ${url}`,
    });
  }
  return parseRosterSnapshot(raw);
}

// One-time repair for PRE-roster phantom tenant keys: posts (clientId + a suggestion's
// forClientId), clients branding docs, automations, and share links stamped with an id the roster never
// issued (the old slugify(name) mint — e.g. "clear-sky-aircraft-parts" vs canonical
// "clear-sky"). Only touches NON-EMPTY off-roster ids whose display name matches a roster
// client by slugified-name equality (the exact worker POST /api/drafts repair rule); a
// suggestion's empty clientId is by design and is never filled here. Share docs are patched
// in place — the guest session token is minted FROM the doc at sign-in, so no reissue needed.
async function cmdRestamp() {
  console.log(`\nProject: ${PROJECT_ID}   mode: ${flags.apply ? 'APPLY' : 'dry-run'}\n`);
  const roster = await loadRoster();
  const slugSet = new Set(roster.map((c) => c.slug));
  const slugByName = buildRosterRepairMap(roster, slugify);
  console.log(`Roster: ${roster.length} clients (${[...slugSet].sort().join(', ')})`);

  // The roster slug an off-roster stamp should become, or undefined (empty / already canonical / no match).
  const repair = (name, id) => (!id || slugSet.has(id)) ? undefined : slugByName.get(slugify(name || ''));

  const posts = await listAll('posts', ['client', 'clientId', 'forClientId', 'source']);
  const clients = await listAll('clients', ['name', 'clientId']);
  const automations = await listAll('automations', ['client', 'clientId']);
  const shares = await listAll('shares', ['client', 'clientId', 'revoked']);

  const { malformedSources, suggestions, unsafeSuggestionTenants } = classifyPostRows(posts);
  if (malformedSources.length) {
    for (const post of malformedSources.slice(0, 20)) console.log(`   post ${post.id}: source is not a string`);
    die('Cannot safely classify ordinary posts and suggestions for restamp. Repair malformed source fields first.');
  }
  if (unsafeSuggestionTenants.length) {
    for (const post of unsafeSuggestionTenants.slice(0, 20)) {
      console.log(`   suggestion ${post.id}: clientId=${JSON.stringify(fieldString(post, 'clientId') ?? null)}`);
    }
    die('Refusing restamp while a suggestion has a non-empty/malformed clientId. Suggestions must remain tenant-private.');
  }

  const plan = [];    // { res, label, fields: [{field,from,to}], updateTime }
  const orphans = []; // off-roster with no roster name match — report, never guess
  for (const p of posts) {
    const cName = str(p.fields.client);
    const suggestion = fieldString(p, 'source') === 'suggestion';
    const field = suggestion ? 'forClientId' : 'clientId';
    const id = str(p.fields[field]);
    const to = repair(cName, id);
    if (to) plan.push({
      res: p.name,
      label: `${suggestion ? 'suggestion' : 'post'} ${p.id} (${JSON.stringify(cName ?? null)})`,
      fields: [{ field, from: id, to }],
      updateTime: p.updateTime,
    });
    else if (id && !slugSet.has(id)) orphans.push(`post ${p.id} ${field}=${id} client=${JSON.stringify(cName ?? null)}`);
  }
  for (const c of clients) {
    const id = str(c.fields.clientId), n = str(c.fields.name);
    const to = repair(n, id);
    if (to) plan.push({ res: c.name, label: `clients ${c.id} (${JSON.stringify(n ?? null)})`, fields: [{ field: 'clientId', from: id, to }], updateTime: c.updateTime });
    else if (id && !slugSet.has(id)) orphans.push(`clients ${c.id} clientId=${id} name=${JSON.stringify(n ?? null)}`);
  }
  for (const automation of automations) {
    const id = str(automation.fields.clientId), name = str(automation.fields.client);
    const to = repair(name, id);
    if (to) plan.push({
      res: automation.name,
      label: `automation ${automation.id} (${JSON.stringify(name ?? null)})`,
      fields: [{ field: 'clientId', from: id, to }],
      updateTime: automation.updateTime,
    });
    else if (id && !slugSet.has(id)) {
      orphans.push(`automation ${automation.id} clientId=${id} client=${JSON.stringify(name ?? null)}`);
    }
  }
  for (const s of shares) {
    // Tokens are credentials — never print one whole, even in a local report.
    const id = str(s.fields.clientId), n = str(s.fields.client), tag = `share …${s.id.slice(-8)}`;
    const to = repair(n, id);
    if (to) plan.push({ res: s.name, label: `${tag} (${JSON.stringify(n ?? null)})`, fields: [{ field: 'clientId', from: id, to }], updateTime: s.updateTime });
    else if (id && !slugSet.has(id)) orphans.push(`${tag} clientId=${id} client=${JSON.stringify(n ?? null)}`);
  }

  console.log(`Scanned: ${posts.length} posts, ${clients.length} clients docs, ${automations.length} automations, ${shares.length} share links.\n`);
  if (plan.length) {
    console.log(`Restamp plan (${plan.length} field${plan.length === 1 ? '' : 's'}):`);
    for (const x of plan) {
      for (const field of x.fields) console.log(`   ${x.label}: ${field.field} ${field.from} → ${field.to}`);
    }
  } else {
    console.log('✓ Nothing to restamp — every non-empty tenant key is roster-issued already.');
  }
  if (orphans.length) {
    console.log(`\n⚠ ${orphans.length} off-roster ids with NO roster name match — left untouched (renamed beyond recognition, or an ex-client):`);
    for (const o of orphans.slice(0, 20)) console.log(`   ${o}`);
    if (orphans.length > 20) console.log(`   …and ${orphans.length - 20} more`);
  }
  if (!plan.length) { console.log(''); return; }
  if (!flags.apply) { console.log('\n(dry-run) Re-run with --apply to write. Nothing was changed.\n'); return; }

  console.log('\nApplying…');
  let n = 0;
  for (const x of plan) {
    await patchFields(x.res, Object.fromEntries(x.fields.map((field) => [field.field, field.to])), x.updateTime);
    n += x.fields.length;
    if (n % 25 === 0) console.log(`   …${n} fields`);
  }
  console.log(`\n✓ Restamped ${n} field${n === 1 ? '' : 's'}. Share links were repaired in place (guest tokens mint from the doc at sign-in — no reissue needed).`);
  console.log('Next: node scripts/admin.mjs audit\n');
}

async function cmdAudit() {
  console.log(`\nProject: ${PROJECT_ID}   OWNER_UID: ${OWNER_UID}\n`);
  const roster = await loadRoster();
  console.log(`Canonical roster: ${roster.length} clients (${roster.map((client) => client.slug).sort().join(', ')})\n`);
  const posts = await listAll('posts', [
    'client', 'clientId', 'uid', 'reviewStage', 'source', 'forClientId', 'updatedAt', 'slug',
  ]);
  // Audit is a stop gate. A failed list is unknown state and must terminate;
  // treating it as an empty collection would issue a false clean result.
  const clients = await listAll('clients', ['name', 'clientId', 'uid']);

  const idInventory = await collectStrictIdInventory(posts);
  const incompatibleIds = reportStrictIdInventory(idInventory);
  const { automations, shares } = idInventory;
  const workspace = auditWorkspace({ posts, clients, automations, shares, roster, ownerUid: OWNER_UID });
  const clientUids = stringClaimAudit(clients, 'uid', OWNER_UID);
  const automationOwners = stringClaimAudit(automations, 'ownerUid', OWNER_UID);
  const shareOwners = stringClaimAudit(shares, 'ownerUid', OWNER_UID);
  const distinctIds = new Set(workspace.ordinaryPosts.map((p) => fieldString(p, 'clientId')).filter(Boolean));
  console.log(`posts: ${posts.length} (${workspace.ordinaryPosts.length} ordinary, ${workspace.suggestions.length} suggestions)   distinct ordinary clientId: ${distinctIds.size}`);
  console.log(`clients docs: ${clients.length}   automations: ${automations.length}   shares: ${shares.length}\n`);

  let bad = incompatibleIds ? 1 : 0;
  const resourceId = (row, kind) => kind === 'share' ? `…${row.id.slice(-8)}` : row.id;
  const reportRows = (title, rows, kind, detail = () => '') => {
    if (!rows.length) return;
    bad++;
    console.log(`✗ ${rows.length} ${title}:`);
    for (const row of rows.slice(0, 20)) console.log(`     ${resourceId(row, kind)}${detail(row)}`);
    if (rows.length > 20) console.log(`     …and ${rows.length - 20} more`);
  };
  const reportOwner = (label, kind, audit, field) => {
    reportRows(`${label} missing ${field}`, audit.missing, kind);
    reportRows(`${label} with non-string ${field}`, audit.nonString, kind);
    reportRows(`${label} with ${field} != OWNER_UID`, audit.wrong, kind,
      (row) => `  ${field}=${JSON.stringify(fieldString(row, field) ?? null)}`);
  };
  const reportRosterClaim = (label, kind, field, audit) => {
    reportRows(`${label} missing ${field}`, audit.missing, kind);
    reportRows(`${label} with non-string ${field}`, audit.nonString, kind);
    reportRows(`${label} with malformed/empty ${field}`, audit.invalid, kind,
      (row) => `  ${field}=${JSON.stringify(fieldString(row, field) ?? null)}`);
    reportRows(`${label} with off-roster ${field}`, audit.offRoster, kind,
      (row) => `  ${field}=${JSON.stringify(fieldString(row, field))}`);
  };

  reportOwner('posts', 'post', workspace.postUids, 'uid');
  reportOwner('client branding docs', 'client', clientUids, 'uid');
  reportOwner('automation docs', 'automation', automationOwners, 'ownerUid');
  reportOwner('share docs', 'share', shareOwners, 'ownerUid');
  reportRows('posts with a non-string source (cannot classify suggestion privacy)', workspace.malformedSources, 'post');

  reportRosterClaim('ordinary posts', 'post', 'clientId', workspace.claims.ordinaryPosts);
  reportRosterClaim('suggestions', 'suggestion', 'forClientId', workspace.claims.suggestions);
  reportRosterClaim('client branding docs', 'client', 'clientId', workspace.claims.clients);
  reportRosterClaim('automation docs', 'automation', 'clientId', workspace.claims.automations);
  reportRosterClaim('share docs', 'share', 'clientId', workspace.claims.shares);
  reportRosterClaim('ordinary posts', 'post', 'client', workspace.names.ordinaryPosts);
  reportRosterClaim('suggestions', 'suggestion', 'client', workspace.names.suggestions);
  reportRosterClaim('client branding docs', 'client', 'name', workspace.names.clients);
  reportRosterClaim('automation docs', 'automation', 'client', workspace.names.automations);
  reportRosterClaim('share docs', 'share', 'client', workspace.names.shares);

  reportRows('suggestions whose clientId is not exactly the empty string', workspace.suggestionClientId.invalid, 'suggestion',
    (row) => `  clientId=${JSON.stringify(fieldString(row, 'clientId') ?? null)}`);
  reportRows('suggestions that are not private', workspace.suggestionStage.invalid, 'suggestion',
    (row) => `  reviewStage=${JSON.stringify(fieldString(row, 'reviewStage') ?? null)}`);
  reportRows('ordinary posts without private/in_review reviewStage', workspace.badReviewStage, 'post',
    (row) => `  reviewStage=${JSON.stringify(fieldString(row, 'reviewStage') ?? null)}`);
  reportRows('posts missing updatedAt (newest-first list would omit them)', workspace.updatedAt.missing, 'post');
  reportRows('posts with non-string updatedAt', workspace.updatedAt.nonString, 'post');
  reportRows('posts with non-canonical updatedAt', workspace.updatedAt.invalid, 'post',
    (row) => `  updatedAt=${JSON.stringify(fieldString(row, 'updatedAt') ?? null)}`);
  reportRows('posts with non-string publication slug', workspace.publicationSlugs.nonString, 'post');
  reportRows('posts with non-canonical publication slug', workspace.publicationSlugs.invalid, 'post',
    (row) => `  slug=${JSON.stringify(fieldString(row, 'slug') ?? null)}`);

  if (workspace.mappings.idToMultipleNames.length) {
    bad++; console.log('✗ canonical client IDs map to MULTIPLE normalized display names:');
    for (const conflict of workspace.mappings.idToMultipleNames) {
      console.log(`     ${conflict.id} → ${conflict.names.map((name) => JSON.stringify(name)).join(', ')}`);
    }
  }
  if (workspace.mappings.nameToMultipleIds.length) {
    bad++; console.log('✗ normalized client names map to MULTIPLE client IDs:');
    for (const conflict of workspace.mappings.nameToMultipleIds) {
      console.log(`     ${JSON.stringify(conflict.name)} → ${conflict.ids.join(', ')}`);
    }
  }
  if (workspace.mappings.rosterMismatches.length) {
    bad++; console.log('✗ resource client label/ID pairs disagree with the canonical roster snapshot:');
    for (const mismatch of workspace.mappings.rosterMismatches.slice(0, 20)) {
      console.log(`     ${resourceId(mismatch.row, mismatch.kind)}  ${mismatch.id}=${JSON.stringify(mismatch.name)}; roster name=${JSON.stringify(mismatch.expectedName)}`);
    }
  }

  if (!bad) { console.log('✓ Clean. Every tenant claim matches the canonical roster; IDs, ownership, suggestion privacy, and review stages are consistent.\n'); process.exit(0); }
  console.log('\n→ Stop rollout. Repair the inventory and rerun this audit against the same canonical roster snapshot before deploying the app/rules.\n');
  process.exit(1);
}

// ----- dispatch --------------------------------------------------------------
const COMMANDS = ['bootstrap', 'grant', 'backfill', 'id-inventory', 'review-stage', 'restamp', 'audit'];
(async () => {
  if (!COMMANDS.includes(cmd)) {
    console.log('Usage: node scripts/admin.mjs <bootstrap|grant|backfill|id-inventory|review-stage|restamp|audit> [flags]\n' +
      '  bootstrap --email <e> [--client-id <id>] [--force]   create/refresh a super_admin user doc\n' +
      '  grant     --email <e> --role <client|client_admin|super_admin> [--client-id <id>] [--force]\n' +
      '  backfill  [--apply] [--map map.json]                 add clientId to posts + clients\n' +
      '  id-inventory                                        strict post/automation/share id rollout gate\n' +
      '  review-stage [--apply] [--roster <clients.json> | --context-key <key>]\n' +
      '                                                       missing ordinary→in_review, suggestion→private\n' +
      '  restamp   [--apply] [--roster <clients.json> | --context-key <key>]   phantom clientIds → roster slugs\n' +
      '  audit     [--roster <clients.json> | --context-key <key>]   fail-closed roster/owner/stage audit\n' +
      '  (global)  --key <sa.json> --project <id> --owner-uid <uid>     see file header for details');
    process.exit(cmd ? 1 : 0);
  }
  ensureSA();
  if (cmd === 'bootstrap') return cmdGrant({ defaultRole: 'super_admin' });
  if (cmd === 'grant') return cmdGrant({ defaultRole: null });
  if (cmd === 'backfill') return cmdBackfill();
  if (cmd === 'id-inventory') return cmdIdInventory();
  if (cmd === 'review-stage') return cmdReviewStage();
  if (cmd === 'restamp') return cmdRestamp();
  if (cmd === 'audit') return cmdAudit();
})().catch((e) => die(e?.message || String(e)));
