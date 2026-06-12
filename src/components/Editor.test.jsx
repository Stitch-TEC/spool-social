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
