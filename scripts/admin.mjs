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
// DEPLOY ORDER (see RBAC_DEPLOY_RUNBOOK.md):
//   1) node scripts/admin.mjs bootstrap --email dillon@stitchtec.dev --key sa.json
//   2) firebase deploy --only firestore:rules
//   3) node scripts/admin.mjs backfill --key sa.json            # dry-run, review
//      node scripts/admin.mjs backfill --key sa.json --apply
//   4) node scripts/admin.mjs audit --key sa.json               # must be clean
//   5) provision client users (bootstrap-style writes, role client/client_admin)
//
// COMMANDS
//   bootstrap --email <e> [--role super_admin] [--client-id <id>] [--force]
//   grant     --email <e> --role <client|client_admin|super_admin> [--client-id <id>] [--force]
//   backfill  [--apply] [--map map.json]      # add clientId to posts + clients
//   audit                                      # report orphans / anomalies (exit 1 if any)
//
// FLAGS (global): --key <path> --project <id> --owner-uid <uid>
// =============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';

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
  const res = await fetch(urlPath.startsWith('http') ? urlPath : `${BASE}/${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { _status: 404 };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data?.error?.message || `${method} ${urlPath} failed (${res.status})`);
  return data;
}

// List every doc in a collection, fetching only `fields` (mask). Paginates fully.
async function listAll(collection, fields) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (pageToken) params.set('pageToken', pageToken);
    for (const f of fields) params.append('mask.fieldPaths', f);
    const data = await api('GET', `${collection}?${params}`);
    for (const d of data.documents || []) {
      out.push({ name: d.name, id: d.name.split('/').pop(), fields: d.fields || {} });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Patch a single field on a doc identified by its full resource name.
async function patchField(resourceName, field, value) {
  await api('PATCH', `https://firestore.googleapis.com/v1/${resourceName}?updateMask.fieldPaths=${field}`,
    { fields: toFields({ [field]: value }) });
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
  const posts = await listAll('posts', ['client', 'clientId', 'uid']);
  let clients = [];
  try { clients = await listAll('clients', ['name', 'clientId', 'uid']); } catch { /* collection may not exist */ }

  const names = new Set();
  for (const p of posts) { const c = str(p.fields.client); if (c) names.add(c); }
  for (const c of clients) { const n = str(c.fields.name); if (n) names.add(n); }

  const { map, collisions, override } = buildClientMap([...names]);

  // Report the effective mapping.
  console.log('Client name → clientId:');
  for (const [name, slug] of Object.entries(map).sort()) {
    const fromPosts = posts.filter((p) => str(p.fields.client) === name).length;
    console.log(`   ${JSON.stringify(name).padEnd(28)} → ${slug.padEnd(24)} (${fromPosts} posts)${override[name] ? '  [override]' : ''}`);
  }

  const orphanPosts = posts.filter((p) => !str(p.fields.client));
  const uidAnomalies = posts.filter((p) => str(p.fields.uid) && str(p.fields.uid) !== OWNER_UID);
  const postsToFill = posts.filter((p) => str(p.fields.client) && !str(p.fields.clientId));
  const postsHave = posts.filter((p) => str(p.fields.clientId)).length;
  const clientsToFill = clients.filter((c) => str(c.fields.name) && !str(c.fields.clientId));

  console.log('\nSummary:');
  console.log(`   posts total ............ ${posts.length}`);
  console.log(`   posts already w/ clientId ${postsHave}`);
  console.log(`   posts to backfill ...... ${postsToFill.length}`);
  console.log(`   posts with NO client ... ${orphanPosts.length}  ${orphanPosts.length ? '⚠ cannot map → would be invisible to client users' : ''}`);
  console.log(`   uid != OWNER_UID ....... ${uidAnomalies.length}  ${uidAnomalies.length ? '⚠ unexpected owner — investigate before client logins' : ''}`);
  console.log(`   clients docs ........... ${clients.length} (${clientsToFill.length} to backfill)`);

  if (collisions.length) {
    console.log('\n⚠ SLUG COLLISIONS — distinct names map to the same clientId:');
    for (const [slug, ns] of collisions) console.log(`   ${slug}: ${ns.map((n) => JSON.stringify(n)).join(', ')}`);
    console.log('   Resolve with --map map.json ({"Client Name":"desired-slug", ...}) before applying.');
    if (flags.apply) die('Refusing to apply with unresolved slug collisions.');
  }
  if (uidAnomalies.length) {
    for (const p of uidAnomalies.slice(0, 10)) console.log(`     post ${p.id}: uid=${str(p.fields.uid)}`);
  }

  if (!flags.apply) {
    console.log('\n(dry-run) Re-run with --apply to write clientId. Nothing was changed.\n');
    return;
  }

  console.log('\nApplying…');
  let n = 0;
  for (const p of postsToFill) {
    await patchField(p.name, 'clientId', map[str(p.fields.client)]);
    if (++n % 25 === 0) console.log(`   …${n}/${postsToFill.length} posts`);
  }
  let m = 0;
  for (const c of clientsToFill) {
    await patchField(c.name, 'clientId', map[str(c.fields.name)]);
    m++;
  }
  console.log(`\n✓ Backfilled clientId on ${n} posts and ${m} clients docs.`);
  if (orphanPosts.length) console.log(`⚠ ${orphanPosts.length} posts have no client field and were skipped — run "audit" and fix.`);
  console.log('Next: node scripts/admin.mjs audit\n');
}

async function cmdAudit() {
  console.log(`\nProject: ${PROJECT_ID}   OWNER_UID: ${OWNER_UID}\n`);
  const posts = await listAll('posts', ['client', 'clientId', 'uid']);
  let clients = [];
  try { clients = await listAll('clients', ['name', 'clientId', 'uid']); } catch { /* ignore */ }

  const orphanPosts = posts.filter((p) => !str(p.fields.clientId));
  const uidAnomalies = posts.filter((p) => str(p.fields.uid) && str(p.fields.uid) !== OWNER_UID);
  const clientsNoId = clients.filter((c) => !str(c.fields.clientId));

  // name ↔ clientId consistency across posts.
  const nameToIds = {};
  for (const p of posts) {
    const name = str(p.fields.client), id = str(p.fields.clientId);
    if (name && id) (nameToIds[name] ||= new Set()).add(id);
  }
  const inconsistent = Object.entries(nameToIds).filter(([, ids]) => ids.size > 1);

  const distinctIds = new Set(posts.map((p) => str(p.fields.clientId)).filter(Boolean));
  console.log(`posts: ${posts.length}   with clientId: ${posts.length - orphanPosts.length}   distinct clientId: ${distinctIds.size}`);
  console.log(`clients docs: ${clients.length}   without clientId: ${clientsNoId.length}\n`);

  let bad = 0;
  if (orphanPosts.length) {
    bad++; console.log(`✗ ${orphanPosts.length} posts WITHOUT clientId (invisible to client users; operator-only via isOwner):`);
    for (const p of orphanPosts.slice(0, 20)) console.log(`     ${p.id}  client=${JSON.stringify(str(p.fields.client) ?? null)}`);
    if (orphanPosts.length > 20) console.log(`     …and ${orphanPosts.length - 20} more`);
  }
  if (uidAnomalies.length) {
    bad++; console.log(`✗ ${uidAnomalies.length} posts with uid != OWNER_UID (${OWNER_UID}) — share/owner reads will miss these.`);
  }
  if (clientsNoId.length) {
    bad++; console.log(`✗ ${clientsNoId.length} clients docs without clientId (branding unreadable by client users):`);
    for (const c of clientsNoId.slice(0, 20)) console.log(`     ${c.id}  name=${JSON.stringify(str(c.fields.name) ?? null)}`);
  }
  if (inconsistent.length) {
    bad++; console.log('✗ client name maps to MULTIPLE clientIds (a tenant split — fix before client logins):');
    for (const [name, ids] of inconsistent) console.log(`     ${JSON.stringify(name)} → ${[...ids].join(', ')}`);
  }

  if (!bad) { console.log('✓ Clean. Every post and client doc has a consistent clientId; all posts owned by OWNER_UID.\n'); process.exit(0); }
  console.log('\n→ Fix the above (re-run backfill, or correct data) before provisioning client logins.\n');
  process.exit(1);
}

// ----- dispatch --------------------------------------------------------------
const COMMANDS = ['bootstrap', 'grant', 'backfill', 'audit'];
(async () => {
  if (!COMMANDS.includes(cmd)) {
    console.log('Usage: node scripts/admin.mjs <bootstrap|grant|backfill|audit> [flags]\n' +
      '  bootstrap --email <e> [--client-id <id>] [--force]   create/refresh a super_admin user doc\n' +
      '  grant     --email <e> --role <client|client_admin|super_admin> [--client-id <id>] [--force]\n' +
      '  backfill  [--apply] [--map map.json]                 add clientId to posts + clients\n' +
      '  audit                                                report orphans/anomalies (exit 1 if any)\n' +
      '  (global)  --key <sa.json> --project <id> --owner-uid <uid>     see file header for details');
    process.exit(cmd ? 1 : 0);
  }
  ensureSA();
  if (cmd === 'bootstrap') return cmdGrant({ defaultRole: 'super_admin' });
  if (cmd === 'grant') return cmdGrant({ defaultRole: null });
  if (cmd === 'backfill') return cmdBackfill();
  if (cmd === 'audit') return cmdAudit();
})().catch((e) => die(e?.message || String(e)));
