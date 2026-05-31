import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostCard from './PostCard';

const basePost = {
  id: 'p1',
  client: 'Acme',
  platform: 'gmb',
  content: 'Draft content',
  status: 'draft',
  approvalStatus: 'pending',
};

describe('PostCard', () => {
  it('renders content + client and calls onEdit when the body is clicked', () => {
    const onEdit = vi.fn();
    render(<PostCard post={basePost} onEdit={onEdit} />);
    expect(screen.getByText('Draft content')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Draft content'));
    expect(onEdit).toHaveBeenCalledWith(basePost);
  });

  it('shows the approved badge when the post is approved', () => {
    render(<PostCard post={{ ...basePost, approvalStatus: 'approved' }} onEdit={() => {}} />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('hides owner-only actions in read-only (guest) mode', () => {
    render(<PostCard post={basePost} onEdit={() => {}} isReadOnly />);
    expect(screen.queryByLabelText('Delete Thread')).toBeNull();
    expect(screen.queryByText('Mark Done')).toBeNull();
  });
});
