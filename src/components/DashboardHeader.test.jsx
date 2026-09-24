import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DashboardHeader from './DashboardHeader';

const base = {
  view: 'grid', onViewChange: () => {}, searchQuery: '', onSearchChange: () => {},
  onToggleSidebar: () => {}, onShare: () => {}, filterClient: null, onNew: () => {}, onSignOut: () => {},
};

describe('DashboardHeader identity chip', () => {
  it('shows the signed-in email + role for a real user', () => {
    render(<DashboardHeader {...base} isReadOnly={false} userEmail="dillon@stitchtec.dev" role="super_admin" />);
    expect(screen.getByText('dillon@stitchtec.dev')).toBeInTheDocument();
    expect(screen.getByText('Operator')).toBeInTheDocument();
    // avatar initial
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('maps client roles to a readable label', () => {
    render(<DashboardHeader {...base} isReadOnly={false} userEmail="jane@acme.com" role="client_admin" />);
    expect(screen.getByText('Client admin')).toBeInTheDocument();
  });

  it('shows no identity chip in guest (read-only) mode', () => {
    render(<DashboardHeader {...base} isReadOnly userEmail="" role={null} />);
    expect(screen.queryByText('Operator')).toBeNull();
    // logout/exit control is still present
    expect(screen.getByLabelText('Exit View')).toBeInTheDocument();
  });
});

describe('DashboardHeader controls and responsive contract', () => {
  it('retains each operator action and exposes the selected view', () => {
    const actions = {
      onViewChange: vi.fn(), onToggleSidebar: vi.fn(), onShare: vi.fn(),
      onNew: vi.fn(), onSignOut: vi.fn(),
    };
    render(<DashboardHeader {...base} {...actions} isReadOnly={false} />);
    expect(screen.getByRole('button', { name: 'Grid View' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Calendar View' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Grid View' }));
    fireEvent.click(screen.getByRole('button', { name: 'Calendar View' }));
    expect(actions.onViewChange.mock.calls).toEqual([['grid'], ['calendar']]);
    for (const [label, handler] of [
      ['Toggle Sidebar', 'onToggleSidebar'], ['Share for client review', 'onShare'],
      ['Create New Thread', 'onNew'], ['Log Out', 'onSignOut'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(actions[handler]).toHaveBeenCalledOnce();
    }
  });

  it('keeps the full long client Share name while bounding only its visible label', () => {
    const client = 'A very long client name with many words and an-unbroken-suffix';
    render(<DashboardHeader {...base} isReadOnly={false} filterClient={client} />);
    const share = screen.getByRole('button', { name: `Share ${client} for client review` });
    expect(share).toHaveAttribute('title', `Share ${client} for client review`);
    expect(screen.getByText(`Share ${client}`)).toHaveClass('truncate', 'max-w-[112px]');
  });

  it('retains controlled search edits and clear returns focus to search', () => {
    const onSearchChange = vi.fn();
    render(<DashboardHeader {...base} searchQuery="Existing query" onSearchChange={onSearchChange} />);
    const search = screen.getByRole('textbox', { name: 'Search threads' });
    fireEvent.change(search, { target: { value: 'New query' } });
    expect(onSearchChange).toHaveBeenLastCalledWith('New query');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onSearchChange).toHaveBeenLastCalledWith('');
    expect(search).toHaveFocus();
  });

  it('retains slash shortcut without intercepting field input or modified shortcuts', () => {
    render(<DashboardHeader {...base} />);
    const search = screen.getByRole('textbox', { name: 'Search threads' });
    const logout = screen.getByRole('button', { name: 'Log Out' });
    logout.focus();
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    expect(logout).toHaveFocus();
    fireEvent.keyDown(window, { key: '/' });
    expect(search).toHaveFocus();
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('removes the search shortcut listener on unmount', () => {
    const { unmount } = render(<DashboardHeader {...base} />);
    unmount();
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps guest search and exit but does not expose editing, navigation or account controls', () => {
    const onSignOut = vi.fn();
    render(<DashboardHeader {...base} isReadOnly userEmail="hidden@example.test" role="super_admin" onSignOut={onSignOut} />);
    expect(screen.getByRole('textbox', { name: 'Search threads' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Stitch TEC website' })).toHaveAttribute('href', 'https://stitchtec.dev');
    for (const label of ['Toggle Sidebar', 'Switch Stitch Suite app', 'Grid View', 'Calendar View', 'Share for client review', 'Create New Thread', 'Log Out']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    expect(screen.queryByText('hidden@example.test')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Exit View' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('keeps client-admin actions identical to the existing role contract', () => {
    render(<DashboardHeader {...base} isReadOnly={false} userEmail="client@example.test" role="client_admin" />);
    expect(screen.getByRole('button', { name: 'Share for client review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create New Thread' })).toBeInTheDocument();
    expect(screen.getByText('Client admin')).toBeInTheDocument();
  });

  it('allows natural wrapping at every width without a fixed-height or clipping workaround', () => {
    render(<DashboardHeader {...base} searchQuery="query" />);
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('flex-wrap', 'sticky', 'top-0');
    expect(header).toHaveClass('[@media(max-height:32rem)]:static');
    expect(header).not.toHaveClass('h-16', '2xl:h-16', '2xl:flex-nowrap', 'overflow-hidden', 'overflow-x-hidden');
    expect(screen.getByRole('textbox', { name: 'Search threads' }).parentElement.parentElement)
      .toHaveClass('min-w-[min(100%,10rem)]');
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('min-h-11', 'min-w-11');
      expect(button.className).toContain('focus-visible:outline');
    }
    expect(screen.getByRole('textbox', { name: 'Search threads' })).toHaveClass('min-h-11', 'min-w-0');
  });
});
