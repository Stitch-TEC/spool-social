import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Editor from './Editor';
import { olderRecoveryScope, recoveryScope } from '../utils/editorRecovery';

const principalId = 'recovery-v3-owner';
const post = { id: 'draft-1', content: 'Saved caption', client: 'OMNI', clientId: 'omni', platform: 'linkedin' };
const scope = recoveryScope({ principalId, clientId: 'omni', postId: post.id });
const older = olderRecoveryScope(scope);
const props = () => ({ post, recoveryPrincipalId: principalId, recoveryClientIdFor: () => 'omni',
  uniqueClients: ['OMNI'], clientMap: {}, isReadOnly: false, onCancel: vi.fn(),
  onSave: vi.fn(async form => ({ ok: true, post: { ...form } })), showToast: vi.fn() });

describe('Editor deliberate v3 / older device recovery coexistence', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); cleanup(); localStorage.clear(); });

  it('only inspects v2 work on explicit action, without restoring or deleting it', () => {
    const oldRaw = JSON.stringify({ scope: older, work: { content: '<script>old private text</script>', title: 'Older title' } });
    localStorage.setItem(older.key, oldRaw);
    const editorProps = props();
    render(<Editor {...editorProps} />);
    expect(screen.getByDisplayValue('Saved caption')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Device copy — select and copy' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect older copy' }));
    const inspected = screen.getByRole('textbox', { name: 'Device copy — select and copy' });
    expect(inspected).toHaveValue(JSON.stringify({ content: '<script>old private text</script>', title: 'Older title' }, null, 2));
    expect(inspected).toHaveAttribute('readonly');
    expect(inspected).toHaveFocus();
    expect(inspected.selectionEnd).toBe(inspected.value.length);
    expect(document.querySelector('script')).toBeNull();
    expect(editorProps.onSave).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Saved caption')).toBeInTheDocument();
    expect(localStorage.getItem(older.key)).toBe(oldRaw);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspection' }));
    expect(screen.getByRole('button', { name: 'Inspect older copy' })).toHaveFocus();
  });

  it.each(['empty', 'meaningful'])('keeps an %s valid v2 copy while ordinary saves use only current edits', async kind => {
    const raw = JSON.stringify({ scope: older, work: { content: kind === 'empty' ? '' : 'Old work' } });
    localStorage.setItem(older.key, raw);
    const editorProps = props();
    render(<Editor {...editorProps} />);
    fireEvent.change(screen.getByDisplayValue('Saved caption'), { target: { value: 'Current edit' } });
    fireEvent.pageHide(window);
    expect(JSON.parse(localStorage.getItem(scope.key)).work.content).toBe('Current edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(editorProps.onSave).toHaveBeenCalledWith(expect.objectContaining({ content: 'Current edit' }), expect.any(Object)));
    expect(localStorage.getItem(older.key)).toBe(raw);
  });

  it('cannot reveal a foreign or malformed v2 copy even after explicit inspection', () => {
    const raw = JSON.stringify({ scope: { ...older, principalId: 'foreign' }, work: { content: 'Foreign private text' } });
    localStorage.setItem(older.key, raw);
    render(<Editor {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect older copy' }));
    expect(screen.queryByText(/Foreign private text/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Device copy — select and copy' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(localStorage.getItem(older.key)).toBe(raw);
  });

  it('keeps unscoped legacy work untouched and never offers its contents', () => {
    localStorage.setItem('spool:autosave:draft-1', JSON.stringify({ content: 'Unowned private text' }));
    render(<Editor {...props()} />);
    expect(screen.getByText(/cannot be safely attributed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inspect older copy' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Unowned private text/)).not.toBeInTheDocument();
    expect(localStorage.getItem('spool:autosave:draft-1')).toContain('Unowned private text');
  });

  it('retains unknown v3 fields and permits an ordinary remote save without clearing that copy', async () => {
    const raw = JSON.stringify({ scope, work: { content: 'Unknown version work', futureField: 'Keep me' } });
    localStorage.setItem(scope.key, raw);
    const editorProps = props();
    render(<Editor {...editorProps} />);
    expect(screen.getByText(/Device recovery needs checking/)).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Saved caption'), { target: { value: 'Current edit' } });
    fireEvent.pageHide(window);
    expect(localStorage.getItem(scope.key)).toBe(raw);
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(editorProps.onCancel).toHaveBeenCalled());
    expect(localStorage.getItem(scope.key)).toBe(raw);
  });

  it('does not enable review-details authoring or erase its copy through an ordinary save', async () => {
    const raw = JSON.stringify({ scope, work: { content: 'Recovered caption', reviewDetailsVersion: 1, firstComment: 'Keep separate' } });
    localStorage.setItem(scope.key, raw);
    const editorProps = props();
    render(<Editor {...editorProps} />);
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect device copy' }));
    expect(screen.getByRole('textbox', { name: 'Device copy — select and copy' })).toHaveValue(JSON.stringify({ content: 'Recovered caption', reviewDetailsVersion: 1, firstComment: 'Keep separate' }, null, 2));
    expect(screen.getByDisplayValue('Saved caption')).toBeInTheDocument();
    expect(localStorage.getItem(scope.key)).toBe(raw);
    fireEvent.change(screen.getByDisplayValue('Saved caption'), { target: { value: 'Current legacy edit' } });
    fireEvent.pageHide(window);
    expect(localStorage.getItem(scope.key)).toBe(raw);
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(editorProps.onCancel).toHaveBeenCalled());
    expect(localStorage.getItem(scope.key)).toBe(raw);
  });

  it('refuses a stale Restore after another tab changes the copy', () => {
    localStorage.setItem(scope.key, JSON.stringify({ scope, work: { content: 'Old local work' } }));
    render(<Editor {...props()} />);
    const newer = JSON.stringify({ scope, work: { content: 'Newer other-tab work' } });
    localStorage.setItem(scope.key, newer);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(screen.getByDisplayValue('Saved caption')).toBeInTheDocument();
    expect(localStorage.getItem(scope.key)).toBe(newer);
    expect(screen.getByText(/Device recovery needs checking/)).toBeInTheDocument();
  });

  it.each(['', 'Older unsaved draft'])('preserves undecided v3 work %j through current typing, pagehide and ordinary Save', async content => {
    const raw = JSON.stringify({ scope, work: { content, title: 'Earlier unsaved title' } });
    localStorage.setItem(scope.key, raw);
    const editorProps = props();
    render(<Editor {...editorProps} />);
    fireEvent.change(screen.getByDisplayValue('Saved caption'), { target: { value: 'Current edit' } });
    fireEvent.pageHide(window);
    expect(localStorage.getItem(scope.key)).toBe(raw);
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(editorProps.onCancel).toHaveBeenCalled());
    expect(editorProps.onSave).toHaveBeenCalledWith(expect.objectContaining({ content: 'Current edit' }), expect.any(Object));
    expect(localStorage.getItem(scope.key)).toBe(raw);
  });

  it.each(['Restore', 'Dismiss'])('only %s deliberately admits a future local overwrite/retirement', action => {
    const raw = JSON.stringify({ scope, work: { content: 'Older unsaved draft' } });
    localStorage.setItem(scope.key, raw);
    render(<Editor {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
    if (action === 'Restore') expect(screen.getByDisplayValue('Older unsaved draft')).toBeInTheDocument();
    else expect(localStorage.getItem(scope.key)).toBeNull();
    fireEvent.change(document.querySelector('textarea'), { target: { value: 'Deliberate current edit' } });
    fireEvent.pageHide(window);
    expect(JSON.parse(localStorage.getItem(scope.key)).work.content).toBe('Deliberate current edit');
  });

  it('cannot Dismiss a copy that another tab changed after the banner appeared', () => {
    localStorage.setItem(scope.key, JSON.stringify({ scope, work: { content: 'Older unsaved draft' } }));
    render(<Editor {...props()} />);
    const other = JSON.stringify({ scope, work: { content: 'Other-tab replacement' } });
    localStorage.setItem(scope.key, other);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss', exact: true }));
    fireEvent.change(screen.getByDisplayValue('Saved caption'), { target: { value: 'This tab text' } });
    fireEvent.pageHide(window);
    expect(localStorage.getItem(scope.key)).toBe(other);
    expect(screen.getByRole('button', { name: 'Restore', exact: true })).toBeInTheDocument();
  });

  it.each(['Restore', 'Inspect older copy'])('handles denied storage access during %s without losing current text', action => {
    const target = action === 'Restore' ? scope : older;
    const raw = JSON.stringify({ scope: target, work: { content: 'Local copy' } });
    localStorage.setItem(target.key, raw);
    render(<Editor {...props()} />);
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('Denied storage'); });
    fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
    expect(screen.getByDisplayValue('Saved caption')).toBeInTheDocument();
    expect(screen.getByText(/Device recovery needs checking/)).toBeInTheDocument();
  });

  it('refuses an inspection after the authoritative sign-in identity changes', () => {
    localStorage.setItem(older.key, JSON.stringify({ scope: older, work: { content: 'Private owner work' } }));
    let user = { uid: principalId, isAnonymous: false };
    render(<Editor {...props()} getRecoveryUser={() => user} />);
    user = { uid: 'different-owner', isAnonymous: false };
    fireEvent.click(screen.getByRole('button', { name: 'Inspect older copy' }));
    expect(screen.queryByRole('textbox', { name: 'Device copy — select and copy' })).not.toBeInTheDocument();
  });

  it('keeps manual inspection operable outside the read-only editing fieldset', () => {
    const raw = JSON.stringify({ scope, work: { content: 'Saved caption', reviewDetailsVersion: 1, firstComment: 'Saved reference' } });
    localStorage.setItem(scope.key, raw);
    render(<Editor {...props()} post={{ ...post, reviewDetailsVersion: 1, firstComment: 'Saved reference' }} isReadOnly />);
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Inspect device copy' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    const copied = screen.getByRole('textbox', { name: 'Device copy — select and copy' });
    expect(copied).not.toBeDisabled();
    expect(copied).toHaveFocus();
    expect(copied).toHaveAttribute('readonly');
    expect(localStorage.getItem(scope.key)).toBe(raw);
    expect(screen.getByDisplayValue('Saved caption')).toBeDisabled();
  });

  it('retires displayed inspection when its captured sign-in changes, even before the principal prop catches up', () => {
    localStorage.setItem(older.key, JSON.stringify({ scope: older, work: { content: 'Private owner work' } }));
    let user = { uid: principalId, isAnonymous: false };
    const editorProps = { ...props(), getRecoveryUser: () => user };
    const view = render(<Editor {...editorProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect older copy' }));
    expect(screen.getByRole('textbox', { name: 'Device copy — select and copy' })).toBeInTheDocument();
    user = { uid: 'different-owner', isAnonymous: false };
    view.rerender(<Editor {...editorProps} />);
    expect(screen.queryByRole('textbox', { name: 'Device copy — select and copy' })).not.toBeInTheDocument();
  });
});
