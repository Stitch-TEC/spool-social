import React, { useEffect, useId, useRef, useState } from 'react';
import {
  X, Tag, Users, CheckSquare, Archive, Trash2, Download, Plus, Minus, ChevronUp,
  SendHorizontal, EyeOff
} from 'lucide-react';
import { STATUS } from '../constants';
import { parseBulkTags } from '../utils/bulkTags';
import { TAG_LIMIT, TAG_LENGTH_LIMIT } from '../utils/editorInputs';

const STATUS_OPTIONS = [
  { id: STATUS.DRAFT, label: 'Draft' },
  { id: STATUS.SCHEDULED, label: 'Scheduled' },
  { id: STATUS.POSTED, label: 'Posted' },
];

/**
 * Sticky bottom bar shown while one or more threads are selected. Each action
 * applies to the whole selection. Tag/client/status open a small inline panel
 * so the bar stays compact.
 */
const BulkActionBar = ({
  count,
  totalFiltered,
  uniqueClients = [],
  onReassignClient,
  onAddTags,
  onRemoveTags,
  onSetStatus,
  onSendForReview,
  onHold,
  onArchive,
  onDelete,
  onExport,
  onSelectAll,
  onClear,
  disabled = false,
}) => {
  const [panel, setPanel] = useState(null); // null | 'client' | 'addTags' | 'removeTags' | 'status'
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const active = useRef(true);
  const opener = useRef(null);
  const exportButton = useRef(null);
  const restoreFocus = useRef(false);
  const fieldId = useId();
  const locked = disabled || submitting;
  const tagPanel = panel === 'addTags' || panel === 'removeTags';
  const tagCount = text.split(/[,|]/).filter(tag => tag.trim().replace(/^#/, '').trim()).length;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (!restoreFocus.current || panel !== null || submitting) return;
    restoreFocus.current = false;
    // A successful awaited action closes before its disabled buttons re-enable.
    // Restore focus after that render; a held selection retains Export as an exit.
    const target = opener.current?.isConnected && !opener.current.disabled ? opener.current : exportButton.current;
    if (target?.isConnected) target.focus();
  }, [panel, submitting]);

  const closePanel = () => {
    restoreFocus.current = true;
    setPanel(null);
    setText('');
    setError('');
  };

  const openPanel = (p, event) => {
    if (locked || busy.current) return;
    opener.current = event.currentTarget;
    setPanel(prev => prev === p ? null : p);
    setText('');
    setError('');
  };

  const submitPanel = async (event) => {
    event.preventDefault();
    if (disabled || busy.current) return;
    let value;
    let handler;
    try {
      if (panel === 'client') {
        value = text.trim().replace(/\//g, '').slice(0, 50);
        if (!value) { closePanel(); return; }
        handler = onReassignClient;
      } else if (tagPanel) {
        value = parseBulkTags(text);
        if (!value.length) throw new Error('Enter at least one tag.');
        handler = panel === 'addTags' ? onAddTags : onRemoveTags;
      } else return;
      setError('');
      busy.current = true;
      setSubmitting(true);
      const result = await handler(value);
      if (active.current && result !== false) closePanel();
    } catch (err) {
      if (active.current) setError(err?.message || 'The change could not be applied. Review the selection and try again.');
    } finally {
      busy.current = false;
      if (active.current) setSubmitting(false);
    }
  };

  const btn = 'flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50';

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 pointer-events-none">
      <div className="max-w-3xl mx-auto pointer-events-auto">
        {/* Inline panel (client / tags) */}
        {(panel === 'client' || panel === 'addTags' || panel === 'removeTags') && (
          <form onSubmit={submitPanel} aria-label={panel === 'client' ? 'Reassign client' : panel === 'addTags' ? 'Add tags' : 'Remove tags'} aria-busy={submitting} className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 mb-2 flex min-w-0 flex-wrap items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="min-w-0 flex-[1_1_14rem]">
              <input
                id={fieldId}
                autoFocus
                type="text"
                value={text}
                onChange={(e) => { setText(e.target.value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Escape' && !busy.current) { e.preventDefault(); closePanel(); } }}
                aria-label={panel === 'client' ? 'Client name' : panel === 'addTags' ? 'Tags to add' : 'Tags to remove'}
                aria-invalid={Boolean(error)}
                aria-describedby={[tagPanel && `${fieldId}-limits`, error && `${fieldId}-error`].filter(Boolean).join(' ') || undefined}
                disabled={locked}
                list={panel === 'client' ? 'bulk-client-list' : undefined}
                placeholder={
                  panel === 'client' ? 'New client name…'
                    : panel === 'addTags' ? 'Tags to add (comma-separated)…'
                      : 'Tags to remove (comma-separated)…'
                }
                maxLength={panel === 'client' ? 50 : undefined}
                className="min-h-11 w-full min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
              />
              {tagPanel && <p id={`${fieldId}-limits`} className="mt-1 text-xs text-slate-600 [overflow-wrap:anywhere]">{tagCount}/{TAG_LIMIT} tags · {TAG_LENGTH_LIMIT} characters each · commas or pipes</p>}
              {error && <p id={`${fieldId}-error`} role="alert" className="mt-1 text-sm text-rose-700 [overflow-wrap:anywhere]">{error}</p>}
            </div>
            {panel === 'client' && (
              <datalist id="bulk-client-list">{uniqueClients.map(c => <option key={c} value={c} />)}</datalist>
            )}
            <button type="submit" disabled={locked} className="min-h-11 min-w-11 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-50">{submitting ? 'Applying…' : 'Apply'}</button>
            <button type="button" onClick={closePanel} disabled={submitting} aria-label="Close panel" className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"><X size={16} /></button>
          </form>
        )}

        {/* Status panel */}
        {panel === 'status' && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-2 mb-2 flex flex-wrap items-center gap-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
            {STATUS_OPTIONS.map(s => (
              <button type="button" key={s.id} disabled={locked} onClick={() => { onSetStatus(s.id); closePanel(); }} className={`${btn} flex-1 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700`}>{s.label}</button>
            ))}
            <button type="button" onClick={closePanel} aria-label="Close panel" className={`${btn} text-slate-600 hover:bg-slate-100`}><X size={16} /></button>
          </div>
        )}

        {/* The bar */}
        <div className="bg-slate-900 text-white rounded-xl shadow-2xl flex items-center gap-1 p-2 overflow-x-auto scrollbar-hide">
          <div className="flex items-center gap-2 px-2 shrink-0">
            <span className="bg-indigo-500 text-white text-xs font-black rounded-full w-6 h-6 flex items-center justify-center tabular-nums">{count}</span>
            <span className="text-xs font-medium text-slate-300 hidden sm:inline">selected</span>
          </div>
          <div className="w-px h-6 bg-slate-700 shrink-0" />

          <button type="button" disabled={locked} onClick={(event) => openPanel('client', event)} className={`${btn} text-slate-200 hover:bg-slate-700`}><Users size={14} /> Client</button>
          <button type="button" disabled={locked} aria-label="Add tags" aria-expanded={panel === 'addTags'} onClick={(event) => openPanel('addTags', event)} className={`${btn} text-slate-200 hover:bg-slate-700`}><Plus size={13} /><Tag size={13} /> Tags</button>
          <button type="button" disabled={locked} aria-label="Remove tags" aria-expanded={panel === 'removeTags'} onClick={(event) => openPanel('removeTags', event)} className={`${btn} text-slate-200 hover:bg-slate-700`}><Minus size={13} /><Tag size={13} /></button>
          <button type="button" disabled={locked} onClick={(event) => openPanel('status', event)} className={`${btn} text-slate-200 hover:bg-slate-700`}><CheckSquare size={14} /> Status</button>
          {/* The review verbs lead the bar: working a batch of staged drafts out to the
              client (and pulling one back) is the loop this screen exists for. Send is
              accented — it's the only action here the client actually sees. */}
          {onSendForReview && (
            <button type="button" disabled={locked} onClick={onSendForReview} title="Send the selected staged drafts to the client" className={`${btn} bg-indigo-500 text-white hover:bg-indigo-400`}><SendHorizontal size={14} /> Send for review</button>
          )}
          {onHold && (
            <button type="button" disabled={locked} onClick={onHold} title="Pull the selected posts off the client's review link" className={`${btn} text-slate-200 hover:bg-slate-700`}><EyeOff size={14} /> Staging</button>
          )}
          <button type="button" disabled={locked} onClick={onArchive} className={`${btn} text-slate-200 hover:bg-slate-700`}><Archive size={14} /> Archive</button>
          <button type="button" ref={exportButton} onClick={onExport} className={`${btn} text-slate-200 hover:bg-slate-700`}><Download size={14} /> Export</button>
          <button type="button" disabled={locked} onClick={onDelete} className={`${btn} text-rose-300 hover:bg-rose-500/20`}><Trash2 size={14} /> Delete</button>

          <div className="w-px h-6 bg-slate-700 shrink-0" />
          {count < totalFiltered && (
            <button type="button" disabled={locked} onClick={onSelectAll} className={`${btn} text-indigo-300 hover:bg-slate-700`}><ChevronUp size={14} /> All {totalFiltered}</button>
          )}
          <button type="button" onClick={onClear} className={`${btn} text-slate-400 hover:bg-slate-700`}><X size={14} /> Clear</button>
        </div>
      </div>
    </div>
  );
};

export default BulkActionBar;
