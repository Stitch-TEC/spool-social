import React from 'react';
import { MapPin, MoreHorizontal } from 'lucide-react';
import { PLATFORMS } from '../constants';

const MobilePreview = ({ post }) => {
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const content = post.content || "No content yet...";

  const Wrapper = ({ children }) => (
    <div className="w-[300px] bg-white rounded-[2rem] border-[6px] border-slate-800 shadow-2xl overflow-hidden relative h-[600px] flex flex-col">
       <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-slate-800 rounded-b-xl z-10" />
       <div className="flex-1 overflow-y-auto pt-8 scrollbar-hide">
         {children}
       </div>
    </div>
  );

  // 1. Twitter / X Layout
  if (post.platform === 'twitter') {
    return (
      <Wrapper>
        <div className="px-4 pb-4 font-sans">
           <div className="flex gap-3">
             <div className="w-10 h-10 rounded-full bg-slate-200 shrink-0" />
             <div className="flex-1">
                <div className="flex items-center gap-1">
                   <span className="font-bold text-slate-900 text-sm">You</span> 
                   <span className="text-slate-500 text-sm">@handle · 1m</span>
                </div>
                <p className="text-slate-900 text-sm mt-1 whitespace-pre-wrap leading-normal">{content}</p>
                {post.imageUrl && <div className="mt-3 rounded-2xl overflow-hidden border border-slate-100"><img src={post.imageUrl} className="w-full h-auto object-cover" /></div>}
             </div>
           </div>
        </div>
      </Wrapper>
    );
  }

  // 2. Instagram Layout
  if (post.platform === 'instagram') {
    return (
      <Wrapper>
        <div className="font-sans text-sm pb-4">
           <div className="flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                 <div className="w-8 h-8 rounded-full bg-slate-200" />
                 <span className="font-semibold text-xs text-slate-900">your_username</span>
              </div>
              <MoreHorizontal size={16} />
           </div>
           <div className="bg-slate-100 w-full aspect-square flex items-center justify-center overflow-hidden">
              {post.imageUrl ? <img src={post.imageUrl} className="w-full h-full object-cover" /> : <span className="text-slate-400 text-xs">No Image</span>}
           </div>
           <div className="p-3">
              <p className="text-slate-900 text-xs"><span className="font-semibold mr-2">your_username</span>{content}</p>
           </div>
        </div>
      </Wrapper>
    );
  }

  // 3. LinkedIn Layout
  if (post.platform === 'linkedin') {
    return (
      <Wrapper>
        <div className="bg-white font-sans text-sm pb-4 border-b border-slate-200 mb-4">
           <div className="flex gap-2 p-3">
              <div className="w-10 h-10 rounded bg-slate-200" />
              <div>
                 <div className="font-semibold text-xs text-slate-900">Your Name</div>
                 <div className="text-[10px] text-slate-500">Title • 1st</div>
              </div>
           </div>
           <div className="px-3 pb-2 text-xs text-slate-900 whitespace-pre-wrap">{content}</div>
           {post.imageUrl && <img src={post.imageUrl} className="w-full h-auto object-cover" />}
        </div>
      </Wrapper>
    );
  }

  // Default / GMB Layout
  return (
    <Wrapper>
       <div className="px-4 pb-4 font-sans">
          <div className="flex items-center gap-3 mb-4">
             <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white"><MapPin size={20} /></div>
             <div>
                <div className="font-bold text-slate-900 text-sm">Your Business</div>
                <div className="text-xs text-slate-500">Posted on Google</div>
             </div>
          </div>
          {post.imageUrl && <div className="rounded-lg overflow-hidden mb-3"><img src={post.imageUrl} className="w-full h-40 object-cover" /></div>}
          <p className="text-slate-800 text-sm mb-4 whitespace-pre-wrap">{content}</p>
          <button className="w-full py-2 bg-slate-100 text-blue-700 font-medium rounded-full text-xs">Learn More</button>
       </div>
    </Wrapper>
  );
};

export default MobilePreview;