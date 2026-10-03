import React from 'react';

const TYPES = [['all', 'All'], ['image', 'Images'], ['video', 'Videos']];

const MediaTypeFilter = ({ value, onChange }) => (
  <div role="group" aria-label="Media type" className="flex min-w-0 flex-wrap gap-2">
    {TYPES.map(([type, label]) => (
      <button key={type} type="button" aria-pressed={value === type} onClick={() => onChange(type)}
        className={`min-h-11 min-w-11 rounded-lg border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${value === type ? 'border-indigo-700 bg-indigo-700 text-white' : 'border-slate-500 bg-white text-slate-700 hover:bg-slate-50'}`}>
        {label}
      </button>
    ))}
  </div>
);

export default MediaTypeFilter;
