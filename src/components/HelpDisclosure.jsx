// Native disclosure works by tap, Enter or Space; never hide instructions in hover-only title text.
export default function HelpDisclosure({ label, children }) {
  return <details className="min-w-0 rounded-lg border border-slate-300 bg-white text-sm text-slate-700 [overflow-wrap:anywhere]">
    <summary className="min-h-11 cursor-pointer content-center px-3 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">{label}</summary>
    <div className="space-y-2 px-3 pb-3">{children}</div>
  </details>;
}
