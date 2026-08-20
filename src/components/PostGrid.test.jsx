import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostGrid from './PostGrid';
import { DENSITY } from '../constants';
import { SORT_ORDERS } from '../utils/helpers';

// Local-time constructor: month bucketing is a calendar question (see grouping.test.js).
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

const post = (i, over = {}) => ({
  id: `p${i}`,
  client: 'Acme',
  platform: 'gmb',
  content: `Draft body ${i}`,
  status: 'draft',
  approvalStatus: 'pending',
  reviewStage: 'private',
  scheduledDate: at(2026, 8, 10),
  createdAt: at(2026, 8, 1),
  ...over,
});

const make = (n, over) => Array.from({ length: n }, (_, i) => post(i, over));

const baseProps = {
  clientMap: {},
  onEdit: () => {},
  onDelete: () => {},
  onStatusChange: () => {},
  onArchive: () => {},
  onRestore: () => {},
  onCloneToAll: () => {},
  onDuplicate: () => {},
  onSendForReview: () => {},
  onCreate: () => {},
  sortBy: SORT_ORDERS.SCHEDULED_ASC,
};

// jsdom has no IntersectionObserver, so useWindowedList intentionally degrades to
// "render everything" — which is what makes the layout assertions below exhaustive.
// The windowing tests further down install a stub to exercise the other branch.
describe('PostGrid — density', () => {
  it('renders full cards by default (the footer actions are card-only)', () => {
    render(<PostGrid {...baseProps} posts={make(3)} />);
    expect(screen.getAllByText('Open App')).toHaveLength(3);
  });

  it('renders one row per post in list density, and drops the card-only footer', () => {
    render(<PostGrid {...baseProps} posts={make(3)} density={DENSITY.LIST} />);
    expect(screen.queryByLabelText('Open platform app')).toBeNull();
    expect(screen.getAllByLabelText('Send for review')).toHaveLength(3);
    expect(screen.getByText('Draft body 0')).toBeInTheDocument();
  });

  it('keeps the card layout in compact density (same verbs, tighter box)', () => {
    render(<PostGrid {...baseProps} posts={make(2)} density={DENSITY.COMPACT} />);
    // Same buttons as a full card, minus the text labels the narrower box can't afford.
    expect(screen.getAllByLabelText('Open platform app')).toHaveLength(2);
    expect(screen.queryByText('Open App')).toBeNull();
  });

  it('falls back to cards for an unrecognised density value', () => {
    render(<PostGrid {...baseProps} posts={make(2)} density="wat" />);
    expect(screen.getAllByText('Open App')).toHaveLength(2);
  });

  it('pins a review guest to cards even when list density is requested', () => {
    // A one-line row invites approving copy the client only skimmed, so the guest's
    // surface never becomes a list — App hides the control and the grid enforces it.
    render(<PostGrid {...baseProps} posts={make(2)} isReadOnly density={DENSITY.LIST} />);
    expect(screen.getAllByText('Approve')).toHaveLength(2);
    expect(screen.queryByLabelText('Send for review')).toBeNull();
  });
});

describe('PostGrid — group headings', () => {
  it('breaks a long list into runs that follow the sort, with the full run count', () => {
    const posts = [
      ...make(4, { scheduledDate: at(2026, 7, 5) }),
      ...make(10, { scheduledDate: at(2026, 8, 5) }),
    ];
    render(<PostGrid {...baseProps} posts={posts} sortBy={SORT_ORDERS.SCHEDULED_ASC} />);

    const july = screen.getByRole('heading', { name: /July 2026/ });
    expect(july).toBeInTheDocument();
    expect(july.textContent).toContain('4');
    expect(screen.getByRole('heading', { name: /August 2026/ }).textContent).toContain('10');
  });

  it('groups by client when sorting by client', () => {
    const posts = [...make(7, { client: 'Acme' }), ...make(7, { client: 'Beta' })];
    render(<PostGrid {...baseProps} posts={posts} sortBy={SORT_ORDERS.CLIENT_AZ} />);
    expect(screen.getByRole('heading', { name: /Acme/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Beta/ })).toBeInTheDocument();
  });

  it('stays flat for a short list — a heading over six cards is noise', () => {
    const posts = [
      ...make(3, { scheduledDate: at(2026, 7, 5) }),
      ...make(3, { scheduledDate: at(2026, 8, 5) }),
    ];
    render(<PostGrid {...baseProps} posts={posts} sortBy={SORT_ORDERS.SCHEDULED_ASC} />);
    expect(screen.queryByRole('heading', { name: /July 2026/ })).toBeNull();
    expect(screen.getAllByText(/^Draft body/)).toHaveLength(6);
  });

  it('groups the list density too', () => {
    const posts = [
      ...make(4, { scheduledDate: at(2026, 7, 5) }),
      ...make(10, { scheduledDate: at(2026, 8, 5) }),
    ];
    render(<PostGrid {...baseProps} posts={posts} density={DENSITY.LIST} sortBy={SORT_ORDERS.SCHEDULED_ASC} />);
    expect(screen.getByRole('heading', { name: /July 2026/ })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Send for review')).toHaveLength(14);
  });
});

describe('PostGrid — list size readout', () => {
  it('says how long the list is once everything is mounted', () => {
    render(<PostGrid {...baseProps} posts={make(3)} />);
    expect(screen.getByText('3 threads — end of list')).toBeInTheDocument();
  });

  it('uses the singular for one post', () => {
    render(<PostGrid {...baseProps} posts={make(1)} />);
    expect(screen.getByText('1 thread — end of list')).toBeInTheDocument();
  });

  it('keeps the empty states it had before', () => {
    render(<PostGrid {...baseProps} posts={[]} />);
    expect(screen.getByText('No threads found')).toBeInTheDocument();

    render(<PostGrid {...baseProps} posts={[]} isSuggestionLane />);
    expect(screen.getByText('No suggestions waiting')).toBeInTheDocument();
  });
});

describe('PostGrid — incremental window', () => {
  let observed;
  beforeEach(() => {
    observed = [];
    class StubIO {
      constructor(cb) { this.cb = cb; }
      observe(el) { observed.push(el); }
      disconnect() {}
    }
    globalThis.IntersectionObserver = StubIO;
  });
  afterEach(() => { delete globalThis.IntersectionObserver; });

  it('mounts one page, reports the window honestly, and expands on "Show all"', () => {
    // 60 > the cards page size (48), so the first paint is a partial window.
    render(<PostGrid {...baseProps} posts={make(60)} sortBy="unsorted" />);

    expect(screen.getAllByText('Open App')).toHaveLength(48);
    expect(screen.getByText('Showing 48 of 60')).toBeInTheDocument();
    // The sentinel is only observed while there is more to load.
    expect(observed).toHaveLength(1);

    fireEvent.click(screen.getByText('Show all 60'));
    expect(screen.getAllByText('Open App')).toHaveLength(60);
    expect(screen.getByText('60 threads — end of list')).toBeInTheDocument();
  });

  it('gives the list density a bigger page, because a row costs less than a card', () => {
    // 60 posts is a full list at list density (page size 150) but a partial one as cards.
    render(<PostGrid {...baseProps} posts={make(60)} density={DENSITY.LIST} sortBy="unsorted" />);
    expect(screen.getAllByLabelText('Send for review')).toHaveLength(60);
    expect(screen.getByText('60 threads — end of list')).toBeInTheDocument();
  });

  it('collapses the window when the filter context changes', () => {
    const { rerender } = render(<PostGrid {...baseProps} posts={make(60)} resetKey="a" sortBy="unsorted" />);
    fireEvent.click(screen.getByText('Show all 60'));
    expect(screen.getAllByText('Open App')).toHaveLength(60);

    rerender(<PostGrid {...baseProps} posts={make(60)} resetKey="b" sortBy="unsorted" />);
    expect(screen.getAllByText('Open App')).toHaveLength(48);
  });

  it('keeps a heading truthful about a run it has only partly mounted', () => {
    const posts = [
      ...make(40, { scheduledDate: at(2026, 7, 5) }),
      ...make(20, { scheduledDate: at(2026, 8, 5) }),
    ];
    render(<PostGrid {...baseProps} posts={posts} sortBy={SORT_ORDERS.SCHEDULED_ASC} />);

    // 48 of 60 mounted: July is whole, August has 8 of its 20 on screen — and says 20.
    expect(screen.getByRole('heading', { name: /July 2026/ }).textContent).toContain('40');
    expect(screen.getByRole('heading', { name: /August 2026/ }).textContent).toContain('20');
    expect(screen.getAllByText('Open App')).toHaveLength(48);
  });
});

describe('PostGrid — selection', () => {
  it('routes a row click to selection rather than the editor when selecting', () => {
    const onToggleSelect = vi.fn();
    const onEdit = vi.fn();
    render(
      <PostGrid
        {...baseProps}
        posts={make(1)}
        density={DENSITY.LIST}
        selectable
        selectedIds={new Set()}
        onToggleSelect={onToggleSelect}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByText('Draft body 0'));
    expect(onToggleSelect).toHaveBeenCalledWith('p0');
    expect(onEdit).not.toHaveBeenCalled();
  });
});
