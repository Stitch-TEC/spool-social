import React, { useState } from 'react';
import { X, AlertCircle, CheckCircle, ThumbsDown } from 'lucide-react';
import MobilePreview from './MobilePreview';
import { resolveImage } from '../utils/helpers';

const ReviewModal = ({ post, mediaMap, onApprove, onRequestChanges, onClose }) => {
  const [feedback, setFeedback] = useState('');
  const [mode, setMode] = useState('view');
  const [activeTags, setActiveTags] = useState([]);
  
  const displayImage = resolveImage(post.imageUrl, mediaMap);
  const feedbackTags = ["Fix Text", "Change Image", "Wrong Link", "Tone Issue"];

  const toggleTag = (tag) => {
    setActiveTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSubmit = () => {
    const finalFeedback = `${activeTags.join(', ')}${activeTags.length > 0 && feedback ? ' - ' : ''}${feedback}`;
    onRequestChanges(finalFeedback || "Changes requested");
  };
  
  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col md:flex-row overflow-hidden animate-in fade-in zoom-in">
        <div className="flex-1 bg-slate-100 p-8 flex items-center justify-center border-r border-slate-200">
             <MobilePreview post={{...post, imageUrl: displayImage}} />
        </div>
        <div className="flex-1 flex flex-col bg-white">
          <div className="p-6 border-b border-slate-100 flex justify-between items-start">
            <div>
              <h3 className="text-xl font-bold text-slate-800">Review Thread</h3>
              <p className="text-sm text-slate-500">Scheduled: {new Date(post.scheduledDate).toLocaleString()}</p>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full"><X size={20} className="text-slate-400" /></button>
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
                 {post.tags && (
                   <div className="flex gap-2">
                     {post.tags.map(t => <span key={t} className="px-2 py-1 bg-indigo-50 text-indigo-700 text-xs rounded-full font-medium">{t}</span>)}
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
                      <button key={tag} onClick={() => toggleTag(tag)} className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${activeTags.includes(tag) ? 'bg-rose-100 border-rose-200 text-rose-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                        {tag}
                      </button>
                    ))}
                 </div>
                 <textarea 
                    className="w-full h-32 p-4 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 resize-none"
                    placeholder="Add specific notes..."
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                 />
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