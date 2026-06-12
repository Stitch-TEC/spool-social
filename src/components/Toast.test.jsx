import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import Toast from './Toast';

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses after 3 seconds', () => {
    const onClose = vi.fn();
    render(<Toast message="Saved" onClose={onClose} />);
    act(() => vi.advanceTimersByTime(2999));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('re-arms the timer when the message changes (regression: second toast was dismissed early)', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Toast message="First" onClose={onClose} />);

    act(() => vi.advanceTimersByTime(2000));
    rerender(<Toast message="Second" onClose={onClose} />);

    // Old timer would have fired at t=3000; the re-armed one fires at t=5000.
    act(() => vi.advanceTimersByTime(1500));
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1500));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
