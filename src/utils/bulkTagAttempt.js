import { doc, getDocFromServer, runTransaction } from 'firebase/firestore';
import { archiveBaselineFor } from './archivePost';
import { canonicalBulkTags, mergeBulkTags } from './bulkTags';
import { nextSaveUpdatedAt } from './postSave';
import { OPERATOR_UID } from '../config/roles';

export const BULK_TAG_THREAD_LIMIT = 200;
const FIELDS = ['uid', 'clientId', 'client', 'status', 'updatedAt'];
const sameTags = (a, b) => a.length === b.length && a.every((tag, index) => tag === b[index]);
const stop = (code, message) => Object.assign(new Error(message), { code });
const sameBaseline = (a, b) => FIELDS.every(field => a[field] === b[field]) && sameTags(a.tags, b.tags);

// The hook's tags are display-sanitized. Fresh stored tags must independently
// pass strict validation before they can become a write baseline; this is not
// an implicit repair of malformed legacy records.
export function bulkTagBaselineFor(post) {
  const baseline = archiveBaselineFor(post);
  if (!baseline || baseline.uid !== OPERATOR_UID || post.source === 'suggestion' || post.forClientId || post.isTemplate) return null;
  try {
    const tags = canonicalBulkTags(post.tags === undefined ? [] : post.tags);
    return Object.freeze({ ...baseline, tags: Object.freeze(tags) });
  } catch { return null; }
}

// One atomic tag operation, not a sequence of partially committed chunks. All
// fresh reads/validation precede every write. The ever-prepared marker stays
// conservative across SDK retries and lost responses; it is not cancellation
// proof. The caller owns the page-memory uncertainty hold and actor admission.
export async function runBulkTagAttempt({ db, items, tags, action, actorUid, assertAdmission }) {
  let writePrepared = false;
  let plan = [];
  let incoming = [];
  const candidates = [];
  const receipt = confirmed => Object.freeze({
    actorUid, projectId: db?.app?.options?.projectId || null,
    action, tags: Object.freeze([...incoming]), confirmed,
    items: Object.freeze(plan.map(({ id, baseline }) => Object.freeze({ id, baseline }))),
    candidates: Object.freeze([...candidates]),
  });
  try {
    if (typeof assertAdmission !== 'function') throw stop('bulk_tag_admission', 'Sign-in needs checking.');
    assertAdmission();
    if (typeof actorUid !== 'string' || !actorUid || actorUid.length > 128 || actorUid.includes('/')) {
      throw stop('bulk_tag_admission', 'Sign-in needs checking.');
    }
    incoming = canonicalBulkTags(tags);
    if (!incoming.length || !['add', 'remove'].includes(action)) throw stop('bulk_tag_input', 'Choose tags to add or remove.');
    if (!Array.isArray(items) || !items.length || items.length > BULK_TAG_THREAD_LIMIT) {
      throw stop('bulk_tag_selection', `Select 1–${BULK_TAG_THREAD_LIMIT} threads.`);
    }
    const ids = new Set();
    plan = [];
    for (const item of items) {
      const baseline = bulkTagBaselineFor(item?.baseline);
      if (!item || typeof item.id !== 'string' || !item.id || item.id.includes('/')
        || ids.has(item.id) || item.postRef?.id !== item.id || !baseline) {
        throw stop('bulk_tag_selection', 'Selected thread details need checking.');
      }
      ids.add(item.id);
      // Refuse a visible overflow before submitting a transaction too.
      mergeBulkTags(baseline.tags, incoming, action);
      plan.push(Object.freeze({ id: item.id, postRef: item.postRef, baseline }));
    }
    const outcome = await runTransaction(db, async transaction => {
      assertAdmission();
      const snapshots = await Promise.all(plan.map(item => transaction.get(item.postRef)));
      assertAdmission();
      const updates = [];
      const unchangedIds = [];
      for (let index = 0; index < plan.length; index++) {
        const item = plan[index];
        const snapshot = snapshots[index];
        if (item.postRef.id !== item.id) throw stop('bulk_tag_conflict', 'Selected thread reference changed.');
        if (!snapshot.exists()) throw stop('bulk_tag_conflict', 'A selected thread no longer exists.');
        const live = bulkTagBaselineFor(snapshot.data());
        if (!live) throw stop('bulk_tag_conflict', 'A selected thread needs review before changing tags.');
        if (FIELDS.some(field => live[field] !== item.baseline[field]) || !sameTags(live.tags, item.baseline.tags)) {
          throw stop('bulk_tag_conflict', 'A selected thread changed. Check the current list.');
        }
        const next = mergeBulkTags(live.tags, incoming, action);
        if (sameTags(next, live.tags)) unchangedIds.push(item.id);
        else updates.push({ item, patch: { tags: next, updatedAt: nextSaveUpdatedAt(live) } });
      }
      assertAdmission();
      // Retain each complete callback candidate, rather than mixing expected
      // revisions from different SDK retries. This receipt is independent of
      // the current selection and contains no caption, media or feedback.
      const patches = new Map(updates.map(({ item, patch }) => [item.id, patch]));
      const candidate = Object.freeze(plan.map(({ id, baseline }) => Object.freeze({
        id, baseline: Object.freeze({ ...baseline, ...patches.get(id),
          tags: Object.freeze([...(patches.get(id)?.tags || baseline.tags)]) }),
      })));
      for (const { item, patch } of updates) {
        assertAdmission();
        if (!writePrepared || candidates.at(-1) !== candidate) candidates.push(candidate);
        writePrepared = true;
        transaction.update(item.postRef, patch);
      }
      return { changedIds: updates.map(({ item }) => item.id), unchangedIds };
    });
    if (!outcome || !Array.isArray(outcome.changedIds) || !Array.isArray(outcome.unchangedIds)
      || outcome.changedIds.length + outcome.unchangedIds.length !== plan.length
      || new Set([...outcome.changedIds, ...outcome.unchangedIds]).size !== plan.length
      || [...outcome.changedIds, ...outcome.unchangedIds].some(id => !ids.has(id))) {
      throw stop('bulk_tag_control', 'The transaction result could not be checked.');
    }
    try { assertAdmission(); }
    catch (error) {
      return { status: writePrepared ? 'needs_checking' : 'stopped', confirmed: true, writePrepared,
        ...outcome, receipt: receipt(true), error };
    }
    return { status: 'complete', confirmed: true, ...outcome, receipt: receipt(true) };
  } catch (error) {
    return { status: writePrepared ? 'needs_checking' : 'stopped', confirmed: false, writePrepared,
      ...(writePrepared ? { receipt: receipt(false) } : {}), error };
  }
}

// Server-only inspection of the original operation, never a mutation/retry.
// Matching one entire candidate confirms current saved tags/revisions, not
// historic provider acknowledgement or cancellation of an unknown request.
export async function checkBulkTagReceipt({ db, receipt, actorUid, assertAdmission }) {
  try {
    if (typeof assertAdmission !== 'function') throw stop('bulk_tag_admission', 'Sign-in needs checking.');
    assertAdmission();
    if (!receipt || typeof actorUid !== 'string' || !actorUid || receipt.actorUid !== actorUid || !receipt.projectId
      || receipt.projectId !== db?.app?.options?.projectId || !Array.isArray(receipt.items)
      || !receipt.items.length || receipt.items.length > BULK_TAG_THREAD_LIMIT
      || !Array.isArray(receipt.candidates) || !receipt.candidates.length) {
      throw stop('bulk_tag_receipt', 'The original tag update is unavailable.');
    }
    const ids = receipt.items.map(item => item.id);
    if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || id.includes('/'))) {
      throw stop('bulk_tag_receipt', 'The original thread list needs checking.');
    }
    const snapshots = await Promise.all(ids.map(id => getDocFromServer(doc(db, 'posts', id))));
    assertAdmission();
    const current = snapshots.map((snapshot, index) => {
      if (snapshot.id !== ids[index] || !snapshot.exists()) throw stop('bulk_tag_check', 'A thread is unavailable.');
      const baseline = bulkTagBaselineFor(snapshot.data());
      if (!baseline) throw stop('bulk_tag_check', 'A thread needs inspection.');
      return baseline;
    });
    const matches = receipt.candidates.some(candidate => candidate.length === ids.length && candidate.every((expected, index) =>
      expected.id === ids[index] && bulkTagBaselineFor(expected.baseline) && sameBaseline(expected.baseline, current[index])));
    assertAdmission();
    return { status: matches ? 'matched' : 'needs_checking', count: ids.length };
  } catch (error) { return { status: 'needs_checking', error }; }
}
