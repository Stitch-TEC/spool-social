import { describe, expect, it } from 'vitest';
import { EDITOR_WORK_FIELDS, editorWorkSignature, reconcileEditorSave } from './editorSaveState';

const legacy = { id: 'p1', platform: 'linkedin', content: 'Caption', title: '', altText: '', metaDescription: '',
  client: 'Synthetic Client', imageUrl: '', scheduledDate: '', status: 'draft', tags: [], isTemplate: false };
const media = { id: 'media01234567890123456789', url: 'https://youtu.be/synthetic', label: 'Cut one', version: 'v1' };
const details = { reviewDetailsVersion: 1, firstComment: 'Separate text', reviewMedia: [media] };

describe('review details: editor work semantics without enabled authoring', () => {
  it('keeps every legacy work signature unchanged', () => {
    expect(editorWorkSignature(legacy)).toBe(JSON.stringify(EDITOR_WORK_FIELDS.map(key => legacy[key])));
    const result = reconcileEditorSave(legacy, legacy, { ...legacy, scheduledDate: null });
    expect(result.dirty).toBe(false);
    for (const key of ['reviewDetailsVersion', 'firstComment', 'reviewMedia']) expect(result.baseline).not.toHaveProperty(key);
  });
  it('normalizes empty controls only for dirty comparison, keeping the sticky marker distinct from legacy', () => {
    expect(editorWorkSignature({ ...legacy, reviewDetailsVersion: 1 }))
      .toBe(editorWorkSignature({ ...legacy, reviewDetailsVersion: 1, firstComment: '', reviewMedia: [] }));
    expect(editorWorkSignature({ ...legacy, reviewDetailsVersion: 1 })).not.toBe(editorWorkSignature(legacy));
  });
  it.each(['firstComment', 'reviewMedia'])('retains newer %s separately from the exact saved baseline', key => {
    const submitted = { ...legacy, ...details };
    const changed = key === 'firstComment' ? 'New comment' : [{ ...media, version: 'v2' }];
    const result = reconcileEditorSave(submitted, { ...submitted, [key]: changed }, submitted);
    expect(result.form[key]).toEqual(changed); expect(result.baseline[key]).toEqual(submitted[key]);
    expect(result.dirty).toBe(true);
  });
  it('preserves newer review work without injecting it into a committed legacy baseline', () => {
    const result = reconcileEditorSave(legacy, { ...legacy, ...details }, legacy);
    expect(result.form).toMatchObject(details);
    expect(result.baseline).not.toHaveProperty('reviewDetailsVersion');
    expect(result.dirty).toBe(true);
  });
  it('preserves explicit optional absence rather than assigning undefined during reconciliation', () => {
    const submitted = { ...legacy, ...details };
    const { firstComment: omitted, ...cleared } = submitted;
    expect(omitted).toBe(details.firstComment);
    const result = reconcileEditorSave(submitted, cleared, submitted);
    expect(result.form).not.toHaveProperty('firstComment');
    expect(result.baseline.firstComment).toBe(details.firstComment);
    expect(result.dirty).toBe(true);
  });
  it('rejects malformed metadata rather than hiding it through a dirty signature or baseline defaults', () => {
    expect(() => editorWorkSignature({ ...legacy, firstComment: '' })).toThrow('Review details');
    expect(() => reconcileEditorSave(legacy, legacy, { ...legacy, reviewDetailsVersion: 2 })).toThrow('Review details');
  });
});
