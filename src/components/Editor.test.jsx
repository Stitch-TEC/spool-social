import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
