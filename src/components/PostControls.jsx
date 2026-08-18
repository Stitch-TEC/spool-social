import React from 'react';
import { ArrowUpDown, Layers, Tag } from 'lucide-react';
import { PLATFORMS } from '../constants';
import { SORT_ORDERS } from '../utils/helpers';
import { SELECT_CLASS, activeSelectClass } from '../utils/facetStyles';

// Sort choices, default (soonest-first) at top. CLIENT_AZ only makes sense for the
// operator (a client member / guest sees one client), filtered out below when
// showClientSort is false.
const SORT_OPTIONS = [
  { value: SORT_ORDERS.SCHEDULED_ASC, label: 'Scheduled — soonest first' },
  { value: SORT_ORDERS.SCHEDULED_DESC, label: 'Scheduled — latest first' },
  { value: SORT_ORDERS.CREATED_DESC, label: 'Recently added' },
  { value: SORT_ORDERS.CREATED_ASC, label: 'Oldest added' },
  { value: SORT_ORDERS.CLIENT_AZ, label: 'Client A–Z', operatorOnly: true },
  { value: SORT_ORDERS.PLATFORM, label: 'Platform' },
];

// A tag is only worth offering as a filter if 2+ posts share it — this hides the
// per-post traceability tags (e.g. an imported calendar id) while keeping the
// real themes (pillars/series). Ranked by frequency, capped for a sane menu.
const filterableTags = (tagCounts, active) => {
  const shared = Object.keys(tagCounts)
    .filter((t) => tagCounts[t] >= 2)
    .sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b))
    .slice(0, 40);
  return active && !shared.includes(active) ? [...shared, active] : shared;
};

const selectClass = SELECT_CLASS;

/**
 * Compact sort + platform-filter controls for the post grid. Pure presentational —
 * all state lives in App. `platformCounts` is a { platformId: count } map over the
 * current client/search/archive scope (before the platform filter) so only
 * platforms that actually have posts are offered, each with its count.
 */
const PostControls = ({
  sortBy, onSortChange,
  filterPlatform, onPlatformChange, platformCounts = {},
  filterTag, onTagChange, tagCounts = {},
  showClientSort = true,
  // Sort always applies; the platform/tag filters can be hidden on lanes where they don't (the
  // Suggestions lane short-circuits before filtering) so dead controls don't mislead.
  showFilters = true,
}) => {
  const present = Object.keys(platformCounts).filter((p) => platformCounts[p] > 0);
  // Keep the active platform selectable even if the other filters dropped its
  // count to 0 (else the controlled <select> value wouldn't match any option).
  const platforms = filterPlatform && !present.includes(filterPlatform) ? [...present, filterPlatform] : present;
  const tags = filterableTags(tagCounts, filterTag);
  const sortOptions = SORT_OPTIONS.filter((o) => !o.operatorOnly || showClientSort);

  return (
    <div className="flex flex-wrap items-center gap-2 shrink-0" role="group" aria-label="Sort and filter posts">
      {/* Platform filter */}
      {showFilters && (
      <div className="relative">
        <Layers size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <select
          value={filterPlatform || ''}
          onChange={(e) => onPlatformChange(e.target.value || null)}
          aria-label="Filter by platform"
          className={activeSelectClass(!!filterPlatform)}
        >
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {(PLATFORMS[p]?.name || p)} ({platformCounts[p] || 0})
            </option>
          ))}
        </select>
        <Chevron />
      </div>
      )}

      {/* Tag filter — only when there are shared tags to filter by */}
      {showFilters && tags.length > 0 && (
        <div className="relative">
          <Tag size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <select
            value={filterTag || ''}
            onChange={(e) => onTagChange(e.target.value || null)}
            aria-label="Filter by tag"
            className={activeSelectClass(!!filterTag)}
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>#{t} ({tagCounts[t] || 0})</option>
            ))}
          </select>
          <Chevron />
        </div>
      )}

      {/* Sort */}
      <div className="relative">
        <ArrowUpDown size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value)}
          aria-label="Sort posts"
          className={selectClass}
        >
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <Chevron />
      </div>
    </div>
  );
};

export const Chevron = () => (
  <svg className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default PostControls;
