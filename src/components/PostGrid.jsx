import React, { memo, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Grid, Loader2, ArrowUp } from 'lucide-react';
import PostCard from './PostCard';
import PostRow from './PostRow';
import { DEFAULT_CLIENT_SETTINGS, DENSITY, DENSITY_VALUES } from '../constants';
import { buildGroups, visibleGroups } from '../utils/grouping';

// How many posts mount at once, and how many more arrive as you approach the end.
// A CARD is not cheap — platform icon, formatted date, readiness chips, a lazy
// <img> — and this grid routinely holds several hundred posts (one seeded client
// alone has 400). Mounting all of them blocked the main thread for seconds on
// every filter change; the window makes that cost proportional to what's on screen.
//
// The denser modes render strictly less per post, so they can afford a bigger page:
// a list row is a single flex line with no feedback trail and no chip wrapping, and
// with only ~48px each you'd otherwise hit the sentinel again before the scroll
// settled. These are tuned to "roughly three screens of runway" in each mode.
const PAGE_SIZE = {
  [DENSITY.CARDS]: 48,
  [DENSITY.COMPACT]: 72,
  [DENSITY.LIST]: 150,
};

// Column counts per density. Every breakpoint up to `xl` is exactly what CARDS did
// before; the wide steps are new. They're derived from card WIDTH, not from a wish
// for more columns: with the 256px sidebar and the page's `lg:p-8`, a 1600px window
// leaves ~1290px of content, so four columns there are ~305px wide — the same width
// a card already has at the xl breakpoint. The screenshot that prompted this was
// 1614px, spending that room on three ~390px columns instead.
const GRID_CLASS = {
  [DENSITY.CARDS]: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4 gap-6',
  // Compact cards need ~290px (56px thumbnail + two lines of copy), so its columns
  // step up one breakpoint later than the raw count difference suggests.
  [DENSITY.COMPACT]: 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 4xl:grid-cols-5 gap-4',
};

// The list is one bordered surface with hairline separators rather than N floating
// cards: at 48px per post, per-card shadows and gaps read as visual noise and cost
// another third of the height they were meant to organise.
const LIST_CLASS = 'bg-white border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100';

/**
 * Incremental window over a long post list.
 *
 * Deliberately NOT fixed-height virtualization: the grid is responsive (1/2/3/4/5
 * columns) and cards have genuinely variable heights (image or not, title or not,
 * feedback or not), so a virtualizer would need per-item measurement to avoid
 * scroll-jump. Growing the mounted set as a sentinel nears the viewport keeps the
 * browser's own layout authoritative — no measurement, no jump, no dependency.
 *
 * Returns the whole list untouched when IntersectionObserver is unavailable
 * (jsdom, ancient browsers), so behaviour degrades to "render everything" rather
 * than "render 48 and never grow".
 */
function useWindowedList(posts, resetKey, pageSize) {
  const supported = typeof IntersectionObserver !== 'undefined';
  const initial = supported ? pageSize : Infinity;
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
          setWin((w) => ({ ...w, limit: Math.min(w.limit + pageSize, posts.length) }));
        }
      },
      { rootMargin: '800px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [supported, limit, posts.length, pageSize]);

  const count = Math.min(limit, posts.length);
  const visible = useMemo(
    () => (limit >= posts.length ? posts : posts.slice(0, limit)),
    [posts, limit]
  );

  return {
    visible,
    count,
    sentinelRef,
    hasMore: limit < posts.length,
    showAll: () => setWin((w) => ({ ...w, limit: Infinity })),
  };
}

/**
 * "Back to top" for a feed that can be hundreds of posts long. Appears once you're
 * a couple of screens down — the toolbar is at the top of the page and there is no
 * other way back to it but a long flick.
 *
 * Hidden below `sm`: the bulk-action bar owns the bottom edge on narrow screens,
 * and mobile browsers already have a scroll-to-top gesture of their own.
 */
const BackToTop = () => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 1400);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="Back to top"
      aria-label="Back to top"
      className="hidden sm:flex fixed bottom-5 right-5 z-30 items-center gap-1.5 bg-white/95 backdrop-blur-sm border border-slate-200 text-slate-600 hover:text-indigo-600 hover:border-indigo-300 shadow-lg rounded-full pl-3 pr-3.5 py-2 text-xs font-bold transition-colors"
    >
      <ArrowUp size={14} /> Top
    </button>
  );
};

/**
 * A run heading — "August 2026 · 34" — sticky under the app header so you always
 * know which month/client/platform you are looking at, however far down you are.
 * `top-16` is the app header's height; the page itself is the scroll container.
 */
const GroupHeading = ({ label, hint, count }) => (
  <h3 className="sticky top-16 z-10 flex items-center gap-2 mb-3 py-2 bg-slate-50/90 backdrop-blur-sm border-b border-slate-200">
    <span className="text-xs font-bold uppercase tracking-wider text-slate-500 truncate">{label}</span>
    <span className="text-[10px] font-bold text-slate-500 bg-slate-200/70 rounded-full px-1.5 py-0.5 tabular-nums shrink-0">{count}</span>
    {hint && <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 shrink-0">{hint}</span>}
  </h3>
);

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
  // How much of each post to show — see constants.DENSITY.
  density = DENSITY.CARDS,
  // The active sort order. Only used to derive the group headings, which have to
  // follow the ordering or their runs wouldn't be contiguous (utils/grouping.js).
  sortBy = null,
  // Identifies the current filter/lane/sort context. Changing it collapses the
  // window back to the first page (see useWindowedList).
  resetKey = '',
}) => {
  // A review guest stays on cards no matter what. Their surface is for READING the
  // copy before they approve it, and a one-line row invites approving something you
  // only skimmed — so the density control is operator/member-only (App) and pinned
  // here too, which is also why PostRow never has to reason about a read-only viewer.
  const mode = !isReadOnly && DENSITY_VALUES.includes(density) ? density : DENSITY.CARDS;
  const isList = mode === DENSITY.LIST;

  const { visible, count, sentinelRef, hasMore, showAll } = useWindowedList(posts, resetKey, PAGE_SIZE[mode]);

  // Runs over the FULL filtered list (not the window), so a heading's count is the
  // truth about what sits under it even when only part of it is mounted. null when
  // grouping wouldn't help — short lists and sorts with no natural runs render flat.
  const groups = useMemo(() => buildGroups(posts, sortBy), [posts, sortBy]);
  const shownGroups = useMemo(() => visibleGroups(groups, count), [groups, count]);

  const renderPost = useCallback((p) => {
    const shared = {
      post: p,
      onEdit,
      onDelete,
      onStatusChange,
      onArchive,
      onRestore,
      onUseTemplate,
      onResubmit,
      onSendForReview,
      onPromoteSuggestion,
      onDismissSuggestion,
      showProvenance,
      selectable,
      selected: selectable && selectedIds?.has(p.id),
      onToggleSelect,
      clientSettings: clientMap[p.client] || DEFAULT_CLIENT_SETTINGS,
    };
    return isList ? (
      <PostRow key={p.id} {...shared} />
    ) : (
      <PostCard
        key={p.id}
        {...shared}
        isReadOnly={isReadOnly}
        onCloneToAll={onCloneToAll}
        onDuplicate={onDuplicate}
        onHoldFromReview={onHoldFromReview}
        onPushToSender={onPushToSender}
        onPublishToSite={onPublishToSite}
        density={mode}
      />
    );
  }, [
    isList, mode, clientMap, isReadOnly, onEdit, onCloneToAll, onDuplicate, onDelete,
    onStatusChange, onArchive, onRestore, onUseTemplate, onResubmit, onSendForReview,
    onHoldFromReview, onPromoteSuggestion, onDismissSuggestion, onPushToSender,
    onPublishToSite, showProvenance, selectable, selectedIds, onToggleSelect,
  ]);

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

  const containerClass = isList ? LIST_CLASS : GRID_CLASS[mode];

  return (
    <>
      {shownGroups ? (
        <div className={isList ? 'space-y-5' : 'space-y-6'}>
          {shownGroups.map((g) => (
            /* start is part of the key: buildGroups can legitimately re-open a run
               (a sort whose key isn't the group key), and two <section>s with the
               same React key would collide. */
            <section key={`${g.key}:${g.start}`} aria-label={g.label}>
              <GroupHeading label={g.label} hint={g.hint} count={g.count} />
              <div className={containerClass}>
                {posts.slice(g.start, g.end).map(renderPost)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className={containerClass}>{visible.map(renderPost)}</div>
      )}

      {/* The window is never silent about itself: the count is always visible, even
          once everything is mounted, so "is this the whole list?" is answerable
          without counting cards. "Show all" is there for anyone who wants to Ctrl-F. */}
      <div
        ref={hasMore ? sentinelRef : undefined}
        className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 py-8 text-sm text-slate-400"
      >
        {hasMore ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-indigo-400" aria-hidden="true" />
            <span className="tabular-nums">Showing {count} of {posts.length}</span>
            <button onClick={showAll} className="text-xs font-bold text-indigo-600 hover:underline">
              Show all {posts.length}
            </button>
          </>
        ) : (
          <span className="tabular-nums text-xs font-semibold text-slate-300">
            {posts.length} {posts.length === 1 ? 'thread' : 'threads'} — end of list
          </span>
        )}
      </div>

      <BackToTop />
    </>
  );
});

export default PostGrid;
