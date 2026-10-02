import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { findHelpGuide, HELP_SEARCH_LIMIT, searchHelpGuides } from '../utils/helpContent';

const control = 'min-h-11 min-w-11 max-w-full rounded-lg px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';

export default function HelpGuides({ audience }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState(null);
  const headingRef = useRef(null);
  const searchRef = useRef(null);
  const navigationRef = useRef(false);
  const guide = findHelpGuide(topic, audience);
  const matches = useMemo(() => searchHelpGuides(query, audience), [query, audience]);
  useLayoutEffect(() => {
    if (!navigationRef.current) return;
    navigationRef.current = false;
    headingRef.current?.focus();
  }, [topic]);
  const navigate = next => { navigationRef.current = true; setTopic(next); };

  return guide ? (
    <article className="min-w-0 space-y-4">
      <button type="button" onClick={() => navigate(null)} className={`${control} border border-slate-400 text-slate-700 hover:bg-slate-50`}>All guides</button>
      <h3 ref={headingRef} tabIndex={-1} className="text-xl font-bold text-slate-900 focus:outline-none">{guide.title}</h3>
      <p className="text-slate-700">{guide.summary}</p>
      {guide.warning && <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><strong>Before you act: </strong>{guide.warning}</p>}
      <ol className="list-decimal space-y-3 pl-6 text-slate-800">{guide.steps.map(step => <li key={step}>{step}</li>)}</ol>
      {guide.note && <p className="text-sm text-slate-700">{guide.note}</p>}
    </article>
  ) : (
    <section className="min-w-0 space-y-4" aria-label="Spool guides">
      <h3 ref={headingRef} tabIndex={-1} className="text-lg font-bold text-slate-900 focus:outline-none">{audience === 'operator' ? 'Operator guides' : audience === 'member' ? 'Client workspace guides' : audience === 'guest' ? 'Review guides' : 'Getting help'}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={id} className="min-w-0 grow basis-48 text-sm font-semibold text-slate-700">Find a guide
          <input ref={searchRef} id={id} type="search" value={query} maxLength={HELP_SEARCH_LIMIT} placeholder="Try review, video or save" onChange={event => setQuery(event.target.value.slice(0, HELP_SEARCH_LIMIT))}
            className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-500 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600" />
        </label>
        {query && <button type="button" className={`${control} border border-slate-400 text-slate-700`} onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Clear search</button>}
      </div>
      <p role="status" className="text-sm text-slate-600">{matches.length ? `${matches.length} ${matches.length === 1 ? 'guide' : 'guides'}` : 'No matching guides. Try another word or clear your search.'}</p>
      <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
        {matches.map(item => <li key={item.id} className="min-w-0"><button type="button" onClick={() => navigate(item.id)} className="min-h-11 w-full min-w-0 rounded-xl border border-slate-300 p-4 text-left hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
          <span className="block text-xs font-semibold text-indigo-700">{item.category}</span>
          <span className="mt-1 block font-bold text-slate-900">{item.title}</span>
          <span className="mt-1 block text-sm text-slate-700">{item.summary}</span>
        </button></li>)}
      </ul>
    </section>
  );
}
