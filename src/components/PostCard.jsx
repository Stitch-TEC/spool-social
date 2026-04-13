import React, { memo, useState } from 'react';
import { 
  Clock, CheckCircle, AlertCircle, Layers, CopyPlus, 
  Edit3, Trash2, Copy, ExternalLink, Archive, ArchiveRestore
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import { PLATFORMS, STATUS, APPROVAL_STATUS } from '../constants';

const PostCard = memo(({ post, clientSettings = {}, resolvedImageUrl, onEdit, onDelete, onDuplicate, onCloneToAll, onStatusChange, onArchive, onRestore, isReadOnly }) => {
  const [copied, setCopied] = useState(false);
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isScheduled = post.status === STATUS.SCHEDULED;
  const isPosted = post.status === STATUS.POSTED;
  const isArchived = post.status === STATUS.ARCHIVED;
  const formattedDate = post.scheduledDate ? new Date(post.scheduledDate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No date set';
  
  const brandColor = clientSettings.brandColor || '#4338ca'; // indigo-700 default
  const copyToClipboard = (text) => { 
     // Simple clipboard copy
     navigator.clipboard.writeText(text);
     setCopied(true);
     setTimeout(() => setCopied(false), 2000);
  };

  const getStatusColor = () => { 
      if (post.approvalStatus === APPROVAL_STATUS.APPROVED) return 'border-l-4 border-l-emerald-500'; 
      if (post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) return 'border-l-4 border-l-rose-500'; 
      if (isPosted) return 'opacity-90'; 
      return ''; 
  };

  return (
    <div className={`group bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col ${getStatusColor()}`}>
      <div className={`h-1.5 w-full ${isPosted ? 'bg-indigo-500' : isScheduled ? 'bg-amber-400' : 'bg-slate-300'}`} />
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <div className="flex items-center gap-2">
            <PlatformIcon platformId={post.platform} size={28} />
            <div>
                <h4 className="font-semibold text-slate-800 text-sm">{platform.name}</h4>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 text-xs text-slate-400"><Clock size={10} /><span>{formattedDate}</span></div>
                    {post.client && <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-100 bg-slate-50 font-medium truncate max-w-[80px]" style={{ color: brandColor }}>{post.client}</span>}
                </div>
            </div>
          </div>
          
          {post.approvalStatus === APPROVAL_STATUS.APPROVED && <div className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded flex items-center gap-1"><CheckCircle size={12} /> Approved</div>}
          {post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED && <div className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded flex items-center gap-1"><AlertCircle size={12} /> Review</div>}

          {!isReadOnly && (
            <div className="flex gap-1 transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100">
              {isArchived ? (
                <button onClick={(e) => { e.stopPropagation(); onRestore(post.id); }} title="Restore Thread" aria-label="Restore Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><ArchiveRestore size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); onArchive(post.id); }} title="Archive Thread" aria-label="Archive Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-amber-600 rounded-md"><Archive size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              <button onClick={(e) => { e.stopPropagation(); onCloneToAll(post); }} title="Blast: Clone to All Platforms" aria-label="Blast: Clone to All Platforms" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><Layers size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onDuplicate(post); }} title="Clone Draft" aria-label="Clone Draft" className="p-2 sm:p-1.5 text-slate-400 hover:text-blue-600 rounded-md"><CopyPlus size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} title="Edit Thread" aria-label="Edit Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-emerald-700 rounded-md"><Edit3 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(post.id); }} title="Delete Thread" aria-label="Delete Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-rose-600 rounded-md"><Trash2 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
            </div>
          )}
        </div>

        {post.tags && post.tags.length > 0 && <div className="flex flex-wrap gap-1 mb-3">{post.tags.map((tag, i) => <span key={i} className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-100 text-slate-500 border border-slate-200">{tag}</span>)}</div>}
        {/* ⚡ OPTIMIZATION: Use native browser-level lazy loading for post images to reduce initial network and memory usage for off-screen items. */}
        <div className="mb-4 flex-1 cursor-pointer" onClick={() => onEdit(post)}>
          <p className="text-slate-600 text-sm line-clamp-3 leading-relaxed font-medium">{post.content || <span className="italic text-slate-300">Empty...</span>}</p>
          {resolvedImageUrl && <div className="mt-3 relative h-32 w-full bg-slate-50 rounded-lg overflow-hidden border border-slate-100"><img src={resolvedImageUrl} alt="Asset" className="w-full h-full object-cover" loading="lazy" /></div>}
        </div>
        
        {post.feedback && <div className="mb-4 p-2 bg-rose-50 rounded-lg border border-rose-100 text-xs text-rose-900 italic">"{post.feedback}"</div>}

        {!isReadOnly && (
          <div className="flex items-center justify-between pt-3 border-t border-slate-50 mt-auto">
            <button
              onClick={(e) => { e.stopPropagation(); copyToClipboard(post.content); }}
              className={`flex items-center gap-1.5 text-xs font-medium transition-colors active:scale-95 p-1 sm:p-0 ${copied ? 'text-emerald-600' : 'text-slate-500 hover:text-indigo-700'}`}
              title="Copy content to clipboard"
              aria-label="Copy content to clipboard"
            >
              {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
              <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            <a href={platform.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors p-1 sm:p-0"><ExternalLink size={14} /><span className="hidden sm:inline">Open App</span></a>
            <button onClick={(e) => { e.stopPropagation(); onStatusChange(post.id, isPosted ? STATUS.DRAFT : STATUS.POSTED); }} className={`flex items-center gap-1.5 text-xs font-bold px-3 py-2 sm:px-2.5 sm:py-1.5 rounded-full transition-colors ${isPosted ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{isPosted ? 'Posted' : 'Mark Done'}</button>
          </div>
        )}
      </div>
    </div>
  );
});

export default PostCard;