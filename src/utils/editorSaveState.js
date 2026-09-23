import { versionMediaUrl, versionSpoolMediaContent } from './helpers';
import { displayReviewScheduledDateAsDate } from './reviewIdentity';

export const EDITOR_WORK_FIELDS = ['platform', 'content', 'title', 'altText', 'metaDescription', 'client', 'imageUrl', 'scheduledDate', 'status', 'tags', 'isTemplate'];
export const editorWorkSignature = (form) => JSON.stringify(EDITOR_WORK_FIELDS.map((key) => form[key]));

// Use the same read-time media/date compatibility as the posts listener. The
// stored record stays separate: it is the next save's authoritative baseline.
export function reconcileEditorSave(submitted, current, savedPost) {
  if (!savedPost || typeof savedPost.id !== 'string' || !savedPost.id
    || (submitted.id && submitted.id !== savedPost.id)) {
    throw new Error('Save did not return the expected thread identity');
  }
  const date = displayReviewScheduledDateAsDate(savedPost.scheduledDate);
  const baseline = {
    ...submitted,
    ...savedPost,
    content: versionSpoolMediaContent(savedPost.content || ''),
    imageUrl: versionMediaUrl(savedPost.imageUrl || ''),
    scheduledDate: date
      ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : '',
  };
  const form = { ...baseline };
  for (const key of EDITOR_WORK_FIELDS) {
    if (JSON.stringify(current[key]) !== JSON.stringify(submitted[key])) form[key] = current[key];
  }
  return { baseline, form, dirty: editorWorkSignature(form) !== editorWorkSignature(baseline) };
}
