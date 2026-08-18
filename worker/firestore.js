// Server-side Firestore writes from the Worker, authenticated with a Firebase
// service account (set FIREBASE_SERVICE_ACCOUNT = the downloaded JSON, as a
// secret). Service-account access BYPASSES security rules, so callers MUST
// validate/sanitize before writing.
//
// Flow: sign a JWT with the SA private key (RS256) -> exchange at Google's OAuth
// token endpoint for an access token (cached ~1h) -> call the Firestore REST API.

let tokenCache = { exp: 0, token: null };

function pkcs8ToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadServiceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  return {
    clientEmail: sa.client_email,
    privateKey: (sa.private_key || '').replace(/\\n/g, '\n')
  };
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && now < tokenCache.exp - 60) return tokenCache.token;

  const { clientEmail, privateKey } = loadServiceAccount(env);
  if (!clientEmail || !privateKey) throw new Error('Service account missing client_email/private_key');

  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned =
    `${enc({ alg: 'RS256', typ: 'JWT' })}.` +
    enc({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    });

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8ToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'OAuth token exchange failed');

  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

// Convert a JS value to a Firestore REST typed value. RECURSIVE: arrays may hold nested maps
// (feedbackThread entries are {text, by, at} objects — the old flat version stringified them to
// "[object Object]"). Primitive + string-array behavior is unchanged.
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

// Convert a flat object to Firestore REST typed fields.
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toValue(v);
  return fields;
}

// Create a document in the `posts` collection. Returns the new doc id.
export async function createPost(env, docData) {
  const token = await getAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID not set');

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/posts`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(docData) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Firestore write failed (${res.status})`);
  return (data.name || '').split('/').pop();
}

const FS_BASE = (env) =>
  `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Parse a Firestore REST typed value back into plain JS. RECURSIVE mirror of toValue — array items
// may be maps (feedbackThread entries), which the old flat version silently dropped to null.
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}

// Parse Firestore REST typed fields back into a plain JS object.
function fromFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}

// List posts for a uid (filtered/sorted by the caller). Single-field equality
// query — no composite index required.
// Every post owned by `uid`. Paginates with a __name__ cursor: a fixed single-page
// limit silently dropped posts once the owner outgrew it, and BOTH callers compute
// over the whole set — /api/drafts (attention COUNTS + the client-facing list) and
// resolveClientId (find the tenant an existing post uses) — so a truncated page
// under-counts pending reviews and can mint a phantom slug for a client whose posts
// happened to sort past the cap. `cap` is an optional early-stop (default: fetch all).
// where(uid==x) + orderBy(__name__) is served by the automatic single-field index
// (its entries are already ordered by name within a uid) — no composite index needed.
export async function listPosts(env, uid, cap = Infinity) {
  const token = await getAccessToken(env);
  const pageSize = 300;
  const out = [];
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'posts' }],
      where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize
    };
    if (startAfter) structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const res = await fetch(`${FS_BASE(env)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(data?.error?.message || `Query failed (${res.status})`);
    const rows = (Array.isArray(data) ? data : []).filter(r => r.document);
    for (const r of rows) {
      out.push({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields) });
      if (out.length >= cap) return out;
    }
    if (rows.length < pageSize) return out;
    startAfter = rows[rows.length - 1].document.name;
  }
}

// Cheap review-state counts for /api/drafts?summary=1 (the frequently-polled cross-app attention
// strip). Pages with a __name__ cursor + a SELECT projection so it pulls ONLY the four fields the
// counts need — never post bodies / feedbackThread arrays. Semantics mirror the list summary
// EXACTLY: non-template; suggestions counted on their own; archived excluded from review;
// pending/changes_requested among the rest.
export async function countDraftSummary(env, uid) {
  const token = await getAccessToken(env);
  const pageSize = 300;
  let pendingReview = 0, changesRequested = 0, suggestions = 0;
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'posts' }],
      where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } },
      select: { fields: [
        { fieldPath: 'isTemplate' },
        { fieldPath: 'source' },
        { fieldPath: 'status' },
        { fieldPath: 'approvalStatus' },
      ] },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize
    };
    if (startAfter) structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const res = await fetch(`${FS_BASE(env)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(data?.error?.message || `Summary query failed (${res.status})`);
    const rows = (Array.isArray(data) ? data : []).filter(r => r.document);
    for (const r of rows) {
      const f = r.document.fields || {};
      if (f.isTemplate?.booleanValue === true) continue;              // templates aren't drafts
      if ((f.source?.stringValue || '') === 'suggestion') { suggestions++; continue; }
      if ((f.status?.stringValue || '') === 'archived') continue;     // cleared → not review content
      const approval = f.approvalStatus?.stringValue || '';
      if (approval === 'pending') pendingReview++;
      else if (approval === 'changes_requested') changesRequested++;
    }
    if (rows.length < pageSize) break;
    startAfter = rows[rows.length - 1].document.name;
  }
  return { pendingReview, changesRequested, suggestions };
}

export async function getPost(env, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/posts/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Get failed (${res.status})`);
  return { id, ...fromFields(data.fields) };
}

// Read a users/{email} RBAC doc (lowercased email = doc id). Returns the parsed
// record ({ roles: [...], clientId, email }) or null if absent. Used by the
// Worker to resolve a caller's role + clientId server-side (the same model the
// firestore.rules helpers resolve via get(users/$(email))).
export async function getUserRecord(env, email) {
  if (!email) return null;
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/users/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `User lookup failed (${res.status})`);
  return fromFields(data.fields);
}

// Upsert a users/{email} RBAC doc (the POM people-sync propagation path). PATCH with an
// updateMask creates-or-merges, so unmanaged fields on an existing doc are never clobbered.
export async function setUserRecord(env, email, record) {
  const token = await getAccessToken(env);
  const mask = Object.keys(record).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FS_BASE(env)}/users/${encodeURIComponent(email)}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(record) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `User upsert failed (${res.status})`);
  return fromFields(data.fields);
}

// Delete a users/{email} RBAC doc (people-sync revoke). 404 = already gone (idempotent).
export async function deleteUserRecord(env, email) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/users/${encodeURIComponent(email)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `User delete failed (${res.status})`);
  }
  return true;
}

export async function updatePost(env, id, patch) {
  const token = await getAccessToken(env);
  const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FS_BASE(env)}/posts/${id}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(patch) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Update failed (${res.status})`);
  return { id, ...fromFields(data.fields) };
}

// Masked field update + ATOMIC array append in ONE Firestore commit (:commit with an
// appendMissingElements transform). Used by the review verbs so a concurrent reviewer's
// feedbackThread entry can never be clobbered by a snapshot rebuild — the Spool UI and the
// POM broker both write this field. Entries carry an ISO timestamp, so the union-dedupe
// never merges two distinct notes. The legacy 20-entry cap can't be enforced atomically;
// readers trim for display instead.
export async function updatePostWithAppend(env, id, patch, arrayField, entry) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [{
        update: {
          name: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/posts/${id}`,
          fields: toFields(patch)
        },
        updateMask: { fieldPaths: Object.keys(patch) },
        updateTransforms: [{ fieldPath: arrayField, appendMissingElements: { values: [toValue(entry)] } }],
        currentDocument: { exists: true }
      }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Update failed (${res.status})`);
  // :commit returns write results, not the doc — re-read so callers get the same shape as updatePost.
  return await getPost(env, id);
}

export async function deletePost(env, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/posts/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Delete failed (${res.status})`);
  }
  return true;
}

// --- Share links (per-client review tokens) ---------------------------------
//
// Mint a Firebase **custom token** for an anonymous review session, signed with
// the service-account private key (the same key used for Firestore access).
// Firebase verifies it against the SA's public cert, so no extra IAM role is
// needed for local signing. `claims` become developer claims on the guest's ID
// token (readable as request.auth.token.<claim> in security rules).
export async function mintCustomToken(env, uid, claims) {
  const { clientEmail, privateKey } = loadServiceAccount(env);
  if (!clientEmail || !privateKey) throw new Error('Service account missing client_email/private_key');

  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned =
    `${enc({ alg: 'RS256', typ: 'JWT' })}.` +
    enc({
      iss: clientEmail,
      sub: clientEmail,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: now,
      exp: now + 3600,
      uid,
      claims
    });

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8ToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// A share doc lives at shares/<token>; the token IS the doc id (an unguessable
// 128-bit+ secret). Client code can never read/write this collection (rules
// deny it) — only the Worker, via the service account, touches it.
export async function createShareDoc(env, token, data) {
  const accessToken = await getAccessToken(env);
  const url = `${FS_BASE(env)}/shares?documentId=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error?.message || `Share create failed (${res.status})`);
  return token;
}

export async function getShareDoc(env, token) {
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/shares/${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Share get failed (${res.status})`);
  return { id: token, ...fromFields(data.fields) };
}

// Every share doc owned by `ownerUid`. Paginates with a __name__ cursor: a fixed
// single-page limit silently truncated the share-link MANAGEMENT listing once the
// owner outgrew it (and shares have no creation cap bounding them below the limit),
// so a stale link past the cap became invisible — and un-revocable — from the list.
// where(ownerUid==x)+orderBy(__name__) rides the automatic single-field index.
export async function listShareDocs(env, ownerUid, cap = Infinity) {
  const token = await getAccessToken(env);
  const pageSize = 200;
  const out = [];
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'shares' }],
      where: { fieldFilter: { field: { fieldPath: 'ownerUid' }, op: 'EQUAL', value: { stringValue: ownerUid } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize
    };
    if (startAfter) structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const res = await fetch(`${FS_BASE(env)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(data?.error?.message || `Share list failed (${res.status})`);
    const rows = (Array.isArray(data) ? data : []).filter(r => r.document);
    for (const r of rows) {
      out.push({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields) });
      if (out.length >= cap) return out;
    }
    if (rows.length < pageSize) return out;
    startAfter = rows[rows.length - 1].document.name;
  }
}

export async function deleteShareDoc(env, token) {
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/shares/${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Share delete failed (${res.status})`);
  }
  return true;
}

// --- Content automations (super-admin-only, Worker-managed) ------------------
//
// Config for the scheduled content generator. Like shares/{token}, this
// collection is touched ONLY by the Worker via the service account; clients can
// never read or write it (firestore.rules denies the collection outright). Docs
// MUST be flat (toFields can't serialize nested maps/timestamps) — ISO strings
// for time, integers for counts. See worker/automation.js for the runner.

// Create an automation config (Firestore auto-id). Returns the new doc id.
export async function createAutomation(env, data) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/automations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error?.message || `Automation create failed (${res.status})`);
  return (out.name || '').split('/').pop();
}

export async function getAutomation(env, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/automations/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Automation get failed (${res.status})`);
  return { id, ...fromFields(data.fields) };
}

// List an owner's automations. Single-field equality query (no composite index).
export async function listAutomations(env, ownerUid, limit = 200) {
  const token = await getAccessToken(env);
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'automations' }],
      where: { fieldFilter: { field: { fieldPath: 'ownerUid' }, op: 'EQUAL', value: { stringValue: ownerUid } } },
      limit
    }
  };
  const res = await fetch(`${FS_BASE(env)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(data?.error?.message || `Automation list failed (${res.status})`);
  return (Array.isArray(data) ? data : [])
    .filter(r => r.document)
    .map(r => ({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields) }));
}

export async function updateAutomation(env, id, patch) {
  const token = await getAccessToken(env);
  const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FS_BASE(env)}/automations/${encodeURIComponent(id)}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(patch) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Automation update failed (${res.status})`);
  return { id, ...fromFields(data.fields) };
}

export async function deleteAutomation(env, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/automations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Automation delete failed (${res.status})`);
  }
  return true;
}

// Look up a client's branding / AI settings by the immutable clientId so the
// automation runner can produce on-brand copy + imagery (the same fields the
// in-app editor passes to buildTextContext/buildImagePrompt). The clients doc id
// is `${uid}__${name}`, so we query the clientId FIELD rather than by id.
// Returns the parsed settings ({ name, aiBrandVoice, aiAudience, aiTone,
// aiKeywords, aiAvoid, brandColor, ... }) or null if the client has no doc.
export async function getClientSettings(env, clientId) {
  if (!clientId) return null;
  const token = await getAccessToken(env);
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'clients' }],
      where: { fieldFilter: { field: { fieldPath: 'clientId' }, op: 'EQUAL', value: { stringValue: clientId } } },
      limit: 1
    }
  };
  const res = await fetch(`${FS_BASE(env)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(data?.error?.message || `Client lookup failed (${res.status})`);
  const doc = (Array.isArray(data) ? data : []).find(r => r.document);
  return doc ? fromFields(doc.document.fields) : null;
}

// Resolve the canonical clientId an existing post already uses for a display
// name, so an automation binds to the same tenant key its posts use rather than
// trusting a client-supplied slug that could drift (e.g. after a backfill --map
// override). Returns null for a brand-new client with no posts yet — the caller
// then falls back to the supplied id. Mirrors the app's clientIdByName (which is
// also derived from posts), so existing clients resolve identically.
export async function resolveClientId(env, clientName) {
  if (!clientName || !env.OWNER_UID) return null;
  try {
    const posts = await listPosts(env, env.OWNER_UID);
    const hit = posts.find(p => p.client === clientName && p.clientId);
    return hit ? hit.clientId : null;
  } catch (err) {
    console.error('resolveClientId failed:', err?.message || err);
    return null;
  }
}

// --- Client-lifecycle helpers (rename propagation + purge; internal-key routes only) --------
//
// Generic slug-scoped primitives for /api/client-rename + /api/client-purge. Every helper is
// keyed by a doc's clientId-style FIELD (the suite join key), never by display name, and every
// write goes through :commit with the doc's exact resource name (branding doc ids contain
// percent-escapes, so building URL paths from ids is a footgun). Chunks are ≤400 writes
// (Firestore's :commit cap is 500). Callers report per-store counts — a chunk failure throws an
// Error carrying `.committed` (writes already applied) so the caller can still report honestly.

const COMMIT_CHUNK = 400;

export const docResourceName = (env, collectionId, id) =>
  `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionId}/${id}`;

// Every doc in `collectionId` whose `fieldPath` string-equals `value`. Pages with a __name__
// cursor (single-field equality + orderBy(__name__) rides the automatic index — no composite).
// Returns [{ id, name, fields, raw }] — `fields` parsed to plain JS, `raw` the untouched REST
// typed fields (for lossless copies). `cap` bounds a runaway tenant (default 5000).
export async function listDocsWhere(env, collectionId, fieldPath, value, { pageSize = 300, cap = 5000, select } = {}) {
  const token = await getAccessToken(env);
  const out = [];
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId }],
      where: { fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: { stringValue: String(value) } } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize
    };
    if (Array.isArray(select) && select.length) structuredQuery.select = { fields: select.map(fieldPath => ({ fieldPath })) };
    if (startAfter) structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const res = await fetch(`${FS_BASE(env)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(data?.error?.message || `${collectionId} query failed (${res.status})`);
    const rows = (Array.isArray(data) ? data : []).filter(r => r.document);
    for (const r of rows) {
      const raw = r.document.fields || {};
      out.push({ id: r.document.name.split('/').pop(), name: r.document.name, fields: fromFields(raw), raw });
      if (out.length >= cap) { out.truncated = true; return out; } // caller MUST surface this — never a silent partial
    }
    if (rows.length < pageSize) return out;
    startAfter = rows[rows.length - 1].document.name;
  }
}

// One doc's raw fields by id (null when absent). Used to inspect a rename TARGET before merging.
function docResourceUrl(env, collectionId, id) { return `${FS_BASE(env)}/${collectionId}/${encodeURIComponent(id)}`; }
export async function getDocRaw(env, collectionId, id) {
  const token = await getAccessToken(env);
  const res = await fetch(docResourceUrl(env, collectionId, id), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `${collectionId}/${id} read failed (${res.status})`);
  return data.fields || {};
}

// :commit `writes` in ≤400-write chunks. Returns the number of writes applied. On a failed
// chunk throws with `.committed` = writes applied by the earlier chunks.
async function commitChunked(env, writes) {
  if (!writes.length) return 0;
  const token = await getAccessToken(env);
  let committed = 0;
  for (let i = 0; i < writes.length; i += COMMIT_CHUNK) {
    const chunk = writes.slice(i, i + COMMIT_CHUNK);
    const res = await fetch(`${FS_BASE(env)}:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes: chunk })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const err = new Error(data?.error?.message || `Commit failed (${res.status})`);
      err.committed = committed;
      throw err;
    }
    committed += chunk.length;
  }
  return committed;
}

// Masked update of the same `patch` on every doc (by exact resource name). `currentDocument.
// exists=true` so a concurrently-deleted doc is never resurrected as a stub — the chunk fails
// instead (reported, not silent). Returns the count applied.
export async function batchUpdateDocs(env, docNames, patch) {
  const fields = toFields(patch);
  const updateMask = { fieldPaths: Object.keys(patch) };
  return commitChunked(env, docNames.map(name => ({
    update: { name, fields }, updateMask, currentDocument: { exists: true }
  })));
}

// Delete every doc (by exact resource name). A delete of an absent doc is a no-op success in
// :commit, so re-running is idempotent. Returns the count of delete writes applied.
export async function batchDeleteDocs(env, docNames) {
  return commitChunked(env, docNames.map(name => ({ delete: name })));
}

// Merge `rawFields` (REST typed fields, e.g. a doc's `raw` from listDocsWhere) into
// `collectionId/{id}` — creates the doc if absent, overwrites only the listed fields if present
// (SPA setDoc(..., {merge:true}) semantics). No precondition on purpose: this IS the upsert.
export async function mergeDocRaw(env, collectionId, id, rawFields) {
  const keys = Object.keys(rawFields);
  if (!keys.length) return 0;
  return commitChunked(env, [{
    update: { name: docResourceName(env, collectionId, id), fields: rawFields },
    updateMask: { fieldPaths: keys }
  }]);
}

// All image URLs referenced by any post (for the orphan-image sweep). Paginates
// with a __name__ cursor: a fixed single-page limit silently dropped references
// once the posts collection outgrew it, and the GC would then delete images that
// are still in use. The sweep must see EVERY post or not run at all (it throws).
export async function listAllImageUrls(env, pageSize = 1000) {
  const token = await getAccessToken(env);
  const urls = new Set();
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'posts' }],
      select: { fields: [{ fieldPath: 'imageUrl' }] },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize
    };
    if (startAfter) structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const res = await fetch(`${FS_BASE(env)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const data = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(data?.error?.message || `Query failed (${res.status})`);
    const rows = (Array.isArray(data) ? data : []).filter(r => r.document);
    for (const r of rows) {
      const u = r.document?.fields?.imageUrl?.stringValue;
      if (u) urls.add(u);
    }
    if (rows.length < pageSize) return urls;
    startAfter = rows[rows.length - 1].document.name;
  }
}
