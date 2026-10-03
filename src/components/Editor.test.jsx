import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import Editor from './Editor';
import { recoveryScope } from '../utils/editorRecovery';
const recoveryKey = slot => recoveryScope({ principalId: 'editor-test', clientId: 'acme', postId: slot === 'new' ? null : slot }).key;

const baseProps = {
  recoveryPrincipalId: 'editor-test',
  recoveryClientIdFor: name => name === 'Acme' ? 'acme' : '',
  post: null,
  onSave: vi.fn(),
  onCancel: vi.fn(),
  clientMap: {},
  uniqueClients: [],
  showToast: vi.fn(),
  isReadOnly: false,
};

// Mirrors the Editor's local-timezone conversion.
const toLocalISOString = (date) => {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

describe('Editor', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('defaults new threads to no schedule', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T09:30:00'));
    try {
      const { container } = render(<Editor {...baseProps} />);
      const input = container.querySelector('input[type="datetime-local"]');
      expect(input.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "New Thread" for new posts and "Edit Thread" when editing', () => {
    const { unmount } = render(<Editor {...baseProps} />);
    expect(screen.getByText('New Thread')).toBeInTheDocument();
    unmount();

    render(<Editor {...baseProps} post={{ id: 'p1', content: 'hi', client: 'Acme' }} />);
    expect(screen.getByText('Edit Thread')).toBeInTheDocument();
  });

  it.each([null, undefined, '', 'invalid date'])('keeps an undated/invalid legacy schedule empty (%s)', value => {
    render(<Editor {...baseProps} post={{ id: 'undated', client: 'Acme', content: 'Keep this date empty', scheduledDate: value }} />);
    expect(screen.getByLabelText('Schedule (optional)')).toHaveValue('');
  });

  it('keeps a real stored date in local time instead of clearing or redating it', () => {
    const date = new Date('2026-10-08T15:30:00.000Z');
    render(<Editor {...baseProps} post={{ id: 'dated', client: 'Acme', content: 'Keep this real date', scheduledDate: date.toISOString() }} />);
    expect(screen.getByLabelText('Schedule (optional)')).toHaveValue(toLocalISOString(date));
  });

  it('shows read-only reasons, disables editing and removes Save without disabling Close', () => {
    const onSave = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} isReadOnly readOnlyReason="Ask Stitch TEC to update this older thread." post={{ id: 'old', content: 'Old thread', client: 'Acme' }} />);
    expect(screen.getByRole('heading', { name: 'View Thread' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Schedule (optional)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close Editor' })).toBeEnabled();
    fireEvent.keyDown(document.querySelector('textarea'), { key: 'Enter', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('retains overlong and duplicate tags and explains the limit rather than truncating', () => {
    render(<Editor {...baseProps} post={{ id: 'tags', client: 'Acme', content: 'Copy', tags: ['one'] }} />);
    const input = screen.getByLabelText('New tag');
    fireEvent.change(input, { target: { value: 'a'.repeat(21) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('a'.repeat(21));
    expect(screen.getByText(/Each tag must contain 1–20/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'one' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('one');
    expect(screen.getByText(/Remove duplicate tags/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'a'.repeat(20) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('');
    expect(screen.getByText(`#${'a'.repeat(20)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });

  it('uses the caller’s observed platform preference only on initial creation', () => {
    const { rerender } = render(<Editor {...baseProps} initialPlatform="linkedin" />);
    expect(document.querySelector('textarea')).toHaveAttribute('placeholder', 'Share a professional insight or milestone...');
    rerender(<Editor {...baseProps} initialPlatform="facebook" />);
    expect(document.querySelector('textarea')).toHaveAttribute('placeholder', 'Share a professional insight or milestone...');
  });

  it('does not silently discard typed work when a thread becomes read-only before its recovery debounce', () => {
    const onCancel = vi.fn();
    const post = { id: 'retires', content: 'Original copy', client: 'Acme', clientId: 'acme' };
    const { rerender } = render(<Editor {...baseProps} post={post} onCancel={onCancel} />);
    fireEvent.change(screen.getByDisplayValue('Original copy'), { target: { value: 'Unsaved current work' } });
    rerender(<Editor {...baseProps} post={post} onCancel={onCancel} isReadOnly recoveryPrincipalId="" readOnlyReason="This thread needs checking." />);
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(screen.getByText(/Your edits are not saved to Spool/)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(screen.getByDisplayValue('Unsaved current work')).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('offers selectable raw text when clipboard is unavailable after a read-only transition', async () => {
    const actor = { uid: 'editor-test', isAnonymous: false };
    const getRecoveryUser = () => actor;
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const post = { id: 'copy-fallback', content: 'Original copy', client: 'Acme', clientId: 'acme' };
    const { rerender } = render(<Editor {...baseProps} post={post} getRecoveryUser={getRecoveryUser} />);
    fireEvent.change(screen.getByDisplayValue('Original copy'), { target: { value: '**Unsaved raw Markdown**' } });
    rerender(<Editor {...baseProps} post={post} getRecoveryUser={getRecoveryUser} isReadOnly recoveryPrincipalId="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy text', exact: true }));
    const recoveryText = await screen.findByRole('textbox', { name: 'Recovery text — select and copy' });
    expect(writeText).toHaveBeenCalledWith('**Unsaved raw Markdown**');
    expect(recoveryText).not.toBeDisabled();
    expect(recoveryText).toHaveAttribute('readonly');
    expect(recoveryText).toHaveValue('**Unsaved raw Markdown**');
    expect(recoveryText).toHaveFocus();
    expect(recoveryText.selectionStart).toBe(0);
    expect(recoveryText.selectionEnd).toBe('**Unsaved raw Markdown**'.length);
    expect(baseProps.onSave).not.toHaveBeenCalled();
  });

  it('toggles the mobile preview overlay open and closed', () => {
    // The preview panels are always in the DOM (shown/hidden by responsive CSS),
    // so the conditionally-rendered FAB + the header toggle label are the
    // reliable signals that previewMode flipped.
    render(<Editor {...baseProps} post={{ id: 'b1', platform: 'blog', title: 'T', content: '# Hello\n\nWorld', client: 'Acme' }} />);

    // Overlay closed: FAB present, header toggle says "Preview".
    expect(screen.getByLabelText('Open Preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();

    // Open via the header toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByLabelText('Open Preview')).not.toBeInTheDocument(); // FAB hidden
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument(); // toggle flipped

    // Close via the in-panel close button.
    fireEvent.click(screen.getByLabelText('Close Preview'));
    expect(screen.getByLabelText('Open Preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });

  it('exposes a keyboard-resizable preview separator', () => {
    render(<Editor {...baseProps} post={{ id: 'b2', platform: 'blog', content: 'body', client: 'Acme' }} />);
    const handle = screen.getByRole('separator', { name: 'Resize preview panel' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('prefills the client on a new post from the caller context', () => {
    render(<Editor {...baseProps} initialClient="Acme" />);
    expect(screen.getByPlaceholderText('Select or type a new client...').value).toBe('Acme');
  });

  it('locks the client field for client members (save path pins it anyway)', () => {
    render(<Editor {...baseProps} initialClient="Acme" clientLocked />);
    expect(screen.getByPlaceholderText('Select or type a new client...')).toBeDisabled();
  });

  it('passes the editor-open client label and immutable ID to the atomic save boundary', async () => {
    const onSave = vi.fn(async form => ({ ok: true, post: { ...form } }));
    render(<Editor
      {...baseProps}
      onSave={onSave}
      post={{ id: 'p1', client: 'Acme', clientId: 'acme-canonical', status: 'draft', content: 'Ready' }}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', client: 'Acme', clientId: 'acme-canonical' }),
      expect.objectContaining({
        baselineStatus: 'draft',
        baselineClient: 'Acme',
        baselineClientId: 'acme-canonical',
      }),
    ));
  });

  it('applies bold markdown on mod+B in a long-form draft', () => {
    render(<Editor {...baseProps} post={{ id: 'b3', platform: 'blog', title: 'T', content: 'hello', client: 'Acme' }} />);
    const textarea = screen.getByDisplayValue('hello');
    textarea.setSelectionRange(0, 5);
    // jsdom reports a non-Mac platform, so the binding is Ctrl there.
    fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });
    // jsdom takes replaceRange's fallback path (no execCommand) — the native
    // setter + input event must still sync React state.
    expect(screen.getByDisplayValue('**hello**')).toBeInTheDocument();
  });

  it('does NOT bind formatting shortcuts on plain-text social platforms', () => {
    render(<Editor {...baseProps} post={{ id: 's1', platform: 'twitter', content: 'hi', client: 'Acme' }} />);
    const textarea = screen.getByDisplayValue('hi');
    textarea.setSelectionRange(0, 2);
    fireEvent.keyDown(textarea, { key: 'b', ctrlKey: true });
    expect(screen.getByDisplayValue('hi')).toBeInTheDocument();
  });

  it('keeps unsaved form fields when picking a Spark Deck prompt', () => {
    render(<Editor {...baseProps} />);

    const clientInput = screen.getByPlaceholderText('Select or type a new client...');
    fireEvent.change(clientInput, { target: { value: 'Acme Corp' } });

    fireEvent.click(screen.getByText('Spark Deck'));
    // Pick the first prompt in the deck.
    fireEvent.click(screen.getByText("Share a 'behind the scenes' photo of your workspace."));

    // Prompt landed in the content box…
    expect(screen.getByDisplayValue("Share a 'behind the scenes' photo of your workspace.")).toBeInTheDocument();
    // …and the unsaved client name survived (regression: SparkDeck used to reset the form).
    expect(clientInput.value).toBe('Acme Corp');
  });

  it('lets the Content toolbar wrap while keeping a named, touch-sized keyboard target', () => {
    render(<Editor {...baseProps} />);
    const sparkButton = screen.getByRole('button', { name: 'Spark Deck', exact: true });
    expect(sparkButton).toHaveAttribute('type', 'button');
    expect(sparkButton).toHaveClass('min-h-11', 'min-w-11', 'max-w-full', 'focus-visible:outline-2', 'focus-visible:outline-offset-2');
    expect(sparkButton.parentElement).toHaveClass('min-w-0', 'flex-wrap', 'gap-y-2');
    expect(screen.getByText('Content', { selector: 'label' })).toHaveClass('text-slate-600');
    expect(sparkButton.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([false, true])('keeps the current caption, date and tags when opening and closing Spark Deck (read-only: %s)', isReadOnly => {
    const onSave = vi.fn();
    const scheduledDate = '2026-10-08T15:30:00.000Z';
    render(<Editor {...baseProps} onSave={onSave} isReadOnly post={{
      id: 'toolbar-preservation', client: 'Acme', clientId: 'acme', platform: 'blog',
      title: 'Existing title', content: 'Existing caption', scheduledDate, tags: ['existing'],
    }} />);
    const caption = screen.getByDisplayValue('Existing caption');
    if (!isReadOnly) fireEvent.change(caption, { target: { value: 'Unsaved caption' } });

    fireEvent.click(screen.getByRole('button', { name: 'Spark Deck', exact: true }));
    expect(screen.getByRole('dialog', { name: 'Spark Deck' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Spark Deck' }));

    expect(screen.queryByRole('dialog', { name: 'Spark Deck' })).not.toBeInTheDocument();
    expect(caption).toHaveValue(isReadOnly ? 'Existing caption' : 'Unsaved caption');
    expect(screen.getByDisplayValue('Existing title')).toBeInTheDocument();
    expect(screen.getByLabelText('Schedule (optional)')).toHaveValue(toLocalISOString(new Date(scheduledDate)));
    expect(screen.getByText('#existing')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Select or type a new client...')).toHaveValue('Acme');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not offer to save whitespace-only content', () => {
    const onSave = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} post={{ id: 'empty', content: '   \n ', client: 'Acme' }} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps edits and enables retry when saving rejects', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Network unavailable'))
      .mockImplementationOnce(async form => ({ ok: true, post: { ...form } }));
    const showToast = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} showToast={showToast} post={{ id: 'retry', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Keep my changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Your edits are still here'), 'error'));
    expect(screen.getByDisplayValue('Keep my changes')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('retry'))).work.content).toBe('Keep my changes');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.localStorage.getItem(recoveryKey('retry'))).toBeNull());
    fireEvent(window, new Event('pagehide'));
    expect(window.localStorage.getItem(recoveryKey('retry'))).toBeNull();
  });

  it('keeps a recovery copy when the save boundary reports failure', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(<Editor {...baseProps} onSave={onSave} post={{ id: 'failed', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Still unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(recoveryKey('failed'))).work.content).toBe('Still unsaved'));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('flushes the latest edits when a mobile app is hidden before the debounce', () => {
    render(<Editor {...baseProps} post={{ id: 'hidden', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Before backgrounding' } });
    expect(window.localStorage.getItem(recoveryKey('hidden'))).toBeNull();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('hidden'))).work.content).toBe('Before backgrounding');
  });

  it('flushes on pagehide and removes lifecycle listeners when closed', () => {
    const { unmount } = render(<Editor {...baseProps} post={{ id: 'leaving', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Recover me' } });
    fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('leaving'))).work.content).toBe('Recover me');
    unmount();
    window.localStorage.removeItem(recoveryKey('leaving'));
    fireEvent(window, new Event('pagehide'));
    expect(window.localStorage.getItem(recoveryKey('leaving'))).toBeNull();
  });

  it('confirms local recovery only after storing the latest edits', () => {
    render(<Editor {...baseProps} post={{ id: 'close', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Latest edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByText(/A recovery copy was stored on this device/)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('close'))).work.content).toBe('Latest edit');
  });

  it('does not promise recovery when device storage is unavailable', () => {
    render(<Editor {...baseProps} post={{ id: 'quota', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Do not lose this' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByText(/could not store your latest edits for recovery/)).toBeInTheDocument();
    expect(screen.queryByText(/A recovery copy was stored/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByDisplayValue('Do not lose this')).toBeInTheDocument();
  });

  it('updates the warning if storage stops working while discard is open', () => {
    const onCancel = vi.fn();
    render(<Editor {...baseProps} onCancel={onCancel} post={{ id: 'changing-storage', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Latest edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByText(/A recovery copy was stored on this device/)).toBeInTheDocument();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText(/could not store your latest edits for recovery/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not write recovery content for read-only viewers on background events', () => {
    render(<Editor {...baseProps} isReadOnly post={{ id: 'readonly', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Synthetic change' } });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    fireEvent(window, new Event('pagehide'));
    expect(window.localStorage.getItem(recoveryKey('readonly'))).toBeNull();
  });

  it('explains that a new image is excluded from local recovery', () => {
    render(<Editor {...baseProps} post={{ id: 'image', content: 'Original', client: 'Acme', imageUrl: 'data:image/png;base64,c2FtcGxl' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Image draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByText(/the new image is not included/)).toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem(recoveryKey('image'))).work;
    expect(saved.content).toBe('Image draft');
    expect(saved).not.toHaveProperty('imageUrl');
  });

  it('blocks duplicate saves but keeps the existing discard exit during a pending save', async () => {
    let completeSave;
    const onSave = vi.fn(() => new Promise(resolve => { completeSave = resolve; }));
    const onCancel = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} onCancel={onCancel} post={{ id: 'pending', content: 'Ready', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Ready'), { target: { value: 'Ready to save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Close Editor' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await act(async () => completeSave(false));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('retains newer edits, migrates new-draft recovery and reuses the acknowledged ID', async () => {
    let completeSave;
    const onSave = vi.fn(() => new Promise(resolve => { completeSave = resolve; }));
    const onCancel = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} onCancel={onCancel} initialClient="Acme" />);
    const textarea = document.querySelector('textarea');
    fireEvent.change(textarea, { target: { value: 'First version' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const submitted = onSave.mock.calls[0][0];
    fireEvent.change(textarea, { target: { value: 'Newer version' } });
    const savedPost = { ...submitted, id: 'created-1', clientId: 'acme', status: 'draft' };
    await act(async () => completeSave({ ok: true, post: savedPost }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Newer version')).toBeInTheDocument();
    expect(screen.getByText('Edit Thread')).toBeInTheDocument();
    expect(window.localStorage.getItem(recoveryKey('new'))).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('created-1'))).work.content).toBe('Newer version');
    fireEvent.change(textarea, { target: { value: 'Latest background edit' } });
    fireEvent(window, new Event('pagehide'));
    expect(window.localStorage.getItem(recoveryKey('new'))).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('created-1'))).work.content).toBe('Latest background edit');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[1]).toEqual([
      expect.objectContaining({ id: 'created-1', content: 'Latest background edit' }),
      expect.objectContaining({ savedPost, baselineClientId: 'acme', baselineStatus: 'draft' }),
    ]);
    await act(async () => completeSave({ ok: true, post: onSave.mock.calls[1][0] }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(recoveryKey('created-1'))).toBeNull();
  });

  it('preserves an edit queued in the same React batch as the save acknowledgement', async () => {
    let completeSave;
    const onSave = vi.fn(() => new Promise(resolve => { completeSave = resolve; }));
    const onCancel = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} onCancel={onCancel} post={{ id: 'batched', content: 'Original', client: 'Acme' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Queued update' } });
      completeSave({ ok: true, post: onSave.mock.calls[0][0] });
    });
    expect(screen.getByDisplayValue('Queued update')).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('batched'))).work.content).toBe('Queued update');
  });

  it('keeps the latest edits when a pending save fails', async () => {
    let failSave;
    const onSave = vi.fn(() => new Promise((_resolve, reject) => { failSave = reject; }));
    render(<Editor {...baseProps} onSave={onSave} post={{ id: 'latest-failure', content: 'Original', client: 'Acme' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Typed after saving' } });
    await act(async () => failSave(new Error('Offline')));
    expect(screen.getByDisplayValue('Typed after saving')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(JSON.parse(window.localStorage.getItem(recoveryKey('latest-failure'))).work.content).toBe('Typed after saving');
  });

  it('does not reload the original post when a client-name refresh follows an acknowledged save', async () => {
    let completeSave;
    const onSave = vi.fn(() => new Promise(resolve => { completeSave = resolve; }));
    const original = { id: 'renamed', client: 'Acme', clientId: 'acme', status: 'draft', content: 'Original' };
    const props = { ...baseProps, onSave, post: original, initialClient: 'Acme', clientLocked: true };
    const { rerender } = render(<Editor {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Still editing' } });
    const committed = { ...onSave.mock.calls[0][0], client: 'Acme renamed', status: 'scheduled' };
    await act(async () => completeSave({ ok: true, post: committed }));
    rerender(<Editor {...props} initialClient="Acme renamed" />);
    expect(screen.getByDisplayValue('Still editing')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme renamed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[1][1]).toMatchObject({ baselineClient: 'Acme renamed', baselineStatus: 'scheduled', savedPost: committed });
    await act(async () => completeSave(false));
  });
});
