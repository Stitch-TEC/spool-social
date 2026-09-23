import { EDITOR_WORK_FIELDS, reconcileEditorSave } from './editorSaveState';
import { OPERATOR_UID } from '../config/roles';

export const CREATE_JOURNAL_DATABASE = 'spool-create-recovery-v3';
const STORE = 'intents';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[a-zA-Z0-9_-]{20,80}$/;
const PAYLOAD_FIELDS = [...EDITOR_WORK_FIELDS, 'slug', 'uid', 'clientId', 'approvalStatus', 'feedback', 'reviewStage', 'createdAt', 'updatedAt'];
const validPayloadTypes = p => p && PAYLOAD_FIELDS.every(k => k === 'tags' ? Array.isArray(p[k]) && p[k].every(t => typeof t === 'string') : typeof p[k] === (k === 'isTemplate' ? 'boolean' : 'string'));
export const workCopy = form => Object.fromEntries(EDITOR_WORK_FIELDS.map(k => [k, form[k] ?? (k === 'tags' ? [] : k === 'isTemplate' ? false : '')]));
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createScope({ principalId, clientId, projectId, isTemplate = false }) {
  if (typeof principalId !== 'string' || !principalId.trim() || !SLUG.test(clientId || '')
    || typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{3,62}$/.test(projectId)) return null;
  const scope = { version: 3, principalId, clientId, projectId, database: '(default)', flow: isTemplate ? 'template' : 'thread' };
  return { ...scope, key: JSON.stringify(Object.values(scope)) };
}

export function validWork(work) {
  return work && typeof work === 'object' && EDITOR_WORK_FIELDS.every(key => key === 'tags'
    ? Array.isArray(work[key]) && work[key].every(t => typeof t === 'string')
    : typeof work[key] === (key === 'isTemplate' ? 'boolean' : 'string'));
}

export function validateIntent(record, scope) {
  if (!record || !scope || !sameValue(record.scope, scope) || !ID.test(record.id || '')
    || !Number.isSafeInteger(record.revision) || record.revision < 1
    || !['draft', 'discarded', 'prepared', 'submitted', 'confirmed', 'complete'].includes(record.state)
    || !validWork(record.work)) throw new Error('This device’s previous save record could not be verified. Copy your text and ask the operator to review it.');
  if (['draft', 'discarded'].includes(record.state) && record.payload === null && record.submittedWork === null) return record;
  const p = record.payload;
  if (!validWork(record.submittedWork) || !p || Object.keys(p).some(k => !PAYLOAD_FIELDS.includes(k))
    || !validPayloadTypes(p)
    || p.clientId !== scope.clientId || p.uid !== OPERATOR_UID
    || !['draft', 'scheduled', 'posted', 'archived'].includes(p.status)
    || !['pending', 'approved', 'changes_requested'].includes(p.approvalStatus)
    || !['private', 'in_review'].includes(p.reviewStage)
    || typeof p.createdAt !== 'string' || !Number.isFinite(Date.parse(p.createdAt)) || p.updatedAt !== p.createdAt
    || typeof p.content !== 'string' || !p.content.trim() || typeof p.client !== 'string'
    || !!p.isTemplate !== (scope.flow === 'template')) throw new Error('This device’s previous save identity could not be verified. No request was sent.');
  if (['confirmed', 'complete'].includes(record.state) && (!validWork(record.baselineWork) || !validPayloadTypes(record.baseline)
    || record.baseline?.id !== record.id || record.baseline?.clientId !== scope.clientId
    || record.baseline?.uid !== p.uid || record.baseline?.createdAt !== p.createdAt)) throw new Error('This device’s saved-thread identity could not be verified. Keep this copy for review.');
  return record;
}

// Resolve only on transaction COMPLETE: a successful put request can still be
// rolled back by quota errors or browser shutdown. No dependency/polyfill.
export function createJournal(factory = globalThis.indexedDB) {
  const transact = (scope, change) => new Promise((resolve, reject) => {
    if (!scope || !factory) { reject(new Error('Device recovery is unavailable. No new thread was sent. Keep this editor open or copy your text.')); return; }
    let db; let tx; let finished = false; let result;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      db?.close();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { try { tx?.abort(); } catch { /* already ended */ } finish(new Error('Device recovery did not respond. No new request can start; copy your text and try again.')); }, 5000);
    let request;
    try { request = factory.open(CREATE_JOURNAL_DATABASE, 1); }
    catch (error) { finish(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }); };
    request.onblocked = () => finish(new Error('Another Spool tab is blocking device recovery. Close older tabs, then try again.'));
    request.onerror = () => finish(new Error('Device recovery could not be opened. Keep this editor open or copy your text.'));
    request.onsuccess = () => {
      db = request.result;
      if (finished) { db.close(); return; }
      db.onversionchange = () => db.close();
      try {
        tx = db.transaction(STORE, change ? 'readwrite' : 'readonly');
        tx.oncomplete = () => finish();
        tx.onabort = tx.onerror = () => finish(new Error('Device recovery could not be committed. Keep this editor open or copy your text.'));
        const store = tx.objectStore(STORE);
        const read = store.get(scope.key);
        read.onsuccess = () => {
          try {
            const existing = read.result ? validateIntent(read.result, scope) : null;
            result = change ? change(existing) : existing;
            if (change) {
              validateIntent(result, scope);
              if (JSON.stringify(result).length > 2_000_000) throw new Error('This draft is too large for device recovery. Copy your text and reduce the attached image before saving.');
              store.put({ ...result, key: scope.key });
            }
          } catch (error) { tx.abort(); finish(error); }
        };
      } catch (error) { finish(error); }
    };
  });
  const current = (record, found) => {
    if (!found || found.id !== record.id || found.revision !== record.revision) throw new Error('Another tab changed this recovery copy. Your edits are still here; copy them before reopening the previous save.');
    return found;
  };
  return {
    read: scope => transact(scope),
    begin: (scope, work) => transact(scope, old => {
      if (old && !['complete', 'discarded'].includes(old.state)) throw new Error('A previous save needs checking before another thread can be created.');
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const id = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
      return { scope, id, revision: 1, state: 'draft', payload: null, submittedWork: null, work: workCopy(work) };
    }),
    prepare: (record, payload, work) => transact(record.scope, old => {
      current(record, old);
      if (old.state === 'discarded') throw new Error('This unsent copy was discarded. Copy any newer text before reopening.');
      if (old.state !== 'draft') throw new Error('The first submitted copy is fixed. Check previous save before saving newer edits.');
      return { ...old, state: 'prepared', payload, submittedWork: workCopy(work) };
    }),
    writeWork: (record, work) => transact(record.scope, old => {
      current(record, old);
      if (old.state === 'discarded') throw new Error('This unsent copy was discarded. Copy any newer text before reopening.');
      // A local edit can arrive while retirement is committing. Preserve it
      // against this SAME acknowledged ID, never mint a replacement. If a new
      // tab/intent already won, current() rejects instead of overwriting it.
      return sameValue(old.work, workCopy(work)) ? old : { ...old, state: old.state === 'complete' ? 'confirmed' : old.state, revision: old.revision + 1, work: workCopy(work) };
    }),
    claim: record => transact(record.scope, old => {
      current(record, old);
      if (old.state !== 'prepared') throw new Error('Spool has not confirmed this save. Use Check previous save; it will not create another thread.');
      return { ...old, state: 'submitted' };
    }),
    acknowledge: (record, post) => transact(record.scope, old => {
      current(record, old);
      if (post.id !== old.id || post.clientId !== old.scope.clientId || post.uid !== old.payload.uid || post.createdAt !== old.payload.createdAt) throw new Error('The saved thread identity changed. Keep this recovery copy for review.');
      return { ...old, state: 'confirmed', baseline: post, baselineWork: workCopy(reconcileEditorSave(old.submittedWork, old.submittedWork, post).baseline) };
    }),
    complete: record => transact(record.scope, old => {
      current(record, old);
      if (old.state !== 'confirmed') throw new Error('The previous save must be confirmed before finishing recovery.');
      return { ...old, state: 'complete' };
    }),
    discard: record => transact(record.scope, old => {
      current(record, old);
      if (old.state !== 'draft') throw new Error('This save may have been sent. Check previous save instead of discarding its identity.');
      return { ...old, state: 'discarded' };
    }),
  };
}
