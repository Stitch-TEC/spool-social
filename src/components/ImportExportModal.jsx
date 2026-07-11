import React, { useState, useMemo, useCallback, useRef } from 'react';
import { X, Upload, Download, Database, FileText, AlertCircle, Users, Lock, Loader2 } from 'lucide-react';
import { PLATFORMS, STATUS } from '../constants';
import {
  convertToCSV,
  postsToJSON,
  downloadFile,
  parseImportFile,
  postFingerprint,
  filterPostsByClients,
  repinPostsToClient,
} from '../utils/csv';
import useEscapeKey from '../hooks/useEscapeKey';

const EXPORT_SCOPES = [
  { id: 'active', label: 'Active threads' },
  { id: 'archived', label: 'Archived only' },
  { id: 'all', label: 'Everything (active + archived)' },
];

const scopeMatches = (post, scope) => {
  const archived = post.status === STATUS.ARCHIVED;
  if (scope === 'archived') return archived;
  if (scope === 'active') return !archived;
  return true; // 'all'
};

/**
 * One surface for moving content in and out of Spool (CSV / JSON).
 *
 * Scope is role-aware and enforced in three places (this modal is only the UI):
 *   - Client members see NO client picker — every export is already limited to
 *     their own posts (usePosts scopes by clientId) and every import is re-pinned
 *     to their client (here for preview + accuracy, and again on write in App).
 *   - The operator gets an "All clients / by client(s)" multi-select that drives
 *     both which posts are exported and which clients an uploaded file imports.
 * The real tenant boundary is firestore.rules; this keeps the UI honest.
 */
const ImportExportModal = ({
  posts = [],
  uniqueClients = [],
  isOperator = false,
  scopeClient = null,       // client member's own display name (locks the scope)
  onImport,                 // async (rows) => boolean — App writes + returns success
  onClose,
  showToast,
}) => {
  useEscapeKey(onClose);
  const [tab, setTab] = useState('export'); // 'export' | 'import'

  return (
    <div role="dialog" aria-modal="true" aria-label="Import and export content" className="fixed inset-0 z-[85] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center"><Database size={18} /></div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Import &amp; Export</h2>
              <p className="text-xs text-slate-400">
                {isOperator
                  ? 'Move content for all clients or a selection'
                  : <span className="flex items-center gap-1"><Lock size={11} /> {scopeClient || 'Your content'}</span>}
              </p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X size={20} /></button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-4 flex gap-1" role="tablist">
          <button
            role="tab" aria-selected={tab === 'export'}
            onClick={() => setTab('export')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${tab === 'export' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <Download size={15} /> Export
          </button>
          <button
            role="tab" aria-selected={tab === 'import'}
            onClick={() => setTab('import')}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-bold rounded-lg transition-colors ${tab === 'import' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <Upload size={15} /> Import
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          {tab === 'export'
            ? <ExportPane posts={posts} uniqueClients={uniqueClients} isOperator={isOperator} showToast={showToast} onDone={onClose} />
            : <ImportPane posts={posts} isOperator={isOperator} scopeClient={scopeClient} onImport={onImport} showToast={showToast} onDone={onClose} />}
        </div>
      </div>
    </div>
  );
};

// --- Shared: operator client multi-select -----------------------------------
const ClientPicker = ({ uniqueClients, allSelected, setAllSelected, selected, toggle, countFor }) => (
  <div className="mb-5">
    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5"><Users size={12} /> Clients</h3>
    <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-100 cursor-pointer text-sm font-semibold text-slate-700">
      <input type="checkbox" checked={allSelected} onChange={(e) => setAllSelected(e.target.checked)} className="accent-indigo-600" />
      All clients
    </label>
    {!allSelected && (
      <div className="mt-1.5 max-h-40 overflow-y-auto space-y-0.5 pl-1">
        {uniqueClients.length === 0 && <p className="text-xs text-slate-400 italic px-2 py-1">No clients yet.</p>}
        {uniqueClients.map((c) => (
          <label key={c} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer text-sm text-slate-600">
            <span className="flex items-center gap-2 min-w-0">
              <input type="checkbox" checked={selected.has(c)} onChange={() => toggle(c)} className="accent-indigo-600 shrink-0" />
              <span className="truncate">{c}</span>
            </span>
            {countFor && <span className="text-xs text-slate-300 tabular-nums shrink-0">{countFor(c)}</span>}
          </label>
        ))}
      </div>
    )}
  </div>
);

// --- Export -----------------------------------------------------------------
const ExportPane = ({ posts, uniqueClients, isOperator, showToast, onDone }) => {
  const [scope, setScope] = useState('active');
  const [format, setFormat] = useState('csv');
  const [allSelected, setAllSelected] = useState(true);
  const [selected, setSelected] = useState(() => new Set());

  const toggle = useCallback((c) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
    setAllSelected(false);
  }, []);

  const countFor = useCallback(
    (c) => posts.filter((p) => p.client === c && scopeMatches(p, scope)).length,
    [posts, scope]
  );

  const exportPosts = useMemo(() => {
    const byScope = posts.filter((p) => scopeMatches(p, scope));
    if (!isOperator || allSelected) return byScope;
    if (selected.size === 0) return []; // "by client(s)" mode with nothing picked → nothing
    return filterPostsByClients(byScope, Array.from(selected));
  }, [posts, scope, isOperator, allSelected, selected]);

  const handleExport = () => {
    if (exportPosts.length === 0) { showToast?.('Nothing to export in this scope', 'error'); return; }
    const date = new Date().toISOString().split('T')[0];
    if (format === 'json') {
      downloadFile(postsToJSON(exportPosts), `spool-backup-${date}.json`, 'application/json');
    } else {
      downloadFile(convertToCSV(exportPosts), `spool-export-${date}.csv`, 'text/csv;charset=utf-8;');
    }
    showToast?.(`Exported ${exportPosts.length} thread${exportPosts.length === 1 ? '' : 's'} 📥`);
    onDone?.();
  };

  return (
    <div>
      {isOperator && (
        <ClientPicker
          uniqueClients={uniqueClients}
          allSelected={allSelected} setAllSelected={setAllSelected}
          selected={selected} toggle={toggle} countFor={countFor}
        />
      )}

      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Include</h3>
      <div className="space-y-1 mb-5">
        {EXPORT_SCOPES.map((s) => (
          <label key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 cursor-pointer text-sm text-slate-700">
            <input type="radio" name="export-scope" checked={scope === s.id} onChange={() => setScope(s.id)} className="accent-indigo-600" />
            {s.label}
          </label>
        ))}
      </div>

      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Format</h3>
      <div className="grid grid-cols-2 gap-2 mb-6">
        <button
          onClick={() => setFormat('csv')}
          className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors ${format === 'csv' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          <FileText size={16} /> <span className="text-left leading-tight">CSV<span className="block text-[10px] font-normal opacity-70">Spreadsheet-editable</span></span>
        </button>
        <button
          onClick={() => setFormat('json')}
          className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors ${format === 'json' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          <Database size={16} /> <span className="text-left leading-tight">JSON<span className="block text-[10px] font-normal opacity-70">Full backup</span></span>
        </button>
      </div>

      <button
        onClick={handleExport}
        disabled={exportPosts.length === 0}
        className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white px-5 py-2.5 font-bold rounded-lg text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <Download size={16} /> Export {exportPosts.length} thread{exportPosts.length === 1 ? '' : 's'}
      </button>
    </div>
  );
};

// --- Import -----------------------------------------------------------------
const ImportPane = ({ posts, isOperator, scopeClient, onImport, showToast, onDone }) => {
  const inputRef = useRef(null);
  const [rows, setRows] = useState(null);      // parsed + (member) re-pinned rows, or null before a file
  const [fileName, setFileName] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [allSelected, setAllSelected] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const handleFile = (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        let parsed = parseImportFile(ev.target.result, file.name);
        // A client member's upload is re-pinned to their own client up front so
        // the duplicate check + breakdown reflect what will actually be written.
        if (!isOperator && scopeClient) parsed = repinPostsToClient(parsed, scopeClient);
        setRows(parsed);
        setFileName(file.name);
        setAllSelected(true);
        setSelected(new Set());
        setSkipDuplicates(true); // each file starts from the safe default (parity with the old per-file preview)
      } catch (err) {
        console.error('Import parse error:', err);
        showToast?.("Couldn't read that file — use a Spool CSV or JSON export", 'error');
      }
    };
    reader.readAsText(file);
  };

  const existingFps = useMemo(() => new Set((posts || []).map(postFingerprint)), [posts]);
  const fileClients = useMemo(() => [...new Set((rows || []).map((r) => r.client).filter(Boolean))].sort(), [rows]);

  // Operator may narrow the import to selected clients; members always import all
  // (already re-pinned to their one client).
  const clientScoped = useMemo(() => {
    if (!rows) return [];
    if (!isOperator || allSelected) return rows;
    if (selected.size === 0) return []; // "by client(s)" mode with nothing picked → nothing
    return filterPostsByClients(rows, Array.from(selected));
  }, [rows, isOperator, allSelected, selected]);

  const { fresh, duplicates } = useMemo(() => {
    const seen = new Set();
    const fr = [], dup = [];
    for (const p of clientScoped) {
      const fp = postFingerprint(p);
      const isDup = existingFps.has(fp) || seen.has(fp);
      seen.add(fp);
      (isDup ? dup : fr).push(p);
    }
    return { fresh: fr, duplicates: dup };
  }, [clientScoped, existingFps]);

  const toImport = skipDuplicates ? fresh : clientScoped;

  const byPlatform = useMemo(() => {
    const m = {};
    for (const p of toImport) m[p.platform] = (m[p.platform] || 0) + 1;
    return m;
  }, [toImport]);

  const toggle = useCallback((c) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
    setAllSelected(false);
  }, []);

  const handleConfirm = async () => {
    if (busy || toImport.length === 0) return;
    setBusy(true);
    try {
      const ok = await onImport(toImport);
      if (ok) onDone?.();
    } finally {
      setBusy(false);
    }
  };

  if (!rows) {
    return (
      <div>
        <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-200 rounded-xl py-10 px-4 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors">
          <Upload size={26} className="text-slate-400" />
          <span className="text-sm font-semibold text-slate-600">Choose a CSV or JSON file</span>
          <span className="text-xs text-slate-400">Exported from Spool, or a spreadsheet with the same columns</span>
          <input ref={inputRef} type="file" accept=".csv,.json,text/csv,application/json" onChange={handleFile} className="hidden" />
        </label>
        {!isOperator && scopeClient && (
          <p className="mt-4 text-xs text-slate-500 flex items-start gap-1.5">
            <Lock size={12} className="mt-0.5 shrink-0" /> Every imported thread is added under <span className="font-semibold">{scopeClient}</span>, whatever the file's client column says.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-slate-400 flex items-center gap-1 mb-4"><FileText size={12} /> {fileName}
        <button onClick={() => setRows(null)} className="ml-auto text-indigo-600 font-semibold hover:underline">Choose another</button>
      </p>

      {rows.length === 0 ? (
        <div className="text-center py-8 text-slate-500">
          <AlertCircle className="mx-auto mb-2 text-amber-500" size={28} />
          <p className="font-medium">No valid rows found.</p>
          <p className="text-sm text-slate-400 mt-1">Each row needs at least a <code className="text-xs bg-slate-100 px-1 rounded">client</code> and <code className="text-xs bg-slate-100 px-1 rounded">content</code> value.</p>
        </div>
      ) : (
        <>
          {isOperator && fileClients.length > 1 && (
            <ClientPicker
              uniqueClients={fileClients}
              allSelected={allSelected} setAllSelected={setAllSelected}
              selected={selected} toggle={toggle}
              countFor={(c) => rows.filter((r) => r.client === c).length}
            />
          )}

          {!isOperator && scopeClient && (
            <p className="mb-4 text-xs text-slate-500 flex items-start gap-1.5">
              <Lock size={12} className="mt-0.5 shrink-0" /> Importing under <span className="font-semibold">{scopeClient}</span>.
            </p>
          )}

          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-3xl font-black text-slate-900">{toImport.length}</span>
            <span className="text-slate-500 font-medium">thread{toImport.length === 1 ? '' : 's'} will be created</span>
          </div>

          {duplicates.length > 0 && (
            <label className="flex items-start gap-3 p-3 mb-4 rounded-xl bg-amber-50 border border-amber-100 cursor-pointer">
              <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} className="mt-0.5 accent-amber-600" />
              <span className="text-sm text-amber-900">
                <span className="font-bold">Skip {duplicates.length} duplicate{duplicates.length === 1 ? '' : 's'}</span>
                <span className="block text-xs text-amber-700/80 mt-0.5">Rows matching an existing thread (same client, platform &amp; content) — or repeated within this file.</span>
              </span>
            </label>
          )}

          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">By platform</h3>
          <div className="space-y-1 text-sm mb-2">
            {Object.entries(byPlatform).map(([p, n]) => (
              <div key={p} className="flex justify-between text-slate-600"><span>{PLATFORMS[p]?.name || p}</span><span className="font-bold tabular-nums">{n}</span></div>
            ))}
            {Object.keys(byPlatform).length === 0 && <span className="text-slate-300 italic text-xs">—</span>}
          </div>
        </>
      )}

      <div className="mt-6 flex items-center justify-end gap-3">
        <button onClick={onDone} className="px-4 py-2 font-bold text-slate-500 hover:text-slate-700 text-sm">Cancel</button>
        <button
          onClick={handleConfirm}
          disabled={busy || toImport.length === 0}
          className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 font-bold rounded-lg text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} Import {toImport.length > 0 ? toImport.length : ''}
        </button>
      </div>
    </div>
  );
};

export default ImportExportModal;
