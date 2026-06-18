import React, { useState, useEffect } from 'react';
import { Sparkles, Loader2, X, Wand2, Hash } from 'lucide-react';
import { generateImage, generateText } from '../utils/generationApi';
import { buildTextContext } from '../utils/aiPrompt';
import { TONE_PRESETS, LENGTH_PRESETS } from '../constants';

/**
 * Inline "generate with AI" control.
 *
 *   kind 'image' — prompt -> hosted image URL (onResult receives the URL).
 *   kind 'text'  — platform/tone/length + client-context aware. Three actions:
 *       Generate  — fresh draft from a prompt
 *       Improve   — rewrite the current draft (optionally with guidance)
 *       Hashtags  — append relevant hashtags to the current draft
 *     onResult receives the new content string.
 *
 * Text props: platform, clientName, clientSettings (clientMap[client]), currentText.
 */
const AIGenerate = ({
  kind,
  onResult,
  showToast,
  platform = 'gmb',
  clientName = '',
  clientSettings = null,
  currentText = ''
}) => {
  const isText = kind === 'text';
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [tone, setTone] = useState(clientSettings?.aiTone || 'professional');
  const [length, setLength] = useState('medium');

  // Pre-fill the tone from the selected client's saved default when it changes.
  useEffect(() => {
    if (clientSettings?.aiTone) setTone(clientSettings.aiTone);
  }, [clientSettings?.aiTone]);

  const label = isText ? 'AI draft' : 'Generate image';
  const hasDraft = currentText.trim().length > 0;

  const runText = async (mode) => {
    if (loading) return;
    const p = prompt.trim();
    if (mode === 'generate' && !p) return;
    if ((mode === 'improve' || mode === 'hashtags') && !hasDraft) {
      showToast?.('Write or generate a draft first', 'error');
      return;
    }

    setLoading(true);
    try {
      const { system, maxTokens } = buildTextContext({ platform, tone, length, clientName, clientSettings });
      let result;

      if (mode === 'generate') {
        result = await generateText(p, { system, maxTokens });
      } else if (mode === 'improve') {
        const guidance = p ? ` Additional guidance: ${p}.` : '';
        result = await generateText(
          `Rewrite and improve the post below for this platform and brand, keeping its core message.${guidance}\n\nPOST:\n${currentText}`,
          { system, maxTokens }
        );
      } else {
        const tags = await generateText(
          `Suggest 3–6 relevant, high-quality hashtags for the post below. Return ONLY the hashtags separated by spaces — nothing else.\n\nPOST:\n${currentText}`,
          { system, maxTokens: 60 }
        );
        result = `${currentText.trim()}\n\n${tags.trim()}`;
      }

      onResult(result);
      setOpen(false);
      setPrompt('');
      showToast?.(mode === 'hashtags' ? 'Hashtags added' : mode === 'improve' ? 'Draft improved' : 'Draft generated');
    } catch (err) {
      showToast?.(err.message || 'Generation failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  const runImage = async () => {
    const p = prompt.trim();
    if (!p || loading) return;
    setLoading(true);
    try {
      const url = await generateImage(p);
      onResult(url);
      setOpen(false);
      setPrompt('');
      showToast?.('Image generated');
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

  // --- Image: single-row prompt ---
  if (!isText) {
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
              if (e.key === 'Enter') { e.preventDefault(); runImage(); }
              if (e.key === 'Escape') { setOpen(false); setPrompt(''); }
            }}
            placeholder="Describe the image you want…"
            disabled={loading}
            className="w-full pl-7 pr-3 py-1.5 bg-white border border-indigo-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60"
          />
        </div>
        <button
          type="button"
          onClick={runImage}
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
  }

  // --- Text: panel with tone/length + Generate / Improve / Hashtags ---
  const selectClass =
    'bg-white border border-indigo-200 rounded-lg text-xs font-medium px-2 py-1.5 focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60';

  return (
    <div className="w-full bg-indigo-50/60 border border-indigo-100 rounded-xl p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Sparkles size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-indigo-400" />
          <input
            autoFocus
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); runText('generate'); }
              if (e.key === 'Escape') { setOpen(false); setPrompt(''); }
            }}
            placeholder={hasDraft ? 'Topic to generate, or guidance for Improve…' : 'What should this post be about?'}
            disabled={loading}
            className="w-full pl-7 pr-3 py-1.5 bg-white border border-indigo-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60"
          />
        </div>
        <button
          type="button"
          onClick={() => { setOpen(false); setPrompt(''); }}
          className="p-1 text-slate-400 hover:text-rose-500"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select value={tone} onChange={(e) => setTone(e.target.value)} disabled={loading} className={selectClass} aria-label="Tone">
          {TONE_PRESETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <select value={length} onChange={(e) => setLength(e.target.value)} disabled={loading} className={selectClass} aria-label="Length">
          {LENGTH_PRESETS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>

        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => runText('generate')}
            disabled={loading || !prompt.trim()}
            className="flex items-center gap-1 bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Generate
          </button>
          <button
            type="button"
            onClick={() => runText('improve')}
            disabled={loading || !hasDraft}
            title="Rewrite the current draft for this platform & brand"
            className="flex items-center gap-1 bg-white text-indigo-700 border border-indigo-200 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-50 disabled:opacity-40"
          >
            <Wand2 size={12} /> Improve
          </button>
          <button
            type="button"
            onClick={() => runText('hashtags')}
            disabled={loading || !hasDraft}
            title="Append relevant hashtags"
            aria-label="Add hashtags"
            className="flex items-center gap-1 bg-white text-indigo-700 border border-indigo-200 p-1.5 rounded-lg text-xs font-bold hover:bg-indigo-50 disabled:opacity-40"
          >
            <Hash size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AIGenerate;
