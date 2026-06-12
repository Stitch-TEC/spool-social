import React from 'react';
import { Grid } from 'lucide-react';
import PostCard from './PostCard';
import { DEFAULT_CLIENT_SETTINGS } from '../constants';

const PostGrid = ({
  posts,
  clientMap,
  isReadOnly,
  onEdit,
  onCloneToAll,
  onDuplicate,
  onDelete,
  onStatusChange,
  onArchive,
  onRestore,
  onCreate
}) => {
  if (posts.length === 0) {
    return (
      <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
        <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4"><Grid className="text-slate-300" /></div>
        <h3 className="text-slate-900 font-bold text-lg">No threads found</h3>
        {!isReadOnly && <button onClick={onCreate} className="text-indigo-600 font-bold hover:underline">Create Thread</button>}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
      {posts.map(p => (
        <PostCard
          key={p.id}
          post={p}
          clientSettings={clientMap[p.client] || DEFAULT_CLIENT_SETTINGS}
          isReadOnly={isReadOnly}
          onEdit={onEdit}
          onCloneToAll={onCloneToAll}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onStatusChange={onStatusChange}
          onArchive={onArchive}
          onRestore={onRestore}
        />
      ))}
    </div>
  );
};

export default PostGrid;
