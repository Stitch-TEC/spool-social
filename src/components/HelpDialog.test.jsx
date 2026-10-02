import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HelpDialog from './HelpDialog';
import HelpGuides from './HelpGuides';
import HelpDisclosure from './HelpDisclosure';

const Fixture = ({ audience = 'operator' }) => {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open help</button><input aria-label="Background draft" defaultValue="Keep this text" />{open && <HelpDialog audience={audience} onClose={() => setOpen(false)} />}</>;
};

describe('Help dialog and task navigation', () => {
  it.each(['close', 'escape'])('contains focus, preserves background and returns owned focus on %s', async how => {
    const { container } = render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Open help' }); trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Help & guides' });
    const close = within(dialog).getByRole('button', { name: 'Close help' });
    expect(close).toHaveFocus(); expect(container).toHaveAttribute('inert'); expect(container).toHaveAttribute('aria-hidden', 'true');
    await screen.findByRole('searchbox', { name: 'Find a guide' });
    const buttons = within(dialog).getAllByRole('button');
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(buttons.at(-1)).toHaveFocus();
    fireEvent.keyDown(buttons.at(-1), { key: 'Tab' }); expect(close).toHaveFocus();
    if (how === 'close') fireEvent.click(close); else fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(trigger).toHaveFocus();
    expect(container).not.toHaveAttribute('inert'); expect(container).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('textbox', { name: 'Background draft' })).toHaveValue('Keep this text');
  });
  it('does not broadcast Escape to an unrelated window handler', () => {
    const otherEscape = vi.fn(); window.addEventListener('keydown', otherEscape);
    render(<Fixture />); fireEvent.click(screen.getByRole('button', { name: 'Open help' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close help' }), { key: 'Escape' });
    expect(otherEscape).not.toHaveBeenCalled(); window.removeEventListener('keydown', otherEscape);
  });
  it('routes interior Tab explicitly so Safari cannot skip guide buttons', async () => {
    render(<Fixture />); fireEvent.click(screen.getByRole('button', { name: 'Open help' }));
    const search = await screen.findByRole('searchbox');
    const dialog = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close help' });
    const firstGuide = within(dialog).getAllByRole('button')[1];
    fireEvent.keyDown(close, { key: 'Tab' }); expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: 'Tab' }); expect(firstGuide).toHaveFocus();
    fireEvent.keyDown(firstGuide, { key: 'Tab', shiftKey: true }); expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: 'Tab', shiftKey: true }); expect(close).toHaveFocus();
  });
  it('routes Tab logically from article and index headings without escaping the dialog', async () => {
    render(<Fixture />); fireEvent.click(screen.getByRole('button', { name: 'Open help' }));
    fireEvent.click(await screen.findByRole('button', { name: /Add a video link/ }));
    const title = screen.getByRole('heading', { name: 'Add a video link' });
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: 'Tab' }); expect(screen.getByRole('button', { name: 'Close help' })).toHaveFocus();
    title.focus(); fireEvent.keyDown(title, { key: 'Tab', shiftKey: true }); expect(screen.getByRole('button', { name: 'All guides' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'All guides' }));
    const index = screen.getByRole('heading', { name: 'Operator guides' }); expect(index).toHaveFocus();
    fireEvent.keyDown(index, { key: 'Tab', shiftKey: true }); expect(screen.getByRole('button', { name: 'Close help' })).toHaveFocus();
    index.focus(); fireEvent.keyDown(index, { key: 'Tab' }); expect(screen.getByRole('searchbox')).toHaveFocus();
  });
  it('keeps typing focus, searches, focuses topic headings and returns with search intact', () => {
    render(<HelpGuides audience="operator" />);
    const search = screen.getByRole('searchbox', { name: 'Find a guide' }); search.focus();
    fireEvent.change(search, { target: { value: 'video' } }); expect(search).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /Add a video link/ }));
    expect(screen.getByRole('heading', { name: 'Add a video link' })).toHaveFocus();
    expect(screen.getByText(/Before you act:/).parentElement).toHaveTextContent('not a private attachment');
    fireEvent.click(screen.getByRole('button', { name: 'All guides' }));
    expect(screen.getByRole('heading', { name: 'Operator guides' })).toHaveFocus();
    expect(screen.getByRole('searchbox', { name: 'Find a guide' })).toHaveValue('video');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' })); expect(screen.getByRole('searchbox')).toHaveFocus(); expect(screen.getByRole('searchbox')).toHaveValue('');
  });
  it('renders a useful empty state and treats search as text', () => {
    render(<HelpGuides audience="guest" />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '<script>unknown</script>' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching guides');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByText('Share a draft for review')).toBeNull();
  });
  it('has only a native tap/keyboard disclosure, not a hover dependency', () => {
    render(<HelpDisclosure label="Review states"><p>Review is not publication.</p></HelpDisclosure>);
    const summary = screen.getByText('Review states');
    expect(summary.tagName).toBe('SUMMARY'); expect(summary).toHaveClass('min-h-11'); expect(summary).not.toHaveAttribute('title');
    expect(summary.parentElement.tagName).toBe('DETAILS'); expect(summary.parentElement).not.toHaveAttribute('open');
  });
});
