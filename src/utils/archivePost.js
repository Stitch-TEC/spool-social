import { runTransaction } from 'firebase/firestore';
import { STATUS } from '../constants';
import { hasProtectedReviewDetails } from './reviewDetails';
import { nextSaveUpdatedAt } from './postSave';

const CLIENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASELINE_FIELDS = ['uid', 'clientId', 'client', 'status', 'updatedAt'];
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
function validRevision(value) {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, digits = '') => `.${digits.padEnd(3, '0')}Z`);
  return new Date(milliseconds).toISOString() === canonical;
}
function stop(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// No display-name slug fallback or invented revision. Older incompatible rows
// need inspection; a missing timestamp is not proof that a thread is unchanged.
export function archiveBaselineFor(post) {
  if (!post || typeof post !== 'object' || Array.isArray(post)
    || !BASELINE_FIELDS.every(field => Object.prototype.hasOwnProperty.call(post, field))
    || hasProtectedReviewDetails(post)
    || typeof post.uid !== 'string' || !post.uid || post.uid.trim() !== post.uid
    || typeof post.clientId !== 'string' || post.clientId.length > 64 || !CLIENT_ID.test(post.clientId)
    || typeof post.client !== 'string' || !post.client.trim()
    || !Object.values(STATUS).includes(post.status) || !validRevision(post.updatedAt)) return null;
  return Object.freeze(Object.fromEntries(BASELINE_FIELDS.map(field => [field, post[field]])));
}

// A fulfilled transaction confirms the update; a lost response after a write
// was prepared does not prove cancellation. The caller owns a page-memory hold.
export async function runArchiveStatusAttempt({ db, postRef, baseline, action, assertAdmission }) {
  let writePrepared = false;
  let patch = null;
  try {
    if (typeof assertAdmission !== 'function') throw stop('archive_admission', 'Sign-in needs checking.');
    assertAdmission();
    if (!archiveBaselineFor(baseline)) throw stop('archive_baseline', 'Thread details need checking.');
    const target = action === 'archive' ? STATUS.ARCHIVED : action === 'restore' ? STATUS.DRAFT : null;
    if (!target || (action === 'archive' ? baseline.status === STATUS.ARCHIVED : baseline.status !== STATUS.ARCHIVED)) {
      throw stop('archive_conflict', 'Thread status changed.');
    }
    await runTransaction(db, async transaction => {
      assertAdmission();
      const snapshot = await transaction.get(postRef);
      assertAdmission();
      if (!snapshot.exists()) throw stop('archive_conflict', 'Thread no longer exists.');
      const live = snapshot.data();
      if (hasProtectedReviewDetails(live)) throw stop('archive_protected', 'Review details are read-only.');
      if (!archiveBaselineFor(live) || BASELINE_FIELDS.some(field => live[field] !== baseline[field])) {
        throw stop('archive_conflict', 'Thread changed since it was selected.');
      }
      patch = { status: target, updatedAt: nextSaveUpdatedAt(live) };
      assertAdmission();
      writePrepared = true;
      transaction.update(postRef, patch);
    });
    if (!patch) throw stop('archive_control', 'The transaction result could not be checked.');
    try { assertAdmission(); }
    catch (error) { return { status: 'needs_checking', confirmed: true, writePrepared, error }; }
    return { status: 'complete', confirmed: true, patch };
  } catch (error) {
    return { status: writePrepared ? 'needs_checking' : 'stopped', confirmed: false, writePrepared, error };
  }
}
