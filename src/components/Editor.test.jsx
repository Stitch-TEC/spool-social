import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Editor from './Editor';

const baseProps = {
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
    window.localStorage.clear();
  });

  it('defaults the schedule input to local time, not UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T09:30:00'));
    try {
      const { container } = render(<Editor {...baseProps} />);
      const input = container.querySelector('input[type="datetime-local"]');
      expect(input.value).toBe(toLocalISOString(new Date()));
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
    const onSave = vi.fn().mockResolvedValue(true);
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

  it('does not offer to save whitespace-only content', () => {
    const onSave = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} post={{ id: 'empty', content: '   \n ', client: 'Acme' }} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps edits and enables retry when saving rejects', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(true);
    const showToast = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} showToast={showToast} post={{ id: 'retry', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Keep my changes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Your edits are still here'), 'error'));
    expect(screen.getByDisplayValue('Keep my changes')).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('spool:autosave:retry')).content).toBe('Keep my changes');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.localStorage.getItem('spool:autosave:retry')).toBeNull());
    fireEvent(window, new Event('pagehide'));
    expect(window.localStorage.getItem('spool:autosave:retry')).toBeNull();
  });

  it('keeps a recovery copy when the save boundary reports failure', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(<Editor {...baseProps} onSave={onSave} post={{ id: 'failed', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Still unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem('spool:autosave:failed')).content).toBe('Still unsaved'));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('flushes the latest edits when a mobile app is hidden before the debounce', () => {
    render(<Editor {...baseProps} post={{ id: 'hidden', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Before backgrounding' } });
    expect(window.localStorage.getItem('spool:autosave:hidden')).toBeNull();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(JSON.parse(window.localStorage.getItem('spool:autosave:hidden')).content).toBe('Before backgrounding');
  });

  it('flushes on pagehide and removes lifecycle listeners when closed', () => {
    const { unmount } = render(<Editor {...baseProps} post={{ id: 'leaving', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Recover me' } });
    fireEvent(window, new Event('pagehide'));
    expect(JSON.parse(window.localStorage.getItem('spool:autosave:leaving')).content).toBe('Recover me');
    unmount();
    window.localStorage.removeItem('spool:autosave:leaving');
    fireEvent(window, new Event('pagehide'));
    expect(window.localStorage.getItem('spool:autosave:leaving')).toBeNull();
  });

  it('confirms local recovery only after storing the latest edits', () => {
    render(<Editor {...baseProps} post={{ id: 'close', content: 'Original', client: 'Acme' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Latest edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByText(/A recovery copy was stored on this device/)).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('spool:autosave:close')).content).toBe('Latest edit');
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
    expect(window.localStorage.getItem('spool:autosave:readonly')).toBeNull();
  });

  it('explains that a new image is excluded from local recovery', () => {
    render(<Editor {...baseProps} post={{ id: 'image', content: 'Original', client: 'Acme', imageUrl: 'data:image/png;base64,c2FtcGxl' }} />);
    fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Image draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    expect(screen.getByText(/the new image is not included/)).toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem('spool:autosave:image'));
    expect(saved.content).toBe('Image draft');
    expect(saved).not.toHaveProperty('imageUrl');
  });

  it('prevents closing or duplicate submission while a save is pending', async () => {
    let completeSave;
    const onSave = vi.fn(() => new Promise(resolve => { completeSave = resolve; }));
    const onCancel = vi.fn();
    render(<Editor {...baseProps} onSave={onSave} onCancel={onCancel} post={{ id: 'pending', content: 'Ready', client: 'Acme' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Close Editor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Saving...' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    completeSave(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Editor' })).toBeEnabled());
  });
});
