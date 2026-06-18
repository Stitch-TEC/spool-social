import React, { useState, useEffect, useCallback } from 'react';
import { X, Link as LinkIcon, Copy, Check, Trash2, Plus, Loader2, ShieldCheck } from 'lucide-react';
import { listShareLinks, createShareLink, revokeShareLink } from '../utils/shareApi';
import useEscapeKey from '../hooks/useEscapeKey';
import { DATE_FORMATTERS } from '../utils/helpers';

/**
 * Owner tool to create, copy and revoke per-client review links. Each link is a
 * Worker-minted token that scopes an anonymous reviewer to exactly one client
 * (see firestore.rules). Revoking a link invalidates it immediately.
 */
const ShareManager = ({ onClose, uniqueClients = [], initialClient = '', showToast }) => {
  useEscapeKey(onClose);
  const [client, setClient] = useState(initialClient || uniqueClients[0] || '');
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copiedToken, setCopiedToken] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async (c) => {
    if (!c) { setLinks([]); return; }
    setLoading(true);
    setError(null);
    try {
      setLinks(await listShareLinks(c));
    } catch (err) {
      setError(err.message || 'Could not load links');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(client); }, [client, refresh]);

  const copy = async (url, token) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
      showToast?.('Review link copied 📋');
    } catch {
      showToast?.("Couldn't copy — your browser blocked clipboard access", 'error');
    }
  };

  const handleCreate = async () => {
    if (!client || creating) return;
    setCreating(true);
    try {
      const created = await createShareLink(client);
      setLinks(prev => [{ ...created, createdAt: new Date().toISOString() }, ...prev]);
      await copy(created.url, created.token);
    } catch (err) {
      showToast?.(err.message || 'Could not create link', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (token) => {
    setLinks(prev => prev.filter(l => l.token !== token)); // optimistic
    try {
      await revokeShareLink(token);
      showToast?.('Link revoked');
    } catch (err) {
      showToast?.(err.message || 'Revoke failed', 'error');
      refresh(client); // restore truth on failure
    }
  };

  const fmt = (iso) => { try { return DATE_FORMATTERS.full.format(new Date(iso)); } catch { return ''; } };

  return (
    <div role="dialog" aria-modal="true" aria-label="Share for review" className="fixed inset-0 z-[90] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh] animate-in fade-in zoom-in duration-200">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <LinkIcon size={20} className="text-indigo-500" /> Share for review
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X size={20} /></button>
        </div>

        <div className="p-6 overflow-y-auto">
          <label className="block text-sm font-bold text-slate-700 mb-2">Client</label>
          <select
            value={client}
            onChange={(e) => setClient(e.target.value)}
            className="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all font-medium mb-4"
          >
            {uniqueClients.length === 0 && <option value="">No clients yet</option>}
            {uniqueClients.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <button
            onClick={handleCreate}
            disabled={!client || creating}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white py-2.5 rounded-xl font-bold text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors mb-5"
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create a review link
          </button>

          {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}

          {loading ? (
            <div className="flex justify-center py-6"><Loader2 className="animate-spin text-indigo-500" /></div>
          ) : links.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">No active links for this client yet.</p>
          ) : (
            <div className="space-y-2">
              {links.map(l => (
                <div key={l.token} className="border border-slate-200 rounded-xl p-3">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={l.url}
                      onFocus={(e) => e.target.select()}
                      className="flex-1 min-w-0 px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 font-mono"
                    />
                    <button onClick={() => copy(l.url, l.token)} title="Copy link" aria-label="Copy link" className={`p-2 rounded-lg ${copiedToken === l.token ? 'text-emerald-600 bg-emerald-50' : 'text-slate-500 hover:bg-slate-100'}`}>
                      {copiedToken === l.token ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                    <button onClick={() => handleRevoke(l.token)} title="Revoke link" aria-label="Revoke link" className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"><Trash2 size={16} /></button>
                  </div>
                  {l.createdAt && <p className="text-[11px] text-slate-400 mt-1.5">Created {fmt(l.createdAt)}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="mt-5 flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-xl p-3">
            <ShieldCheck size={16} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>Anyone with a link can review <b className="text-slate-700">{client || 'this client'}</b>’s content — approve or request changes, no account needed. They can’t see other clients or edit anything. Revoke a link any time.</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShareManager;
