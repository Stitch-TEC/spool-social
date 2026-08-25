// Server-side Firestore writes from the Worker, authenticated with a Firebase
// service account (set FIREBASE_SERVICE_ACCOUNT = the downloaded JSON, as a
// secret). Service-account access BYPASSES security rules, so callers MUST
// validate/sanitize before writing.
//
// Flow: sign a JWT with the SA private key (RS256) -> exchange at Google's OAuth
// token endpoint for an access token (cached ~1h) -> call the Firestore REST API.

import { transformMediaDestinations } from '../src/utils/mediaMarkup.js';
import { DRAFT_PUBLIC_FIELD_PATHS } from './draftUpdate.js';

let tokenCache = { exp: 0, token: null };

export const FIRESTORE_AUTO_ID_RE = /^[A-Za-z0-9]{20}$/;
export const SHARE_TOKEN_RE = /^[a-f0-9]{64}$/;
const COLLECTION_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,1499}$/;

export class InvalidFirestoreIdError extends Error {
  constructor(kind = 'document') {
    super(`Invalid ${kind} id`);
    this.name = 'InvalidFirestoreIdError';
    this.code = 'invalid_document_id';
    this.status = 400;
  }
}

export function requireAutoId(id, kind = 'document') {
  const value = String(id || '');
  if (!FIRESTORE_AUTO_ID_RE.test(value)) throw new InvalidFirestoreIdError(kind);
  return value;
}

export function requireShareToken(token) {
  const value = String(token || '');
  if (!SHARE_TOKEN_RE.test(value)) throw new InvalidFirestoreIdError('share token');
  return value;
}

// Non-auto-id helpers (branding/user/lifecycle) still need a single Firestore
// path segment. Reject separators/control bytes, then URL-encode at REST path
// boundaries. This is intentionally broader than auto IDs because branding IDs
// include an owner prefix plus encodeURIComponent(name).
export function requireDocumentSegment(id, kind = 'document') {
  const value = String(id || '');
  const hasControl = Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!value || value.length > 1500 || value === '.' || value === '..' || value.includes('/') || hasControl) {
    throw new InvalidFirestoreIdError(kind);
  }
  return value;
}

function requireCollectionId(collectionId) {
  const value = String(collectionId || '');
  if (!COLLECTION_ID_RE.test(value)) throw new InvalidFirestoreIdError('collection');
  return value;
}

export const encodedAutoId = (id, kind = 'document') => encodeURIComponent(requireAutoId(id, kind));
const encodedShareToken = (token) => encodeURIComponent(requireShareToken(token));

function decodeB64urlUtf8(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidFirestoreIdError('draft cursor');
  }
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidFirestoreIdError('draft cursor');
  }
}

function requireFirestoreReadTime(value) {
  const text = String(value || '');
  if (text.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(text)
    || !Number.isFinite(Date.parse(text))) {
    throw new InvalidFirestoreIdError('draft cursor');
  }
  return text;
}

export function requireDraftUpdatedAt(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)
    || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString() !== text) {
    throw new InvalidFirestoreIdError('draft cursor');
  }
  return text;
}

function requireDraftCursorSeen(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new InvalidFirestoreIdError('draft cursor');
  }
  return value;
}

export function encodeDraftCursor(id, updatedAt, seen, filterKey, readTime) {
  const payload = new TextEncoder().encode(JSON.stringify({
    v: 2,
    id: requireAutoId(id, 'draft cursor'),
    updatedAt: requireDraftUpdatedAt(updatedAt),
    seen: requireDraftCursorSeen(seen),
    filter: String(filterKey || ''),
    readTime: requireFirestoreReadTime(readTime),
  }));
  return b64url(payload);
}

export function decodeDraftCursor(value, filterKey) {
  let payload;
  try { payload = JSON.parse(decodeB64urlUtf8(value)); }
  catch { throw new InvalidFirestoreIdError('draft cursor'); }
  if (!isPlainObject(payload)
    || Object.keys(payload).length !== 6
    || payload.v !== 2
    || typeof payload.filter !== 'string'
    || payload.filter !== String(filterKey || '')) {
    throw new InvalidFirestoreIdError('draft cursor');
  }
  return {
    id: requireAutoId(payload.id, 'draft cursor'),
    updatedAt: requireDraftUpdatedAt(payload.updatedAt),
    seen: requireDraftCursorSeen(payload.seen),
    readTime: requireFirestoreReadTime(payload.readTime),
  };
}

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
  return requireAutoId((data.name || '').split('/').pop(), 'draft');
}

const FS_BASE = (env) =>
  `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const isPlainObject = (value) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

async function readJsonStrict(response, context) {
  try { return await response.json(); }
  catch { throw new Error(`${context} returned invalid JSON`); }
}

function validateFirestoreValue(value, context) {
  if (!isPlainObject(value)) throw new Error(`${context} contains a malformed Firestore value`);
  const variants = [
    'nullValue', 'booleanValue', 'integerValue', 'doubleValue', 'timestampValue',
    'stringValue', 'bytesValue', 'referenceValue', 'geoPointValue', 'arrayValue', 'mapValue',
  ].filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (variants.length !== 1 || Object.keys(value).length !== 1) {
    throw new Error(`${context} contains an unknown/ambiguous Firestore value`);
  }
  const kind = variants[0];
  const payload = value[kind];
  // The REST API has emitted both the protobuf-JSON enum spelling and `null`
  // across client/library generations. They are the only two canonical null
  // representations; accepting either keeps legacy documents readable without
  // weakening the structural check.
  if (kind === 'nullValue' && payload !== null && payload !== 'NULL_VALUE') {
    throw new Error(`${context} has malformed nullValue`);
  }
  if (kind === 'booleanValue' && typeof payload !== 'boolean') throw new Error(`${context} has malformed booleanValue`);
  if (kind === 'integerValue' && (typeof payload !== 'string' || !/^-?\d+$/.test(payload))) throw new Error(`${context} has malformed integerValue`);
  if (kind === 'doubleValue' && typeof payload !== 'number'
    && !['NaN', 'Infinity', '-Infinity'].includes(payload)) {
    throw new Error(`${context} has malformed doubleValue`);
  }
  if (['timestampValue', 'stringValue', 'bytesValue', 'referenceValue'].includes(kind) && typeof payload !== 'string') {
    throw new Error(`${context} has malformed ${kind}`);
  }
  if (kind === 'geoPointValue' && (!isPlainObject(payload)
    || Object.keys(payload).some((key) => !['latitude', 'longitude'].includes(key))
    || typeof payload.latitude !== 'number' || typeof payload.longitude !== 'number')) {
    throw new Error(`${context} has malformed geoPointValue`);
  }
  if (kind === 'arrayValue') {
    if (!isPlainObject(payload)
      || Object.keys(payload).some((key) => key !== 'values')
      || (payload.values !== undefined && !Array.isArray(payload.values))) {
      throw new Error(`${context} has malformed arrayValue`);
    }
    for (const item of payload.values || []) validateFirestoreValue(item, context);
  }
  if (kind === 'mapValue') {
    if (!isPlainObject(payload)
      || Object.keys(payload).some((key) => key !== 'fields')
      || (payload.fields !== undefined && !isPlainObject(payload.fields))) {
      throw new Error(`${context} has malformed mapValue`);
    }
    validateFirestoreFields(payload.fields || {}, context);
  }
}

function validateFirestoreFields(fields, context = 'Firestore document') {
  if (!isPlainObject(fields)) throw new Error(`${context} contains malformed fields`);
  for (const value of Object.values(fields)) validateFirestoreValue(value, context);
}

/** Parse Firestore's streaming runQuery JSON representation without ever
 * interpreting malformed/undecodable responses as an empty result set. */
export async function readRunQueryDocuments(response, context = 'Firestore query') {
  const data = await readJsonStrict(response, context);
  if (!response.ok) {
    const message = isPlainObject(data) && isPlainObject(data.error) && typeof data.error.message === 'string'
      ? data.error.message
      : `${context} failed (${response.status})`;
    throw new Error(message);
  }
  if (!Array.isArray(data)) throw new Error(`${context} returned a non-array result`);
  // A successful empty Firestore query still carries a readTime-only response.
  // A bare empty stream has no proof that the backend completed the query, so
  // destructive consumers (GC/lifecycle) must treat it as uncertainty.
  if (data.length === 0) throw new Error(`${context} returned an incomplete empty result`);
  const documents = [];
  let hasCompletionEvidence = false;
  for (const [index, message] of data.entries()) {
    if (!isPlainObject(message)) throw new Error(`${context} returned malformed result message ${index}`);
    const allowedMessageFields = new Set([
      'document', 'transaction', 'readTime', 'skippedResults', 'explainMetrics', 'done',
    ]);
    if (Object.keys(message).some((key) => !allowedMessageFields.has(key))) {
      throw new Error(`${context} returned malformed result message ${index}`);
    }
    if (message.transaction !== undefined && (typeof message.transaction !== 'string' || !message.transaction)) {
      throw new Error(`${context} returned malformed transaction ${index}`);
    }
    // Firestore's new-transaction selector is a valid metadata-only first
    // response, but its schema requires it to be the sole field. It is not by
    // itself proof that the result stream finished.
    if (message.transaction !== undefined) {
      if (Object.keys(message).length !== 1) {
        throw new Error(`${context} returned malformed transaction result ${index}`);
      }
      continue;
    }
    if (message.readTime !== undefined && (typeof message.readTime !== 'string' || !message.readTime)) {
      throw new Error(`${context} returned malformed readTime ${index}`);
    }
    if (message.skippedResults !== undefined
      && (!Number.isInteger(message.skippedResults) || message.skippedResults < 0)) {
      throw new Error(`${context} returned malformed skippedResults ${index}`);
    }
    if (message.explainMetrics !== undefined && !isPlainObject(message.explainMetrics)) {
      throw new Error(`${context} returned malformed explainMetrics ${index}`);
    }
    if (message.done !== undefined && typeof message.done !== 'boolean') {
      throw new Error(`${context} returned malformed done selector ${index}`);
    }
    if (Object.prototype.hasOwnProperty.call(message, 'document')) {
      const document = message.document;
      const allowedDocumentFields = new Set(['name', 'fields', 'createTime', 'updateTime']);
      if (!isPlainObject(document)
        || Object.keys(document).some((key) => !allowedDocumentFields.has(key))
        || typeof document.name !== 'string'
        || !/^projects\/[^/]+\/databases\/[^/]+\/documents\/(?:[^/]+\/[^/]+)(?:\/[^/]+\/[^/]+)*$/.test(document.name)) {
        throw new Error(`${context} returned malformed document result ${index}`);
      }
      if (document.fields !== undefined) validateFirestoreFields(document.fields, `${context} document ${index}`);
      if (document.createTime !== undefined && (typeof document.createTime !== 'string' || !document.createTime)) {
        throw new Error(`${context} returned malformed document createTime ${index}`);
      }
      if (document.updateTime !== undefined && (typeof document.updateTime !== 'string' || !document.updateTime)) {
        throw new Error(`${context} returned malformed document updateTime ${index}`);
      }
      documents.push(document);
      hasCompletionEvidence = true;
      continue;
    }
    // Empty queries canonically emit readTime/no-document. The current v1 API
    // may alternatively emit done:true with no document. Known partial-progress
    // messages are structurally valid, but done:false is explicitly nonterminal
    // and cannot turn an otherwise empty stream into a trusted empty result.
    const hasProgressMetadata = message.readTime !== undefined
      || message.skippedResults !== undefined
      || message.explainMetrics !== undefined
      || message.done !== undefined;
    if (!hasProgressMetadata) {
      throw new Error(`${context} returned malformed non-document result ${index}`);
    }
    if (message.done === true || (message.done === undefined && message.readTime !== undefined)) {
      hasCompletionEvidence = true;
    }
  }
  if (!documents.length && !hasCompletionEvidence) {
    throw new Error(`${context} returned an incomplete empty result`);
  }
  return documents;
}

/** Strict parser for a one-alias Firestore runAggregationQuery count. An
 * undecodable, partial, duplicated, or structurally unexpected response is
 * uncertainty—not a zero count. */
async function readRunAggregationResult(response, context = 'Firestore count') {
  const data = await readJsonStrict(response, context);
  if (!response.ok) {
    const message = isPlainObject(data) && isPlainObject(data.error) && typeof data.error.message === 'string'
      ? data.error.message
      : `${context} failed (${response.status})`;
    throw new Error(message);
  }
  if (!Array.isArray(data) || data.length === 0) throw new Error(`${context} returned an incomplete result`);
  let count = null;
  let readTime = '';
  let hasCompletionEvidence = false;
  for (const [index, message] of data.entries()) {
    if (!isPlainObject(message)
      || Object.keys(message).some((key) => !['result', 'transaction', 'readTime', 'done'].includes(key))) {
      throw new Error(`${context} returned malformed result message ${index}`);
    }
    if (message.transaction !== undefined) {
      if (typeof message.transaction !== 'string' || !message.transaction || Object.keys(message).length !== 1) {
        throw new Error(`${context} returned malformed transaction result ${index}`);
      }
      continue;
    }
    if (message.readTime !== undefined && (typeof message.readTime !== 'string' || !message.readTime)) {
      throw new Error(`${context} returned malformed readTime ${index}`);
    }
    if (message.readTime !== undefined) readTime = message.readTime;
    if (message.done !== undefined && typeof message.done !== 'boolean') {
      throw new Error(`${context} returned malformed done selector ${index}`);
    }
    if (message.result !== undefined) {
      if (count !== null
        || !isPlainObject(message.result)
        || Object.keys(message.result).length !== 1
        || !isPlainObject(message.result.aggregateFields)
        || Object.keys(message.result.aggregateFields).length !== 1
        || !Object.prototype.hasOwnProperty.call(message.result.aggregateFields, 'count')) {
        throw new Error(`${context} returned malformed aggregate result ${index}`);
      }
      const value = message.result.aggregateFields.count;
      validateFirestoreValue(value, context);
      if (!Object.prototype.hasOwnProperty.call(value, 'integerValue')) {
        throw new Error(`${context} returned a non-integer count`);
      }
      const parsed = Number(value.integerValue);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${context} returned an invalid count`);
      count = parsed;
    } else if (message.readTime === undefined && message.done === undefined) {
      throw new Error(`${context} returned malformed non-result message ${index}`);
    }
    if (message.done === true
      || (message.done === undefined && message.readTime !== undefined && message.result !== undefined)) {
      hasCompletionEvidence = true;
    }
  }
  if (count === null) throw new Error(`${context} returned no count`);
  if (!hasCompletionEvidence) throw new Error(`${context} returned an incomplete count`);
  if (!readTime) throw new Error(`${context} returned no readTime`);
  return { count, readTime };
}

export const readRunAggregationCount = async (response, context = 'Firestore count') =>
  (await readRunAggregationResult(response, context)).count;

// Parse a Firestore REST typed value back into plain JS. RECURSIVE mirror of toValue — array items
// may be maps (feedbackThread entries), which the old flat version silently dropped to null.
function fromValue(v) {
  validateFirestoreValue(v, 'Firestore document');
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
  validateFirestoreFields(fields);
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
    const rows = await readRunQueryDocuments(res, 'Post list query');
    for (const document of rows) {
      const id = requireAutoId(document.name.split('/').pop(), 'draft');
      out.push({ id, ...fromFields(document.fields) });
      if (out.length >= cap) return out;
    }
    if (rows.length < pageSize) return out;
    startAfter = rows[rows.length - 1].name;
  }
}

// The final serialized API response, not merely raw Firestore rows, must remain
// below this boundary. The collector measures transformed/allowlisted rows and
// reserves space for the envelope + opaque cursor; the route performs one exact
// final assertion before returning it.
export const DRAFT_PAGE_MAX_BYTES = 1024 * 1024;
export const DRAFT_RESPONSE_OVERHEAD_BYTES = 8 * 1024;
const DRAFT_SCAN_BATCH = 10;

export class DraftRowTooLargeError extends Error {
  constructor(id = '') {
    super('A draft is too large to return within the response limit');
    this.name = 'DraftRowTooLargeError';
    this.code = 'draft_row_too_large';
    this.status = 413;
    this.draftId = id;
  }
}

const stringFieldFilter = (fieldPath, value) => ({
  fieldFilter: {
    field: { fieldPath },
    op: 'EQUAL',
    value: { stringValue: String(value) },
  },
});

const booleanFieldFilter = (fieldPath, value) => ({
  fieldFilter: {
    field: { fieldPath },
    op: 'EQUAL',
    value: { booleanValue: value },
  },
});

function joinedFilters(filters) {
  if (filters.length === 1) return filters[0];
  return { compositeFilter: { op: 'AND', filters } };
}

function draftBaseFilters(uid, filters = {}) {
  if (typeof uid !== 'string' || !uid || !isPlainObject(filters)
    || Object.keys(filters).some((field) => !['clientId', 'client', 'platform', 'status', 'reviewStage'].includes(field))
    || Object.values(filters).some((value) => typeof value !== 'string' || !value)) {
    throw new Error('Draft query filters are malformed');
  }
  const out = [stringFieldFilter('uid', uid)];
  for (const field of ['clientId', 'client', 'platform', 'status', 'reviewStage']) {
    if (typeof filters[field] === 'string' && filters[field]) out.push(stringFieldFilter(field, filters[field]));
  }
  return out;
}

async function runDraftCount(env, token, filters, context, readTime = '') {
  const structuredQuery = {
    from: [{ collectionId: 'posts' }],
    where: joinedFilters(filters),
  };
  const res = await fetch(`${FS_BASE(env)}:runAggregationQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery,
        aggregations: [{ alias: 'count', count: {} }],
      },
      ...(readTime ? { readTime } : {}),
    }),
  });
  const result = await readRunAggregationResult(res, context);
  if (readTime && result.readTime !== readTime) {
    throw new Error(`${context} returned the wrong snapshot readTime`);
  }
  return result;
}

/** Exact count of non-template, non-suggestion drafts matching server-side
 * equality filters. Inclusion-exclusion keeps legacy rows with missing
 * isTemplate/source fields while excluding the two explicit parked classes. */
async function countFilteredDraftSnapshot(env, uid, filters = {}, requestedReadTime = '') {
  const token = await getAccessToken(env);
  const base = draftBaseFilters(uid, filters);
  const baseResult = await runDraftCount(env, token, base, 'Draft list count', requestedReadTime);
  const readTime = baseResult.readTime;
  const [templateResult, suggestionResult, templateSuggestionResult] = await Promise.all([
    runDraftCount(env, token, [...base, booleanFieldFilter('isTemplate', true)], 'Draft template count', readTime),
    runDraftCount(env, token, [...base, stringFieldFilter('source', 'suggestion')], 'Draft suggestion count', readTime),
    runDraftCount(env, token, [
      ...base,
      booleanFieldFilter('isTemplate', true),
      stringFieldFilter('source', 'suggestion'),
    ], 'Draft template-suggestion count', readTime),
  ]);
  return {
    total: filteredDraftTotal({
      all: baseResult.count,
      templates: templateResult.count,
      suggestions: suggestionResult.count,
      templateSuggestions: templateSuggestionResult.count,
    }),
    readTime,
  };
}

export const countFilteredDrafts = async (env, uid, filters = {}, readTime = '') =>
  (await countFilteredDraftSnapshot(env, uid, filters, readTime)).total;

export function filteredDraftTotal({ all, templates, suggestions, templateSuggestions }) {
  const values = [all, templates, suggestions, templateSuggestions];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Draft counts were malformed');
  }
  const total = all - templates - suggestions + templateSuggestions;
  if (templates > all || suggestions > all || templateSuggestions > templates
    || templateSuggestions > suggestions || total < 0) {
    throw new Error('Draft counts were internally inconsistent');
  }
  return total;
}

function draftRowIsEligible(row, filters = {}) {
  if (!isPlainObject(row)
    || typeof row._cursorName !== 'string'
    || !row._cursorName
    || requireDraftUpdatedAt(row._cursorUpdatedAt) !== row._cursorUpdatedAt) {
    throw new Error('Draft page contained a malformed row');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'isTemplate') && typeof row.isTemplate !== 'boolean') {
    throw new Error('Draft page contained a malformed isTemplate field');
  }
  if (Object.prototype.hasOwnProperty.call(row, 'source') && typeof row.source !== 'string') {
    throw new Error('Draft page contained a malformed source field');
  }
  if (row.isTemplate === true || row.source === 'suggestion') return false;
  return Object.entries(filters).every(([field, value]) => row[field] === value);
}

export function buildDraftListStructuredQuery(uid, startAfter = null, batchSize = DRAFT_SCAN_BATCH) {
  if (typeof uid !== 'string' || !uid || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 300) {
    throw new Error('Draft ordered query inputs are malformed');
  }
  const structuredQuery = {
    from: [{ collectionId: 'posts' }],
    where: joinedFilters([stringFieldFilter('uid', uid)]),
    select: { fields: DRAFT_PUBLIC_FIELD_PATHS.map((fieldPath) => ({ fieldPath })) },
    orderBy: [
      { field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
    ],
    limit: batchSize,
  };
  if (startAfter) {
    if (!isPlainObject(startAfter) || typeof startAfter.name !== 'string' || !startAfter.name) {
      throw new InvalidFirestoreIdError('draft cursor');
    }
    structuredQuery.startAt = {
      values: [
        { stringValue: requireDraftUpdatedAt(startAfter.updatedAt) },
        { referenceValue: startAfter.name },
      ],
      before: false,
    };
  }
  return structuredQuery;
}

/** Collect one bounded page from a cursor-driven reader. The reader may need to
 * skip any number of templates/suggestions, but retained allocation never grows
 * beyond the requested page and byte ceiling. */
export async function collectBoundedDraftRows({
  readPage,
  initialCursor = null,
  limit = 300,
  maxBytes = DRAFT_PAGE_MAX_BYTES,
  batchSize = DRAFT_SCAN_BATCH,
  transformRow = async (row) => row,
  filters = {},
}) {
  if (typeof readPage !== 'function') throw new Error('Draft page reader is required');
  if (typeof transformRow !== 'function') throw new Error('Draft row transformer is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid draft page limit');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid draft page byte limit');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 300) throw new Error('Invalid draft scan batch');

  const drafts = [];
  let retainedBytes = 2;
  let scanCursor = initialCursor;
  let lastReturnedCursor = null;
  let truncated = false;

  for (;;) {
    const rows = await readPage(scanCursor, batchSize);
    if (!Array.isArray(rows) || rows.length > batchSize) throw new Error('Draft page reader returned a malformed page');
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!isPlainObject(row) || typeof row._cursorName !== 'string' || !row._cursorName) {
        throw new Error('Draft page reader did not advance its cursor');
      }
      const rowCursor = {
        name: row._cursorName,
        updatedAt: requireDraftUpdatedAt(row._cursorUpdatedAt),
      };
      const advances = !scanCursor
        || rowCursor.updatedAt < scanCursor.updatedAt
        || (rowCursor.updatedAt === scanCursor.updatedAt && rowCursor.name < scanCursor.name);
      if (!advances) throw new Error('Draft page reader did not advance its cursor');
      scanCursor = rowCursor;
      if (!draftRowIsEligible(row, filters)) continue;

      const {
        _cursorName: _discardedCursor,
        _cursorUpdatedAt: _discardedUpdatedAt,
        ...rawPublicRow
      } = row;
      const publicRow = await transformRow(rawPublicRow);
      if (!isPlainObject(publicRow)) throw new Error('Draft row transformer returned a malformed row');
      const rowJson = JSON.stringify(publicRow);
      const rowBytes = new TextEncoder().encode(rowJson).byteLength + (drafts.length ? 1 : 0);
      if (drafts.length >= limit || retainedBytes + rowBytes > maxBytes) {
        if (!drafts.length) throw new DraftRowTooLargeError(String(publicRow.id || ''));
        truncated = true;
        break;
      }
      drafts.push(publicRow);
      retainedBytes += rowBytes;
      lastReturnedCursor = rowCursor;
    }

    if (truncated || rows.length < batchSize) break;
  }

  if (truncated && !lastReturnedCursor) throw new Error('Draft page could not make cursor progress');
  return {
    drafts,
    truncated,
    nextName: truncated ? lastReturnedCursor.name : '',
    nextUpdatedAt: truncated ? lastReturnedCursor.updatedAt : '',
    retainedBytes,
  };
}

/** Cursor-paginated draft list. The ordered query uses only uid + updatedAt so
 * one declared composite index covers every supported filter combination.
 * Optional equality filters, templates, and suggestions are applied while
 * scanning ten projected rows at a time. The exact filtered aggregation count
 * and final seen-count check make a missing order key fail closed rather than
 * silently shortening a page. */
export async function listDraftPage(env, uid, {
  filters = {},
  cursorId = '',
  cursorUpdatedAt = '',
  cursorSeen = 0,
  readTime = '',
  limit = 300,
  maxBytes = DRAFT_PAGE_MAX_BYTES,
  transformRow = async (row) => row,
} = {}) {
  if (!Number.isSafeInteger(cursorSeen) || cursorSeen < 0
    || (!!cursorId !== !!cursorUpdatedAt)
    || (!!cursorId !== !!readTime)
    || (!!cursorId !== (cursorSeen > 0))) {
    throw new InvalidFirestoreIdError('draft cursor');
  }
  const snapshot = await countFilteredDraftSnapshot(env, uid, filters, readTime);
  const { total } = snapshot;
  if (total === 0) {
    if (cursorSeen || cursorId) throw new InvalidFirestoreIdError('draft cursor');
    return { drafts: [], count: 0, total: 0, truncated: false, nextId: '', readTime: snapshot.readTime };
  }
  if (cursorSeen >= total) throw new InvalidFirestoreIdError('draft cursor');

  const token = await getAccessToken(env);
  const initialCursor = cursorId
    ? {
      name: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/posts/${requireAutoId(cursorId, 'draft cursor')}`,
      updatedAt: requireDraftUpdatedAt(cursorUpdatedAt),
    }
    : null;
  // Validate every advertised filter even though the ordered scan applies the
  // optional values locally to avoid a 32-index combination matrix.
  draftBaseFilters(uid, filters);
  const overheadReserve = Math.min(DRAFT_RESPONSE_OVERHEAD_BYTES, Math.floor(maxBytes / 4));
  const page = await collectBoundedDraftRows({
    initialCursor,
    limit,
    maxBytes: maxBytes - overheadReserve,
    transformRow,
    filters,
    readPage: async (startAfter, batchSize) => {
      const structuredQuery = buildDraftListStructuredQuery(uid, startAfter, batchSize);
      const res = await fetch(`${FS_BASE(env)}:runQuery`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery, readTime: snapshot.readTime }),
      });
      const documents = await readRunQueryDocuments(res, 'Draft page query');
      return documents.map((document) => {
        const fields = fromFields(document.fields);
        return {
          ...fields,
          id: requireAutoId(document.name.split('/').pop(), 'draft'),
          _cursorName: document.name,
          _cursorUpdatedAt: requireDraftUpdatedAt(fields.updatedAt),
        };
      });
    },
  });
  const seen = cursorSeen + page.drafts.length;
  if (seen > total
    || (page.truncated && seen >= total)
    || (!page.truncated && seen !== total)) {
    throw new Error('Draft pagination snapshot is incomplete or inconsistent; run the updatedAt backfill audit');
  }
  return {
    drafts: page.drafts,
    count: page.drafts.length,
    total,
    truncated: page.truncated,
    nextId: page.truncated ? requireAutoId(page.nextName.split('/').pop(), 'draft cursor') : '',
    nextUpdatedAt: page.truncated ? requireDraftUpdatedAt(page.nextUpdatedAt) : '',
    seen,
    readTime: snapshot.readTime,
  };
}

// Cheap review-state counts for /api/drafts?summary=1 (the frequently-polled cross-app attention
// strip). Pages with a __name__ cursor + a SELECT projection so it pulls ONLY the four fields the
// counts need — never post bodies / feedbackThread arrays. Semantics mirror the list summary
// EXACTLY: non-template; suggestions counted on their own; archived excluded from review;
// pending/changes_requested among the rest.
export async function countDraftSummary(env, uid) {
  const token = await getAccessToken(env);
  const pageSize = 300;
  let pendingReview = 0, changesRequested = 0, suggestions = 0, staged = 0;
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
        { fieldPath: 'reviewStage' },
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
    const rows = await readRunQueryDocuments(res, 'Draft summary query');
    for (const document of rows) {
      const f = document.fields || {};
      if (f.isTemplate?.booleanValue === true) continue;              // templates aren't drafts
      if ((f.source?.stringValue || '') === 'suggestion') { suggestions++; continue; }
      if ((f.status?.stringValue || '') === 'archived') continue;     // cleared → not review content
      const approval = f.approvalStatus?.stringValue || '';
      // HONESTY FIX: 'pending' was the default on every draft from the moment it was
      // created, so pendingReview counted drafts the client had never been shown — POM's
      // attention strip reported work waiting on the client that was actually waiting on
      // US. A staged draft is now counted separately. The internal summary keeps
      // the historical absent=in_review meaning during the guarded backfill window;
      // strict guest/member rules fail missing values closed after rollout.
      if ((f.reviewStage?.stringValue || 'in_review') === 'private') { staged++; continue; }
      if (approval === 'pending') pendingReview++;
      else if (approval === 'changes_requested') changesRequested++;
    }
    if (rows.length < pageSize) break;
    startAfter = rows[rows.length - 1].name;
  }
  // `staged` is additive — consumers that don't know the field simply ignore it.
  return { pendingReview, changesRequested, suggestions, staged };
}

export async function getPost(env, id) {
  const safeId = encodedAutoId(id, 'draft');
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/posts/${safeId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Get failed (${res.status})`);
  return { id: requireAutoId(id, 'draft'), ...fromFields(data.fields), _updateTime: data.updateTime || '' };
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
  const safeId = encodedAutoId(id, 'draft');
  const token = await getAccessToken(env);
  const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FS_BASE(env)}/posts/${safeId}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(patch) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Update failed (${res.status})`);
  return { id: requireAutoId(id, 'draft'), ...fromFields(data.fields) };
}

export class FirestoreUpdateConflictError extends Error {
  constructor(message = 'Firestore document changed concurrently') {
    super(message);
    this.name = 'FirestoreUpdateConflictError';
    this.code = 'update_conflict';
    this.retryable = true;
  }
}

/** Generic optimistic transaction loop used by the Worker REST client.
 *
 * Firestore's REST `currentDocument.updateTime` is the compare-and-swap token.
 * A conflicting review write makes commit reject, so the mutation builder runs
 * again against the new live document instead of overwriting its review state.
 */
export async function runUpdateTimeTransaction({ read, build, commit, maxAttempts = 5 }) {
  let lastConflict;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const live = await read();
    if (!live) {
      const err = new Error('Document no longer exists');
      err.code = 'not_found';
      err.status = 404;
      throw err;
    }
    const mutation = await build(live, attempt);
    try {
      await commit(live, mutation, attempt);
      return { live, mutation, attempts: attempt + 1 };
    } catch (err) {
      if (!err?.retryable) throw err;
      lastConflict = err;
    }
  }
  throw lastConflict || new FirestoreUpdateConflictError();
}

export function buildPostMutationWrite(env, id, updateTime, mutation) {
  const safeId = requireAutoId(id, 'draft');
  if (!updateTime) throw new Error('Firestore updateTime missing from draft read');
  const patch = mutation?.patch || {};
  const append = mutation?.append || null;
  if (!Object.keys(patch).length && !append) return null;
  if (append) requireDocumentSegment(append.field, 'field');

  const write = {
    update: {
      name: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/posts/${safeId}`,
      fields: toFields(patch),
    },
    updateMask: { fieldPaths: Object.keys(patch) },
    currentDocument: { updateTime },
  };
  if (append) {
    write.updateTransforms = [{
      fieldPath: append.field,
      appendMissingElements: { values: [toValue(append.entry)] },
    }];
  }
  return write;
}

async function commitPostMutation(env, id, updateTime, mutation) {
  const write = buildPostMutationWrite(env, id, updateTime, mutation);
  if (!write) return;

  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [write] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (
      res.status === 409
      || res.status === 412
      || ['ABORTED', 'FAILED_PRECONDITION'].includes(data?.error?.status)
    ) throw new FirestoreUpdateConflictError();
    throw new Error(data?.error?.message || `Update failed (${res.status})`);
  }
}

export async function mutatePostAtomically(env, id, build, { maxAttempts = 5 } = {}) {
  requireAutoId(id, 'draft');
  const result = await runUpdateTimeTransaction({
    maxAttempts,
    read: () => getPost(env, id),
    build,
    commit: (live, mutation) => commitPostMutation(env, id, live._updateTime, mutation),
  });
  return { ...result, document: await getPost(env, id) };
}

export async function deletePost(env, id) {
  const safeId = encodedAutoId(id, 'draft');
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/posts/${safeId}`, {
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
  const safeToken = requireShareToken(token);
  const accessToken = await getAccessToken(env);
  const url = `${FS_BASE(env)}/shares?documentId=${encodeURIComponent(safeToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error?.message || `Share create failed (${res.status})`);
  return safeToken;
}

export async function getShareDoc(env, token) {
  const safeToken = requireShareToken(token);
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/shares/${encodedShareToken(safeToken)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Share get failed (${res.status})`);
  return { id: safeToken, ...fromFields(data.fields) };
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
    const rows = await readRunQueryDocuments(res, 'Share list query');
    for (const document of rows) {
      const id = requireShareToken(document.name.split('/').pop());
      out.push({ id, ...fromFields(document.fields) });
      if (out.length >= cap) return out;
    }
    if (rows.length < pageSize) return out;
    startAfter = rows[rows.length - 1].name;
  }
}

export async function deleteShareDoc(env, token) {
  const safeToken = requireShareToken(token);
  const accessToken = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/shares/${encodedShareToken(safeToken)}`, {
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
  return requireAutoId((out.name || '').split('/').pop(), 'automation');
}

export async function getAutomation(env, id) {
  const safeId = encodedAutoId(id, 'automation');
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/automations/${safeId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Automation get failed (${res.status})`);
  return { id: requireAutoId(id, 'automation'), ...fromFields(data.fields) };
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
  const documents = await readRunQueryDocuments(res, 'Automation list query');
  return documents
    .map(document => ({
      id: requireAutoId(document.name.split('/').pop(), 'automation'),
      ...fromFields(document.fields),
    }));
}

export async function updateAutomation(env, id, patch) {
  const safeId = encodedAutoId(id, 'automation');
  const token = await getAccessToken(env);
  const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${FS_BASE(env)}/automations/${safeId}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(patch) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Automation update failed (${res.status})`);
  return { id: requireAutoId(id, 'automation'), ...fromFields(data.fields) };
}

export async function deleteAutomation(env, id) {
  const safeId = encodedAutoId(id, 'automation');
  const token = await getAccessToken(env);
  const res = await fetch(`${FS_BASE(env)}/automations/${safeId}`, {
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
  const documents = await readRunQueryDocuments(res, 'Client lookup query');
  return documents.length ? fromFields(documents[0].fields) : null;
}

// Resolve the canonical clientId an existing post already uses for a display
// name, so an automation binds to the same tenant key its posts use rather than
// trusting a client-supplied slug that could drift (e.g. after a backfill --map
// override). Returns null for a brand-new client with no posts yet — the caller
// then falls back to the supplied id. Mirrors the app's clientIdByName (which is
// also derived from posts), so existing clients resolve identically.
export async function resolveClientId(env, clientName) {
  if (!clientName || !env.OWNER_UID) return null;
  // This runs on EVERY draft + automation create, and it used to pull the entire
  // posts collection (every field of every post across every client) to read one
  // string off one document. A single-field equality query on `client` rides
  // Firestore's automatic index — no composite index needed — and a small cap is
  // plenty: we only need one post that already carries the tenant key.
  //
  // Deliberately do not translate query/parse errors into `null`: null means a
  // successful lookup found no existing tenant. Treating malformed Firestore
  // output as that valid empty state can mint a phantom client id.
  const rows = await listDocsWhere(env, 'posts', 'client', clientName, {
    pageSize: 40, cap: 40, select: ['uid', 'clientId'],
  });
  // Every Spool post is attributed to the owner uid by design; verify rather than
  // assume, so a stray doc can never hand back another workspace's tenant key.
  const hit = rows.find(r => r.fields?.uid === env.OWNER_UID && r.fields?.clientId);
  return hit ? hit.fields.clientId : null;
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
  `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${requireCollectionId(collectionId)}/${requireDocumentSegment(id)}`;

// Every doc in `collectionId` whose `fieldPath` string-equals `value`. Pages with a __name__
// cursor (single-field equality + orderBy(__name__) rides the automatic index — no composite).
// Returns [{ id, name, fields, raw }] — `fields` parsed to plain JS, `raw` the untouched REST
// typed fields (for lossless copies). `cap` bounds a runaway tenant (default 5000).
export async function listDocsWhere(env, collectionId, fieldPath, value, { pageSize = 300, cap = 5000, select } = {}) {
  const safeCollectionId = requireCollectionId(collectionId);
  requireDocumentSegment(fieldPath, 'field');
  const token = await getAccessToken(env);
  const out = [];
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: safeCollectionId }],
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
    const rows = await readRunQueryDocuments(res, `${safeCollectionId} lifecycle query`);
    for (const document of rows) {
      const raw = document.fields || {};
      out.push({ id: document.name.split('/').pop(), name: document.name, fields: fromFields(raw), raw });
      if (out.length >= cap) { out.truncated = true; return out; } // caller MUST surface this — never a silent partial
    }
    if (rows.length < pageSize) return out;
    startAfter = rows[rows.length - 1].name;
  }
}

// One doc's raw fields by id (null when absent). Used to inspect a rename TARGET before merging.
function docResourceUrl(env, collectionId, id) {
  return `${FS_BASE(env)}/${requireCollectionId(collectionId)}/${encodeURIComponent(requireDocumentSegment(id))}`;
}
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
// Every /media key referenced from a markdown body: the editor's toolbar image
// button inserts images INLINE as ![alt](…/media/<key>), and long-form posts often
// carry several. Those references live in `content`, not `imageUrl`.
export async function listAllImageUrls(env, pageSize = 1000) {
  const token = await getAccessToken(env);
  const urls = new Set();
  let startAfter = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'posts' }],
      // `content` is projected too, because the GC deletes anything it can't see
      // referenced: an inline markdown image was invisible here, so once it aged
      // past the grace window the nightly sweep deleted a picture that was still
      // published in a post. A larger projection is the cheap half of that trade.
      select: { fields: [{ fieldPath: 'imageUrl' }, { fieldPath: 'content' }] },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: pageSize
    };
    if (startAfter) structuredQuery.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const res = await fetch(`${FS_BASE(env)}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery })
    });
    const rows = await readRunQueryDocuments(res, 'Image-reference GC query');
    collectPostImageReferences(rows, urls);
    if (rows.length < pageSize) return urls;
    startAfter = rows[rows.length - 1].name;
  }
}

/** Collect the two projected reference fields with application-level shape
 * checks. A structurally valid map/null in imageUrl/content is still uncertain
 * for GC and must stop the sweep rather than be silently treated as no URL. */
export function collectPostImageReferences(documents, urls = new Set()) {
  for (const document of documents) {
    const fields = document.fields || {};
    for (const fieldName of ['imageUrl', 'content']) {
      const value = fields[fieldName];
      if (value !== undefined && (!isPlainObject(value)
        || Object.keys(value).length !== 1
        || typeof value.stringValue !== 'string')) {
        throw new Error(`Image-reference GC query returned non-string ${fieldName}`);
      }
    }
    const u = fields.imageUrl?.stringValue;
    if (u) urls.add(u);
    const body = fields.content?.stringValue;
    if (body) {
      // Use the exact standards-aware destination parser used for output and
      // approval identity. This sees reference definitions, clickable media,
      // raw img/source srcset, and browser-decoded character references that
      // a `/media/` regex would miss (and could otherwise orphan a live key).
      transformMediaDestinations(body, (candidate) => {
        urls.add(candidate);
        return candidate;
      });
    }
  }
  return urls;
}
