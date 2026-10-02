import { validateIntent, sameValue } from './createJournal';
import { REVIEW_DETAILS_FIELDS, copyReviewDetailsFields, isValidReviewDetails } from './reviewDetails';

const invalidField = () => { throw new Error('Spool has not confirmed this save. The saved response contained an invalid field. Keep this copy for review.'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encodeValue = (value, key, mediaItem = false) => value === null ? { nullValue: null }
  : typeof value === 'string' ? { stringValue: value }
  : typeof value === 'boolean' ? { booleanValue: value }
    : key === 'reviewDetailsVersion' && value === 1 ? { integerValue: '1' }
    : Array.isArray(value) ? { arrayValue: { values: value.map(item => encodeValue(item, key, key === 'reviewMedia')) } }
      : key === 'reviewMedia' && mediaItem && object(value) ? { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, encodeValue(entry, name)])) } }
      : (() => { throw new Error('Unsupported new-thread field'); })();
const decodeValue = (value, key, mediaItem = false, required = true) => {
  if (!object(value) || Object.keys(value).length !== 1) return invalidField();
  const kind = Object.keys(value)[0];
  if (kind === 'nullValue') return value.nullValue === null ? null : invalidField();
  if (kind === 'stringValue') return typeof value.stringValue === 'string' ? value.stringValue : invalidField();
  if (kind === 'booleanValue') return typeof value.booleanValue === 'boolean' ? value.booleanValue : invalidField();
  if (kind === 'integerValue') {
    if (key === 'reviewDetailsVersion') return value.integerValue === '1' ? 1 : invalidField();
    return required ? invalidField() : undefined;
  }
  if (kind === 'arrayValue') {
    const array = value.arrayValue;
    if (!object(array) || Object.keys(array).some(name => name !== 'values')
      || (Object.prototype.hasOwnProperty.call(array, 'values') && !Array.isArray(array.values))
      || mediaItem) return invalidField();
    return (array.values || []).map(item => decodeValue(item, key, key === 'reviewMedia', required));
  }
  if (kind === 'mapValue' && key === 'reviewMedia' && mediaItem) {
    const map = value.mapValue;
    if (!object(map) || Object.keys(map).length !== 1 || !object(map.fields)
      || Object.keys(map.fields).length !== 4
      || !['id', 'url', 'label', 'version'].every(name => Object.prototype.hasOwnProperty.call(map.fields, name))) return invalidField();
    return Object.fromEntries(Object.entries(map.fields).map(([name, entry]) => {
      if (!object(entry) || Object.keys(entry).length !== 1 || typeof entry.stringValue !== 'string') return invalidField();
      return [name, entry.stringValue];
    }));
  }
  // Preserve the legacy treatment of unrelated response metadata, while never
  // accepting an unsupported kind for this attempt's frozen/recognized fields.
  if (required) return invalidField();
  return undefined;
};

// Firebase ID tokens enforce the existing Firestore rules. This never uses the
// worker/service-account identity and never updates or recreates an existing ID.
export async function intentRequest({ record, getUser, maySend = () => true, create = false, beforeCreate, fetcher = fetch }) {
  validateIntent(record, record.scope);
  const user = getUser();
  const active = () => maySend() && user && !user.isAnonymous && getUser() === user && user.uid === record.scope.principalId;
  if (!active()) throw new Error('Your sign-in changed. Reopen this draft under its original account.');
  const token = await user.getIdToken();
  if (!active()) throw new Error('Your sign-in changed. No new request was sent.');
  if (create) {
    await beforeCreate(); // Durable admission precedes any possible dispatch.
    if (!active()) throw new Error('The editor or sign-in changed. Check previous save when you return.');
  }
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(record.scope.projectId)}/databases/(default)/documents/posts`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetcher(create ? `${base}?documentId=${encodeURIComponent(record.id)}` : `${base}/${encodeURIComponent(record.id)}`, {
      method: create ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(create ? { 'Content-Type': 'application/json' } : {}) },
      ...(create ? { body: JSON.stringify({ fields: Object.fromEntries(Object.entries(record.payload).map(([key, value]) => [key, encodeValue(value, key)])) }) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!active()) throw new Error('Your session changed. The original save still needs checking.');
    if (!response.ok) throw new Error('Spool has not confirmed this save. The thread may have changed, moved or been deleted. Keep this copy and ask the operator to review it.');
    const body = await response.json();
    if (!active()) throw new Error('Your session changed. The original save still needs checking.');
    const expected = `projects/${record.scope.projectId}/databases/(default)/documents/posts/${record.id}`;
    const baseline = record.state === 'confirmed' ? record.baseline : record.payload;
    if (!object(body.fields || {})) return invalidField();
    const post = Object.fromEntries(Object.entries(body.fields || {}).map(([key, value]) => [key, decodeValue(value, key, false,
      (Object.prototype.hasOwnProperty.call(baseline || {}, key) && baseline[key] !== undefined) || REVIEW_DETAILS_FIELDS.includes(key))]));
    if (!isValidReviewDetails(post)) return invalidField();
    const frozenDetails = copyReviewDetailsFields(baseline || {});
    const returnedDetails = copyReviewDetailsFields(post);
    if (!baseline || body.name !== expected || !sameValue(frozenDetails, returnedDetails)
      || Object.entries(baseline).some(([key, value]) => key !== 'id' && !REVIEW_DETAILS_FIELDS.includes(key) && !sameValue(value, post[key]))) throw new Error('The saved thread differs from this attempt. Open the existing thread to review it; this recovery copy has not overwritten anything.');
    return { ...post, id: record.id };
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Spool has not confirmed this save. Keep this copy and use Check previous save when your connection returns.');
    throw error;
  } finally { clearTimeout(timeout); }
}
