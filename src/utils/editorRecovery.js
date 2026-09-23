import { EDITOR_WORK_FIELDS } from './editorSaveState';

// Legacy spool:autosave:* entries have no trustworthy owner. Never read, adopt
// or delete them automatically. v2 is scoped by authenticated user AND tenant.
export function recoveryScope({ principalId, clientId, postId, isTemplate }) {
  if (typeof principalId !== 'string' || !principalId.trim()
    || typeof clientId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clientId)) return null;
  const slot = postId ? `post:${postId}` : isTemplate ? 'new-template' : 'new';
  return {
    version: 2, principalId, clientId, slot,
    key: `spool:autosave:v2:${[principalId, clientId, slot].map(encodeURIComponent).join(':')}`,
  };
}

export function readRecovery(storage, scope) {
  if (!scope) return null;
  try {
    const entry = JSON.parse(storage.getItem(scope.key) || 'null');
    if (!entry || !entry.scope || Object.keys(scope).some(k => entry.scope[k] !== scope[k])) return null;
    const work = entry.work;
    if (!work || typeof work !== 'object' || typeof work.content !== 'string') return null;
    // Device storage is untrusted. Reject malformed fields rather than letting
    // recovery break rendering or forward unexpected values to the save path.
    for (const field of EDITOR_WORK_FIELDS) {
      if (!(field in work)) continue;
      if (field === 'tags') {
        if (!Array.isArray(work.tags) || work.tags.some(t => typeof t !== 'string')) return null;
      } else if (field === 'isTemplate') {
        if (typeof work[field] !== 'boolean') return null;
      } else if (typeof work[field] !== 'string') return null;
    }
    return entry;
  } catch { return null; }
}
