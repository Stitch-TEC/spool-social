// =============================================================================
// Feed grouping — landmarks for a long queue.
//
// A workspace here routinely holds several hundred posts, and until now the grid
// rendered them as one undifferentiated wall: nothing told you where "next week"
// ended, or where one client's posts stopped and the next client's began. The
// SORT already implies those boundaries; this module just makes them visible.
//
// The group axis is DERIVED FROM THE SORT — and specifically from the SAME KEY the
// sort orders by, which is what makes every run provably contiguous. Grouping by
// anything else fragments the list: `usePosts` sorts the scheduled views by
// `scheduledDate || createdAt`, so keying the headings off `scheduledDate` alone
// dropped every undated post into a "No date set" island in the middle of a month,
// splitting that month into two identically-labelled runs.
//   scheduled sorts → calendar month of scheduledDate, falling back to createdAt
//                     (exactly usePosts' `_sortTs`)
//   created sorts   → calendar month the draft was added
//   Client A–Z      → client
//   Platform        → platform
//
// Pure: no React, no DOM. Grouping is computed once per (list, sort) and reused
// across the grid's incremental window.
// =============================================================================
import { PLATFORMS } from '../constants';
import { DATE_FORMATTERS, SORT_ORDERS } from './helpers';

// Below this many posts a header row is noise, not navigation — you can already
// see the whole list. Deliberately generous: the grid shows ~6-12 cards per screen.
export const GROUP_MIN_POSTS = 12;

export const GROUP_MODE = {
  // The queue's own ordering date: scheduledDate when there is one, else createdAt.
  MONTH_QUEUE: 'month_queue',
  MONTH_CREATED: 'month_created',
  CLIENT: 'client',
  PLATFORM: 'platform',
};

/** Which axis a given sort order implies, or null when the sort has no natural runs. */
export const groupModeFor = (sortBy) => {
  switch (sortBy) {
    case SORT_ORDERS.SCHEDULED_ASC:
    case SORT_ORDERS.SCHEDULED_DESC:
      return GROUP_MODE.MONTH_QUEUE;
    case SORT_ORDERS.CREATED_ASC:
    case SORT_ORDERS.CREATED_DESC:
      return GROUP_MODE.MONTH_CREATED;
    case SORT_ORDERS.CLIENT_AZ:
      return GROUP_MODE.CLIENT;
    case SORT_ORDERS.PLATFORM:
      return GROUP_MODE.PLATFORM;
    default:
      return null;
  }
};

const asDate = (v) => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

// Only reachable for a doc with neither a scheduled date NOR a createdAt — usePosts
// always supplies the latter, so in practice this is a guard, not a bucket you see.
// An UNDATED post is deliberately NOT bucketed here: it sorts by createdAt, so it
// belongs to the run it sorts into (its own card/row still reads "No date set", which
// is where that fact belongs — a heading can only describe position in the order).
const NO_DATE = { key: '__no_date__', label: 'No date set' };

const monthGroup = (date) => {
  if (!date) return NO_DATE;
  return {
    key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
    label: DATE_FORMATTERS.monthYear.format(date),
  };
};

/** { key, label } for one post under one group mode. Never throws on a partial doc. */
export const groupOf = (post, mode) => {
  switch (mode) {
    case GROUP_MODE.MONTH_QUEUE:
      return monthGroup(asDate(post?.scheduledDate) || asDate(post?.createdAt));
    case GROUP_MODE.MONTH_CREATED:
      return monthGroup(asDate(post?.createdAt));
    case GROUP_MODE.CLIENT: {
      const name = String(post?.client || '').trim();
      return name ? { key: `c:${name}`, label: name } : { key: '__no_client__', label: 'No client' };
    }
    case GROUP_MODE.PLATFORM: {
      const id = post?.platform || '';
      return { key: `p:${id}`, label: PLATFORMS[id]?.name || id || 'Unknown platform' };
    }
    default:
      return null;
  }
};

/**
 * Contiguous runs over an ALREADY-SORTED list.
 *
 * Returns null — meaning "render one flat grid, same as before" — when grouping
 * wouldn't help: no group axis for this sort, too few posts to need landmarks, or
 * everything lands in a single group (a header naming the whole list says nothing).
 *
 * Each run is `{ key, label, hint, count, start, end }` with `end` EXCLUSIVE, so a
 * caller can slice the source list directly. `count` is the run's TRUE size even
 * when the caller has only mounted part of it, so a header can't lie about how
 * much sits underneath it.
 */
export function buildGroups(posts, sortBy, { minPosts = GROUP_MIN_POSTS, now = Date.now() } = {}) {
  const mode = groupModeFor(sortBy);
  const list = posts || [];
  if (!mode || list.length < minPosts) return null;

  const currentMonth = monthGroup(new Date(now)).key;
  const isMonthMode = mode === GROUP_MODE.MONTH_QUEUE || mode === GROUP_MODE.MONTH_CREATED;

  const runs = [];
  let open = null;
  for (let i = 0; i < list.length; i++) {
    const g = groupOf(list[i], mode);
    if (!open || open.key !== g.key) {
      if (open) runs.push(open);
      open = {
        key: g.key,
        label: g.label,
        // "This month" is the one temporal cue worth spending a header on: in a
        // soonest-first queue it marks where the backlog ends and the live plan begins.
        hint: isMonthMode && g.key === currentMonth ? 'This month' : undefined,
        count: 0,
        start: i,
        end: i,
      };
    }
    open.count++;
    open.end = i + 1;
  }
  if (open) runs.push(open);

  return runs.length > 1 ? runs : null;
}

/**
 * The runs that intersect the first `limit` posts, clipped to it — the grid mounts
 * an incremental window, so a run can be half-rendered. `count` is left alone (the
 * header keeps reporting the full run); only `end` moves.
 */
export function visibleGroups(groups, limit) {
  if (!groups) return null;
  if (!Number.isFinite(limit)) return groups;
  const out = [];
  for (const g of groups) {
    if (g.start >= limit) break;
    out.push(g.end <= limit ? g : { ...g, end: limit });
  }
  return out;
}
