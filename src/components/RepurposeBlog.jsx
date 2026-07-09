import React, { useState } from 'react';
import { Share2, Loader2, X } from 'lucide-react';
import { generateText } from '../utils/generationApi';
import { buildTextContext } from '../utils/aiPrompt';
import { PLATFORMS } from '../constants';

const TARGETS = ['linkedin', 'twitter', 'instagram', 'gmb'];

/**
 * Turn the current long-form draft into channel-tailored social drafts.
 * Generates one post per selected platform and hands them to onCreateDrafts,
 * which persists them as new draft posts for the same client.
 */
// clientId (optional suite slug) attributes the per-channel generations to the client at the gateway meter.
const RepurposeBlog = ({ title, content, client, clientSettings, clientId, onCreateDrafts, showToast }) => {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(() => new Set(['linkedin', 'twitter']));
  const [loading, setLoading] = useState(false);

  const toggle = (id) =>
    setSel(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const run = async () => {
    if (loading) return;
    if (!content.trim()) { showToast?.('Write the post first', 'error'); return; }
    const platforms = [...sel];
    if (platforms.length === 0) { showToast?.('Pick at least one channel', 'error'); return; }

    setLoading(true);
    try {
      const drafts = [];
      for (const platform of platforms) {
        const { system, maxTokens } = buildTextContext({ platform, clientName: client, clientSettings });
        const text = await generateText(
          `Adapt the following long-form post into ${PLATFORMS[platform].name} copy that drives readers to the full piece. Make it native to the platform; don't just truncate.\n\nTITLE: ${title || '(untitled)'}\n\nPOST:\n${content}`,
          { system, maxTokens, clientId, platform }
        );
        drafts.push({ platform, content: text, client });
      }
      const n = await onCreateDrafts(drafts);
      showToast?.(`Created ${n ?? drafts.length} social draft${(n ?? drafts.length) === 1 ? '' : 's'}`);
      setOpen(false);
    } catch (err) {
      showToast?.(err.message || 'Repurpose failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline"
      >
        <Share2 size={12} /> <span>Repurpose → social</span>
      </button>
    );
  }

  return (
    <div className="w-full bg-indigo-50/60 border border-indigo-100 rounded-xl p-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-600">Generate social drafts from this post</span>
        <button type="button" onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-rose-500" aria-label="Cancel">
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2.5">
        {TARGETS.map(id => (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            disabled={loading}
            className={`px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${sel.has(id) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
          >
            {PLATFORMS[id].name}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={run}
        disabled={loading || sel.size === 0}
        className="flex items-center gap-1 bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:opacity-50"
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
        {loading ? 'Generating…' : `Create ${sel.size} draft${sel.size === 1 ? '' : 's'}`}
      </button>
    </div>
  );
};

export default RepurposeBlog;
