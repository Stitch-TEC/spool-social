import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import MediaTypeFilter from './MediaTypeFilter';

describe('MediaTypeFilter', () => {
  it('offers three controlled keyboard buttons with pressed state, wrapping and 44px targets', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MediaTypeFilter value="all" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Media type' });
    expect(group).toHaveClass('flex-wrap');
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map(button => button.textContent)).toEqual(['All', 'Images', 'Videos']);
    for (const button of buttons) expect(button).toHaveClass('min-h-11', 'min-w-11', 'focus-visible:outline-2');
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(buttons[2]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('video');
    // The parent owns selection; clicking does not invent local state.
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    rerender(<MediaTypeFilter value="video" onChange={onChange} />);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(buttons[2]).toHaveAttribute('aria-pressed', 'true');
    buttons[1].focus(); expect(buttons[1]).toHaveFocus();
    expect(buttons.every(button => button.type === 'button')).toBe(true);
  });
});
