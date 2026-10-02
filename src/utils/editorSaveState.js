import { versionMediaUrl, versionSpoolMediaContent } from './helpers';
import { displayReviewScheduledDateAsDate } from './reviewIdentity';
import { REVIEW_DETAILS_FIELDS, copyReviewDetailsFields, reviewDetailsSnapshot } from './reviewDetails';

// These legacy required fields remain fixed so old recovery work/payloads do
// not become invalid merely because optional review metadata is understood.
export const EDITOR_WORK_FIELDS = ['platform', 'content', 'title', 'altText', 'metaDescription', 'client', 'imageUrl', 'scheduledDate', 'status', 'tags', 'isTemplate'];
export const editorWorkSignature = (form) => {
  const values = EDITOR_WORK_FIELDS.map((key) => form[key]);
  const details = reviewDetailsSnapshot(form);
  if (details !== null) values.push(details);
  return JSON.stringify(values);
};

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
  // Read-time defaults must not inject optional fields missing from the saved
  // record. Current edits are reconciled separately, preserving clear/absence.
  for (const key of REVIEW_DETAILS_FIELDS) delete baseline[key];
  Object.assign(baseline, copyReviewDetailsFields(savedPost));
  const form = { ...baseline };
  for (const key of EDITOR_WORK_FIELDS) {
    if (JSON.stringify(current[key]) !== JSON.stringify(submitted[key])) form[key] = current[key];
  }
  for (const key of REVIEW_DETAILS_FIELDS) {
    if (JSON.stringify(current[key]) === JSON.stringify(submitted[key])) continue;
    if (Object.prototype.hasOwnProperty.call(current, key)) form[key] = current[key];
    else delete form[key];
  }
  return { baseline, form, dirty: editorWorkSignature(form) !== editorWorkSignature(baseline) };
}
