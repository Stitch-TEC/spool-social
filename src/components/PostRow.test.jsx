import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostRow from './PostRow';

const basePost = {
  id: 'p1',
  client: 'Acme',
  platform: 'gmb',
  content: 'Draft content',
  status: 'draft',
  approvalStatus: 'pending',
  scheduledDate: new Date(2026, 7, 10, 12, 0, 0),
};

describe('PostRow', () => {
  it('shows the channel, the copy and the client, and opens the editor on click', () => {
    const onEdit = vi.fn();
    render(<PostRow post={basePost} onEdit={onEdit} />);

    expect(screen.getByText('Draft content')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    // The channel is an icon in a row, so its name has to be reachable another way.
    expect(screen.getByText('Google Business')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Draft content'));
    expect(onEdit).toHaveBeenCalledWith(basePost);
  });

  it('leads with the title when there is one, then the body', () => {
    render(<PostRow post={{ ...basePost, platform: 'blog', title: 'Why kissing bonds matter' }} onEdit={() => {}} />);
    expect(screen.getByText('Why kissing bonds matter')).toBeInTheDocument();
    expect(screen.getByText('Draft content')).toBeInTheDocument();
  });

  it('marks an empty draft rather than rendering a blank row', () => {
    render(<PostRow post={{ ...basePost, content: '' }} onEdit={() => {}} />);
    expect(screen.getByText('Empty…')).toBeInTheDocument();
  });

  it('reports the review state, and the staging state as "Not sent"', () => {
    render(<PostRow post={{ ...basePost, reviewStage: 'private' }} onEdit={() => {}} />);
    expect(screen.getByText('Not sent')).toBeInTheDocument();
  });

  it('offers "Send for review" for a staged post', () => {
    const onSendForReview = vi.fn();
    const p = { ...basePost, reviewStage: 'private' };
    render(<PostRow post={p} onEdit={() => {}} onSendForReview={onSendForReview} />);
    fireEvent.click(screen.getByLabelText('Send for review'));
    expect(onSendForReview).toHaveBeenCalledWith(p);
    expect(screen.queryByLabelText('Set post status')).toBeNull();
  });

  it('offers "Back for review" (replacing the status control) when changes are requested', () => {
    const onResubmit = vi.fn();
    render(
      <PostRow
        post={{ ...basePost, approvalStatus: 'changes_requested' }}
        onEdit={() => {}}
        onResubmit={onResubmit}
        onStatusChange={() => {}}
      />
    );
    expect(screen.queryByLabelText('Set post status')).toBeNull();
    fireEvent.click(screen.getByLabelText('Back for review'));
    expect(onResubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('keeps the status control for a post already in front of the client', () => {
    const onStatusChange = vi.fn();
    render(<PostRow post={{ ...basePost, reviewStage: 'in_review' }} onEdit={() => {}} onStatusChange={onStatusChange} />);
    expect(screen.getByText('Awaiting')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Set post status'), { target: { value: 'scheduled' } });
    expect(onStatusChange).toHaveBeenCalledWith('p1', 'scheduled');
  });

  it('limits member workflow controls to rule-permitted statuses', () => {
    render(
      <PostRow
        post={{ ...basePost, reviewStage: 'in_review' }}
        onEdit={() => {}}
        onDelete={() => {}}
        onStatusChange={() => {}}
        statusOptions={['draft', 'scheduled']}
      />
    );
    const values = [...screen.getByLabelText('Set post status').options].map(option => option.value);
    expect(values).toEqual(['draft', 'scheduled']);
    expect(screen.queryByLabelText('Archive Thread')).toBeNull();
  });

  it('swaps Archive for Restore on an archived post', () => {
    const onRestore = vi.fn();
    render(<PostRow post={{ ...basePost, status: 'archived' }} onEdit={() => {}} onRestore={onRestore} onArchive={() => {}} />);
    expect(screen.queryByLabelText('Archive Thread')).toBeNull();
    fireEvent.click(screen.getByLabelText('Restore Thread'));
    expect(onRestore).toHaveBeenCalledWith('p1');
  });

  it('does not offer review actions for archived rows', () => {
    const props = { onEdit: () => {}, onResubmit: vi.fn(), onSendForReview: vi.fn() };
    const { rerender } = render(<PostRow
      post={{ ...basePost, status: 'archived', approvalStatus: 'changes_requested', reviewStage: 'in_review' }}
      {...props}
    />);
    expect(screen.queryByLabelText('Back for review')).toBeNull();
    rerender(<PostRow post={{ ...basePost, status: 'archived', reviewStage: 'private' }} {...props} />);
    expect(screen.queryByLabelText('Send for review')).toBeNull();
  });

  it('counts what is missing and names it on hover instead of spending a line on chips', () => {
    // gmb wants an image (warning) and this one has no date (warning) → two gaps.
    render(<PostRow post={{ ...basePost, scheduledDate: null }} onEdit={() => {}} />);
    expect(screen.getByTitle('No image · Not scheduled').textContent).toContain('2');
  });

  it('reads a required-image gap as a blocker, not a warning', () => {
    render(<PostRow post={{ ...basePost, platform: 'instagram' }} onEdit={() => {}} />);
    expect(screen.getByTitle('Needs an image')).toBeInTheDocument();
  });

  it('renders a template row whose primary verb is "Use"', () => {
    const onUseTemplate = vi.fn();
    const tmpl = { ...basePost, isTemplate: true };
    render(<PostRow post={tmpl} onEdit={() => {}} onUseTemplate={onUseTemplate} onDelete={() => {}} />);

    expect(screen.getByText('Template')).toBeInTheDocument();
    // A template sits outside the review loop, so it carries no review badge.
    expect(screen.queryByText('Not sent')).toBeNull();
    fireEvent.click(screen.getByLabelText('Use as draft'));
    expect(onUseTemplate).toHaveBeenCalledWith(tmpl);
  });

  it('renders a parked suggestion with promote / dismiss and nothing that mints a draft', () => {
    const onPromoteSuggestion = vi.fn();
    const onDismissSuggestion = vi.fn();
    const s = { ...basePost, source: 'suggestion' };
    render(
      <PostRow
        post={s}
        onEdit={() => {}}
        onPromoteSuggestion={onPromoteSuggestion}
        onDismissSuggestion={onDismissSuggestion}
      />
    );

    expect(screen.getByText('Suggested')).toBeInTheDocument();
    expect(screen.queryByLabelText('Archive Thread')).toBeNull();
    expect(screen.queryByLabelText('Set post status')).toBeNull();

    fireEvent.click(screen.getByLabelText('Use this suggestion'));
    expect(onPromoteSuggestion).toHaveBeenCalledWith(s);
    fireEvent.click(screen.getByLabelText('Dismiss suggestion'));
    expect(onDismissSuggestion).toHaveBeenCalledWith(s);
  });

  it('labels an automation draft for the operator only', () => {
    const { unmount } = render(<PostRow post={{ ...basePost, source: 'automation' }} onEdit={() => {}} showProvenance />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
    unmount();

    render(<PostRow post={{ ...basePost, source: 'automation' }} onEdit={() => {}} />);
    expect(screen.queryByText('Auto')).toBeNull();
  });

  it('toggles selection instead of opening the editor while selecting', () => {
    const onToggleSelect = vi.fn();
    const onEdit = vi.fn();
    render(<PostRow post={basePost} onEdit={onEdit} selectable onToggleSelect={onToggleSelect} />);
    fireEvent.click(screen.getByText('Draft content'));
    expect(onToggleSelect).toHaveBeenCalledWith('p1');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('shows "No date" for an unscheduled post rather than an empty column', () => {
    render(<PostRow post={{ ...basePost, scheduledDate: null }} onEdit={() => {}} />);
    expect(screen.getByText('No date')).toBeInTheDocument();
  });
});
