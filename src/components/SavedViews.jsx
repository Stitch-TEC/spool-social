import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { hasViewName, MAX_SAVED_VIEWS, MAX_VIEW_NAME, normalizeViewName, parseSavedViews, resolveViewClient, savedViewsKey, serializeSavedViews, validViewFilters, validViewName } from '../utils/savedViews';

const CONTROL = 'min-h-11 min-w-11 rounded-lg border border-slate-500 bg-white px-3 text-sm text-slate-800 placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed';
const STORAGE_ERROR = 'Saved views could not be read in this browser. Your filters have not changed. Retry, or keep using the filters normally.';

// App keys this component by project, UID and auth revision. No automatic apply,
// cross-account state, background sync, records or content export belongs here.
export default function SavedViews({ projectId, uid, isCurrent, roster, currentFilters, canSave, onApply }) {
  const selectId = useId(), nameId = useId();
  const key = savedViewsKey(projectId, uid);
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = () => mounted.current && !!key && isCurrent();
  const [views, setViews] = useState([]);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);

  const read = () => {
    if (!allowed()) return null;
    try {
      const result = parseSavedViews(localStorage.getItem(key));
      if (!allowed()) return null;
      setViews(result);
      setFailed(false);
      return result;
    } catch {
      if (allowed()) { setViews([]); setFailed(true); setNotice(STORAGE_ERROR); }
      return null;
    }
  };
  const refresh = () => { if (read()) setNotice(''); };
  const write = (next, message) => {
    if (!allowed()) return false;
    try {
      localStorage.setItem(key, serializeSavedViews(next));
      if (!allowed()) return false;
      setViews(next); setFailed(false); setNotice(message);
      return true;
    } catch {
      if (allowed()) setNotice('This browser could not save the change. Nothing was saved or deleted. Keep using the filters normally, or try again.');
      return false;
    }
  };
  const save = event => {
    event.preventDefault();
    if (!allowed() || !canSave) return;
    const trimmed = normalizeViewName(name);
    if (!validViewName(trimmed)) { setNotice('Enter a view name of 1–48 characters.'); return; }
    const client = resolveViewClient(roster, { name: currentFilters.clientName });
    if (!client.ok) { setNotice('This client cannot be matched to the current client list. Nothing was saved. Try again after the client list is available.'); return; }
    const filters = { clientSlug: client.slug, review: currentFilters.review, status: currentFilters.status, platform: currentFilters.platform, media: currentFilters.media, needs: currentFilters.needs, sort: currentFilters.sort };
    if (!validViewFilters(filters)) { setNotice('These filters cannot be saved as a view. Return to the active queue and try again.'); return; }
    const latest = read();
    if (!latest) return;
    if (hasViewName(latest, trimmed)) { setNotice('That view name is already used. Choose a different name, or delete the old view first.'); return; }
    if (latest.length >= MAX_SAVED_VIEWS) { setNotice('You have 12 saved views. Delete one before saving another.'); return; }
    if (write([...latest, { name: trimmed, filters }], 'View saved in this browser only.')) { setName(''); setSelected(trimmed); }
  };
  const apply = () => {
    const latest = read();
    if (!latest) return;
    const view = latest.find(item => item.name === selected);
    if (!view) { setSelected(''); setNotice('This view is no longer available. Choose another saved view.'); return; }
    const client = resolveViewClient(roster, { slug: view.filters.clientSlug });
    if (!client.ok) { setNotice('This view’s client is missing, unavailable or ambiguous. Your filters have not changed. Check the client list before trying again.'); return; }
    if (!allowed()) return;
    onApply({ ...view.filters, clientName: client.name });
    if (allowed()) setNotice('View applied to the active queue. Search, tag and selected posts were cleared.');
  };
  const remove = () => {
    const latest = read();
    if (!latest) return;
    if (!latest.some(item => item.name === selected)) { setSelected(''); setNotice('This view is no longer available.'); return; }
    if (write(latest.filter(item => item.name !== selected), 'Saved view deleted from this browser. No posts were changed.')) setSelected('');
  };

  return (
    <details className="mb-5 rounded-xl border border-slate-200 bg-white p-3" onToggle={event => { if (event.currentTarget.open) refresh(); }}>
      <summary className="min-h-11 py-3 cursor-pointer rounded-lg text-sm font-bold text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Saved views · this browser only</summary>
      <div className="space-y-3 pt-2">
        <p className="text-sm text-slate-600">Save client, review and other filters—not posts. Applying a view opens the active queue and clears search, tag and selected posts. Views do not sync to other devices.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[1_1_12rem] text-sm font-medium text-slate-700">
            <label htmlFor={selectId}>Saved view</label>
            <select id={selectId} className={`${CONTROL} mt-1 w-full h-11 py-0`} value={views.some(view => view.name === selected) ? selected : ''} onChange={event => { setSelected(event.target.value); setNotice(''); }}>
              <option value="">{views.length ? 'Choose a view' : 'No saved views yet'}</option>
              {views.map(view => <option key={view.name} value={view.name}>{view.name}</option>)}
            </select>
          </div>
          <button type="button" className={CONTROL} disabled={!selected || !views.some(view => view.name === selected)} onClick={apply}>Apply view</button>
          <button type="button" className={CONTROL} disabled={!selected || !views.some(view => view.name === selected)} onClick={remove}>Delete view</button>
        </div>
        <form onSubmit={save} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[1_1_12rem] text-sm font-medium text-slate-700">
            <label htmlFor={nameId}>New view name</label>
            <input id={nameId} className={`${CONTROL} mt-1 w-full`} value={name} onChange={event => setName(event.target.value)} maxLength={MAX_VIEW_NAME} placeholder="e.g. Lyf Fit — Changes" autoComplete="off" />
          </div>
          <button className={CONTROL} type="submit" disabled={!canSave || !key}>Save current filters</button>
        </form>
        {!canSave && <p className="text-sm text-slate-600">To save filters, open the active queue—not Archives, Templates or Suggestions.</p>}
        <p className="text-xs text-slate-600">Up to 12 views. Search, tags and layout are not saved. Names are stored on this device: do not include private content.</p>
        {notice && <p role="status" className="text-sm text-slate-700 break-words">{notice}</p>}
        {failed && <button type="button" className={CONTROL} onClick={refresh}>Retry reading saved views</button>}
      </div>
    </details>
  );
}
