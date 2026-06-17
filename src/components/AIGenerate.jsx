import React, { useState } from 'react';
import { Sparkles, Loader2, X } from 'lucide-react';
import { generateImage, generateText } from '../utils/generationApi';

/**
 * Inline "generate with AI" control, reused for both image and text.
 *
 * Props:
 *   kind      'image' | 'text'
 *   onResult  (value) => void   — receives the image URL or generated text
 *   showToast (msg, type) => void
 */
const AIGenerate = ({ kind, onResult, showToast }) => {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);

  const label = kind === 'image' ? 'Generate image' : 'AI draft';
  const placeholder =
    kind === 'image'
      ? 'Describe the image you want…'
      : 'What should this post be about?';

  const run = async () => {
    const p = prompt.trim();
    if (!p || loading) return;
    setLoading(true);
    try {
      const result = kind === 'image' ? await generateImage(p) : await generateText(p);
      onResult(result);
      setOpen(false);
      setPrompt('');
      showToast?.(kind === 'image' ? 'Image generated' : 'Draft generated');
    } catch (err) {
      showToast?.(err.message || 'Generation failed', 'error');
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
        <Sparkles size={12} /> <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="relative flex-1">
        <Sparkles size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-indigo-400" />
        <input
          autoFocus
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); run(); }
            if (e.key === 'Escape') { setOpen(false); setPrompt(''); }
          }}
          placeholder={placeholder}
          disabled={loading}
          className="w-full pl-7 pr-3 py-1.5 bg-white border border-indigo-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60"
        />
      </div>
      <button
        type="button"
        onClick={run}
        disabled={loading || !prompt.trim()}
        className="flex items-center gap-1 bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:opacity-50"
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        {loading ? 'Working…' : 'Go'}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setPrompt(''); }}
        className="p-1 text-slate-400 hover:text-rose-500"
        aria-label="Cancel"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export default AIGenerate;
