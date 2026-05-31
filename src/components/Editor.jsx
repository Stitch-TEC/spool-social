import React, { useState, useEffect, useMemo } from 'react';
import { 
  X, Save, Wand2, RefreshCw, Smartphone, Image as ImageIcon, 
  Trash2, UploadCloud, Calendar as CalendarIcon, Loader2
} from 'lucide-react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import PlatformIcon from './PlatformIcon';
import MobilePreview from './MobilePreview';
import CharCountCircle from './CharCountCircle'; // ✅ NEW
import { PLATFORMS, STATUS, DEFAULT_CLIENT_SETTINGS } from '../constants';
import { resolveImage, TRANSFORMATIONS, processImageFile } from '../utils/helpers'; // ✅ NEW

// NOTE: Calling Gemini directly from the browser exposes the API key in the client
// bundle (every VITE_* var is public). The "Fix Grammar" button is therefore only
// shown when a key is configured, and the call should be moved behind a server-side
// proxy (e.g. a Cloud Function) before enabling AI in production.
const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const AI_ENABLED = !!GEMINI_KEY && GEMINI_KEY !== 'your_gemini_api_key_here';
const genAI = AI_ENABLED ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// Static class strings so Tailwind's JIT can detect them (dynamic `border-${x}` is purged).
const PLATFORM_ACTIVE_CLASSES = {
  gmb: 'border-blue-500 bg-blue-50',
  linkedin: 'border-sky-500 bg-sky-50',
  twitter: 'border-slate-800 bg-slate-50',
  instagram: 'border-pink-500 bg-pink-50',
};

const Editor = ({ post, onSave, onCancel, mediaMap, clientMap, uniqueClients, showToast, onOpenSparkDeck, isReadOnly }) => {
  const allClients = useMemo(() => {
    const set = new Set([...(uniqueClients || []), ...Object.keys(clientMap || {})]);
    return [...set].sort();
  }, [uniqueClients, clientMap]);

  const [formData, setFormData] = useState({
    platform: 'gmb',
    content: '',
    client: '',
    imageUrl: '',
    scheduledDate: new Date().toISOString().slice(0, 16),
    status: STATUS.DRAFT,
    tags: []
  });
  const [previewMode, setPreviewMode] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

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
      // SAFE DATE CONVERSION FOR INPUT (Local Timezone Aware)
      const toLocalISOString = (date) => {
        const tzOffset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
      };

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

  const handleAI = async (mode) => {
    if (!formData.content) return showToast("Write some content first!", "error");
    setIsGenerating(true);
    try {
      if (mode === 'fix') {
        if (!genAI) return showToast("AI grammar fix isn't configured.", "error");
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(`Fix grammar and spelling, keep tone casual: "${formData.content}"`);
        setFormData(prev => ({ ...prev, content: result.response.text() }));
      } else {
        const transform = TRANSFORMATIONS[mode];
        if (transform) setFormData(prev => ({ ...prev, content: transform(formData.content) }));
      }
      showToast("Content polished! ✨");
    } catch (error) {
      console.error("AI Error:", error);
      showToast("AI Service unavailable.", "error");
    } finally {
      setIsGenerating(false);
    }
  };

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
             <h2 className="font-bold text-slate-800 text-lg">New Thread</h2>
          </div>
          <button
            onClick={handleSaveWrapper}
            disabled={isOverLimit || !formData.content || isReadOnly || isSaving}
            className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2 rounded-full font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg min-w-[100px] justify-center"
          >
             {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
             <span>{isSaving ? 'Saving...' : 'Save'}</span>
          </button>
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

          {/* Editor Area */}
          <div className="relative group">
            <div className="flex justify-between items-center mb-2">
               <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Content</label>
               <button onClick={onOpenSparkDeck} className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline"><Wand2 size={12}/> <span>Spark Deck</span></button>
            </div>
            <textarea 
               className={`w-full h-64 p-4 rounded-xl border-2 text-base leading-relaxed resize-none focus:ring-0 transition-all ${isOverLimit ? 'border-rose-300 focus:border-rose-500 bg-rose-50' : 'border-slate-200 focus:border-indigo-500 bg-white'}`}
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
            {/* ✅ RESTORED: Char Counter */}
            <div className="absolute bottom-16 right-4">
               <CharCountCircle current={wordCount} max={currentPlatform.maxChars} />
            </div>
            
            <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-3 pb-4 border-b border-slate-100">
               {AI_ENABLED && <button onClick={() => handleAI('fix')} disabled={isGenerating} className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 bg-indigo-50 text-indigo-700 text-[10px] sm:text-xs font-bold rounded-lg hover:bg-indigo-100 flex items-center gap-1.5 transition-colors"><Wand2 size={12}/>{isGenerating ? 'Fixing...' : 'Fix Grammar'}</button>}
               <button onClick={() => handleAI('punchy')} className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 bg-orange-50 text-orange-700 text-[10px] sm:text-xs font-bold rounded-lg hover:bg-orange-100 flex items-center gap-1.5"><Smartphone size={12}/>Punchy</button>
               <button onClick={() => handleAI('professional')} className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 bg-blue-50 text-blue-700 text-[10px] sm:text-xs font-bold rounded-lg hover:bg-blue-100 flex items-center gap-1.5"><RefreshCw size={12}/>Professional</button>
               <button onClick={() => handleAI('emojify')} className="px-2.5 py-1.5 sm:px-3 sm:py-1.5 bg-pink-50 text-pink-700 text-[10px] sm:text-xs font-bold rounded-lg hover:bg-pink-100 flex items-center gap-1.5"><Wand2 size={12}/>Emojify</button>
            </div>
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
                <img src={resolveImage(formData.imageUrl, mediaMap)} className="w-full h-48 object-cover" alt="Preview" />
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
         <div className="flex-1 flex items-center justify-center p-8 bg-slate-100/50 backdrop-blur-3xl">
            <MobilePreview
              post={{...formData, imageUrl: resolveImage(formData.imageUrl, mediaMap)}}
              clientSettings={clientMap[formData.client] || DEFAULT_CLIENT_SETTINGS}
            />
         </div>
      </div>
      
      {/* Mobile Toggle */}
      <button onClick={() => setPreviewMode(true)} title="Open Preview" aria-label="Open Preview" className="md:hidden fixed bottom-6 right-6 z-50 bg-slate-900 text-white p-4 rounded-full shadow-xl"><Smartphone size={24}/></button>
    </div>
  );
};

export default Editor;