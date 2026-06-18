import React, { useState, useMemo } from 'react';
import { X, Upload, AlertCircle, FileText } from 'lucide-react';
import { PLATFORMS } from '../constants';
import { postFingerprint } from '../utils/csv';
import useEscapeKey from '../hooks/useEscapeKey';

/**
 * Preview + confirm step before an import is committed to Firestore. Shows a
 * count, a per-platform / per-client breakdown, and lets the user skip rows
 * that duplicate posts already in the workspace (matched by client+platform+
 * content). Nothing is written until "Import" is clicked.
 */
const ImportModal = ({ posts = [], existingPosts = [], fileName = '', onConfirm, onCancel }) => {
  useEscapeKey(onCancel);
  const [skipDuplicates, setSkipDuplicates] = useState(true);

  const existingFps = useMemo(
    () => new Set(existingPosts.map(postFingerprint)),
    [existingPosts]
  );

  const { duplicates, fresh } = useMemo(() => {
    const seenInFile = new Set();
    const dup = [];
    const fr = [];
    for (const p of posts) {
      const fp = postFingerprint(p);
      const isDup = existingFps.has(fp) || seenInFile.has(fp);
      seenInFile.add(fp);
      (isDup ? dup : fr).push(p);
    }
    return { duplicates: dup, fresh: fr };
  }, [posts, existingFps]);

  const toImport = skipDuplicates ? fresh : posts;

  const breakdown = useMemo(() => {
    const byPlatform = {};
    const byClient = {};
    for (const p of toImport) {
      byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
      byClient[p.client] = (byClient[p.client] || 0) + 1;
    }
    return { byPlatform, byClient };
  }, [toImport]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Import preview" className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh] animate-in fade-in zoom-in duration-200">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center"><Upload size={18} /></div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Import preview</h2>
              {fileName && <p className="text-xs text-slate-400 flex items-center gap-1"><FileText size={11} /> {fileName}</p>}
            </div>
          </div>
          <button onClick={onCancel} aria-label="Cancel import" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X size={20} /></button>
        </div>

        <div className="p-6 overflow-y-auto">
          {posts.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <AlertCircle className="mx-auto mb-2 text-amber-500" size={28} />
              <p className="font-medium">No valid rows found.</p>
              <p className="text-sm text-slate-400 mt-1">Each row needs at least a <code className="text-xs bg-slate-100 px-1 rounded">client</code> and <code className="text-xs bg-slate-100 px-1 rounded">content</code> value.</p>
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-3xl font-black text-slate-900">{toImport.length}</span>
                <span className="text-slate-500 font-medium">thread{toImport.length === 1 ? '' : 's'} will be created</span>
              </div>

              {duplicates.length > 0 && (
                <label className="flex items-start gap-3 p-3 mb-4 rounded-xl bg-amber-50 border border-amber-100 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                    className="mt-0.5 accent-amber-600"
                  />
                  <span className="text-sm text-amber-900">
                    <span className="font-bold">Skip {duplicates.length} duplicate{duplicates.length === 1 ? '' : 's'}</span>
                    <span className="block text-xs text-amber-700/80 mt-0.5">Rows matching an existing thread (same client, platform &amp; content) — or repeated within this file.</span>
                  </span>
                </label>
              )}

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">By platform</h3>
                  <div className="space-y-1">
                    {Object.entries(breakdown.byPlatform).map(([p, n]) => (
                      <div key={p} className="flex justify-between text-slate-600">
                        <span>{PLATFORMS[p]?.name || p}</span><span className="font-bold tabular-nums">{n}</span>
                      </div>
                    ))}
                    {Object.keys(breakdown.byPlatform).length === 0 && <span className="text-slate-300 italic text-xs">—</span>}
                  </div>
                </div>
                <div>
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">By client</h3>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {Object.entries(breakdown.byClient).sort((a, b) => b[1] - a[1]).map(([c, n]) => (
                      <div key={c} className="flex justify-between text-slate-600">
                        <span className="truncate mr-2">{c}</span><span className="font-bold tabular-nums">{n}</span>
                      </div>
                    ))}
                    {Object.keys(breakdown.byClient).length === 0 && <span className="text-slate-300 italic text-xs">—</span>}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-3 rounded-b-2xl">
          <button onClick={onCancel} className="px-4 py-2 font-bold text-slate-500 hover:text-slate-700 text-sm">Cancel</button>
          <button
            onClick={() => onConfirm(toImport)}
            disabled={toImport.length === 0}
            className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 font-bold rounded-lg text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Upload size={16} /> Import {toImport.length > 0 ? toImport.length : ''}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportModal;
