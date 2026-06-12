import React from 'react';
import { STATUS, APPROVAL_STATUS } from '../constants';

const CHIPS = [
  { key: null, label: 'All' },
  { key: STATUS.DRAFT, label: 'Drafts' },
  { key: STATUS.SCHEDULED, label: 'Scheduled' },
  { key: STATUS.POSTED, label: 'Posted' },
  { key: APPROVAL_STATUS.CHANGES_REQUESTED, label: 'Needs changes' },
];

const StatusFilterChips = ({ value, onChange, counts }) => (
  <div className="flex flex-wrap gap-2 mb-6" role="group" aria-label="Filter by status">
    {CHIPS.map(({ key, label }) => {
      const count = counts[key ?? 'all'] ?? 0;
      const active = value === key;
      return (
        <button
          key={label}
          onClick={() => onChange(key)}
          aria-pressed={active}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
            active
              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
              : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:text-indigo-700'
          }`}
        >
          {label}
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] leading-none ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>
            {count}
          </span>
        </button>
      );
    })}
  </div>
);

export default StatusFilterChips;
