import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X, Save, Wand2, Smartphone, Image as ImageIcon, Eye, Sparkles,
  Trash2, UploadCloud, Calendar as CalendarIcon, Loader2
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
import { PLATFORMS, STATUS, DEFAULT_CLIENT_SETTINGS } from '../constants';
import { processImageFile } from '../utils/helpers';
import { describeImage, generateText } from '../utils/generationApi';
import { slugifyClientId } from '../config/roles';

// Converts a Date to a `datetime-local` input value in the user's local timezone.
// (Plain toISOString() is UTC, which shifts the default time by the tz offset.)
const toLocalISOString = (date) => {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

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

const Editor = ({ post, onSave, onCancel, clientMap, uniqueClients, clientIdByName, showToast, isReadOnly, onCreateDrafts, postImagesByClient = {} }) => {
  const allClients = useMemo(() => {
    const set = new Set([...(uniqueClients || []), ...Object.keys(clientMap || {})]);
    return [...set].sort();
  }, [uniqueClients, clientMap]);

  // The selected client's suite SLUG — attributes AI generation to the client at the gateway meter.
  // Resolution order matches the app's canonical clientIdFor: the edited post's already-stamped id,
  // then the posts-derived name→id map (App.jsx passes it role-scoped), then the branding doc's
  // stamped id, then the slugified name as the last resort (a drifted display name could otherwise
  // meter under a phantom slug).
  const genClientId = (name) => (
    (post?.client === name && post?.clientId)
      || clientIdByName?.[name]
      || clientMap?.[name]?.clientId
      || (name ? slugifyClientId(name) : '')
  );

  const [formData, setFormData] = useState({
    platform: 'gmb',
    content: '',
    title: '',
    altText: '',
    metaDescription: '',
    client: '',
    imageUrl: '',
    scheduledDate: toLocalISOString(new Date()),
    status: STATUS.DRAFT,
    tags: [],
    isTemplate: false
  });
  const [previewMode, setPreviewMode] = useState(false);
  const [isSparkOpen, setIsSparkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [altLoading, setAltLoading] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);
  const textareaRef = useRef(null);

  // --- Resizable preview panel (desktop) ---
  const PREVIEW_MIN = 320;
  const PREVIEW_MAX = 860;
  const [previewWidth, setPreviewWidth] = useState(() => {
    try {
      const saved = parseInt(window.localStorage?.getItem('spool:previewWidth'), 10);
      return Number.isFinite(saved) ? Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, saved)) : 420;
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
  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      try {
        const processedImage = await processImageFile(file);
        setFormData(prev => ({ ...prev, imageUrl: processedImage }));
      } catch {
        showToast("Error processing image", "error");
      }
    }
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
        client: '',
        imageUrl: '',
        scheduledDate: safeDateString,
        status: STATUS.DRAFT,
        tags: [],
        isTemplate: false
      };
      setFormData({
        ...defaultState,
        ...post,
        scheduledDate: safeDateString
      });
    }
  }, [post]);

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (file) {
      try {
        const processedImage = await processImageFile(file); // ✅ COMPRESSION
        setFormData(prev => ({ ...prev, imageUrl: processedImage }));
      } catch {
        showToast("Error processing image", "error");
      }
    }
  };

  const currentPlatform = PLATFORMS[formData.platform] || PLATFORMS.gmb;
  const isLongForm = currentPlatform.longForm === true;
  const wordCount = formData.content.length;
  const isOverLimit = wordCount > currentPlatform.maxChars;

  const handleSaveWrapper = async () => {
    if (isReadOnly || isOverLimit || !formData.content || isSaving) return;
    setIsSaving(true);
    try {
      await onSave(formData);
    } finally {
      setIsSaving(false);
    }
  };

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
             <button onClick={onCancel} title="Close Editor" aria-label="Close Editor" className="p-2 hover:bg-slate-100 rounded-full text-slate-500"><X size={20}/></button>
             <h2 className="font-bold text-slate-800 text-lg">{post?.id ? 'Edit Thread' : 'New Thread'}</h2>
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
                  onResult={(txt) => setFormData(prev => ({ ...prev, content: txt }))}
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
                value={formData.content}
                onChange={(txt) => setFormData(prev => ({ ...prev, content: txt }))}
              />
            )}
            <textarea
               ref={textareaRef}
               className={`w-full ${isLongForm ? 'h-96' : 'h-64'} p-4 rounded-xl border-2 text-base leading-relaxed resize-none focus:ring-0 transition-all ${isOverLimit ? 'border-rose-300 focus:border-rose-500 bg-rose-50' : 'border-slate-200 focus:border-indigo-500 bg-white'}`}
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
            {/* ✅ RESTORED: Char Counter (hidden for long-form blog) */}
            {!isLongForm && (
              <div className="absolute bottom-16 right-4">
                 <CharCountCircle current={wordCount} max={currentPlatform.maxChars} />
              </div>
            )}
          </div>

          {/* Evergreen: mark as a reusable template (kept out of the dated queue,
              lives in the Templates library — "Use as draft" clones it into a post). */}
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
                </select>
             </div>
             <div className="flex flex-col gap-1">
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Client Name</label>
                {/* 🔒 SECURITY: Input length limit */}
                <input type="text" list="client-list" maxLength={50} placeholder="Select or type a new client..." value={formData.client} onChange={(e) => setFormData({ ...formData, client: e.target.value })} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all" />
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
                <MarkdownPreview content={formData.content} title={formData.title} imageUrl={formData.imageUrl} />
              </div>
            ) : (
              <MobilePreview
                post={formData}
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
            setFormData(prev => ({ ...prev, content: txt }));
            setIsSparkOpen(false);
          }}
        />
      )}

      {pickerOpen && (
        <MediaPicker
          onClose={() => setPickerOpen(false)}
          onSelect={(url) => setFormData(prev => ({ ...prev, imageUrl: url }))}
          showToast={showToast}
          /* The post's client resolved to the canonical SLUG (same genClientId chain the AI calls
             use: stamped id → clientIdByName → branding doc → slugify fallback) so the picker can
             also offer the client's curated library — the slug-keyed folder POM's Assets card shares. */
          clientKey={genClientId(formData.client)}
          clientName={formData.client}
          clientImages={postImagesByClient[formData.client] || []}
        />
      )}
    </div>
  );
};

export default Editor;