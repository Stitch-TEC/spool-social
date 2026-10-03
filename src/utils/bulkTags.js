import { validatedTags } from './editorInputs';

// Stored tags must already be canonical. A bulk edit cannot quietly repair or
// rename older values while applying an unrelated tag change.
export function canonicalBulkTags(value) {
  if (!Array.isArray(value)) throw new Error('Stored tags need review before bulk editing.');
  const tags = validatedTags(value);
  if (tags.some((tag, index) => tag !== value[index])) {
    throw new Error('Stored tags need review before bulk editing.');
  }
  return tags;
}

export function parseBulkTags(text) {
  if (typeof text !== 'string') throw new Error('Enter tags separated by commas or pipes.');
  const tags = text.split(/[,|]/).map(tag => tag.trim().replace(/^#/, '').trim()).filter(Boolean);
  return validatedTags(tags);
}

export function mergeBulkTags(current, incoming, action) {
  if (action !== 'add' && action !== 'remove') throw new Error('Choose Add tags or Remove tags.');
  const existing = canonicalBulkTags(current);
  const changes = canonicalBulkTags(incoming);
  const changed = new Set(changes);
  const merged = action === 'remove'
    ? existing.filter(tag => !changed.has(tag))
    : [...existing, ...changes.filter(tag => !existing.includes(tag))];
  return validatedTags(merged);
}
