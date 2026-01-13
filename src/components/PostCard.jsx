import React from 'react';
import { 
  Clock, CheckCircle, AlertCircle, Layers, CopyPlus, 
  Edit3, Trash2, Copy, ExternalLink 
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import { PLATFORMS, STATUS, APPROVAL_STATUS } from '../constants';
import { resolveImage } from '../utils/helpers';

const PostCard = ({ post, mediaMap, onEdit, onDelete, onDuplicate, onCloneToAll, onStatusChange, isReadOnly, onClick }) => {
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isScheduled = post.status === STATUS.SCHEDULED;
  const isPosted = post.status === STATUS.POSTED;
  const formattedDate = post.scheduledDate ? new Date(post.scheduledDate).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No date set';
  const displayImage = resolveImage(post.imageUrl, mediaMap);
  
  const copyToClipboard = (text) => { 
     // Simple clipboard copy
     navigator.clipboard.writeText(text);
  };

  const getStatusColor = () => { 
      if (post.approvalStatus === APPROVAL_STATUS.APPROVED) return 'border-l-4 border-l-emerald-500'; 
      if (post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED) return 'border-l-4 border-l-rose-500'; 
      if (isPosted) return 'opacity-90'; 
      return ''; 
  };

  return (
    <div onClick={onClick} className={`group bg-white border border-slate-100 rounded-xl shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col cursor-pointer ${getStatusColor()}`}>
      <div className={`h-1.5 w-full ${isPosted ? 'bg-indigo-500' : isScheduled ? 'bg-amber-400' : 'bg-slate-300'}`} />
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex justify-between items-start mb-3">
          <div className="flex items-center gap-2">
            <PlatformIcon platformId={post.platform} size={28} />
            <div>
                <h4 className="font-semibold text-slate-800 text-sm">{platform.name}</h4>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 text-xs text-slate-400"><Clock size={10} /><span>{formattedDate}</span></div>
                    {post.client && <span className="text-[10px] bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded border border-indigo-100 font-medium truncate max-w-[80px]">{post.client}</span>}
                </div>
            </div>
          </div>
          
          {post.approvalStatus === APPROVAL_STATUS.APPROVED && <div className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded flex items-center gap-1"><CheckCircle size={12} /> Approved</div>}
          {post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED && <div className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded flex items-center gap-1"><AlertCircle size={12} /> Review</div>}

          {!isReadOnly && (
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={(e) => { e.stopPropagation(); onCloneToAll(post); }} title="Blast: Clone to All Platforms" className="p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><Layers size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); onDuplicate(post); }} title="Clone Draft" className="p-1.5 text-slate-400 hover:text-blue-600 rounded-md"><CopyPlus size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} className="p-1.5 text-slate-400 hover:text-emerald-700 rounded-md"><Edit3 size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(post.id); }} className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md"><Trash2 size={14} /></button>
            </div>
          )}
        </div>

        {post.tags && post.tags.length > 0 && <div className="flex flex-wrap gap-1 mb-3">{post.tags.map((tag, i) => <span key={i} className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-100 text-slate-500 border border-slate-200">{tag}</span>)}</div>}
        <div className="mb-4 flex-1"><p className="text-slate-600 text-sm line-clamp-3 leading-relaxed font-medium">{post.content || <span className="italic text-slate-300">Empty...</span>}</p>{displayImage && <div className="mt-3 relative h-32 w-full bg-slate-50 rounded-lg overflow-hidden border border-slate-100"><img src={displayImage} alt="Asset" className="w-full h-full object-cover" /></div>}</div>
        
        {post.feedback && <div className="mb-4 p-2 bg-rose-50 rounded-lg border border-rose-100 text-xs text-rose-900 italic">"{post.feedback}"</div>}

        {!isReadOnly && (
          <div className="flex items-center justify-between pt-3 border-t border-slate-50 mt-auto">
            <button onClick={(e) => { e.stopPropagation(); copyToClipboard(post.content); }} className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-indigo-700 transition-colors active:scale-95"><Copy size={12} /><span>Copy</span></button>
            <a href={platform.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors"><ExternalLink size={12} /><span>Open App</span></a>
            <button onClick={(e) => { e.stopPropagation(); onStatusChange(post.id, isPosted ? STATUS.DRAFT : STATUS.POSTED); }} className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-full transition-colors ${isPosted ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{isPosted ? 'Posted' : 'Mark Done'}</button>
          </div>
        )}
      </div>
    </div>
  );
};

export default PostCard;