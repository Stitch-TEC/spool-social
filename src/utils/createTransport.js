import { validateIntent, sameValue } from './createJournal';

const encodeValue = value => typeof value === 'string' ? { stringValue: value }
  : typeof value === 'boolean' ? { booleanValue: value }
    : Array.isArray(value) ? { arrayValue: { values: value.map(encodeValue) } }
      : (() => { throw new Error('Unsupported new-thread field'); })();
const decodeValue = value => 'stringValue' in value ? value.stringValue
  : 'booleanValue' in value ? value.booleanValue
    : 'arrayValue' in value ? (value.arrayValue.values || []).map(decodeValue)
      : undefined;

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
      ...(create ? { body: JSON.stringify({ fields: Object.fromEntries(Object.entries(record.payload).map(([key, value]) => [key, encodeValue(value)])) }) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!active()) throw new Error('Your session changed. The original save still needs checking.');
    if (!response.ok) throw new Error('Spool has not confirmed this save. The thread may have changed, moved or been deleted. Keep this copy and ask the operator to review it.');
    const body = await response.json();
    if (!active()) throw new Error('Your session changed. The original save still needs checking.');
    const expected = `projects/${record.scope.projectId}/databases/(default)/documents/posts/${record.id}`;
    const post = Object.fromEntries(Object.entries(body.fields || {}).map(([key, value]) => [key, decodeValue(value)]));
    const baseline = record.state === 'confirmed' ? record.baseline : record.payload;
    if (!baseline || body.name !== expected || Object.entries(baseline).some(([key, value]) => key !== 'id' && !sameValue(value, post[key]))) throw new Error('The saved thread differs from this attempt. Open the existing thread to review it; this recovery copy has not overwritten anything.');
    return { ...post, id: record.id };
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Spool has not confirmed this save. Keep this copy and use Check previous save when your connection returns.');
    throw error;
  } finally { clearTimeout(timeout); }
}
