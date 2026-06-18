import React, { memo, useState, useCallback, useMemo } from 'react';
import {
  Clock, CheckCircle, AlertCircle, Layers, CopyPlus,
  Edit3, Trash2, Copy, ExternalLink, Archive, ArchiveRestore, Check
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import { PLATFORMS, STATUS, APPROVAL_STATUS } from '../constants';
import { DATE_FORMATTERS } from '../utils/helpers';

const PostCard = memo(({ post, clientSettings = {}, onEdit, onDelete, onDuplicate, onCloneToAll, onStatusChange, onArchive, onRestore, isReadOnly, selectable = false, selected = false, onToggleSelect }) => {
  const [copied, setCopied] = useState(false);
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isScheduled = post.status === STATUS.SCHEDULED;
  const isPosted = post.status === STATUS.POSTED;
  const isArchived = post.status === STATUS.ARCHIVED;

  // ⚡ OPTIMIZATION: Use pre-compiled Intl.DateTimeFormat and memoize the result.
  // This avoids redundant formatting work on every render, leveraging referentially
  // stable Date objects from the parent's optimized data listener.
  const formattedDate = useMemo(() => {
    return post.scheduledDate ? DATE_FORMATTERS.short.format(post.scheduledDate) : 'No date set';
  }, [post.scheduledDate]);
  
  const brandColor = clientSettings.brandColor || '#4338ca'; // indigo-700 default

  // ⚡ OPTIMIZATION: Memoize clipboard handler to prevent unnecessary re-renders of the button.
  const copyToClipboard = useCallback((text) => {
     navigator.clipboard.writeText(text).then(() => {
       setCopied(true);
       setTimeout(() => setCopied(false), 2000);
     }).catch(() => {
       // Clipboard unavailable (insecure context / permissions) — fail quietly.
     });
  }, []);

  const getStatusColor = () => { 
      if (post.approvalStatus === APPROVAL_STATUS.APPROVED) return 'border-l-4 border-l-emerald-500'; 
      if (post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) return 'border-l-4 border-l-rose-500'; 
      if (isPosted) return 'opacity-90'; 
      return ''; 
  };

  const toggle = () => onToggleSelect?.(post.id);

  return (
    <div
      onClick={selectable ? toggle : undefined}
      className={`group relative bg-white border rounded-xl shadow-sm transition-all overflow-hidden flex flex-col ${getStatusColor()} ${
        selectable
          ? `cursor-pointer ${selected ? 'border-indigo-500 ring-2 ring-indigo-500/40' : 'border-slate-200 hover:border-indigo-300'}`
          : 'border-slate-100 hover:shadow-md'
      }`}
    >
      {selectable && (
        <div className={`absolute top-3 left-3 z-10 w-6 h-6 rounded-md flex items-center justify-center border-2 transition-colors ${selected ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white/90 border-slate-300'}`}>
          {selected && <Check size={15} strokeWidth={3} />}
        </div>
      )}
      <div className={`h-1.5 w-full ${isPosted ? 'bg-indigo-500' : isScheduled ? 'bg-amber-400' : 'bg-slate-300'}`} />
      <div className="p-5 flex-1 flex flex-col">
        <div className={`flex justify-between items-start mb-3 ${selectable ? 'pl-7' : ''}`}>
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

          {!isReadOnly && !selectable && (
            <div className="flex gap-1 transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100">
              {isArchived ? (
                <button onClick={(e) => { e.stopPropagation(); onRestore(post.id); }} title="Restore Thread" aria-label="Restore Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><ArchiveRestore size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); onArchive(post.id); }} title="Archive Thread" aria-label="Archive Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-amber-600 rounded-md"><Archive size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              <button onClick={(e) => { e.stopPropagation(); onCloneToAll(post); }} title="Blast: Clone to All Clients" aria-label="Blast: Clone to All Clients" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><Layers size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onDuplicate(post); }} title="Clone Draft" aria-label="Clone Draft" className="p-2 sm:p-1.5 text-slate-400 hover:text-blue-600 rounded-md"><CopyPlus size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} title="Edit Thread" aria-label="Edit Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-emerald-700 rounded-md"><Edit3 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(post.id); }} title="Delete Thread" aria-label="Delete Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-rose-600 rounded-md"><Trash2 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
            </div>
          )}
        </div>

        {post.tags && post.tags.length > 0 && <div className="flex flex-wrap gap-1 mb-3">{post.tags.map((tag, i) => <span key={i} className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-100 text-slate-500 border border-slate-200">{tag}</span>)}</div>}
        {/* ⚡ OPTIMIZATION: Use native browser-level lazy loading for post images to reduce initial network and memory usage for off-screen items. */}
        <div className={`mb-4 flex-1 ${selectable ? '' : 'cursor-pointer'}`} onClick={selectable ? undefined : () => onEdit(post)}>
          {post.title && <h5 className="font-bold text-slate-800 text-sm mb-1 line-clamp-1">{post.title}</h5>}
          <p className="text-slate-600 text-sm line-clamp-3 leading-relaxed font-medium">{post.content || <span className="italic text-slate-300">Empty...</span>}</p>
          {post.imageUrl && <div className="mt-3 relative h-32 w-full bg-slate-50 rounded-lg overflow-hidden border border-slate-100"><img src={post.imageUrl} alt={post.altText || 'Asset'} className="w-full h-full object-cover" loading="lazy" /></div>}
        </div>
        
        {post.feedback && <div className="mb-4 p-2 bg-rose-50 rounded-lg border border-rose-100 text-xs text-rose-900 italic">"{post.feedback}"</div>}

        {!isReadOnly && !selectable && (
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
            <a href={platform.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open platform app" aria-label="Open platform app" className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors p-1 sm:p-0"><ExternalLink size={14} /><span className="hidden sm:inline">Open App</span></a>
            <button onClick={(e) => { e.stopPropagation(); onStatusChange(post.id, isPosted ? STATUS.DRAFT : STATUS.POSTED); }} className={`flex items-center gap-1.5 text-xs font-bold px-3 py-2 sm:px-2.5 sm:py-1.5 rounded-full transition-colors ${isPosted ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{isPosted ? 'Posted' : 'Mark Done'}</button>
          </div>
        )}
      </div>
    </div>
  );
});

export default PostCard;