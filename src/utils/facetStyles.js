// Shared styling for the grid toolbar's facet <select>s. Lives outside the
// component files so both PostControls and FilterBar render one visually
// consistent row from ONE class string (and so neither file has to export a
// non-component, which breaks React Fast Refresh).

// `h-8 py-0 leading-none` rather than `py-1.5`: an `appearance-none` <select>
// keeps a UA-internal box, and in Safari that box is TALLER than the padding-derived
// height — so the option label rendered flush with (and clipped by) the bottom
// border, which is exactly how the toolbar looked in the 1614px Safari screenshot
// that prompted this pass. An explicit height plus zero vertical padding lets the
// browser center the label in a box we control, in every engine.
export const SELECT_CLASS =
  'appearance-none bg-white border border-slate-200 rounded-lg pl-8 pr-7 h-8 py-0 leading-none text-xs font-semibold text-slate-600 ' +
  'hover:border-indigo-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none cursor-pointer transition-colors';

// An ACTIVE facet reads indigo, so "what am I filtered by?" is answerable at a
// glance across a six-control toolbar instead of by reading every dropdown value.
export const activeSelectClass = (active) =>
  active
    ? SELECT_CLASS.replace('border-slate-200', 'border-indigo-400').replace('text-slate-600', 'text-indigo-700 bg-indigo-50')
    : SELECT_CLASS;
