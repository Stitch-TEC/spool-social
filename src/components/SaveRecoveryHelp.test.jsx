import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SaveRecoveryHelp from './SaveRecoveryHelp';
import { saveRecoveryReference } from '../utils/saveRecoveryReference';
import { createScope, workCopy } from '../utils/createJournal';
import { OPERATOR_UID } from '../config/roles';

function fixture({ state = 'submitted', isTemplate = false } = {}) {
  const scope = createScope({ principalId: 'private-account-id', clientId: 'acme', projectId: 'demo-spool', isTemplate });
  const work = workCopy({ content: 'PRIVATE-CONTENT', title: 'PRIVATE-TITLE', imageUrl: 'https://private.invalid/image', client: 'PRIVATE-LABEL', tags: ['PRIVATE-TAG'], platform: 'gmb', status: 'draft', isTemplate });
  const payload = { ...work, slug: 'private-slug', uid: OPERATOR_UID, clientId: 'acme', approvalStatus: 'pending', feedback: 'PRIVATE-FEEDBACK', reviewStage: 'private', createdAt: '2026-09-23T19:00:00.000Z', updatedAt: '2026-09-23T19:00:00.000Z' };
  const record = { id: 'a'.repeat(32), revision: 2, scope, state, work, payload, submittedWork: work, arbitrary: 'PRIVATE-EXTRA', token: 'PRIVATE-TOKEN', error: 'PRIVATE-ERROR' };
  if (state === 'confirmed') Object.assign(record, { baseline: { ...payload, id: record.id }, baselineWork: work });
  const user = { uid: scope.principalId, isAnonymous: false };
  return { record, scope, principalId: scope.principalId, projectId: scope.projectId, getUser: () => user };
}
function openHelp(props = fixture()) {
  const result = render(<SaveRecoveryHelp {...props} />);
  fireEvent.click(screen.getByText('Help with this save'));
  return result;
}
const copy = () => fireEvent.click(screen.getByRole('button', { name: 'Copy save reference' }));
const setClipboard = clipboard => vi.stubGlobal('navigator', { clipboard });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('allowlisted save reference', () => {
  it.each(['prepared', 'submitted', 'confirmed'])('reports %s as local metadata without exposing content or identity', state => {
    const props = fixture({ state });
    const text = saveRecoveryReference(props.record, props.scope, props.principalId, props.projectId);
    expect(text).toContain('Thread reference: ' + 'a'.repeat(32));
    expect(text).toContain('Client ID: acme');
    expect(text).toContain('Device revision: 2');
    expect(text).toContain('not proof');
    for (const privateValue of ['PRIVATE-', 'private-account-id', 'private.invalid', 'private-slug', OPERATOR_UID, props.scope.key]) expect(text).not.toContain(privateValue);
  });
  it('labels template attempts accurately', () => {
    const props = fixture({ isTemplate: true });
    expect(saveRecoveryReference(props.record, props.scope, props.principalId, props.projectId)).toContain('Type: Template');
  });
  it.each(['draft', 'discarded', 'complete', 'unknown'])('does not expose %s records', state => {
    const props = fixture({ state });
    expect(saveRecoveryReference(props.record, props.scope, props.principalId, props.projectId)).toBe('');
  });
  it.each(['principal', 'project', 'client', 'flow', 'corrupt'])('rejects mismatched or invalid %s scope', changed => {
    const p = fixture();
    if (changed === 'principal') p.principalId = 'another-account';
    if (changed === 'project') p.projectId = 'other-project';
    if (changed === 'client') p.scope = createScope({ principalId: p.principalId, projectId: p.projectId, clientId: 'other' });
    if (changed === 'flow') p.scope = createScope({ principalId: p.principalId, projectId: p.projectId, clientId: 'acme', isTemplate: true });
    if (changed === 'corrupt') p.record.id = 'bad\nPRIVATE-CONTENT';
    expect(saveRecoveryReference(p.record, p.scope, p.principalId, p.projectId)).toBe('');
    expect(render(<SaveRecoveryHelp {...p} />).container).toBeEmptyDOMElement();
  });
});

describe('explicit save-reference copying', () => {
  it('copies only on request, keeps the record unchanged and never reads storage/network', async () => {
    const p = fixture(); const original = JSON.stringify(p.record);
    const clipboard = { writeText: vi.fn().mockResolvedValue() };
    const fetcher = vi.fn(); const storage = { open: vi.fn() };
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('indexedDB', storage);
    setClipboard(clipboard);
    openHelp(p);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Save reference')).toHaveAttribute('readonly');
    copy();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Save reference copied'));
    expect(clipboard.writeText).toHaveBeenCalledWith(screen.getByLabelText('Save reference').value);
    expect(JSON.stringify(p.record)).toBe(original);
    expect(fetcher).not.toHaveBeenCalled(); expect(storage.open).not.toHaveBeenCalled();
  });
  it.each(['missing', 'denied'])('offers selectable manual reference with %s clipboard', async mode => {
    setClipboard(mode === 'missing' ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    openHelp(); copy();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('copy it manually'));
    expect(screen.getByLabelText('Save reference').value).toContain('Thread reference');
  });
  it.each([null, { uid: 'another-account' }, { uid: 'private-account-id', isAnonymous: true }])('hides details for invalid active user %j', user => {
    expect(render(<SaveRecoveryHelp {...fixture()} getUser={() => user} />).container).toBeEmptyDOMElement();
  });
  it('does not dispatch copy after synchronous auth invalidation before rerender', () => {
    const clipboard = { writeText: vi.fn() };
    setClipboard(clipboard);
    const p = fixture(); let user = p.getUser();
    openHelp({ ...p, getUser: () => user }); user = null; copy();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
  it.each(['auth', 'revision', 'unmount'])('ignores a late clipboard completion after %s changes', async change => {
    let resolve;
    setClipboard({ writeText: () => new Promise(done => { resolve = done; }) });
    const p = fixture(); let user = p.getUser();
    const view = openHelp({ ...p, getUser: () => user }); copy();
    if (change === 'auth') { user = { ...user }; view.rerender(<SaveRecoveryHelp {...p} getUser={() => user} />); }
    if (change === 'revision') view.rerender(<SaveRecoveryHelp {...p} record={{ ...p.record, revision: 3 }} />);
    if (change === 'unmount') view.unmount();
    await act(async () => resolve());
    expect(screen.queryByText(/Save reference copied/)).not.toBeInTheDocument();
  });
});
