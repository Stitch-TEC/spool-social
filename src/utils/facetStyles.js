// Shared styling for the grid toolbar's facet <select>s. Lives outside the
// component files so both PostControls and FilterBar render one visually
// consistent row from ONE class string (and so neither file has to export a
// non-component, which breaks React Fast Refresh).

export const SELECT_CLASS =
  'appearance-none bg-white border border-slate-200 rounded-lg pl-8 pr-7 py-1.5 text-xs font-semibold text-slate-600 ' +
  'hover:border-indigo-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer transition-colors';

// An ACTIVE facet reads indigo, so "what am I filtered by?" is answerable at a
// glance across a six-control toolbar instead of by reading every dropdown value.
export const activeSelectClass = (active) =>
  active
    ? SELECT_CLASS.replace('border-slate-200', 'border-indigo-400').replace('text-slate-600', 'text-indigo-700 bg-indigo-50')
    : SELECT_CLASS;
