import React from 'react';
import { Lightbulb } from 'lucide-react';
import { STATUS, APPROVAL_STATUS } from '../constants';

const CHIPS = [
  { key: null, label: 'All' },
  { key: STATUS.DRAFT, label: 'Drafts' },
  { key: STATUS.SCHEDULED, label: 'Scheduled' },
  { key: STATUS.POSTED, label: 'Posted' },
  { key: APPROVAL_STATUS.CHANGES_REQUESTED, label: 'Needs changes' },
];

// Not a post status — the operator-only parked-suggestions lane (automation 'suggest' mode). The
// parent gates `showSuggestions` so clients never see the chip. Given an amber accent + lamp icon
// (when inactive) so parked AI suggestions read as an attention lane, not just another filter.
const SUGGESTIONS_CHIP = { key: 'suggestions', label: 'Suggestions', icon: Lightbulb, accent: 'amber' };

const StatusFilterChips = ({ value, onChange, counts, showSuggestions = false }) => (
  <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
    {(showSuggestions ? [...CHIPS, SUGGESTIONS_CHIP] : CHIPS).map(({ key, label, icon: Icon, accent }) => {
      const count = counts[key ?? 'all'] ?? 0;
      const active = value === key;
      // The selected chip always reads indigo (so "which filter am I on?" stays consistent);
      // only the INACTIVE state carries an accent, drawing the eye to the suggestions lane.
      const inactiveClass = accent === 'amber'
        ? 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-300'
        : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-700';
      return (
        <button
          key={label}
          onClick={() => onChange(key)}
          aria-pressed={active}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
            active
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
              : inactiveClass
          }`}
        >
          {Icon && <Icon size={12} className={active ? '' : (accent === 'amber' ? 'text-amber-500' : '')} />}
          {label}
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] leading-none ${
            active ? 'bg-white/20' : (accent === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500')
          }`}>
            {count}
          </span>
        </button>
      );
    })}
  </div>
);

export default StatusFilterChips;
