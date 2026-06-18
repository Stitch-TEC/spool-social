import React, { useState } from 'react';
import {
  X, Tag, Users, CheckSquare, Archive, Trash2, Download, Plus, Minus, ChevronUp
} from 'lucide-react';
import { STATUS } from '../constants';

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
  onArchive,
  onDelete,
  onExport,
  onSelectAll,
  onClear,
}) => {
  const [panel, setPanel] = useState(null); // null | 'client' | 'addTags' | 'removeTags' | 'status'
  const [text, setText] = useState('');

  const openPanel = (p) => { setPanel(prev => prev === p ? null : p); setText(''); };

  const parseTags = (s) =>
    s.split(/[,|]/).map(t => t.trim().replace(/^#/, '').slice(0, 20)).filter(Boolean).slice(0, 10);

  const submitPanel = () => {
    if (panel === 'client') {
      const c = text.trim().replace(/\//g, '').slice(0, 50);
      if (c) onReassignClient(c);
    } else if (panel === 'addTags') {
      const tags = parseTags(text);
      if (tags.length) onAddTags(tags);
    } else if (panel === 'removeTags') {
      const tags = parseTags(text);
      if (tags.length) onRemoveTags(tags);
    }
    setPanel(null);
    setText('');
  };

  const btn = 'flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-colors whitespace-nowrap';

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-3 pb-3 pointer-events-none">
      <div className="max-w-3xl mx-auto pointer-events-auto">
        {/* Inline panel (client / tags) */}
        {(panel === 'client' || panel === 'addTags' || panel === 'removeTags') && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 mb-2 flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
            <input
              autoFocus
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitPanel(); if (e.key === 'Escape') setPanel(null); }}
              list={panel === 'client' ? 'bulk-client-list' : undefined}
              placeholder={
                panel === 'client' ? 'New client name…'
                  : panel === 'addTags' ? 'Tags to add (comma-separated)…'
                    : 'Tags to remove (comma-separated)…'
              }
              maxLength={panel === 'client' ? 50 : 200}
              className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus:ring-0"
            />
            {panel === 'client' && (
              <datalist id="bulk-client-list">{uniqueClients.map(c => <option key={c} value={c} />)}</datalist>
            )}
            <button onClick={submitPanel} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700">Apply</button>
            <button onClick={() => setPanel(null)} aria-label="Close" className="p-2 text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
        )}

        {/* Status panel */}
        {panel === 'status' && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-2 mb-2 flex items-center gap-1 animate-in fade-in slide-in-from-bottom-2 duration-150">
            {STATUS_OPTIONS.map(s => (
              <button key={s.id} onClick={() => { onSetStatus(s.id); setPanel(null); }} className="flex-1 px-3 py-2 rounded-lg text-xs font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-700">{s.label}</button>
            ))}
            <button onClick={() => setPanel(null)} aria-label="Close" className="p-2 text-slate-400 hover:text-slate-600"><X size={16} /></button>
          </div>
        )}

        {/* The bar */}
        <div className="bg-slate-900 text-white rounded-xl shadow-2xl flex items-center gap-1 p-2 overflow-x-auto scrollbar-hide">
          <div className="flex items-center gap-2 px-2 shrink-0">
            <span className="bg-indigo-500 text-white text-xs font-black rounded-full w-6 h-6 flex items-center justify-center tabular-nums">{count}</span>
            <span className="text-xs font-medium text-slate-300 hidden sm:inline">selected</span>
          </div>
          <div className="w-px h-6 bg-slate-700 shrink-0" />

          <button onClick={() => openPanel('client')} className={`${btn} text-slate-200 hover:bg-slate-700`}><Users size={14} /> Client</button>
          <button onClick={() => openPanel('addTags')} className={`${btn} text-slate-200 hover:bg-slate-700`}><Plus size={13} /><Tag size={13} /> Tags</button>
          <button onClick={() => openPanel('removeTags')} className={`${btn} text-slate-200 hover:bg-slate-700`}><Minus size={13} /><Tag size={13} /></button>
          <button onClick={() => openPanel('status')} className={`${btn} text-slate-200 hover:bg-slate-700`}><CheckSquare size={14} /> Status</button>
          <button onClick={onArchive} className={`${btn} text-slate-200 hover:bg-slate-700`}><Archive size={14} /> Archive</button>
          <button onClick={onExport} className={`${btn} text-slate-200 hover:bg-slate-700`}><Download size={14} /> Export</button>
          <button onClick={onDelete} className={`${btn} text-rose-300 hover:bg-rose-500/20`}><Trash2 size={14} /> Delete</button>

          <div className="w-px h-6 bg-slate-700 shrink-0" />
          {count < totalFiltered && (
            <button onClick={onSelectAll} className={`${btn} text-indigo-300 hover:bg-slate-700`}><ChevronUp size={14} /> All {totalFiltered}</button>
          )}
          <button onClick={onClear} className={`${btn} text-slate-400 hover:bg-slate-700`}><X size={14} /> Clear</button>
        </div>
      </div>
    </div>
  );
};

export default BulkActionBar;
