import React from 'react';
import { LayoutGrid, LayoutList, List } from 'lucide-react';
import { DENSITY } from '../constants';

// Ordered loosest → tightest, which is also the order of how much of a post you
// see: full card → thumbnail + two lines → one row. Labels are spelled out in the
// tooltip because the icons alone can't say how much density you're buying.
const MODES = [
  {
    value: DENSITY.CARDS,
    icon: LayoutGrid,
    label: 'Cards',
    hint: 'Cards — full image and three lines of copy',
  },
  {
    value: DENSITY.COMPACT,
    icon: LayoutList,
    label: 'Compact',
    hint: 'Compact — thumbnail beside two lines, about twice as many per screen',
  },
  {
    value: DENSITY.LIST,
    icon: List,
    label: 'List',
    hint: 'List — one row per thread, for scanning hundreds at once',
  },
];

/**
 * How much of each post the feed shows. Purely a view preference (App persists it
 * per browser) — it changes nothing about what is in the list, which is why it sits
 * apart from the filter controls rather than among them.
 */
const DensityToggle = ({ value, onChange }) => (
  <div className="flex bg-slate-100 p-0.5 rounded-lg shrink-0" role="group" aria-label="Feed density">
    {MODES.map((mode) => {
      const Icon = mode.icon;
      const { value: v, label, hint } = mode;
      const active = value === v;
      return (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={active}
          aria-label={`${label} view`}
          title={hint}
          className={`p-1.5 rounded-md transition-colors ${
            active ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <Icon size={15} />
        </button>
      );
    })}
  </div>
);

export default DensityToggle;
