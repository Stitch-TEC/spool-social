import React, { useState } from 'react';
import { X, AlertCircle, CheckCircle, ThumbsDown } from 'lucide-react';
import MobilePreview from './MobilePreview';
import CharCountCircle from './CharCountCircle';
import { DATE_FORMATTERS } from '../utils/helpers';
import useEscapeKey from '../hooks/useEscapeKey';
import { publicationSlugOf } from '../utils/review';
import { reviewFeedbackState } from '../utils/reviewFeedback';

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
  const isArchived = post.status === 'archived';
  const publicationSlug = publicationSlugOf(post);
  const composedFeedback = reviewFeedbackState(activeTags, feedback);

  const toggleTag = (tag) => {
    setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSubmit = () => {
    if (!composedFeedback.valid) return;
    onRequestChanges(composedFeedback.text);
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
                Schedule (workflow only): {post.scheduledDate ? DATE_FORMATTERS.full.format(post.scheduledDate instanceof Date ? post.scheduledDate : new Date(post.scheduledDate)) : 'No date set'}
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
                 <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                   <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                     <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Title</dt>
                     <dd className="mt-1 text-slate-700 break-words">{post.title || 'Not set'}</dd>
                   </div>
                   <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                     <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Channel</dt>
                     <dd className="mt-1 text-slate-700 break-words">{post.platform || 'Not set'}</dd>
                   </div>
                   <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                     <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Image description</dt>
                     <dd className="mt-1 text-slate-700 break-words">{post.altText || 'Not set'}</dd>
                   </div>
                   <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                     <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">SEO description</dt>
                     <dd className="mt-1 text-slate-700 break-words">{post.metaDescription || 'Not set'}</dd>
                   </div>
                   <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 sm:col-span-2">
                     <dt className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Publication path</dt>
                     <dd className="mt-1 text-slate-700 break-all">
                       {['blog', 'job'].includes(post.platform) ? `/${publicationSlug || '(not set)'}` : 'Not used for this channel'}
                     </dd>
                   </div>
                 </dl>
                 {post.tags && post.tags.length > 0 && (
                   <div>
                     <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Internal tags — not part of approval</p>
                     <div className="flex flex-wrap gap-2">
                       {post.tags.map(t => <span key={t} className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs rounded-full font-medium">{t}</span>)}
                     </div>
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
                    <label htmlFor="review-feedback" className="sr-only">Specific feedback</label>
                    <textarea
                        id="review-feedback"
                        className={`w-full h-32 p-4 border rounded-xl text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 resize-none ${composedFeedback.overBy ? 'border-rose-500' : 'border-slate-200'}`}
                        placeholder="Add specific notes..."
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        aria-invalid={!composedFeedback.valid}
                        aria-describedby="review-feedback-status"
                    />
                    <div className="absolute bottom-3 right-3">
                        <CharCountCircle current={composedFeedback.length} max={500} />
                    </div>
                 </div>
                 <p
                   id="review-feedback-status"
                   role={composedFeedback.overBy ? 'alert' : 'status'}
                   aria-live="polite"
                   className={`text-xs ${composedFeedback.overBy ? 'font-semibold text-rose-700' : 'text-slate-500'}`}
                 >
                   {composedFeedback.overBy
                     ? `${composedFeedback.overBy} character${composedFeedback.overBy === 1 ? '' : 's'} over the 500-character limit.`
                     : !composedFeedback.hasText
                       ? 'Enter feedback or select a reason.'
                       : `${500 - composedFeedback.length} characters remaining.`}
                 </p>
               </div>
             )}
          </div>
          <div className="p-6 border-t border-slate-100 bg-slate-50/50">
            {isArchived && (
              <p className="mb-3 text-sm text-slate-600 text-center">This thread is archived and can’t be approved or sent back for changes.</p>
            )}
            {mode === 'view' ? (
              <div className="flex gap-4">
                <button disabled={isArchived} onClick={() => setMode('reject')} className="flex-1 py-3 bg-white border border-slate-200 text-slate-700 font-bold rounded-xl hover:bg-rose-50 hover:text-rose-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"><ThumbsDown size={18}/> Request Changes</button>
                <button disabled={isArchived} onClick={onApprove} className="flex-1 py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 disabled:opacity-50 disabled:cursor-not-allowed"><CheckCircle size={18}/> Approve Thread</button>
              </div>
            ) : (
              <div className="flex gap-4">
                <button onClick={() => setMode('view')} className="px-6 py-3 text-slate-500 font-medium hover:text-slate-700 transition-colors">Cancel</button>
                <button disabled={!composedFeedback.valid} onClick={handleSubmit} className="flex-1 py-3 bg-rose-600 text-white font-bold rounded-xl hover:bg-rose-700 transition-all shadow-lg shadow-rose-600/20 disabled:opacity-50 disabled:cursor-not-allowed">Submit Feedback</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReviewModal;
