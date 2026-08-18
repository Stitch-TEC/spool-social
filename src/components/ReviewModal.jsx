import React, { useState } from 'react';
import { X, AlertCircle, CheckCircle, ThumbsDown } from 'lucide-react';
import MobilePreview from './MobilePreview';
import CharCountCircle from './CharCountCircle';
import { DATE_FORMATTERS } from '../utils/helpers';
import useEscapeKey from '../hooks/useEscapeKey';

const fmtDate = (iso) => {
  try { return DATE_FORMATTERS.full.format(new Date(iso)); } catch { return ''; }
};

// `by` is stored from the AUTHOR's point of view ('you' = the agency, 'client' =
// the reviewer) — the worker's PATCH path writes the same two values. Rendering it
// literally meant the CLIENT saw our internal notes labelled "You", i.e. attributed
// to themselves. Labels are resolved against the VIEWER instead.
const attribution = (by, viewerIsClient) =>
  by === 'client'
    ? (viewerIsClient ? 'You' : 'Client')
    : (viewerIsClient ? 'Your team' : 'You');

const ReviewModal = ({ post, clientSettings = {}, onApprove, onRequestChanges, onClose, viewerIsClient = true }) => {
  const [feedback, setFeedback] = useState('');
  const [mode, setMode] = useState('view');
  const [activeTags, setActiveTags] = useState([]);
  useEscapeKey(onClose);

  // Prior review rounds (newest last). Falls back to the legacy single `feedback`
  // field for posts created before threaded history existed.
  const feedbackHistory = Array.isArray(post.feedbackThread) && post.feedbackThread.length > 0
    ? post.feedbackThread
    : (post.feedback ? [{ text: post.feedback, by: 'client' }] : []);

  const feedbackTags = ["Fix Text", "Change Image", "Wrong Link", "Tone Issue"];

  const toggleTag = (tag) => {
    setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSubmit = () => {
    const finalFeedback = `${activeTags.join(', ')}${activeTags.length > 0 && feedback ? ' - ' : ''}${feedback}`;
    onRequestChanges(finalFeedback || "Changes requested");
  };
  
  return (
    <div role="dialog" aria-modal="true" aria-label="Review Thread" className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[95vh] sm:h-[90vh] flex flex-col md:flex-row overflow-hidden animate-in fade-in zoom-in">
        <div className="flex-1 bg-slate-100 p-4 sm:p-8 flex items-center justify-center border-b md:border-b-0 md:border-r border-slate-200 overflow-y-auto">
             <div className="scale-75 sm:scale-90 md:scale-100 origin-center">
                <MobilePreview post={post} clientSettings={clientSettings} />
             </div>
        </div>
        <div className="flex-1 flex flex-col bg-white">
          <div className="p-6 border-b border-slate-100 flex justify-between items-start">
            <div>
              <h3 className="text-xl font-bold text-slate-800">Review Thread</h3>
              {/* ⚡ OPTIMIZATION: Use pre-compiled Intl.DateTimeFormat for faster formatting. */}
              <p className="text-sm text-slate-500">
                Scheduled: {post.scheduledDate ? DATE_FORMATTERS.full.format(post.scheduledDate instanceof Date ? post.scheduledDate : new Date(post.scheduledDate)) : 'No date set'}
              </p>
            </div>
            <button onClick={onClose} title="Close Review" aria-label="Close Review" className="p-2 hover:bg-slate-100 rounded-full"><X size={20} className="text-slate-400" /></button>
          </div>

          <div className="p-6 flex-1 overflow-y-auto">
             {mode === 'view' ? (
               <div className="space-y-6">
                 <div>
                   <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Content</label>
                   <div className="p-4 bg-slate-50 rounded-xl text-slate-700 text-sm whitespace-pre-wrap leading-relaxed border border-slate-100">
                     {post.content}
                   </div>
                 </div>
                 {post.tags && post.tags.length > 0 && (
                   <div className="flex flex-wrap gap-2">
                     {post.tags.map(t => <span key={t} className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs rounded-full font-medium">{t}</span>)}
                   </div>
                 )}
                 {feedbackHistory.length > 0 && (
                   <div>
                     <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Feedback history</label>
                     <div className="space-y-2">
                       {feedbackHistory.map((f, i) => (
                         <div key={i} className="p-3 bg-rose-50/60 rounded-xl border border-rose-100">
                           <div className="flex items-center justify-between mb-1">
                             <span className="text-[11px] font-bold uppercase tracking-wider text-rose-600">{attribution(f.by, viewerIsClient)}</span>
                             {f.at && <span className="text-[11px] text-slate-400">{fmtDate(f.at)}</span>}
                           </div>
                           <p className="text-sm text-slate-700 whitespace-pre-wrap">{f.text}</p>
                         </div>
                       ))}
                     </div>
                   </div>
                 )}
               </div>
             ) : (
               <div className="space-y-4 animate-in slide-in-from-right-4 duration-200">
                 <div className="flex items-center gap-2 text-rose-600 font-bold">
                    <AlertCircle size={20} />
                    <h3>Request Changes</h3>
                 </div>
                 <div className="flex flex-wrap gap-2">
                    {feedbackTags.map(tag => (
                      <button
                        key={tag}
                        onClick={() => toggleTag(tag)}
                        aria-pressed={activeTags.includes(tag)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${activeTags.includes(tag) ? 'bg-rose-100 border-rose-200 text-rose-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}
                      >
                        {tag}
                      </button>
                    ))}
                 </div>
                 <div className="relative">
                    <textarea
                        className="w-full h-32 p-4 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 resize-none"
                        placeholder="Add specific notes..."
                        maxLength={500}
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                    />
                    <div className="absolute bottom-3 right-3">
                        <CharCountCircle current={feedback.length} max={500} />
                    </div>
                 </div>
               </div>
             )}
          </div>
          <div className="p-6 border-t border-slate-100 bg-slate-50/50">
            {mode === 'view' ? (
              <div className="flex gap-4">
                <button onClick={() => setMode('reject')} className="flex-1 py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-xl hover:bg-rose-50 hover:text-rose-700 transition-all flex items-center justify-center gap-2"><ThumbsDown size={18}/> Request Changes</button>
                <button onClick={onApprove} className="flex-1 py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"><CheckCircle size={18}/> Approve Thread</button>
              </div>
            ) : (
              <div className="flex gap-4">
                <button onClick={() => setMode('view')} className="px-6 py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors">Cancel</button>
                <button onClick={handleSubmit} className="flex-1 py-3 bg-rose-600 text-white font-bold rounded-xl hover:bg-rose-700 transition-all shadow-lg shadow-rose-600/20">Submit Feedback</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReviewModal;