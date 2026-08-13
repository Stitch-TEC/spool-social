import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useDeferredValue } from 'react';
import {
  X, Save, Wand2, Smartphone, Image as ImageIcon, Eye, Sparkles,
  Trash2, UploadCloud, Calendar as CalendarIcon, Loader2, History
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import MobilePreview from './MobilePreview';
import MarkdownPreview from './MarkdownPreview';
import MarkdownToolbar from './MarkdownToolbar';
import RepurposeBlog from './RepurposeBlog';
import MediaPicker from './MediaPicker';
import SparkDeck from './SparkDeck';
import AIGenerate from './AIGenerate';
import CharCountCircle from './CharCountCircle'; // ✅ NEW
import ConfirmModal from './ConfirmModal';
import { PLATFORMS, STATUS, DEFAULT_CLIENT_SETTINGS } from '../constants';
import { processImageFile } from '../utils/helpers';
import { replaceRange, twitterLength, looksLikeSocialMarkdown, containsRawHtml } from '../utils/markdownEditing';
import { describeImage, generateText, ensureHostedImage } from '../utils/generationApi';
import { slugifyClientId } from '../config/roles';

// Converts a Date to a `datetime-local` input value in the user's local timezone.
// (Plain toISOString() is UTC, which shifts the default time by the tz offset.)
const toLocalISOString = (date) => {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

// Fields that count as "the operator's work" for the unsaved-changes guard and
// the local autosave. (Derived/readonly fields like source/approvalStatus are
// deliberately excluded — they change underneath the operator without them typing.)
const WORK_FIELDS = ['platform', 'content', 'title', 'altText', 'metaDescription', 'client', 'imageUrl', 'scheduledDate', 'status', 'tags', 'isTemplate'];
const workSignature = (fd) => JSON.stringify(WORK_FIELDS.map((k) => fd[k]));

// Static class strings so Tailwind's JIT can detect them (dynamic `border-${x}` is purged).
const PLATFORM_ACTIVE_CLASSES = {
  gmb: 'border-blue-500 bg-blue-50',
  facebook: 'border-[#1877F2] bg-blue-50',
  linkedin: 'border-sky-500 bg-sky-50',
  twitter: 'border-slate-800 bg-slate-50',
  instagram: 'border-pink-500 bg-pink-50',
  blog: 'border-emerald-500 bg-emerald-50',
  job: 'border-violet-500 bg-violet-50',
};

const Editor = ({ post, onSave, onCancel, clientMap, uniqueClients, clientIdByName, clientIdFor, showToast, isReadOnly, onCreateDrafts, postImagesByClient = {}, initialClient = '', clientLocked = false }) => {
  const allClients = useMemo(() => {
    const set = new Set([...(uniqueClients || []), ...Object.keys(clientMap || {})]);
    return [...set].sort();
  }, [uniqueClients, clientMap]);

  // The selected client's suite SLUG — attributes AI generation to the client at the gateway meter.
  // Resolution order: the edited post's already-stamped id, then the posts-derived name→id map
  // (App.jsx passes it role-scoped), then the branding doc's stamped id, then App's roster-aware
  // clientIdFor (which matches the roster by normalized display name before falling back to
  // slugify — a drifted display name previously metered under a phantom slug). The bare slugify
  // tail survives only as a defensive default when the prop isn't wired (e.g. isolated renders).
  const genClientId = (name) => (
    (post?.client === name && post?.clientId)
      || clientIdByName?.[name]
      || clientMap?.[name]?.clientId
      || (name ? (clientIdFor ? clientIdFor(name) : slugifyClientId(name)) : '')
  );

  const [formData, setFormData] = useState({
    platform: 'gmb',
    content: '',
    title: '',
    altText: '',
    metaDescription: '',
    // New posts start with the caller's client context (the active sidebar filter,
    // or a client member's own client) so the media picker's per-client sections
    // work immediately — previously they only appeared when editing an existing post.
    client: initialClient,
    imageUrl: '',
    scheduledDate: toLocalISOString(new Date()),
    status: STATUS.DRAFT,
    tags: [],
    isTemplate: false
  });
  const [previewMode, setPreviewMode] = useState(false);
  const [isSparkOpen, setIsSparkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // What the media picker fills: the cover image slot, or an inline markdown
  // image at the captured cursor position (toolbar image button, long-form).
  const [pickerMode, setPickerMode] = useState('cover');
  const inlineRangeRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [altLoading, setAltLoading] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  // Locally-recovered unsaved work (see the autosave effects below).
  const [recovered, setRecovered] = useState(null);
  const textareaRef = useRef(null);

  // Last-saved (or loaded) snapshot — the unsaved-changes guard compares
  // against this. Seeded from the first render's defaults; the post-load
  // effect re-seeds it whenever a post is opened.
  const pristineRef = useRef(null);
  if (pristineRef.current === null) pristineRef.current = formData;

  // Mirror of the current content for callbacks that fire from child components
  // (AI results, Spark Deck) — reading state through a ref avoids acting on a
  // stale closure when the reply lands after further typing.
  const contentRef = useRef('');
  contentRef.current = formData.content;

  // Full form mirror for the flush paths (beforeunload, discard-confirm) whose
  // handlers are mounted once and must still snapshot CURRENT values.
  const formDataRef = useRef(formData);
  formDataRef.current = formData;

  // The Restore toast outlives this editor (the Toast is App-owned) — its
  // action must know whether there is still an editor to restore into.
  const editorAliveRef = useRef(true);
  useEffect(() => {
    editorAliveRef.current = true;
    return () => { editorAliveRef.current = false; };
  }, []);

  // One local autosave slot per post, with separate slots for the two distinct
  // "new" flows (New Thread vs New Template) so recovery can't offer a draft
  // from the other flow. Not per-client on purpose: the point is crash/mis-click
  // recovery of the LAST thing being written, not a drafts system.
  const autosaveKey = `spool:autosave:${post?.id || (post?.isTemplate ? 'new-template' : 'new')}`;
  // Bumped by clearAutosave so an in-flight debounced write can't resurrect a
  // snapshot that a successful save just removed.
  const autosaveGenRef = useRef(0);

  // --- Resizable preview panel (desktop) ---
  const PREVIEW_MIN = 320;
  const PREVIEW_MAX = 860;
  const [previewWidth, setPreviewWidth] = useState(() => {
    try {
      const saved = parseInt(window.localStorage?.getItem('spool:previewWidth'), 10);
      // Clamp to the CURRENT viewport too — a width persisted on a wide monitor
      // would otherwise squeeze the edit pane to a sliver on a smaller screen.
      const viewportMax = Math.max(PREVIEW_MIN, window.innerWidth - 360);
      return Number.isFinite(saved) ? Math.min(PREVIEW_MAX, viewportMax, Math.max(PREVIEW_MIN, saved)) : 420;
    } catch { return 420; }
  });
  const resizingRef = useRef(false);

  // Leave the edit pane at least ~360px; clamp to the configured bounds.
  const clampWidth = (w) =>
    Math.min(Math.min(PREVIEW_MAX, window.innerWidth - 360), Math.max(PREVIEW_MIN, w));

  useEffect(() => {
    const onMove = (e) => {
      if (!resizingRef.current) return;
      setPreviewWidth(clampWidth(window.innerWidth - e.clientX)); // panel is on the right
    };
    const onUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  useEffect(() => {
    try { window.localStorage?.setItem('spool:previewWidth', String(previewWidth)); } catch { /* private mode */ }
  }, [previewWidth]);

  const startResize = (e) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const onHandleKey = (e) => {
    if (e.key === 'ArrowLeft') setPreviewWidth(w => clampWidth(w + 24));
    else if (e.key === 'ArrowRight') setPreviewWidth(w => clampWidth(w - 24));
    else return;
    e.preventDefault();
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  // Optimize the file, show it immediately, then swap the bulky data URL for a
  // hosted /media URL in the background (content-addressed, so the same photo
  // reused across posts keeps ONE URL). Falls back to the data URL on failure.
  const attachImageFile = async (file) => {
    try {
      const processedImage = await processImageFile(file);
      setFormData(prev => ({ ...prev, imageUrl: processedImage }));
      // Tag the pooled upload with the post's client so it stays scoped to that client in the picker.
      const hosted = await ensureHostedImage(processedImage, genClientId(formData.client));
      if (hosted !== processedImage) {
        // Only swap if the user hasn't replaced/removed the image meanwhile.
        setFormData(prev => (prev.imageUrl === processedImage ? { ...prev, imageUrl: hosted } : prev));
      }
    } catch {
      showToast("Error processing image", "error");
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) await attachImageFile(file);
  };

  useEffect(() => {
    if (post) {
      let safeDateString = toLocalISOString(new Date()); // Default to now (local time)
      
      if (post.scheduledDate) {
        // If it's a Date object
        if (post.scheduledDate instanceof Date && !isNaN(post.scheduledDate)) {
           safeDateString = toLocalISOString(post.scheduledDate);
        }
        // If it's a string
        else if (typeof post.scheduledDate === 'string') {
           const d = new Date(post.scheduledDate);
           if (!isNaN(d.getTime())) {
             safeDateString = toLocalISOString(d);
           }
        }
      }

      const defaultState = {
        platform: 'gmb',
        content: '',
        title: '',
        altText: '',
        metaDescription: '',
        client: initialClient,
        imageUrl: '',
        scheduledDate: safeDateString,
        status: STATUS.DRAFT,
        tags: [],
        isTemplate: false
      };
      const loaded = {
        ...defaultState,
        ...post,
        // A post with no client (e.g. "New template") still gets the caller's context.
        client: post.client || initialClient,
        scheduledDate: safeDateString
      };
      setFormData(loaded);
      // The loaded post IS the saved state — re-arm the unsaved-changes guard from it.
      pristineRef.current = loaded;
    }
  }, [post, initialClient]);

  const isDirty = workSignature(formData) !== workSignature(pristineRef.current);
  const isDirtyRef = useRef(false);
  isDirtyRef.current = isDirty;

  // Snapshot + write, shared by the debounced path and the synchronous flush
  // paths. Reads through refs so once-mounted handlers see current values.
  // Data-URL images are OMITTED (not blanked): a 500KB base64 blob would blow
  // the localStorage budget, and omitting means a restore leaves whatever image
  // the post currently has untouched.
  const writeAutosaveNow = () => {
    if (isReadOnly || !isDirtyRef.current) return;
    const fd = formDataRef.current;
    const snap = {};
    for (const k of WORK_FIELDS) snap[k] = fd[k];
    if (typeof snap.imageUrl === 'string' && snap.imageUrl.startsWith('data:')) delete snap.imageUrl;
    snap.savedAt = Date.now();
    try { window.localStorage?.setItem(autosaveKey, JSON.stringify(snap)); } catch { /* quota/private mode */ }
  };

  const clearAutosave = () => {
    autosaveGenRef.current += 1; // invalidate any pending debounced write
    try { window.localStorage?.removeItem(autosaveKey); } catch { /* private mode */ }
  };

  // Warn before the tab closes with unsaved edits — and flush the snapshot
  // FIRST, so "a copy was auto-saved" is true even if the user closes anyway
  // within the debounce window. (In-app close goes through the discard confirm.)
  useEffect(() => {
    const onBeforeUnload = (ev) => {
      if (isDirtyRef.current) {
        writeAutosaveNow();
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
    // writeAutosaveNow reads only refs + the stable autosaveKey — safe to mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Autosave: recover work lost to a crash, refresh, or stray click. ---
  // Offer recovery when a local snapshot differs from what the post actually
  // holds; silently clean up snapshots that match (i.e. the save went through).
  // The comparison is field-wise over EVERYTHING the snapshot captured — a
  // snapshot whose only divergence is schedule/status/tags/client must NOT be
  // treated as "already saved" and deleted. Declared AFTER the post-load effect
  // so pristineRef holds the loaded post when this runs.
  useEffect(() => {
    let saved = null;
    try { saved = JSON.parse(window.localStorage?.getItem(autosaveKey) || 'null'); } catch { saved = null; }
    if (!saved || typeof saved !== 'object' || typeof saved.content !== 'string') return;
    const pristine = pristineRef.current || {};
    const matchesLoaded = WORK_FIELDS.every((k) => {
      if (!(k in saved)) return true;
      // App trims content at save — don't let trailing whitespace alone summon a banner.
      if (k === 'content') return String(saved[k] ?? '').trim() === String(pristine[k] ?? '').trim();
      return JSON.stringify(saved[k] ?? null) === JSON.stringify(pristine[k] ?? null);
    });
    if (matchesLoaded) {
      clearAutosave();
      return;
    }
    setRecovered(saved);
    // Keyed by the autosave slot: post identity is fixed for the life of this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosaveKey]);

  // Debounced write while dirty; the generation check keeps a timer that was
  // already queued when clearAutosave ran from resurrecting a stale snapshot.
  useEffect(() => {
    if (isReadOnly || !isDirty) return undefined;
    const gen = autosaveGenRef.current;
    const t = setTimeout(() => {
      if (gen !== autosaveGenRef.current) return;
      writeAutosaveNow();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData, isDirty, isReadOnly, autosaveKey]);

  const restoreRecovered = () => {
    if (!recovered) return;
    setFormData(prev => {
      const next = { ...prev };
      for (const k of WORK_FIELDS) {
        if (recovered[k] !== undefined) next[k] = recovered[k];
      }
      // A client member's posts stay pinned to their own client (save path
      // enforces it anyway — don't even show a recovered foreign name).
      if (clientLocked) next.client = prev.client;
      return next;
    });
    setRecovered(null);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (file) await attachImageFile(file);
  };

  const currentPlatform = PLATFORMS[formData.platform] || PLATFORMS.gmb;
  const isLongForm = currentPlatform.longForm === true;
  // X/Twitter counts URLs as 23 (t.co) and emoji/CJK as 2 — raw .length lies in
  // both directions there. Everywhere else the raw length is the real limit.
  const charCount = formData.platform === 'twitter' ? twitterLength(formData.content) : formData.content.length;
  const isOverLimit = charCount > currentPlatform.maxChars;

  // ⚡ The live preview re-renders at DEFERRED priority: typing stays responsive
  // even while react-markdown re-parses a long blog post, and MobilePreview's memo
  // skips the urgent keystroke render entirely (its compared fields lag behind).
  const deferredContent = useDeferredValue(formData.content);
  const previewPost = useMemo(
    () => ({ ...formData, content: deferredContent }),
    [formData, deferredContent]
  );

  const handleSaveWrapper = async () => {
    if (isReadOnly || isOverLimit || !formData.content || isSaving) return;
    setIsSaving(true);
    try {
      // onSave returns true only when the write actually happened (validation
      // failures toast and return false) — only then is the local autosave
      // safety net obsolete.
      const ok = await onSave(formData);
      if (ok === true) {
        pristineRef.current = formData;
        clearAutosave();
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Wholesale content replacement (AI draft/improve, Spark Deck). One click
  // used to silently obliterate an hour of writing — now the previous version
  // rides along on the toast's Restore button. The toast is App-owned and can
  // outlive this editor (close right after replacing) — say so instead of
  // silently no-oping a setState on an unmounted component.
  const replaceContent = (txt) => {
    const prevContent = contentRef.current;
    setFormData(prev => ({ ...prev, content: txt }));
    if (prevContent.trim() && prevContent.trim() !== String(txt || '').trim()) {
      showToast?.('Content replaced', 'success', {
        label: 'Restore previous',
        onClick: () => {
          if (!editorAliveRef.current) {
            showToast?.('The editor was closed — reopen the draft to restore', 'error');
            return;
          }
          setFormData(p => ({ ...p, content: prevContent }));
        },
      });
    }
  };

  const requestCancel = () => {
    if (isDirty && !isReadOnly) setShowDiscardConfirm(true);
    else onCancel();
  };

  // Long-form drafts grow the textarea with the content (the surrounding pane
  // scrolls) instead of squeezing a 1,200-word post into a fixed 15-line box.
  // Social platforms keep the fixed height — their content is short by rule.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (!isLongForm) {
      ta.style.height = '';
      return;
    }
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(384, ta.scrollHeight + 2)}px`;
  }, [formData.content, isLongForm, previewMode]);

  const handleAltText = async () => {
    if (altLoading || !formData.imageUrl) return;
    setAltLoading(true);
    try {
      const alt = await describeImage(formData.imageUrl);
      setFormData(prev => ({ ...prev, altText: alt }));
      showToast?.('Alt text generated');
    } catch (err) {
      showToast?.(err.message || 'Alt text failed', 'error');
    } finally {
      setAltLoading(false);
    }
  };

  const handleMeta = async () => {
    if (metaLoading || !formData.content.trim()) return;
    setMetaLoading(true);
    try {
      const meta = await generateText(
        `Write a compelling SEO meta description (max 155 characters, one sentence, no quotes) for the post below.\n\nTITLE: ${formData.title || ''}\n\nPOST:\n${formData.content}`,
        { maxTokens: 80, clientId: genClientId(formData.client), platform: formData.platform }
      );
      setFormData(prev => ({ ...prev, metaDescription: meta.trim().slice(0, 200) }));
      showToast?.('Meta description generated');
    } catch (err) {
      showToast?.(err.message || 'Generation failed', 'error');
    } finally {
      setMetaLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col md:flex-row bg-white overflow-hidden animate-in slide-in-from-right duration-300">
      {/* Left Panel: Edit */}
      <div className={`flex-1 min-w-0 flex flex-col h-full border-r border-slate-200 ${previewMode ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-white sticky top-0 z-10">
          <div className="flex items-center gap-3">
             <button onClick={requestCancel} title="Close Editor" aria-label="Close Editor" className="p-2 hover:bg-slate-100 rounded-full text-slate-500"><X size={20}/></button>
             <h2 className="font-bold text-slate-800 text-lg">{post?.id ? 'Edit Thread' : 'New Thread'}</h2>
             {isDirty && !isReadOnly && (
               <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 uppercase tracking-wider" title="You have unsaved changes">
                 Unsaved
               </span>
             )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreviewMode(p => !p)}
              className="md:hidden flex items-center gap-1 text-xs font-bold text-slate-600 border border-slate-200 rounded-full px-3 py-2 hover:bg-slate-50"
            >
              <Eye size={14} /> {previewMode ? 'Edit' : 'Preview'}
            </button>
            <button
              onClick={handleSaveWrapper}
              disabled={isOverLimit || !formData.content || isReadOnly || isSaving}
              className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2 rounded-full font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg min-w-[100px] justify-center"
            >
               {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
               <span>{isSaving ? 'Saving...' : 'Save'}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 md:p-8 space-y-6">
          {/* Recovered-work banner: a local snapshot exists that this post doesn't hold. */}
          {recovered && !isReadOnly && (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <History size={18} className="text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-amber-800">Unsaved work recovered</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  A draft auto-saved {recovered.savedAt ? `on ${new Date(recovered.savedAt).toLocaleString()} ` : ''}on this device differs from what&apos;s shown. Restore it, or dismiss to keep what&apos;s here.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={restoreRecovered} className="px-3 py-1.5 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-full">Restore</button>
                <button onClick={() => { setRecovered(null); clearAutosave(); }} className="px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100 rounded-full">Dismiss</button>
              </div>
            </div>
          )}

          {/* Platform Select */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Platform</label>
            <div className="grid grid-cols-2 sm:flex gap-2 sm:gap-4">
              {Object.values(PLATFORMS).map(p => (
                <button
                  key={p.id}
                  onClick={() => setFormData({ ...formData, platform: p.id })}
                  aria-pressed={formData.platform === p.id}
                  className={`flex-1 flex flex-row sm:flex-col items-center justify-center gap-2 p-2 sm:p-3 rounded-xl border-2 transition-all ${formData.platform === p.id ? (PLATFORM_ACTIVE_CLASSES[p.id] || 'border-indigo-500 bg-indigo-50') : 'border-slate-100 hover:border-slate-200'}`}
                >
                   <PlatformIcon platformId={p.id} size={20} className="sm:w-6 sm:h-6" />
                   <span className={`text-[10px] sm:text-xs font-bold ${formData.platform === p.id ? 'text-slate-800' : 'text-slate-400'}`}>{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          {isLongForm && (
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Title</label>
              <input
                type="text"
                maxLength={200}
                placeholder="Post title…"
                value={formData.title || ''}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-base font-bold focus:border-indigo-500 focus:ring-0 transition-all"
              />
            </div>
          )}

          {isLongForm && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider">Meta description (SEO)</label>
                <button
                  type="button"
                  onClick={handleMeta}
                  disabled={metaLoading || !formData.content.trim()}
                  className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline disabled:opacity-50"
                >
                  {metaLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Generate
                </button>
              </div>
              <input
                type="text"
                maxLength={200}
                placeholder="One-sentence summary for search results…"
                value={formData.metaDescription || ''}
                onChange={(e) => setFormData({ ...formData, metaDescription: e.target.value })}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:border-indigo-500 focus:ring-0 transition-all"
              />
            </div>
          )}

          {/* Editor Area */}
          <div className="relative group">
            <div className="flex justify-between items-center mb-2 gap-3">
               <label className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">Content</label>
               <button onClick={() => setIsSparkOpen(true)} className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline shrink-0"><Wand2 size={12}/> <span>Spark Deck</span></button>
            </div>
            {!isReadOnly && (
              <div className="mb-2">
                <AIGenerate
                  kind="text"
                  platform={formData.platform}
                  clientName={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  clientId={genClientId(formData.client)}
                  currentText={formData.content}
                  showToast={showToast}
                  onResult={replaceContent}
                  onAppend={(tags) => setFormData(prev => ({ ...prev, content: (prev.content.trim() + '\n\n' + tags).trim() }))}
                />
              </div>
            )}
            {isLongForm && !isReadOnly && (
              <div className="mb-2">
                <RepurposeBlog
                  title={formData.title}
                  content={formData.content}
                  client={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  clientId={genClientId(formData.client)}
                  onCreateDrafts={onCreateDrafts}
                  showToast={showToast}
                />
              </div>
            )}
            {isLongForm && (
              <MarkdownToolbar
                textareaRef={textareaRef}
                onImageRequest={!isReadOnly ? () => {
                  // Capture where the cursor is NOW — opening the picker moves focus.
                  const ta = textareaRef.current;
                  inlineRangeRef.current = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
                  setPickerMode('inline');
                  setPickerOpen(true);
                } : undefined}
              />
            )}
            <textarea
               ref={textareaRef}
               className={`w-full ${isLongForm ? 'min-h-96 overflow-hidden' : 'h-64'} p-4 rounded-xl border-2 text-base leading-relaxed resize-none focus:ring-0 transition-all ${isOverLimit ? 'border-rose-300 focus:border-rose-500 bg-rose-50' : 'border-slate-200 focus:border-indigo-500 bg-white'}`}
               placeholder={currentPlatform.placeholder}
               value={formData.content}
               onChange={(e) => setFormData({ ...formData, content: e.target.value })}
               onKeyDown={(e) => {
                 if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                   e.preventDefault();
                   handleSaveWrapper();
                 }
               }}
            />
            {/* Soft correctness hints — never block, just tell the truth about the target. */}
            {!isLongForm && looksLikeSocialMarkdown(formData.content) && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Markdown formatting (like **bold** or [links](…)) posts as literal characters on {currentPlatform.name} — write plain text here.
              </p>
            )}
            {isLongForm && containsRawHtml(formData.content) && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                This draft contains raw HTML/JSX. The preview shows it as plain text, but the published site will interpret it — check the published result.
              </p>
            )}
            {/* ✅ RESTORED: Char Counter (hidden for long-form blog) */}
            {!isLongForm && (
              <div className="absolute bottom-16 right-4">
                 <CharCountCircle current={charCount} max={currentPlatform.maxChars} />
              </div>
            )}
          </div>

          {/* Evergreen: mark as a reusable template (kept out of the dated queue,
              lives in the Templates library — "Use as draft" clones it into a post).
              Hidden for parked suggestions: a suggestion-template hybrid would sit in two
              lanes at once (the save path forces the flag off for them regardless). */}
          {formData.source !== 'suggestion' && (
            <label className="flex items-center gap-2.5 mb-5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!formData.isTemplate}
                onChange={(e) => setFormData({ ...formData, isTemplate: e.target.checked })}
                className="accent-indigo-600 w-4 h-4 shrink-0"
              />
              <span className="text-sm font-semibold text-slate-700">Reusable template</span>
              <span className="text-xs text-slate-400 hidden sm:inline">— saved to your Templates library; no date needed</span>
            </label>
          )}

          {/* Metadata Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
             <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Schedule</label>
                <div className="relative">
                   <CalendarIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                   <input type="datetime-local" value={formData.scheduledDate} onChange={(e) => setFormData({ ...formData, scheduledDate: e.target.value })} className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all" />
                </div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mt-4 mb-2">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all"
                >
                  <option value={STATUS.DRAFT}>Draft</option>
                  <option value={STATUS.SCHEDULED}>Scheduled</option>
                  <option value={STATUS.POSTED}>Posted</option>
                  {formData.status === STATUS.ARCHIVED && <option value={STATUS.ARCHIVED}>Archived</option>}
                </select>
             </div>
             <div className="flex flex-col gap-1">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Client Name</label>
                {/* 🔒 SECURITY: Input length limit. Client members are pinned to their own
                    client (the save path enforces it) — show the field locked instead of an
                    editable value that would silently be overridden. */}
                <input type="text" list="client-list" maxLength={50} placeholder="Select or type a new client..." value={formData.client} disabled={clientLocked} title={clientLocked ? 'Posts are always saved to your own client' : undefined} onChange={(e) => setFormData({ ...formData, client: e.target.value })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all disabled:opacity-70 disabled:cursor-not-allowed" />
                <datalist id="client-list">
                    {allClients.map(c => <option key={c} value={c} />)}
                </datalist>
             </div>
             {/* Tag Management UI */}
             <div className="md:col-span-2">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Tags</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {formData.tags?.map((tag, i) => (
                      <span key={i} className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1">
                        #{tag}
                        <button
                          onClick={() => setFormData(prev => ({...prev, tags: prev.tags.filter((_, index) => index !== i)}))}
                          className="hover:text-rose-500 p-0.5 rounded-full hover:bg-rose-100 transition-colors"
                          title={`Remove tag #${tag}`}
                          aria-label={`Remove tag #${tag}`}
                        >
                          <X size={12}/>
                        </button>
                      </span>
                    ))}
                </div>
                <input 
                  type="text" 
                  placeholder={formData.tags?.length >= 10 ? "Limit reached (10 tags)" : "Type a tag and press Enter..."}
                  disabled={formData.tags?.length >= 10 || isReadOnly}
                  onKeyDown={(e) => {
                     if (e.key === 'Enter') {
                        e.preventDefault();
                        if (formData.tags?.length >= 10) return;

                        const val = e.target.value.trim().replace(/^#/, '').slice(0, 20);
                        if (val && !formData.tags?.includes(val)) {
                           setFormData(prev => ({...prev, tags: [...(prev.tags || []), val]}));
                        }
                        e.target.value = '';
                     }
                  }} 
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all disabled:opacity-50"
                />
             </div>
          </div>

          {/* Image Upload */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Visual Asset</label>
            {!isReadOnly && (
              <div className="mb-3 space-y-2">
                <AIGenerate
                  kind="image"
                  platform={formData.platform}
                  clientName={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  clientId={genClientId(formData.client)}
                  showToast={showToast}
                  onResult={(url) => setFormData(prev => ({ ...prev, imageUrl: url }))}
                />
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline"
                >
                  <ImageIcon size={12} /> Choose from library
                </button>
              </div>
            )}
            {!formData.imageUrl ? (
              <label 
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-all group ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-500 hover:bg-indigo-50/50'}`}
              >
                <div className="flex flex-col items-center pt-5 pb-6">
                  <UploadCloud className={`w-8 h-8 mb-2 transition-colors ${isDragging ? 'text-indigo-500' : 'text-slate-400 group-hover:text-indigo-500'}`} />
                  <p className={`text-xs font-medium ${isDragging ? 'text-indigo-600' : 'text-slate-500'}`}>{isDragging ? 'Drop image here' : 'Click or drop to upload image'}</p>
                </div>
                <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
              </label>
            ) : (
              <div className="relative rounded-xl overflow-hidden border border-slate-200 group">
                <img src={formData.imageUrl} className="w-full h-48 object-cover" alt={formData.altText || 'Preview'} />
                <button onClick={() => setFormData({ ...formData, imageUrl: '' })} title="Remove Image" aria-label="Remove Image" className="absolute top-2 right-2 p-2 bg-black/50 text-white rounded-full hover:bg-rose-600 transition-colors backdrop-blur-sm"><Trash2 size={16}/></button>
              </div>
            )}
            {formData.imageUrl && !isReadOnly && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Alt text</label>
                  <button type="button" onClick={handleAltText} disabled={altLoading} className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline disabled:opacity-50">
                    {altLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Generate
                  </button>
                </div>
                <input
                  type="text"
                  maxLength={300}
                  placeholder="Describe the image for accessibility / SEO…"
                  value={formData.altText || ''}
                  onChange={(e) => setFormData({ ...formData, altText: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:border-indigo-500 focus:ring-0 transition-all"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drag handle to resize the preview (desktop only) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview panel"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onHandleKey}
        title="Drag to resize preview"
        className="hidden md:flex w-1.5 shrink-0 cursor-col-resize bg-slate-200 hover:bg-indigo-400 focus:bg-indigo-500 focus:outline-none transition-colors items-center justify-center group"
      >
        <div className="w-0.5 h-8 bg-slate-400 group-hover:bg-white rounded-full transition-colors" />
      </div>

      {/* Right Panel: Preview */}
      <div
        style={!previewMode ? { width: `${previewWidth}px` } : undefined}
        className={`bg-slate-100 border-l border-slate-200 flex-col ${previewMode ? 'flex fixed inset-0 z-20 w-full' : 'hidden md:flex shrink-0'}`}
      >
         <div className="p-4 border-b border-slate-200 bg-slate-100 flex justify-between items-center">
            <h3 className="font-bold text-slate-500 text-sm uppercase tracking-wider">Live Preview</h3>
            <button onClick={() => setPreviewMode(!previewMode)} title="Close Preview" aria-label="Close Preview" className="md:hidden p-2 text-slate-500 hover:bg-slate-200 rounded-lg"><X size={20}/></button>
         </div>
         <div className="flex-1 flex items-center justify-center p-6 bg-slate-100/50 backdrop-blur-3xl overflow-hidden">
            {isLongForm ? (
              <div className="w-full h-full overflow-y-auto bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
                <MarkdownPreview content={deferredContent} title={formData.title} imageUrl={formData.imageUrl} />
              </div>
            ) : (
              <MobilePreview
                post={previewPost}
                clientSettings={clientMap[formData.client] || DEFAULT_CLIENT_SETTINGS}
              />
            )}
         </div>
      </div>
      
      {/* Mobile preview FAB — hidden while the preview overlay is open (it has its own close). */}
      {!previewMode && (
        <button onClick={() => setPreviewMode(true)} title="Open Preview" aria-label="Open Preview" className="md:hidden fixed bottom-6 right-6 z-50 bg-slate-900 text-white p-4 rounded-full shadow-xl">
          {isLongForm ? <Eye size={24} /> : <Smartphone size={24} />}
        </button>
      )}

      {/* Spark Deck lives here (not in App) so picking a prompt only updates
          `content` and never resets unsaved client/platform/tags/image state. */}
      {isSparkOpen && (
        <SparkDeck
          onClose={() => setIsSparkOpen(false)}
          onSelect={(txt) => {
            replaceContent(txt);
            setIsSparkOpen(false);
          }}
        />
      )}

      {pickerOpen && (
        <MediaPicker
          onClose={() => { setPickerOpen(false); setPickerMode('cover'); }}
          onSelect={(url) => {
            if (pickerMode === 'inline') {
              // Insert a markdown image at the cursor position captured when the
              // picker opened; caret lands in the alt-text brackets. Deferred a
              // frame so the closing modal can't steal focus back.
              const ta = textareaRef.current;
              const r = inlineRangeRef.current;
              if (ta && r) {
                requestAnimationFrame(() => replaceRange(ta, r.start, r.end, `![](${url})`, r.start + 2, r.start + 2));
              } else {
                setFormData(prev => ({ ...prev, content: `${prev.content.replace(/\n+$/, '')}\n\n![](${url})` }));
              }
            } else {
              setFormData(prev => ({ ...prev, imageUrl: url }));
            }
          }}
          showToast={showToast}
          /* The post's client resolved to the canonical SLUG (same genClientId chain the AI calls
             use: stamped id → clientIdByName → branding doc → slugify fallback) so the picker can
             also offer the client's curated library — the slug-keyed folder POM's Assets card shares. */
          clientKey={genClientId(formData.client)}
          clientName={formData.client}
          clientImages={postImagesByClient[formData.client] || []}
        />
      )}

      {/* Discard confirm — the only way an in-app close loses dirty edits is
          through this explicit choice (the autosave still keeps a local copy). */}
      {showDiscardConfirm && (
        <ConfirmModal
          type="danger"
          title="Discard unsaved changes?"
          message="This thread has edits that haven't been saved. A copy was auto-saved on this device, so you can recover it if you reopen the editor."
          confirmLabel="Discard"
          onCancel={() => setShowDiscardConfirm(false)}
          onConfirm={() => {
            // Flush the snapshot NOW — the debounced write is cancelled at
            // unmount, and the modal just promised a local copy exists.
            writeAutosaveNow();
            setShowDiscardConfirm(false);
            onCancel();
          }}
        />
      )}
    </div>
  );
};

export default Editor;