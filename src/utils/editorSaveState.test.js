import { describe, expect, it } from 'vitest';
import { EDITOR_WORK_FIELDS, reconcileEditorSave } from './editorSaveState';

const submitted = {
  id: 'p1', platform: 'blog', content: 'Submitted', title: 'Title', altText: '',
  metaDescription: '', client: 'Acme', clientId: 'acme', imageUrl: '',
  scheduledDate: '2026-09-22T09:30', status: 'draft', tags: [], isTemplate: false,
};

describe('editor save reconciliation', () => {
  it.each(EDITOR_WORK_FIELDS)('retains newer %s without making it part of the saved baseline', key => {
    const changed = key === 'tags' ? ['new'] : key === 'isTemplate' ? true : 'new';
    const next = reconcileEditorSave(submitted, { ...submitted, [key]: changed }, submitted);
    expect(next.form[key]).toEqual(changed);
    expect(next.baseline[key]).toEqual(submitted[key]);
    expect(next.dirty).toBe(true);
  });

  it('adopts committed status, renamed client, hosted media and metadata for untouched fields', () => {
    const input = { ...submitted, imageUrl: 'data:image/png;base64,YQ==' };
    const committed = { ...submitted, client: 'Acme renamed', status: 'scheduled',
      imageUrl: '/media/generated/o/cover.png', approvalStatus: 'approved', feedback: 'Live feedback' };
    const next = reconcileEditorSave(input, { ...input, content: 'Still editing' }, committed);
    expect(next.form).toMatchObject({ content: 'Still editing', status: 'scheduled', client: 'Acme renamed',
      clientId: 'acme', approvalStatus: 'approved', feedback: 'Live feedback',
      imageUrl: 'https://spool.stitchtec.dev/media/v2/generated/o/cover.png' });
    expect(next.baseline.content).toBe('Submitted');
    expect(next.dirty).toBe(true);
  });

  it('treats read-time media and local schedule normalization as saved, not new work', () => {
    const committed = { ...submitted, content: '![Cover](/media/generated/o/cover.png)',
      scheduledDate: new Date(2026, 8, 22, 9, 30).toISOString() };
    const next = reconcileEditorSave(submitted, submitted, committed);
    expect(next.form.content).toBe('![Cover](https://spool.stitchtec.dev/media/v2/generated/o/cover.png)');
    expect(next.form.scheduledDate).toBe('2026-09-22T09:30');
    expect(next.dirty).toBe(false);
  });

  it.each([null, {}, { id: '' }, { id: 'different' }])('rejects an unexpected saved identity: %j', saved => {
    expect(() => reconcileEditorSave(submitted, submitted, saved)).toThrow('expected thread identity');
  });
});
