import React, { useState, useEffect } from 'react';
import { Sparkles, Loader2, X, Wand2, Hash, Lightbulb } from 'lucide-react';
import { generateImage, generateText, fetchIdeas } from '../utils/generationApi';
import { buildTextContext, buildImagePrompt } from '../utils/aiPrompt';
import { TONE_PRESETS, LENGTH_PRESETS, IMAGE_STYLE_PRESETS, PLATFORMS } from '../constants';

// --- Ideas panel helpers (pure — the /api/ideas payload → a short prompt-seed list) -----------
// Site pages first (the client's own freshest published content), then repo releases/commits.
// Capped so the panel stays a nudge, not a feed — and BALANCED: sites can contribute up to 10
// pages, so an unsplit cap of 8 would mean repo activity never surfaces for any client with a
// busy site. Sites get first claim on 5 slots; repos fill the rest.
const MAX_IDEAS = 8;
const MAX_SITE_IDEAS = 5;

// Module-level (per SPA session), NOT per component instance: every Editor open mounts a fresh
// AIGenerate, and each cold instance would otherwise re-fetch the same client's signals — another
// rate-bucket debit (shared with generation) and another cold-cache stall for identical data.
const ideasCache = new Map(); // clientId -> flattened items (settled fetches only)

// Scraped text lands in a prompt seed — collapse ALL whitespace (incl. newlines) so a hostile
// page title can't fake multi-line prompt structure when "Draft from this" drops it in the box.
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function flattenIdeas(data) {
  const siteItems = [];
  for (const p of data?.signals?.site?.pages || []) {
    const title = flat(p?.title) || flat(p?.url);
    if (!title) continue;
    siteItems.push({
      id: `page:${p?.url || title}`,
      tag: 'Site',
      title,
      description: flat(p?.description),
      url: flat(p?.url)
    });
  }
  const repoItems = [];
  for (const r of data?.signals?.repos || []) {
    for (const it of r?.items || []) {
      const title = flat(it?.title);
      if (!title) continue;
      repoItems.push({
        id: `${r?.repo || 'repo'}:${it?.url || title}`,
        tag: it?.kind === 'release' ? 'Release' : 'Commit',
        title,
        description: flat(r?.description),
        url: flat(it?.url)
      });
    }
  }
  // Sites first (capped so repos always get a look-in when both exist), repos fill to the total.
  const items = siteItems.slice(0, repoItems.length ? MAX_SITE_IDEAS : MAX_IDEAS);
  return items.concat(repoItems.slice(0, MAX_IDEAS - items.length));
}

// The exact seed "Draft from this" drops into the prompt box.
function ideaSeed(item) {
  let seed = `Write about: ${item.title}`;
  if (item.description) seed += ` — ${item.description}`;
  if (item.url) seed += ` (source: ${item.url})`;
  return seed;
}

/**
 * Inline "generate with AI" control.
 *
 *   kind 'image' — style + brand/platform-aware prompt -> hosted image URL.
 *   kind 'text'  — platform/tone/length + client-context aware. Three actions:
 *       Generate  — fresh draft from a prompt
 *       Improve   — rewrite the current draft (optionally with guidance)
 *       Hashtags  — append relevant hashtags to the current draft
 *     onResult receives the new value (content string, or image URL).
 *
 * Shared props: platform, clientName, clientSettings (clientMap[client]),
 * clientId (the suite slug — attributes gateway usage to the client for per-client metering).
 * Text adds: currentText (for Improve / Hashtags).
 */
const AIGenerate = ({
  kind,
  onResult,
  onAppend,
  showToast,
  platform = 'gmb',
  clientName = '',
  clientSettings = null,
  clientId = '',
  currentText = ''
}) => {
  const isText = kind === 'text';
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [tone, setTone] = useState(clientSettings?.aiTone || 'professional');
  const [length, setLength] = useState('medium');
  const [style, setStyle] = useState('photo');
  // Ideas panel (text kind only): content ideas pulled from the client's own site + repos via
  // /api/ideas. 'hidden' covers EVERY quiet state — no client slug, seam unconfigured, upstream
  // error, empty signals — so the feature simply doesn't exist unless it has something to offer.
  const [ideas, setIdeas] = useState([]);
  const [ideasState, setIdeasState] = useState('idle'); // idle | loading | ready | hidden

  // Pre-fill the tone from the selected client's saved default when it changes.
  useEffect(() => {
    setTone(clientSettings?.aiTone || 'professional');
  }, [clientSettings?.aiTone]);

  // Lazy-load ideas when the text panel is open for a client. Errors (including a not_configured
  // seam) collapse to 'hidden' — the panel is a bonus, never a blocker. Two deliberate shapes:
  // (1) DEBOUNCED 600ms — clientId derives from the Editor's free-text client field, so it changes
  //     per keystroke; firing per change would burn the 10/min Firebase rate bucket (shared with
  //     generation) on phantom slugs. Only the settled value fetches.
  // (2) When the client clears (or panel closes), drop stale items — otherwise the previous
  //     client's ideas stay visible and seedable under the new name.
  useEffect(() => {
    if (!open || !isText || !clientId) {
      setIdeas([]);
      setIdeasState('idle');
      return;
    }
    const cached = ideasCache.get(clientId);
    if (cached) {
      setIdeas(cached);
      setIdeasState(cached.length ? 'ready' : 'hidden');
      return;
    }
    let cancelled = false;
    setIdeas([]);
    const t = setTimeout(() => {
      setIdeasState('loading');
      fetchIdeas(clientId)
        .then((data) => {
          // Cache BEFORE the cancelled check: a panel closed mid-flight already paid for this
          // fetch (possibly a slow cold broker collect) — discarding the result would re-pay it
          // on the next open. Only the STATE updates are gated on still being mounted.
          const items = flattenIdeas(data);
          ideasCache.set(clientId, items);
          if (cancelled) return;
          setIdeas(items);
          setIdeasState(items.length ? 'ready' : 'hidden');
        })
        .catch((e) => {
          // Cache only the PERMANENT misses (seam off / never-rostered client) — those genuinely
          // shouldn't be re-hit on every reopen. A transient failure (rate-limit 429, network
          // blip, broker hiccup) stays UNcached so the next open retries instead of the panel
          // playing dead for the rest of the editor session. (Cached before the cancelled check,
          // same reasoning as the success path.)
          const msg = String(e?.message || '');
          if (msg === 'not_configured' || msg === 'unknown_client') {
            ideasCache.set(clientId, []);
          }
          if (cancelled) return;
          setIdeas([]);
          setIdeasState('hidden');
        });
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, isText, clientId]);

  const label = isText ? 'AI draft' : 'Generate image';
  const hasDraft = currentText.trim().length > 0;

  const selectClass =
    'bg-white border border-indigo-200 rounded-lg text-xs font-medium px-2 py-1.5 focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60';

  const close = () => { setOpen(false); setPrompt(''); };

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

      if (mode === 'hashtags') {
        const tags = (await generateText(
          `Suggest 3–6 relevant, high-quality hashtags for the post below. Return ONLY the hashtags separated by spaces — nothing else.\n\nPOST:\n${currentText}`,
          { system, maxTokens: 60, clientId, platform }
        )).trim();
        // Append to the LATEST content (avoids clobbering edits made mid-request).
        if (onAppend) onAppend(tags);
        else onResult(`${currentText.trim()}\n\n${tags}`);
        close();
        showToast?.('Hashtags added');
        return;
      }

      let result;
      if (mode === 'generate') {
        result = await generateText(p, { system, maxTokens, clientId, platform });
      } else {
        const guidance = p ? ` Additional guidance: ${p}.` : '';
        result = await generateText(
          `Rewrite and improve the post below for this platform and brand, keeping its core message.${guidance}\n\nPOST:\n${currentText}`,
          { system, maxTokens, clientId, platform }
        );
      }
      onResult(result);
      close();
      showToast?.(mode === 'improve' ? 'Draft improved' : 'Draft generated');
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
      const fullPrompt = buildImagePrompt({ prompt: p, style, platform, clientName, clientSettings });
      const url = await generateImage(fullPrompt, { clientId, platform });
      onResult(url);
      close();
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

  // --- Image: prompt + style ---
  if (!isText) {
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
                if (e.key === 'Enter') { e.preventDefault(); runImage(); }
                if (e.key === 'Escape') { close(); }
              }}
              placeholder="Describe the image you want…"
              maxLength={1200}
              disabled={loading}
              className="w-full pl-7 pr-3 py-1.5 bg-white border border-indigo-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60"
            />
          </div>
          <button type="button" onClick={close} className="p-1 text-slate-400 hover:text-rose-500" aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={style} onChange={(e) => setStyle(e.target.value)} disabled={loading} className={selectClass} aria-label="Image style">
            {IMAGE_STYLE_PRESETS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <button
            type="button"
            onClick={runImage}
            disabled={loading || !prompt.trim()}
            className="flex items-center gap-1 bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:opacity-50 ml-auto"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {loading ? 'Working…' : 'Generate'}
          </button>
        </div>
      </div>
    );
  }

  // --- Text: prompt + tone/length + Generate / Improve / Hashtags ---
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
              if (e.key === 'Escape') { close(); }
            }}
            placeholder={hasDraft ? 'Topic to generate, or guidance for Improve…' : 'What should this post be about?'}
            disabled={loading}
            className="w-full pl-7 pr-3 py-1.5 bg-white border border-indigo-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 disabled:opacity-60"
          />
        </div>
        <button type="button" onClick={close} className="p-1 text-slate-400 hover:text-rose-500" aria-label="Cancel">
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
          {!PLATFORMS[platform]?.longForm && (
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
          )}
        </div>
      </div>

      {/* Ideas from the client's own site + repos — quiet, optional, never blocking. */}
      {ideasState === 'loading' && (
        <div className="flex items-center gap-1 text-[11px] text-slate-400 px-0.5">
          <Loader2 size={10} className="animate-spin" /> Looking for ideas from this client&rsquo;s site &amp; repos…
        </div>
      )}
      {ideasState === 'ready' && ideas.length > 0 && (
        <div className="border-t border-indigo-100 pt-2">
          <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
            <Lightbulb size={11} className="text-amber-500" />
            Ideas from {clientName ? `${clientName}’s` : 'the client’s'} site &amp; repos
          </div>
          <ul className="space-y-1 max-h-36 overflow-y-auto pr-1">
            {ideas.map((item) => (
              <li key={item.id} className="flex items-start gap-2 bg-white border border-indigo-100 rounded-lg px-2 py-1.5">
                <span className="shrink-0 mt-0.5 text-[9px] font-bold uppercase tracking-wider text-indigo-400 bg-indigo-50 rounded px-1 py-0.5">
                  {item.tag}
                </span>
                <span className="flex-1 min-w-0 truncate text-xs text-slate-600" title={item.description || item.title}>
                  {item.title}
                </span>
                <button
                  type="button"
                  onClick={() => setPrompt(ideaSeed(item))}
                  disabled={loading}
                  title="Seed the prompt with this idea"
                  className="shrink-0 text-indigo-600 text-[11px] font-bold hover:underline disabled:opacity-40"
                >
                  Draft from this
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AIGenerate;
