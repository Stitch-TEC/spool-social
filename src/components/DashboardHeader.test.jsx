import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
