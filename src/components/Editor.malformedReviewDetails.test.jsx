import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Editor from './Editor';

const post = { id: 'synthetic-malformed', content: '<script>Literal saved caption</script>', client: 'Synthetic',
  clientId: 'synthetic', platform: 'linkedin', status: 'draft', reviewStage: 'in_review', approvalStatus: 'pending' };
const props = () => ({ post, uniqueClients: ['Synthetic'], clientMap: {}, isReadOnly: false,
  createRecoveryEnabled: true, recoveryPrincipalId: 'synthetic-user', recoveryProjectId: 'demo-spool',
  recoveryClientIdFor: () => 'synthetic', onSave: vi.fn(), onCreateDrafts: vi.fn(), onCancel: vi.fn(), showToast: vi.fn() });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('malformed canonical metadata is isolated before Editor signatures and recovery', () => {
  it.each([{ reviewDetailsVersion: null }, { reviewDetailsVersion: 99 }, { reviewDetailsVersion: '1' },
    { firstComment: '' }, { reviewMedia: [] }, { reviewDetailsVersion: 1, firstComment: null },
    { reviewDetailsVersion: 1, reviewMedia: null }, { reviewDetailsVersion: 1, reviewMedia: [{}] },
    { reviewDetailsVersion: 1, firstComment: 'x'.repeat(4001) }])('keeps malformed record %# literal and copyable without any storage/network/write path', patch => {
    const original = { ...post, ...patch }, originalBytes = JSON.stringify(original);
    localStorage.setItem('spool:autosave:synthetic-malformed', 'Retain unattributed work');
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const open = vi.fn(() => { throw new Error('Recovery must not open'); });
    vi.stubGlobal('indexedDB', { open });
    const fetch = vi.fn(() => { throw new Error('Network must not be reached'); }); vi.stubGlobal('fetch', fetch);
    const editorProps = props();
    render(<Editor {...editorProps} post={original} />);
    expect(screen.getByRole('heading', { name: 'Thread needs checking' })).toBeInTheDocument();
    const caption = screen.getByRole('textbox', { name: 'Saved caption — select and copy' });
    expect(caption).toHaveValue(post.content); expect(caption).toHaveAttribute('readonly');
    expect(document.querySelector('script, iframe, img, video')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close Editor' })).toHaveFocus();
    fireEvent.focus(caption); expect(caption.selectionEnd).toBe(post.content.length);
    fireEvent.keyDown(window, { key: 'Escape' }); expect(editorProps.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' })); expect(editorProps.onCancel).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(editorProps.onSave).not.toHaveBeenCalled(); expect(editorProps.onCreateDrafts).not.toHaveBeenCalled();
    expect(JSON.stringify(original)).toBe(originalBytes);
  });
  it('can move from malformed to unchanged legacy editor without repairing the source', () => {
    const malformed = { ...post, reviewDetailsVersion: null }, editorProps = props();
    const { rerender } = render(<Editor {...editorProps} post={malformed} />);
    expect(screen.getByRole('heading', { name: 'Thread needs checking' })).toBeInTheDocument();
    rerender(<Editor {...editorProps} post={post} createRecoveryEnabled={false} recoveryPrincipalId="" />);
    expect(screen.getByRole('heading', { name: 'Edit Thread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(screen.getByLabelText('Schedule (optional)')).toHaveValue('');
    expect(malformed.reviewDetailsVersion).toBeNull();
  });
  it('replaces a read-only legacy view with isolated malformed view without accessing device recovery', () => {
    const editorProps = { ...props(), isReadOnly: true, recoveryPrincipalId: '', createRecoveryEnabled: false };
    const { rerender } = render(<Editor {...editorProps} />);
    expect(screen.getByRole('heading', { name: 'View Thread' })).toBeInTheDocument();
    const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    rerender(<Editor {...editorProps} post={{ ...post, firstComment: '' }} />);
    expect(screen.getByRole('heading', { name: 'Thread needs checking' })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); expect(editorProps.onSave).not.toHaveBeenCalled();
  });
  it.each([null, undefined])('still mounts ordinary new-thread editor for %s input', value => {
    render(<Editor {...props()} post={value} createRecoveryEnabled={false} recoveryPrincipalId="" />);
    expect(screen.getByRole('heading', { name: 'New Thread' })).toBeInTheDocument();
    expect(screen.getByLabelText('Schedule (optional)')).toHaveValue('');
  });
  it('still mounts valid canonical metadata read-only without filling absent optional values', () => {
    const marked = { ...post, reviewDetailsVersion: 1 }, original = JSON.stringify(marked);
    render(<Editor {...props()} post={marked} isReadOnly createRecoveryEnabled={false} recoveryPrincipalId="" />);
    expect(screen.getByRole('heading', { name: 'View Thread' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).toBeNull();
    expect(JSON.stringify(marked)).toBe(original); expect(marked).not.toHaveProperty('firstComment');
  });
});
