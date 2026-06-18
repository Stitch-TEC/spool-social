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

// Convert a flat object to Firestore REST typed fields.
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(x => ({ stringValue: String(x) })) } };
    else fields[k] = { stringValue: String(v) };
  }
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

// Parse Firestore REST typed fields back into a plain JS object.
function fromFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('integerValue' in v) out[k] = parseInt(v.integerValue, 10);
    else if ('doubleValue' in v) out[k] = v.doubleValue;
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('nullValue' in v) out[k] = null;
    else if ('timestampValue' in v) out[k] = v.timestampValue;
    else if ('arrayValue' in v) out[k] = (v.arrayValue.values || []).map(x => x.stringValue ?? x.integerValue ?? null);
    else out[k] = null;
  }
  return out;
}

// List posts for a uid (filtered/sorted by the caller). Single-field equality
// query — no composite index required.
export async function listPosts(env, uid, limit = 300) {
  const token = await getAccessToken(env);
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'posts' }],
      where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } },
      limit
    }
  };
  const res = await fetch(`${FS_BASE(env)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(data?.error?.message || `Query failed (${res.status})`);
  return (Array.isArray(data) ? data : [])
    .filter(r => r.document)
    .map(r => ({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields) }));
}

export async function getPost(env, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/posts/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Get failed (${res.status})`);
  return { id, ...fromFields(data.fields) };
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

// All image URLs referenced by any post (for the orphan-image sweep).
export async function listAllImageUrls(env, limit = 2000) {
  const token = await getAccessToken(env);
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'posts' }],
      select: { fields: [{ fieldPath: 'imageUrl' }] },
      limit
    }
  };
  const res = await fetch(`${FS_BASE(env)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(data?.error?.message || `Query failed (${res.status})`);
  const urls = new Set();
  for (const r of (Array.isArray(data) ? data : [])) {
    const u = r.document?.fields?.imageUrl?.stringValue;
    if (u) urls.add(u);
  }
  return urls;
}
