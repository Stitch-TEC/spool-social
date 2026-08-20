import { describe, it, expect } from 'vitest';
import { buildGroups, visibleGroups, groupModeFor, groupOf, GROUP_MODE } from './grouping';
import { SORT_ORDERS } from './helpers';

// Local-time constructors on purpose: month bucketing is a calendar question, and
// an ISO string would put a test on either side of a month boundary depending on
// the runner's timezone.
const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

const post = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  client: 'Acme',
  platform: 'gmb',
  scheduledDate: at(2026, 8, 10),
  createdAt: at(2026, 8, 1),
  ...over,
});

// Enough posts to clear GROUP_MIN_POSTS without writing 12 literals every time.
const fill = (n, over) => Array.from({ length: n }, () => post(over));

describe('groupModeFor', () => {
  it('maps each sort order to the axis its ordering implies', () => {
    expect(groupModeFor(SORT_ORDERS.SCHEDULED_ASC)).toBe(GROUP_MODE.MONTH_QUEUE);
    expect(groupModeFor(SORT_ORDERS.SCHEDULED_DESC)).toBe(GROUP_MODE.MONTH_QUEUE);
    expect(groupModeFor(SORT_ORDERS.CREATED_DESC)).toBe(GROUP_MODE.MONTH_CREATED);
    expect(groupModeFor(SORT_ORDERS.CREATED_ASC)).toBe(GROUP_MODE.MONTH_CREATED);
    expect(groupModeFor(SORT_ORDERS.CLIENT_AZ)).toBe(GROUP_MODE.CLIENT);
    expect(groupModeFor(SORT_ORDERS.PLATFORM)).toBe(GROUP_MODE.PLATFORM);
  });

  it('has no axis for an unknown sort', () => {
    expect(groupModeFor('something_else')).toBeNull();
  });
});

describe('groupOf', () => {
  it('labels a scheduled month', () => {
    expect(groupOf(post({ scheduledDate: at(2026, 8, 3) }), GROUP_MODE.MONTH_QUEUE))
      .toEqual({ key: '2026-08', label: 'August 2026' });
  });

  it('falls back to createdAt for an undated post — the key the queue actually sorts by', () => {
    // usePosts orders the scheduled views by `scheduledDate || createdAt`. Keying the
    // heading off scheduledDate alone would drop this post into an island that splits
    // its neighbours' month into two identically-labelled runs.
    const undated = post({ scheduledDate: null, createdAt: at(2026, 8, 3) });
    expect(groupOf(undated, GROUP_MODE.MONTH_QUEUE).label).toBe('August 2026');
  });

  it('reads an ISO createdAt as well as a Date', () => {
    const iso = groupOf({ createdAt: '2026-08-14T12:00:00.000Z' }, GROUP_MODE.MONTH_CREATED);
    expect(iso.key).toMatch(/^2026-08$/);
  });

  it('falls back to a named bucket for a missing client, and a display name for a platform', () => {
    expect(groupOf({ client: '   ' }, GROUP_MODE.CLIENT)).toEqual({ key: '__no_client__', label: 'No client' });
    expect(groupOf({ platform: 'linkedin' }, GROUP_MODE.PLATFORM).label).toBe('LinkedIn');
    expect(groupOf({ platform: 'not_a_platform' }, GROUP_MODE.PLATFORM).label).toBe('not_a_platform');
  });

  it('never throws on a partial doc', () => {
    expect(groupOf(undefined, GROUP_MODE.MONTH_QUEUE).label).toBe('No date set');
    expect(groupOf({ scheduledDate: 'not a date' }, GROUP_MODE.MONTH_QUEUE).label).toBe('No date set');
  });
});

describe('buildGroups', () => {
  it('renders flat (null) for a short list — headers would be noise, not navigation', () => {
    const posts = [
      ...fill(3, { scheduledDate: at(2026, 7, 5) }),
      ...fill(3, { scheduledDate: at(2026, 8, 5) }),
    ];
    expect(buildGroups(posts, SORT_ORDERS.SCHEDULED_ASC)).toBeNull();
  });

  it('renders flat (null) when the whole list is one group', () => {
    expect(buildGroups(fill(30, { scheduledDate: at(2026, 8, 5) }), SORT_ORDERS.SCHEDULED_ASC)).toBeNull();
  });

  it('renders flat (null) for a sort with no natural runs', () => {
    expect(buildGroups(fill(30), 'unknown_sort')).toBeNull();
  });

  it('splits a sorted list into contiguous month runs with true counts', () => {
    const posts = [
      ...fill(4, { scheduledDate: at(2026, 7, 5) }),
      ...fill(10, { scheduledDate: at(2026, 8, 5) }),
      ...fill(2, { scheduledDate: at(2026, 9, 5) }),
    ];
    const groups = buildGroups(posts, SORT_ORDERS.SCHEDULED_ASC, { now: at(2026, 8, 20).getTime() });

    expect(groups.map((g) => [g.label, g.count, g.start, g.end])).toEqual([
      ['July 2026', 4, 0, 4],
      ['August 2026', 10, 4, 14],
      ['September 2026', 2, 14, 16],
    ]);
    // Only the current month is flagged — that marker is what separates the backlog
    // from the live plan in a soonest-first queue.
    expect(groups.map((g) => g.hint)).toEqual([undefined, 'This month', undefined]);
  });

  it('keeps a month whole when an undated post sorts into the middle of it', () => {
    // The regression this guards: three runs — August, "No date set", August — where
    // the operator sees the same heading twice with an island wedged between them.
    const posts = [
      ...fill(6, { scheduledDate: at(2026, 8, 4) }),
      ...fill(1, { scheduledDate: null, createdAt: at(2026, 8, 5) }),
      ...fill(6, { scheduledDate: at(2026, 8, 6) }),
      ...fill(3, { scheduledDate: at(2026, 9, 1) }),
    ];
    const groups = buildGroups(posts, SORT_ORDERS.SCHEDULED_ASC);
    expect(groups.map((g) => `${g.label}:${g.count}`)).toEqual(['August 2026:13', 'September 2026:3']);
  });

  it('re-opens a run when the same key comes back later (never merges non-adjacent posts)', () => {
    const posts = [
      ...fill(6, { client: 'Acme' }),
      ...fill(6, { client: 'Beta' }),
      ...fill(2, { client: 'Acme' }),
    ];
    const groups = buildGroups(posts, SORT_ORDERS.CLIENT_AZ);
    expect(groups.map((g) => `${g.label}:${g.count}`)).toEqual(['Acme:6', 'Beta:6', 'Acme:2']);
  });

  it('groups by platform display name', () => {
    const posts = [...fill(7, { platform: 'gmb' }), ...fill(7, { platform: 'blog' })];
    expect(buildGroups(posts, SORT_ORDERS.PLATFORM).map((g) => g.label)).toEqual(['Google Business', 'Blog']);
  });

  it('survives an empty or missing list', () => {
    expect(buildGroups([], SORT_ORDERS.SCHEDULED_ASC)).toBeNull();
    expect(buildGroups(undefined, SORT_ORDERS.SCHEDULED_ASC)).toBeNull();
  });
});

describe('visibleGroups', () => {
  const groups = [
    { key: 'a', label: 'A', count: 4, start: 0, end: 4 },
    { key: 'b', label: 'B', count: 10, start: 4, end: 14 },
    { key: 'c', label: 'C', count: 2, start: 14, end: 16 },
  ];

  it('clips the window without lying about how much sits under a heading', () => {
    const shown = visibleGroups(groups, 6);
    expect(shown.map((g) => [g.label, g.start, g.end, g.count])).toEqual([
      ['A', 0, 4, 4],
      ['B', 4, 6, 10],
    ]);
  });

  it('passes everything through once the window covers the list', () => {
    expect(visibleGroups(groups, 16)).toEqual(groups);
    expect(visibleGroups(groups, Infinity)).toBe(groups);
  });

  it('stays null when there is nothing to group', () => {
    expect(visibleGroups(null, 10)).toBeNull();
  });
});
