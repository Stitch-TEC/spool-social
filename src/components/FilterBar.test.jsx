import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FilterBar from './FilterBar';
import { SORT_ORDERS } from '../utils/helpers';
import { REVIEW_STATE, MEDIA_FILTER, NEEDS_FILTER, STATUS } from '../constants';

const base = {
  filterReview: null,
  onReviewChange: () => {},
  reviewCounts: {
    all: 20,
    [REVIEW_STATE.NOT_SENT]: 7,
    [REVIEW_STATE.AWAITING]: 8,
    [REVIEW_STATE.CHANGES]: 2,
    [REVIEW_STATE.APPROVED]: 3,
  },
  filterStatus: null,
  onStatusChange: () => {},
  statusCounts: { [STATUS.DRAFT]: 12, [STATUS.SCHEDULED]: 8, [STATUS.POSTED]: 0 },
  filterMedia: null,
  onMediaChange: () => {},
  mediaCounts: { [MEDIA_FILTER.WITH]: 14, [MEDIA_FILTER.WITHOUT]: 6 },
  filterNeeds: null,
  onNeedsChange: () => {},
  needsCounts: {
    [NEEDS_FILTER.IMAGE]: 6,
    [NEEDS_FILTER.NOT_READY]: 0,
    [NEEDS_FILTER.FEEDBACK]: 2,
    [NEEDS_FILTER.OVERDUE]: 0,
    [NEEDS_FILTER.NO_DATE]: 4,
  },
  filterPlatform: null,
  onPlatformChange: () => {},
  platformCounts: { gmb: 12, linkedin: 8 },
  filterTag: null,
  onTagChange: () => {},
  tagCounts: {},
  sortBy: SORT_ORDERS.SCHEDULED_ASC,
  onSortChange: () => {},
};

const optionText = (label) =>
  within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);

describe('FilterBar — review-state chips', () => {
  it('renders the funnel in order with its counts', () => {
    render(<FilterBar {...base} />);
    const group = screen.getByRole('group', { name: 'Filter by review state' });
    const labels = within(group).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['All20', 'Not sent7', 'Awaiting client8', 'Changes2', 'Approved3']);
  });

  it('reports the chosen state, and null for All', () => {
    const onReviewChange = vi.fn();
    render(<FilterBar {...base} onReviewChange={onReviewChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Awaiting client/ }));
    expect(onReviewChange).toHaveBeenCalledWith(REVIEW_STATE.AWAITING);
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    expect(onReviewChange).toHaveBeenLastCalledWith(null);
  });

  it('marks only the active chip as pressed', () => {
    render(<FilterBar {...base} filterReview={REVIEW_STATE.CHANGES} />);
    expect(screen.getByRole('button', { name: /Changes/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Approved/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the suggestions lane only when asked, with its own count', () => {
    const { rerender } = render(<FilterBar {...base} />);
    expect(screen.queryByRole('button', { name: /Suggestions/ })).toBeNull();
    rerender(<FilterBar {...base} showSuggestions suggestionCount={5} />);
    expect(screen.getByRole('button', { name: /Suggestions/ })).toHaveTextContent('Suggestions5');
  });
});

describe('FilterBar — facet selects', () => {
  it('offers media presence with counts', () => {
    render(<FilterBar {...base} />);
    const opts = optionText('Filter by media');
    expect(opts[0]).toBe('Any media');
    expect(opts).toContain('Has an image (14)');
    expect(opts).toContain('No image (6)');
  });

  it('hides facet values with nothing behind them, so a choice can never yield an empty grid', () => {
    render(<FilterBar {...base} />);
    expect(optionText('Filter by status').some((o) => o.startsWith('Posted'))).toBe(false); // count 0
    const needs = optionText("Filter by what's missing");
    expect(needs).toContain('Needs an image (6)');
    expect(needs).toContain('Not scheduled (4)');
    expect(needs.some((o) => o.startsWith('Not ready'))).toBe(false); // count 0
    expect(needs.some((o) => o.startsWith('Past its date'))).toBe(false); // count 0
  });

  it('keeps the ACTIVE value selectable even once another filter zeroes its count', () => {
    // Otherwise the controlled <select> has no matching option and blanks itself.
    render(<FilterBar {...base} filterNeeds={NEEDS_FILTER.OVERDUE} />);
    expect(optionText("Filter by what's missing")).toContain('Past its date (0)');
  });

  it('drops a facet entirely when nothing at all matches it', () => {
    render(<FilterBar {...base} mediaCounts={{}} />);
    expect(screen.queryByLabelText('Filter by media')).toBeNull();
  });

  it('reports the chosen facet value, and null for the "any" option', () => {
    const onMediaChange = vi.fn();
    render(<FilterBar {...base} onMediaChange={onMediaChange} />);
    const sel = screen.getByLabelText('Filter by media');
    fireEvent.change(sel, { target: { value: MEDIA_FILTER.WITHOUT } });
    expect(onMediaChange).toHaveBeenCalledWith(MEDIA_FILTER.WITHOUT);
    fireEvent.change(sel, { target: { value: '' } });
    expect(onMediaChange).toHaveBeenLastCalledWith(null);
  });

  it('hides the queue facets on the suggestions lane (their counts describe a different list)', () => {
    render(<FilterBar {...base} showFacets={false} />);
    expect(screen.queryByLabelText('Filter by media')).toBeNull();
    expect(screen.queryByLabelText('Filter by platform')).toBeNull();
    expect(screen.getByLabelText('Sort posts')).toBeInTheDocument(); // sort always applies
  });
});

describe('FilterBar — clear', () => {
  it('appears only when filters are on, and reports the count', () => {
    const onClearFilters = vi.fn();
    const { rerender } = render(<FilterBar {...base} activeFilterCount={0} onClearFilters={onClearFilters} />);
    expect(screen.queryByText(/Clear/)).toBeNull();
    rerender(<FilterBar {...base} activeFilterCount={3} onClearFilters={onClearFilters} />);
    fireEvent.click(screen.getByText('Clear 3'));
    expect(onClearFilters).toHaveBeenCalled();
  });
});
