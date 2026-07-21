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
    expect(screen.queryByLabelText('Set post status')).toBeNull();
  });

  it('renders a template card with a badge and "Use as draft" instead of Mark Done', () => {
    const onUseTemplate = vi.fn();
    const tmpl = { ...basePost, isTemplate: true };
    render(<PostCard post={tmpl} onEdit={() => {}} onUseTemplate={onUseTemplate} />);
    expect(screen.getByText('Template')).toBeInTheDocument();
    expect(screen.queryByLabelText('Set post status')).toBeNull();
    fireEvent.click(screen.getByText('Use as draft'));
    expect(onUseTemplate).toHaveBeenCalledWith(tmpl);
  });

  it('shows a status selector for a non-template post and can set it to Scheduled', () => {
    const onStatusChange = vi.fn();
    render(<PostCard post={basePost} onEdit={() => {}} onStatusChange={onStatusChange} />);
    const sel = screen.getByLabelText('Set post status');
    expect(sel).toBeInTheDocument();
    expect(screen.queryByText('Use as draft')).toBeNull();
    fireEvent.change(sel, { target: { value: 'scheduled' } });
    expect(onStatusChange).toHaveBeenCalledWith('p1', 'scheduled');
  });

  it('offers "Back for review" (replacing the status selector) when changes are requested', () => {
    const onResubmit = vi.fn();
    const post = { ...basePost, approvalStatus: 'changes_requested', feedback: 'Tighten the CTA' };
    render(<PostCard post={post} onEdit={() => {}} onStatusChange={() => {}} onResubmit={onResubmit} />);
    expect(screen.queryByLabelText('Set post status')).toBeNull();
    fireEvent.click(screen.getByText('Back for review'));
    expect(onResubmit).toHaveBeenCalledWith('p1');
  });

  it('badges an automation-sourced draft as "Auto" only when provenance is shown (operators)', () => {
    const auto = { ...basePost, source: 'automation' };
    // Operator view: the Auto badge distinguishes a machine draft from a hand-written one.
    const { rerender } = render(<PostCard post={auto} onEdit={() => {}} onStatusChange={() => {}} showProvenance />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
    // Client/guest view (no showProvenance): no machine-provenance labeling.
    rerender(<PostCard post={auto} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.queryByText('Auto')).toBeNull();
  });

  it('shows a generated date on a plain auto draft, and a linked source page on a grounded one (operators)', () => {
    // Plain cron auto draft (no site grounding): still self-explains with a generated date.
    const plain = { ...basePost, source: 'automation', createdAt: '2026-07-20T00:00:00Z' };
    const { rerender } = render(<PostCard post={plain} onEdit={() => {}} onStatusChange={() => {}} showProvenance />);
    expect(screen.getByText(/Generated/)).toBeInTheDocument();
    // Grounded auto draft: shows the client's own source page as a link (provenance the worker now
    // stamps on auto drafts too, not just suggestions).
    const grounded = { ...plain, suggestPageUrl: 'https://acme.com/news', suggestPageTitle: 'Latest news' };
    rerender(<PostCard post={grounded} onEdit={() => {}} onStatusChange={() => {}} showProvenance />);
    expect(screen.getByText('Latest news').closest('a')).toHaveAttribute('href', 'https://acme.com/news');
    // Clients/guests never see any of this provenance.
    rerender(<PostCard post={grounded} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.queryByText('Latest news')).toBeNull();
    expect(screen.queryByText(/Generated/)).toBeNull();
  });

  it('shows the "Suggested" badge and site provenance on a parked suggestion card', () => {
    const suggestion = {
      ...basePost,
      source: 'suggestion',
      suggestPageTitle: 'Our Services',
      suggestPageUrl: 'https://acme.com/services',
    };
    render(
      <PostCard
        post={suggestion}
        onEdit={() => {}}
        onPromoteSuggestion={() => {}}
        onDismissSuggestion={() => {}}
        showProvenance
      />
    );
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    // Provenance links to the source page so "Use this" is an informed click.
    const link = screen.getByText('Our Services').closest('a');
    expect(link).toHaveAttribute('href', 'https://acme.com/services');
    expect(screen.getByText('Use this')).toBeInTheDocument();
  });
});
