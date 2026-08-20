import React, { memo } from 'react';
import { Lightbulb, CheckSquare, Image as ImageIcon, AlertTriangle, FilterX } from 'lucide-react';
import { STATUS, REVIEW_STATE, MEDIA_FILTER, NEEDS_FILTER } from '../constants';
import PostControls, { Chevron } from './PostControls';
import DensityToggle from './DensityToggle';
import { activeSelectClass } from '../utils/facetStyles';

// The parked-suggestions lane rides the same control as the review states but is
// NOT one of them (it's a pre-review bin with its own verbs) — App owns the string.
export const SUGGESTIONS_LANE = 'suggestions';

// The primary axis. Order is the funnel itself: nothing sent → sent and waiting →
// the client came back with notes → done. An operator reads this row left to right
// and knows what to do next; the old row mixed workflow status (Draft/Scheduled/
// Posted) with a single review state (Needs changes), so it answered neither
// question cleanly.
const REVIEW_CHIPS = [
  { key: null, label: 'All', tone: 'slate' },
  { key: REVIEW_STATE.NOT_SENT, label: 'Not sent', tone: 'slate', hint: 'Staging — only you can see these' },
  { key: REVIEW_STATE.AWAITING, label: 'Awaiting client', tone: 'amber', hint: 'Sent — waiting on the client' },
  { key: REVIEW_STATE.CHANGES, label: 'Changes', tone: 'rose', hint: 'The client asked for changes' },
  { key: REVIEW_STATE.APPROVED, label: 'Approved', tone: 'emerald', hint: 'Signed off by the client' },
];

const SUGGESTIONS_CHIP = {
  key: SUGGESTIONS_LANE, label: 'Suggestions', tone: 'amber', icon: Lightbulb,
  hint: 'AI options parked by your automations',
};

// Only the INACTIVE state carries the tone — the selected chip is always indigo so
// "which filter am I on?" reads the same everywhere in the app.
const TONES = {
  slate: 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-700',
  amber: 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300',
  rose: 'bg-rose-50 text-rose-700 border-rose-200 hover:border-rose-300',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:border-emerald-300',
};
const COUNT_TONES = {
  slate: 'bg-slate-100 text-slate-500',
  amber: 'bg-amber-100 text-amber-700',
  rose: 'bg-rose-100 text-rose-700',
  emerald: 'bg-emerald-100 text-emerald-700',
};

const STATUS_OPTIONS = [
  { value: STATUS.DRAFT, label: 'Draft' },
  { value: STATUS.SCHEDULED, label: 'Scheduled' },
  { value: STATUS.POSTED, label: 'Posted' },
];

const MEDIA_OPTIONS = [
  { value: MEDIA_FILTER.WITH, label: 'Has an image' },
  { value: MEDIA_FILTER.WITHOUT, label: 'No image' },
];

const NEEDS_OPTIONS = [
  { value: NEEDS_FILTER.IMAGE, label: 'Needs an image' },
  { value: NEEDS_FILTER.NOT_READY, label: 'Not ready to send' },
  { value: NEEDS_FILTER.FEEDBACK, label: 'Has client feedback' },
  { value: NEEDS_FILTER.OVERDUE, label: 'Past its date' },
  { value: NEEDS_FILTER.NO_DATE, label: 'Not scheduled' },
];

// A facet select that offers ONLY values with content, so the menu can never lead
// to an empty grid. The active value is always kept selectable even at count 0 —
// otherwise the controlled <select> would have no matching option once another
// filter zeroed it out, and React would silently blank the control.
const FacetSelect = ({ icon: Icon, label, value, onChange, options, counts, allLabel }) => {
  const present = options.filter((o) => (counts[o.value] || 0) > 0 || o.value === value);
  if (present.length === 0) return null;
  return (
    <div className="relative">
      {Icon && <Icon size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />}
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={label}
        className={activeSelectClass(!!value)}
      >
        <option value="">{allLabel}</option>
        {present.map((o) => (
          <option key={o.value} value={o.value}>{o.label} ({counts[o.value] || 0})</option>
        ))}
      </select>
      <Chevron />
    </div>
  );
};

/**
 * The grid toolbar: review-state chips (primary axis) over a row of facet selects.
 * Purely presentational — every piece of state lives in App, and every count is
 * computed in App's single facet pass, counted against all the OTHER active
 * filters so a chip's number always matches the grid it produces.
 */
const FilterBar = memo(({
  // Primary axis
  filterReview, onReviewChange, reviewCounts,
  showSuggestions = false, suggestionCount = 0,
  // Secondary facets
  filterStatus, onStatusChange, statusCounts,
  filterMedia, onMediaChange, mediaCounts,
  filterNeeds, onNeedsChange, needsCounts,
  filterPlatform, onPlatformChange, platformCounts,
  filterTag, onTagChange, tagCounts,
  sortBy, onSortChange, showClientSort = true,
  // How much of each post the grid shows. A view preference, so it sits apart from
  // the filters — right-aligned at the end of the row, like the header's view switch.
  density, onDensityChange, showDensity = true,
  // The suggestions lane short-circuits every queue facet — hide them there rather
  // than show dead controls whose counts describe a different list.
  showFacets = true,
  activeFilterCount = 0, onClearFilters,
}) => {
  const chips = showSuggestions ? [...REVIEW_CHIPS, SUGGESTIONS_CHIP] : REVIEW_CHIPS;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by review state">
        {chips.map(({ key, label, tone, hint, icon: Icon }) => {
          const count = key === SUGGESTIONS_LANE ? suggestionCount : (reviewCounts[key ?? 'all'] ?? 0);
          const active = filterReview === key;
          return (
            <button
              key={label}
              onClick={() => onReviewChange(key)}
              aria-pressed={active}
              title={hint}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                active ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : TONES[tone]
              }`}
            >
              {Icon && <Icon size={12} className={active ? '' : 'text-amber-500'} />}
              {label}
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] leading-none tabular-nums ${
                active ? 'bg-white/20' : COUNT_TONES[tone]
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Sort and filter posts">
        {showFacets && (
          <>
            <FacetSelect
              icon={CheckSquare} label="Filter by status" allLabel="Any status"
              value={filterStatus} onChange={onStatusChange}
              options={STATUS_OPTIONS} counts={statusCounts}
            />
            <FacetSelect
              icon={ImageIcon} label="Filter by media" allLabel="Any media"
              value={filterMedia} onChange={onMediaChange}
              options={MEDIA_OPTIONS} counts={mediaCounts}
            />
            <FacetSelect
              icon={AlertTriangle} label="Filter by what's missing" allLabel="Anything"
              value={filterNeeds} onChange={onNeedsChange}
              options={NEEDS_OPTIONS} counts={needsCounts}
            />
          </>
        )}

        <PostControls
          sortBy={sortBy}
          onSortChange={onSortChange}
          filterPlatform={filterPlatform}
          onPlatformChange={onPlatformChange}
          platformCounts={platformCounts}
          filterTag={filterTag}
          onTagChange={onTagChange}
          tagCounts={tagCounts}
          showClientSort={showClientSort}
          showFilters={showFacets}
        />

        {activeFilterCount > 0 && (
          <button
            onClick={onClearFilters}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition-colors"
            title="Clear every filter (the client scope in the sidebar stays)"
          >
            <FilterX size={13} /> Clear {activeFilterCount}
          </button>
        )}

        {showDensity && onDensityChange && (
          <div className="ml-auto">
            <DensityToggle value={density} onChange={onDensityChange} />
          </div>
        )}
      </div>
    </div>
  );
});

export default FilterBar;
