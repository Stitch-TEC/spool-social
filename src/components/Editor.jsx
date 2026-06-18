import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  X, Save, Wand2, Smartphone, Image as ImageIcon, Eye,
  Trash2, UploadCloud, Calendar as CalendarIcon, Loader2
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import MobilePreview from './MobilePreview';
import MarkdownPreview from './MarkdownPreview';
import MarkdownToolbar from './MarkdownToolbar';
import RepurposeBlog from './RepurposeBlog';
import SparkDeck from './SparkDeck';
import AIGenerate from './AIGenerate';
import CharCountCircle from './CharCountCircle'; // ✅ NEW
import { PLATFORMS, STATUS, DEFAULT_CLIENT_SETTINGS } from '../constants';
import { processImageFile } from '../utils/helpers';

// Converts a Date to a `datetime-local` input value in the user's local timezone.
// (Plain toISOString() is UTC, which shifts the default time by the tz offset.)
const toLocalISOString = (date) => {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

// Static class strings so Tailwind's JIT can detect them (dynamic `border-${x}` is purged).
const PLATFORM_ACTIVE_CLASSES = {
  gmb: 'border-blue-500 bg-blue-50',
  linkedin: 'border-sky-500 bg-sky-50',
  twitter: 'border-slate-800 bg-slate-50',
  instagram: 'border-pink-500 bg-pink-50',
  blog: 'border-emerald-500 bg-emerald-50',
};

const Editor = ({ post, onSave, onCancel, clientMap, uniqueClients, showToast, isReadOnly, onCreateDrafts }) => {
  const allClients = useMemo(() => {
    const set = new Set([...(uniqueClients || []), ...Object.keys(clientMap || {})]);
    return [...set].sort();
  }, [uniqueClients, clientMap]);

  const [formData, setFormData] = useState({
    platform: 'gmb',
    content: '',
    title: '',
    client: '',
    imageUrl: '',
    scheduledDate: toLocalISOString(new Date()),
    status: STATUS.DRAFT,
    tags: []
  });
  const [previewMode, setPreviewMode] = useState(false);
  const [isSparkOpen, setIsSparkOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef(null);

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
        client: '',
        imageUrl: '',
        scheduledDate: safeDateString,
        status: STATUS.DRAFT,
        tags: []
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
  const isBlog = currentPlatform.longForm === true;
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

  return (
    <div className="h-full flex flex-col md:flex-row bg-white overflow-hidden animate-in slide-in-from-right duration-300">
      {/* Left Panel: Edit */}
      <div className={`flex-1 flex flex-col h-full border-r border-slate-200 transition-all ${previewMode ? 'hidden md:flex' : 'flex'}`}>
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

          {isBlog && (
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
                  currentText={formData.content}
                  showToast={showToast}
                  onResult={(txt) => setFormData(prev => ({ ...prev, content: txt }))}
                />
              </div>
            )}
            {isBlog && !isReadOnly && (
              <div className="mb-2">
                <RepurposeBlog
                  title={formData.title}
                  content={formData.content}
                  client={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  onCreateDrafts={onCreateDrafts}
                  showToast={showToast}
                />
              </div>
            )}
            {isBlog && (
              <MarkdownToolbar
                textareaRef={textareaRef}
                value={formData.content}
                onChange={(txt) => setFormData(prev => ({ ...prev, content: txt }))}
              />
            )}
            <textarea
               ref={textareaRef}
               className={`w-full ${isBlog ? 'h-96' : 'h-64'} p-4 rounded-xl border-2 text-base leading-relaxed resize-none focus:ring-0 transition-all ${isOverLimit ? 'border-rose-300 focus:border-rose-500 bg-rose-50' : 'border-slate-200 focus:border-indigo-500 bg-white'}`}
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
            {!isBlog && (
              <div className="absolute bottom-16 right-4">
                 <CharCountCircle current={wordCount} max={currentPlatform.maxChars} />
              </div>
            )}
          </div>

          {/* Metadata Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
             <div>
                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Schedule</label>
                <div className="relative">
                   <CalendarIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                   <input type="datetime-local" value={formData.scheduledDate} onChange={(e) => setFormData({ ...formData, scheduledDate: e.target.value })} className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm font-medium focus:border-indigo-500 focus:ring-0 transition-all" />
                </div>
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
              <div className="mb-3">
                <AIGenerate
                  kind="image"
                  platform={formData.platform}
                  clientName={formData.client}
                  clientSettings={clientMap?.[formData.client]}
                  showToast={showToast}
                  onResult={(url) => setFormData(prev => ({ ...prev, imageUrl: url }))}
                />
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
                <img src={formData.imageUrl} className="w-full h-48 object-cover" alt="Preview" />
                <button onClick={() => setFormData({ ...formData, imageUrl: '' })} title="Remove Image" aria-label="Remove Image" className="absolute top-2 right-2 p-2 bg-black/50 text-white rounded-full hover:bg-rose-600 transition-colors backdrop-blur-sm"><Trash2 size={16}/></button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Panel: Preview */}
      <div className={`w-full md:w-[400px] bg-slate-100 border-l border-slate-200 flex flex-col ${previewMode ? 'flex fixed inset-0 z-20' : 'hidden md:flex'}`}>
         <div className="p-4 border-b border-slate-200 bg-slate-100 flex justify-between items-center">
            <h3 className="font-bold text-slate-500 text-sm uppercase tracking-wider">Live Preview</h3>
            <button onClick={() => setPreviewMode(!previewMode)} title="Close Preview" aria-label="Close Preview" className="md:hidden p-2 text-slate-500 hover:bg-slate-200 rounded-lg"><X size={20}/></button>
         </div>
         <div className="flex-1 flex items-center justify-center p-6 bg-slate-100/50 backdrop-blur-3xl overflow-hidden">
            {isBlog ? (
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
      
      {/* Mobile Toggle */}
      <button onClick={() => setPreviewMode(true)} title="Open Preview" aria-label="Open Preview" className="md:hidden fixed bottom-6 right-6 z-50 bg-slate-900 text-white p-4 rounded-full shadow-xl"><Smartphone size={24}/></button>

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
    </div>
  );
};

export default Editor;