import { EDITOR_WORK_FIELDS } from './editorSaveState';
import { REVIEW_DETAILS_FIELDS, copyReviewDetailsFields, hasReviewDetailsFields,
  isValidReviewDetails } from './reviewDetails';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scopeFields = ['version', 'principalId', 'clientId', 'slot', 'key'];
const workFields = [...EDITOR_WORK_FIELDS, ...REVIEW_DETAILS_FIELDS, 'savedAt'];

// Deliberately use a different key. v2 and unscoped spool:autosave:* copies are
// never adopted, overwritten or deleted by v3. Native new-create IDB2 is separate.
export function recoveryScope({ principalId, clientId, postId, isTemplate }) {
  if (typeof principalId !== 'string' || !principalId.trim()
    || typeof clientId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clientId)
    || (postId !== undefined && postId !== null && (typeof postId !== 'string' || !postId))) return null;
  const slot = postId ? `post:${postId}` : isTemplate ? 'new-template' : 'new';
  return scopedKey({ principalId, clientId, slot }, 3);
}

function scopedKey({ principalId, clientId, slot }, version) {
  return { version, principalId, clientId, slot,
    key: `spool:autosave:v${version}:${[principalId, clientId, slot].map(encodeURIComponent).join(':')}` };
}

function validScope(scope) {
  return object(scope) && Object.keys(scope).length === scopeFields.length
    && scopeFields.every(key => own(scope, key)) && [2, 3].includes(scope.version)
    && typeof scope.principalId === 'string' && !!scope.principalId.trim()
    && typeof scope.clientId === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope.clientId)
    && typeof scope.slot === 'string' && /^(?:new|new-template|post:.+)$/.test(scope.slot)
    && scopedKey(scope, scope.version).key === scope.key;
}

export function olderRecoveryScope(scope) {
  return validScope(scope) && scope.version === 3 ? scopedKey(scope, 2) : null;
}

function validWork(work, version) {
  if (!object(work) || typeof work.content !== 'string'
    || Object.keys(work).some(key => !workFields.includes(key))
    || (version === 2 && hasReviewDetailsFields(work)) || !isValidReviewDetails(work)) return false;
  for (const field of EDITOR_WORK_FIELDS) {
    if (!own(work, field)) continue;
    if (field === 'tags') {
      if (!Array.isArray(work.tags) || work.tags.some(tag => typeof tag !== 'string')) return false;
    } else if (field === 'isTemplate') {
      if (typeof work[field] !== 'boolean') return false;
    } else if (typeof work[field] !== 'string') return false;
  }
  return !own(work, 'savedAt') || (Number.isSafeInteger(work.savedAt) && work.savedAt >= 0);
}

// Invalid and unavailable are not absence. Callers retain unknown device work
// and refuse an autosave overwrite; neither state blocks an ordinary remote save.
export function inspectRecovery(storage, scope) {
  if (!validScope(scope)) return { state: 'invalid', entry: null };
  try {
    const raw = storage.getItem(scope.key);
    if (raw === null) return { state: 'absent', entry: null, raw: null };
    let entry;
    try { entry = JSON.parse(raw); } catch { return { state: 'invalid', entry: null, raw }; }
    if (!object(entry) || Object.keys(entry).length !== 2 || !own(entry, 'scope') || !own(entry, 'work')
      || !validScope(entry.scope) || scopeFields.some(key => entry.scope[key] !== scope[key])
      || !validWork(entry.work, scope.version)) return { state: 'invalid', entry: null, raw };
    return { state: 'available', entry, raw };
  } catch { return { state: 'unavailable', entry: null }; }
}

export function readRecovery(storage, scope) {
  return inspectRecovery(storage, scope).entry;
}

// Presence-only inventory never reads unscoped values. A v2 copy is inspected
// separately, only after an explicit action and exact embedded scope checks.
export function olderRecoveryPresence(storage, scope) {
  const older = olderRecoveryScope(scope);
  if (!older) return { scoped: false, unscoped: false, unavailable: false };
  try {
    let scoped = false;
    let unscoped = false;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === older.key) scoped = true;
      if (key === `spool:autosave:${scope.slot.startsWith('post:') ? scope.slot.slice(5) : scope.slot}`) unscoped = true;
    }
    return { scoped, unscoped, unavailable: false };
  } catch { return { scoped: false, unscoped: false, unavailable: true }; }
}

export function captureRecoveryWork(form, savedAt = Date.now()) {
  const work = {};
  for (const key of EDITOR_WORK_FIELDS) {
    if (own(form, key) && form[key] !== undefined) work[key] = key === 'tags' ? [...form.tags] : form[key];
  }
  Object.assign(work, copyReviewDetailsFields(form));
  const imageOmitted = typeof work.imageUrl === 'string' && work.imageUrl.startsWith('data:');
  if (imageOmitted) delete work.imageUrl;
  work.savedAt = savedAt;
  if (!validWork(work, 3)) throw new Error('Device recovery fields need checking.');
  return { work, imageOmitted };
}

export function recoveryMatchesLoaded(work, pristine) {
  if (!validWork(work, 3) || !isValidReviewDetails(pristine)) return false;
  return EDITOR_WORK_FIELDS.every(key => {
    if (!own(work, key)) return true;
    if (key === 'content') return work.content.trim() === String(pristine.content ?? '').trim();
    return JSON.stringify(work[key] ?? null) === JSON.stringify(pristine[key] ?? null);
  }) && REVIEW_DETAILS_FIELDS.every(key => own(work, key) === own(pristine, key)
    && JSON.stringify(work[key]) === JSON.stringify(pristine[key]));
}

export function restoreRecoveryWork(current, work) {
  if (!validWork(work, 3) || !isValidReviewDetails(current)) throw new Error('Device recovery needs checking.');
  // A pre-extension copy must not clear a sticky marker or newer review work.
  if (hasReviewDetailsFields(current) && !hasReviewDetailsFields(work)) {
    throw new Error('This device copy predates the review details. Inspect and copy it instead.');
  }
  const next = { ...current };
  for (const key of EDITOR_WORK_FIELDS) {
    if (own(work, key)) next[key] = key === 'tags' ? [...work.tags] : work[key];
  }
  for (const key of REVIEW_DETAILS_FIELDS) delete next[key];
  Object.assign(next, copyReviewDetailsFields(work));
  next.client = current.client; // the bound slug survives a display-label rename
  return next;
}

// This synchronous observed-value check detects already-changed copies. It is
// not an atomic cross-tab lock; no durable exclusion or cancellation is claimed.
export function writeRecovery(storage, scope, work, expectedRaw) {
  if (!validScope(scope) || scope.version !== 3 || !validWork(work, 3)
    || (typeof expectedRaw !== 'string' && expectedRaw !== null)) return { state: 'invalid' };
  try {
    const current = inspectRecovery(storage, scope);
    if (!['absent', 'available'].includes(current.state)) return { state: current.state };
    if (current.raw !== expectedRaw) return { state: 'changed' };
    if (current.entry && hasReviewDetailsFields(current.entry.work) && !hasReviewDetailsFields(work)) {
      return { state: 'incompatible' }; // never erase future/sticky review data with a legacy autosave
    }
    const raw = JSON.stringify({ scope, work });
    storage.setItem(scope.key, raw);
    if (storage.getItem(scope.key) !== raw) return { state: 'changed' };
    return { state: 'stored', raw };
  } catch { return { state: 'unavailable' }; }
}

export function clearRecovery(storage, scope, expectedRaw, { allowReviewDetails = false } = {}) {
  if (!validScope(scope) || scope.version !== 3 || (typeof expectedRaw !== 'string' && expectedRaw !== null)) return { state: 'invalid' };
  try {
    const current = inspectRecovery(storage, scope);
    if (!['absent', 'available'].includes(current.state)) return { state: current.state };
    if (current.raw !== expectedRaw) return { state: 'changed' };
    // The disabled-authoring editor cannot claim it acknowledged those fields.
    // A future compatible save boundary must deliberately opt into retirement.
    if (current.entry && hasReviewDetailsFields(current.entry.work) && !allowReviewDetails) return { state: 'incompatible' };
    storage.removeItem(scope.key);
    return { state: 'cleared', raw: null };
  } catch { return { state: 'unavailable' }; }
}
