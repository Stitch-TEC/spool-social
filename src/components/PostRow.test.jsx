import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostRow from './PostRow';
import { DATE_FORMATTERS } from '../utils/helpers';

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

describe('PostRow — native preview action', () => {
  it('offers a native open button without nesting any sibling action or status control', () => {
    const onEdit = vi.fn();
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><PostRow
      post={basePost} onEdit={onEdit} onDelete={() => {}} onStatusChange={() => {}}
    /></div>);
    const open = screen.getByRole('button', { name: 'Open thread: Draft content' });
    expect(open.tagName).toBe('BUTTON');
    expect(open).toHaveAttribute('type', 'button');
    expect(open).not.toHaveAttribute('aria-pressed');
    expect(open.querySelector('button, select')).toBeNull();
    expect(open.parentElement.tagName).toBe('DIV');
    expect(open.parentElement).not.toHaveAttribute('role');
    fireEvent.click(open);
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(basePost);
    expect(parentClick).not.toHaveBeenCalled();
    // Whitespace still delegates through the original row click, separately.
    fireEvent.click(open.parentElement);
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(parentClick).toHaveBeenCalledTimes(1);
  });

  it('makes the same button an announced selection toggle without opening the editor', () => {
    const onToggleSelect = vi.fn();
    const onEdit = vi.fn();
    const { rerender } = render(<PostRow post={basePost} selectable selected={false} onEdit={onEdit} onToggleSelect={onToggleSelect} />);
    const select = screen.getByRole('button', { name: 'Select thread: Draft content' });
    expect(select).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(select);
    expect(onToggleSelect).toHaveBeenCalledExactlyOnceWith('p1');
    rerender(<PostRow post={basePost} selectable selected onEdit={onEdit} onToggleSelect={onToggleSelect} />);
    expect(screen.getByRole('button', { name: 'Select thread: Draft content' })).toHaveAttribute('aria-pressed', 'true');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('uses a bounded descriptive name while leaving the original preview intact', () => {
    const title = `A\nheadline ${'x'.repeat(200)}`;
    const { rerender } = render(<PostRow post={{ ...basePost, title }} onEdit={() => {}} />);
    const open = screen.getByRole('button', { name: /^Open thread:/ });
    expect(open.getAttribute('aria-label')).toBe(`Open thread: ${title.replace(/\s+/g, ' ').slice(0, 120)}`);
    expect(open).toHaveTextContent('Draft content');
    rerender(<PostRow post={{ ...basePost, title: '', content: '' }} onEdit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open thread: Empty draft' })).toHaveTextContent('Empty…');
  });

  it('uses nonblank content when the title contains only whitespace', () => {
    const { rerender } = render(<PostRow post={{ ...basePost, title: ' \n\t ', content: '  Useful\npreview  ' }} onEdit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open thread: Useful preview' })).toBeInTheDocument();
    rerender(<PostRow post={{ ...basePost, title: '  ', content: '\n\t' }} onEdit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open thread: Empty draft' })).toBeInTheDocument();
  });
});

describe('PostRow — reflow invariants', () => {
  it('lets rows and action groups wrap while preserving readable native control geometry', () => {
    render(<PostRow post={basePost} onEdit={() => {}} onDelete={() => {}} onArchive={() => {}} onStatusChange={() => {}} />);
    const open = screen.getByRole('button', { name: /^Open thread:/ });
    expect(open.parentElement).toHaveClass('flex-wrap', 'min-w-0');
    expect(open).toHaveClass('basis-[10rem]', 'min-h-[44px]', 'focus-visible:outline-2');
    const status = screen.getByLabelText('Set post status');
    expect(status).toHaveClass('w-[5.5rem]', 'max-w-full', 'h-11', 'py-0', 'min-h-[44px]', 'focus-visible:outline-2');
    const date = screen.getByText(DATE_FORMATTERS.short.format(basePost.scheduledDate));
    expect(date.parentElement).toHaveClass('w-[7.875rem]', 'max-w-full');
    expect(date.parentElement).not.toHaveClass('whitespace-nowrap');
    const secondary = screen.getByLabelText('Delete Thread').parentElement;
    expect(secondary).toHaveClass('flex-wrap', 'max-w-full');
    expect(secondary.parentElement).toHaveClass('flex-wrap', 'max-w-full');
    for (const label of ['Edit Thread', 'Archive Thread', 'Delete Thread']) {
      expect(screen.getByLabelText(label)).toHaveClass('min-h-[44px]', 'min-w-[44px]', 'focus-visible:outline-2');
    }
  });

  it.each([false, true])('preserves secondary action arguments and stops the row action (selection=%s)', (selectable) => {
    const onEdit = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const onToggleSelect = vi.fn();
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><PostRow
      post={basePost} selectable={selectable} onEdit={onEdit} onArchive={onArchive}
      onDelete={onDelete} onToggleSelect={onToggleSelect}
    /></div>);
    fireEvent.click(screen.getByLabelText('Archive Thread'));
    fireEvent.click(screen.getByLabelText('Delete Thread'));
    expect(onArchive).toHaveBeenCalledExactlyOnceWith('p1');
    expect(onDelete).toHaveBeenCalledExactlyOnceWith('p1');
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Edit Thread'));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(basePost);
    expect(onToggleSelect).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('keeps native status click/change separate from both row selection and opening', () => {
    const onEdit = vi.fn();
    const onToggleSelect = vi.fn();
    const onStatusChange = vi.fn();
    render(<PostRow post={basePost} selectable onEdit={onEdit} onToggleSelect={onToggleSelect} onStatusChange={onStatusChange} />);
    const status = screen.getByLabelText('Set post status');
    fireEvent.click(status);
    fireEvent.change(status, { target: { value: 'scheduled' } });
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith('p1', 'scheduled');
    expect(onEdit).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['private', 'pending', 'Send for review', 'onSendForReview'],
    ['in_review', 'changes_requested', 'Back for review', 'onResubmit'],
  ])('keeps the %s primary review action isolated from row selection', (reviewStage, approvalStatus, label, prop) => {
    const post = { ...basePost, reviewStage, approvalStatus };
    const callback = vi.fn();
    const onEdit = vi.fn();
    const onToggleSelect = vi.fn();
    render(<PostRow post={post} selectable onEdit={onEdit} onToggleSelect={onToggleSelect} {...{ [prop]: callback }} />);
    fireEvent.click(screen.getByLabelText(label));
    expect(callback).toHaveBeenCalledExactlyOnceWith(post);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it('preserves template and suggestion action separation and propagation', () => {
    const onEdit = vi.fn();
    const onToggleSelect = vi.fn();
    const onUseTemplate = vi.fn();
    const onPromoteSuggestion = vi.fn();
    const onDismissSuggestion = vi.fn();
    const post = { ...basePost, isTemplate: true };
    const common = { onEdit, onToggleSelect, selectable: true, onUseTemplate, onPromoteSuggestion, onDismissSuggestion };
    const { rerender } = render(<PostRow post={post} {...common} onDelete={() => {}} />);
    fireEvent.click(screen.getByLabelText('Use as draft'));
    expect(onUseTemplate).toHaveBeenCalledExactlyOnceWith(post);
    const suggestion = { ...post, source: 'suggestion' };
    rerender(<PostRow post={suggestion} {...common} />);
    expect(screen.queryByLabelText('Use as draft')).toBeNull();
    expect(screen.queryByLabelText('Delete Thread')).toBeNull();
    fireEvent.click(screen.getByLabelText('Use this suggestion'));
    fireEvent.click(screen.getByLabelText('Dismiss suggestion'));
    expect(onPromoteSuggestion).toHaveBeenCalledExactlyOnceWith(suggestion);
    expect(onDismissSuggestion).toHaveBeenCalledExactlyOnceWith(suggestion);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });
});
