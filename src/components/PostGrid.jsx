import React, { memo, useState, useEffect, useRef, useMemo } from 'react';
import { Grid, Loader2 } from 'lucide-react';
import PostCard from './PostCard';
import { DEFAULT_CLIENT_SETTINGS } from '../constants';

// How many cards mount at once, and how many more arrive as you approach the end.
// A card is not cheap — platform icon, formatted date, readiness chips, a lazy
// <img> — and this grid routinely holds several hundred posts (one seeded client
// alone has 400). Mounting all of them blocked the main thread for seconds on
// every filter change; the window makes that cost proportional to what's on screen.
const PAGE_SIZE = 48;

/**
 * Incremental window over a long post list.
 *
 * Deliberately NOT fixed-height virtualization: the grid is responsive (1/2/3
 * columns) and cards have genuinely variable heights (image or not, title or not,
 * feedback or not), so a virtualizer would need per-item measurement to avoid
 * scroll-jump. Growing the mounted set as a sentinel nears the viewport keeps the
 * browser's own layout authoritative — no measurement, no jump, no dependency.
 *
 * Returns the whole list untouched when IntersectionObserver is unavailable
 * (jsdom, ancient browsers), so behaviour degrades to "render everything" rather
 * than "render 48 and never grow".
 */
function useWindowedList(posts, resetKey) {
  const supported = typeof IntersectionObserver !== 'undefined';
  const initial = supported ? PAGE_SIZE : Infinity;
  // The window is stored WITH the context it belongs to. Collapsing it in an effect
  // instead would paint one frame of the previous window against the new filter —
  // i.e. mount 400 cards and then throw them away, the exact cost this avoids.
  // Adjusting state during render is React's sanctioned pattern for "reset when a
  // prop changes"; React re-runs this component immediately, before painting.
  const [win, setWin] = useState({ key: resetKey, limit: initial });
  if (win.key !== resetKey) setWin({ key: resetKey, limit: initial });
  // This render still holds the stale value, so read through the correction.
  const limit = win.key === resetKey ? win.limit : initial;

  const sentinelRef = useRef(null);

  useEffect(() => {
    if (!supported || limit >= posts.length) return undefined;
    const el = sentinelRef.current;
    if (!el) return undefined;
    // rootMargin buys a screen of runway, so the next batch is already mounted by
    // the time the operator scrolls to it.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setWin((w) => ({ ...w, limit: Math.min(w.limit + PAGE_SIZE, posts.length) }));
        }
      },
      { rootMargin: '800px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [supported, limit, posts.length]);

  const visible = useMemo(
    () => (limit >= posts.length ? posts : posts.slice(0, limit)),
    [posts, limit]
  );

  return {
    visible,
    sentinelRef,
    hasMore: limit < posts.length,
    showAll: () => setWin((w) => ({ ...w, limit: Infinity })),
  };
}

// Memoized: App re-renders on every keystroke, toast, selection change and clock
// tick, and without this each one walked the entire card list again — the urgent
// half of every search keystroke was re-rendering hundreds of subtrees whose props
// hadn't moved. Every handler App passes is a stable useCallback, and `resetKey`
// is compared by value, so the memo genuinely bails.
const PostGrid = memo(({
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
  onCreate,
  onUseTemplate,
  onResubmit,
  onSendForReview,
  onHoldFromReview,
  onPromoteSuggestion,
  onDismissSuggestion,
  onPushToSender,
  onPublishToSite,
  isSuggestionLane = false,
  showProvenance = false,
  selectable = false,
  selectedIds,
  onToggleSelect,
  // Identifies the current filter/lane/sort context. Changing it collapses the
  // window back to the first page (see useWindowedList).
  resetKey = '',
}) => {
  const { visible, sentinelRef, hasMore, showAll } = useWindowedList(posts, resetKey);

  if (posts.length === 0) {
    const isTemplates = !!onUseTemplate;
    // The Suggestions lane's emptiness means "automations haven't parked options yet" — a
    // "Create Thread" CTA here would be a lie (hand-made posts are never suggestions).
    if (isSuggestionLane) {
      return (
        <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
          <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4"><Grid className="text-slate-300" /></div>
          <h3 className="text-slate-900 font-bold text-lg">No suggestions waiting</h3>
          <p className="text-slate-400 text-sm mt-1">Automations set to “Suggest options” park drafts here for you to pick from — check Automations to set one up.</p>
        </div>
      );
    }
    return (
      <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
        <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4"><Grid className="text-slate-300" /></div>
        <h3 className="text-slate-900 font-bold text-lg">{isTemplates ? 'No templates yet' : 'No threads found'}</h3>
        {isTemplates
          ? <p className="text-slate-400 text-sm mt-1">Turn any post into one with the “Reusable template” toggle in the editor.</p>
          : (!isReadOnly && <button onClick={onCreate} className="text-indigo-600 font-bold hover:underline">Create Thread</button>)}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {visible.map(p => (
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
            onUseTemplate={onUseTemplate}
            onResubmit={onResubmit}
            onSendForReview={onSendForReview}
            onHoldFromReview={onHoldFromReview}
            onPromoteSuggestion={onPromoteSuggestion}
            onDismissSuggestion={onDismissSuggestion}
            onPushToSender={onPushToSender}
            onPublishToSite={onPublishToSite}
            showProvenance={showProvenance}
            selectable={selectable}
            selected={selectable && selectedIds?.has(p.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </div>

      {/* The window is never silent about itself: the count is always visible, and
          "Show all" is there for anyone who wants to Ctrl-F the whole page. */}
      {hasMore && (
        <div ref={sentinelRef} className="flex flex-col items-center gap-2 py-8 text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-400" aria-hidden="true" />
          <span className="tabular-nums">Showing {visible.length} of {posts.length}</span>
          <button onClick={showAll} className="text-xs font-bold text-indigo-600 hover:underline">
            Show all {posts.length}
          </button>
        </div>
      )}
    </>
  );
});

export default PostGrid;
