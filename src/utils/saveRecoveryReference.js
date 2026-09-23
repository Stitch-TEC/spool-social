import { createScope, validateIntent } from './createJournal';

const STATE_LABELS = {
  prepared: 'Prepared on this device; confirmation still needed',
  submitted: 'Awaiting confirmation',
  confirmed: 'Previously confirmed; newer edits may remain',
};

// Never serialize the journal, scope key, free-form errors or draft payload.
// A reference helps authorized support find the exact attempt; it proves no outcome.
export function saveRecoveryReference(record, scope, principalId, projectId) {
  try {
    const expected = createScope({ principalId, projectId, clientId: scope?.clientId, isTemplate: scope?.flow === 'template' });
    if (!expected || expected.key !== scope?.key || !STATE_LABELS[record?.state]) return '';
    validateIntent(record, expected);
    return [
      'Spool save reference',
      `Project: ${expected.projectId}`,
      `Client ID: ${expected.clientId}`,
      `Type: ${expected.flow === 'template' ? 'Template' : 'Thread'}`,
      `Thread reference: ${record.id}`,
      `Device state: ${STATE_LABELS[record.state]}`,
      `Device revision: ${record.revision}`,
      `First save prepared: ${new Date(record.payload.createdAt).toISOString()}`,
      'This reference is not proof that the latest work was saved.',
    ].join('\n');
  } catch { return ''; }
}
