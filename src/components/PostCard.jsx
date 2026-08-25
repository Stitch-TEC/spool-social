import React, { memo, useState, useCallback, useMemo } from 'react';
import {
  Clock, CheckCircle, AlertCircle, Layers, CopyPlus,
  Edit3, Trash2, Copy, ExternalLink, Archive, ArchiveRestore, Check, FilePlus, RefreshCw, X, Send, Zap, Sparkles, UploadCloud,
  EyeOff, SendHorizontal, ImageOff
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import { PLATFORMS, STATUS, APPROVAL_STATUS, REVIEW_STATE, DENSITY } from '../constants';
import { DATE_FORMATTERS } from '../utils/helpers';
import { reviewStateOf, daysAwaiting } from '../utils/review';
import { readinessOf, READINESS_LABELS } from '../utils/readiness';

// One badge per review state — the answer to "where is this with the client?",
// which the card previously left the operator to infer from two half-signals
// (an approval pill that only appeared for two of the four states).
const REVIEW_BADGES = {
  [REVIEW_STATE.NOT_SENT]: { label: 'Not sent', icon: EyeOff, cls: 'text-slate-500 bg-slate-100 border-slate-200', rail: 'border-l-slate-300' },
  [REVIEW_STATE.AWAITING]: { label: 'Awaiting', icon: Clock, cls: 'text-sky-700 bg-sky-50 border-sky-100', rail: 'border-l-sky-400' },
  [REVIEW_STATE.CHANGES]: { label: 'Changes', icon: AlertCircle, cls: 'text-rose-600 bg-rose-50 border-rose-100', rail: 'border-l-rose-500' },
  [REVIEW_STATE.APPROVED]: { label: 'Approved', icon: CheckCircle, cls: 'text-emerald-600 bg-emerald-50 border-emerald-100', rail: 'border-l-emerald-500' },
};

// The two card densities, as one table instead of a dozen inline ternaries.
//
// COMPACT is the same card with the same information and the same verbs — it just
// stops spending a full-width 128px image band and three lines of copy on every
// post. That band is what made ~6 posts a screenful at 1600x1200; moving it to a
// 56px thumbnail beside two lines roughly doubles the posts per screen without
// giving up the visual recognition ("the one with the recording-studio photo")
// that makes a thumbnail worth showing at all.
const DENSITY_STYLES = {
  [DENSITY.CARDS]: {
    accent: 'h-1.5', pad: 'p-5', headerMb: 'mb-3', platformText: 'text-sm', platformIcon: 28,
    badgeText: 'text-xs', tagMax: Infinity, tagMb: 'mb-3', bodyMb: 'mb-4', clamp: 'line-clamp-3',
    chipMax: 3, chipMb: 'mb-3', feedbackMb: 'mb-4', footerPt: 'pt-3', actionLabels: true,
  },
  [DENSITY.COMPACT]: {
    accent: 'h-1', pad: 'p-3.5', headerMb: 'mb-2', platformText: 'text-xs', platformIcon: 22,
    badgeText: 'text-[10px]', tagMax: 2, tagMb: 'mb-2', bodyMb: 'mb-2.5', clamp: 'line-clamp-2',
    chipMax: 2, chipMb: 'mb-2', feedbackMb: 'mb-2', footerPt: 'pt-2.5',
    // Icon-only in compact: "Copy" + "Open App" cost ~90px, which is exactly what a
    // narrower card doesn't have — with them, "Send for review" wrapped onto two lines
    // and dragged the whole footer with it. Both buttons keep their title + aria-label.
    actionLabels: false,
  },
};

// The hover action cluster.
//
// Eight icon buttons at ~28px each RESERVE ~190px of the header row even while
// they're invisible — `opacity-0` hides them but keeps their layout. That is what
// squeezed the header into three wrapped lines on a 400px card, and it makes a
// 300px compact card impossible. On pointer devices the cluster therefore leaves
// the flow entirely and floats over the card's top-right corner on hover, handing
// the whole header row back to the platform, date and client.
//
// On TOUCH it stays exactly where it was: `[@media(pointer:fine)]` guards every
// rule, and a device with no hover has no way to reveal an overlay.
const ACTIONS_CLS = [
  'flex gap-1 transition-opacity',
  '[@media(pointer:fine)]:absolute [@media(pointer:fine)]:top-2 [@media(pointer:fine)]:right-2 [@media(pointer:fine)]:z-10',
  '[@media(pointer:fine)]:rounded-lg [@media(pointer:fine)]:border [@media(pointer:fine)]:border-slate-100',
  '[@media(pointer:fine)]:bg-white/95 [@media(pointer:fine)]:backdrop-blur-sm [@media(pointer:fine)]:shadow-sm [@media(pointer:fine)]:p-0.5',
  '[@media(pointer:fine)]:opacity-0',
  '[@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100',
].join(' ');

// The review conversation, from the operator's side of the card.
//
// Before this, the card showed only `post.feedback` — the LATEST note — and
// "Back for review" clears that field by design. So the moment the operator acted
// on feedback, the note describing what to fix vanished from every surface they
// had: `feedbackThread` accumulates every round (atomically, via arrayUnion) but
// nothing in the app ever rendered it outside the guest's review modal.
const FeedbackTrail = ({ post, className = 'mb-4' }) => {
  const [expanded, setExpanded] = useState(false);
  const thread = Array.isArray(post.feedbackThread) ? post.feedbackThread : [];
  // Fall back to the legacy single field for posts that predate threading.
  const entries = thread.length ? thread : (post.feedback ? [{ text: post.feedback, by: 'client' }] : []);
  if (entries.length === 0) return null;

  const shown = expanded ? entries : entries.slice(-1);
  const hidden = entries.length - shown.length;
  return (
    <div className={`${className} space-y-1`}>
      {shown.map((f, i) => (
        <div key={i} className="p-2 bg-rose-50 rounded-lg border border-rose-100 text-xs text-rose-900">
          <span className="font-bold uppercase tracking-wider text-[10px] text-rose-600 mr-1">
            {f.by === 'you' ? 'You' : 'Client'}
          </span>
          <span className="italic">“{f.text}”</span>
        </div>
      ))}
      {(hidden > 0 || expanded) && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          className="text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition-colors"
        >
          {expanded ? 'Hide earlier notes' : `+${hidden} earlier note${hidden === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
};

// Blockers read rose (can't go out), warnings slate (should be better). Capped (at
// three, two when compact) so a card can't turn into a wall of chips — the editor is
// where you fix them. `+N` keeps the cap honest when there are more.
const ReadinessChips = ({ post, max = 3, className = 'mb-3' }) => {
  const { blockers, warnings } = readinessOf(post);
  const all = [
    ...blockers.map((c) => ({ code: c, blocking: true })),
    ...warnings.map((c) => ({ code: c, blocking: false })),
  ];
  const items = all.slice(0, max);
  const hidden = all.length - items.length;
  if (items.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {items.map(({ code, blocking }) => (
        <span
          key={code}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
            blocking ? 'text-rose-700 bg-rose-50 border-rose-100' : 'text-slate-500 bg-slate-50 border-slate-200'
          }`}
        >
          {(code === 'image_missing' || code === 'image_suggested') && <ImageOff size={9} />}
          {READINESS_LABELS[code]}
        </span>
      ))}
      {hidden > 0 && (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border text-slate-400 bg-slate-50 border-slate-200"
          title={all.slice(max).map((i) => READINESS_LABELS[i.code] || i.code).join(' · ')}
        >
          +{hidden}
        </span>
      )}
    </div>
  );
};

const PostCard = memo(({ post, clientSettings = {}, onEdit, onDelete, onDuplicate, onCloneToAll, onStatusChange, statusOptions, onArchive, onRestore, onUseTemplate, onResubmit, onSendForReview, onHoldFromReview, onPromoteSuggestion, onDismissSuggestion, onPushToSender, onPublishToSite, showProvenance = false, isReadOnly, selectable = false, selected = false, onToggleSelect, density = DENSITY.CARDS }) => {
  const [copied, setCopied] = useState(false);
  // LIST density has its own component (PostRow) — anything that isn't COMPACT falls
  // back to the original card, so an unknown value can never render a broken layout.
  const compact = density === DENSITY.COMPACT;
  const D = compact ? DENSITY_STYLES[DENSITY.COMPACT] : DENSITY_STYLES[DENSITY.CARDS];
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isScheduled = post.status === STATUS.SCHEDULED;
  const isPosted = post.status === STATUS.POSTED;
  const isArchived = post.status === STATUS.ARCHIVED;
  const isChangesRequested = post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED;
  const availableStatuses = statusOptions || [STATUS.DRAFT, STATUS.SCHEDULED, STATUS.POSTED];
  const canChangeCurrentStatus = availableStatuses.includes(post.status || STATUS.DRAFT);
  const reviewState = reviewStateOf(post);
  const isNotSent = reviewState === REVIEW_STATE.NOT_SENT;
  const waiting = daysAwaiting(post);
  // Parked automation suggestion (operator-only lane) — swaps the status row for the
  // promote/dismiss pair. Handler presence doubles as the operator gate.
  const isSuggestion = post.source === 'suggestion' && !!onPromoteSuggestion && !!onDismissSuggestion;
  // A draft the cron/automation produced straight into the queue (or a promoted suggestion, which is
  // relabelled 'automation'). Only surfaced to operators (showProvenance) — clients/guests never see
  // machine-provenance labels.
  const isAutomationDraft = post.source === 'automation' && showProvenance && !isSuggestion;

  const statusPill = isPosted ? 'bg-indigo-100 text-indigo-700 border-indigo-200'
    : isScheduled ? 'bg-amber-100 text-amber-800 border-amber-200'
    : isArchived ? 'bg-slate-200 text-slate-500 border-slate-300'
    : 'bg-slate-100 text-slate-600 border-slate-200';

  // ⚡ OPTIMIZATION: Use pre-compiled Intl.DateTimeFormat and memoize the result.
  // This avoids redundant formatting work on every render, leveraging referentially
  // stable Date objects from the parent's optimized data listener.
  const formattedDate = useMemo(() => {
    return post.scheduledDate ? DATE_FORMATTERS.short.format(post.scheduledDate) : 'No date set';
  }, [post.scheduledDate]);

  // When this suggestion/auto draft was generated — shown on the provenance line so "Use this" is
  // a more informed click. createdAt is an ISO string on the doc; guard the parse.
  const generatedDate = useMemo(() => {
    if (!post.createdAt) return '';
    try { return DATE_FORMATTERS.short.format(new Date(post.createdAt)); } catch { return ''; }
  }, [post.createdAt]);

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

  // The left rail encodes the REVIEW state (not the workflow status): scanning a
  // mixed grid, "where is this with the client?" is the question that decides what
  // to do next. Templates have no review lane, so they keep the plain card.
  const getStatusColor = () => {
      // Parked suggestions get an amber rail so they're distinguishable at a glance in a mixed grid.
      if (isSuggestion) return 'border-l-4 border-l-amber-400';
      if (post.isTemplate) return isPosted ? 'opacity-90' : '';
      const rail = REVIEW_BADGES[reviewState]?.rail;
      return `${rail ? `border-l-4 ${rail}` : ''}${isPosted ? ' opacity-90' : ''}`.trim();
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
      <div className={`${D.accent} w-full ${isPosted ? 'bg-indigo-500' : isScheduled ? 'bg-amber-400' : 'bg-slate-300'}`} />
      <div className={`${D.pad} flex-1 flex flex-col`}>
        <div className={`flex justify-between items-start ${D.headerMb} ${selectable ? 'pl-7' : ''}`}>
          {/* min-w-0 here as well as on the text column: without it this flex item can't
              shrink past its min-content width, and it pushed the review badge out of
              the card (which is overflow-hidden, so the badge lost its last character). */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <PlatformIcon platformId={post.platform} size={D.platformIcon} />
            {/* min-w-0 + truncate: without them this column can't shrink, so a narrow
                card broke "X / Twitter" and "Jul 1, 12:00 PM" across lines instead. */}
            <div className="min-w-0">
                <h4 title={platform.name} className={`font-semibold text-slate-800 truncate ${D.platformText}`}>{platform.name}</h4>
                <div className="flex items-center gap-2 flex-wrap">
                    {post.source === 'suggestion'
                      ? <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1"><Sparkles size={9} /> Suggested</span>
                      : post.isTemplate
                      ? <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded">Template</span>
                      : (
                        <div className="flex items-center gap-2">
                          {/* Auto-generated drafts get a distinct 'Auto' badge (operator-only) so a
                              machine draft is never mistaken for a hand-written one in the queue. */}
                          {isAutomationDraft && <span className="text-[10px] font-bold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1"><Zap size={9} /> Auto</span>}
                          <div className="flex items-center gap-1 text-xs text-slate-400 whitespace-nowrap"><Clock size={10} /><span>{formattedDate}</span></div>
                        </div>
                      )}
                    {post.client && <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-100 bg-slate-50 font-medium truncate max-w-[80px]" style={{ color: brandColor }}>{post.client}</span>}
                </div>
            </div>
          </div>
          
          {/* Templates and parked suggestions sit outside the review loop entirely —
              a review badge on either would assert a state that doesn't exist. */}
          {!isSuggestion && !post.isTemplate && (() => {
            const badge = REVIEW_BADGES[reviewState];
            const BadgeIcon = badge.icon;
            return (
              <div
                className={`${D.badgeText} font-bold px-2 py-1 rounded border flex items-center gap-1 shrink-0 ${badge.cls}`}
                title={isNotSent ? 'In staging — the client cannot see this yet' : undefined}
              >
                {BadgeIcon && <BadgeIcon size={12} />} {badge.label}
                {/* How long it's been sitting with the client — operator-only: it's a
                    nudge for us, and would read as pressure on the client's own view. */}
                {!isReadOnly && waiting > 0 && <span className="font-semibold opacity-70 tabular-nums">{waiting}d</span>}
              </div>
            );
          })()}

          {!isReadOnly && !selectable && (
            <div className={ACTIONS_CLS}>
              {/* Suggestion cards keep only Edit + Delete: Archive is a dead end for a parked
                  post, and Duplicate / Clone-to-All mint client-visible drafts — the ONLY way
                  off the suggestions lane is the explicit "Use this" promote below. */}
              {!isSuggestion && (isArchived ? (onRestore && (
                <button onClick={(e) => { e.stopPropagation(); onRestore(post.id); }} title="Restore Thread" aria-label="Restore Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><ArchiveRestore size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )) : (onArchive && (
                <button onClick={(e) => { e.stopPropagation(); onArchive(post.id); }} title="Archive Thread" aria-label="Archive Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-amber-600 rounded-md"><Archive size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )))}
              {/* Pull a sent post back off the client's review link. Only meaningful once
                  it's actually out there, so it's hidden while the post is still staged. */}
              {!isSuggestion && !post.isTemplate && !isArchived && !isNotSent && onHoldFromReview && (
                <button onClick={(e) => { e.stopPropagation(); onHoldFromReview(post); }} title="Move to staging (hide from the client)" aria-label="Move to staging" className="p-2 sm:p-1.5 text-slate-400 hover:text-slate-700 rounded-md"><EyeOff size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              {/* Push to Sender (operator-only via handler presence): templates + APPROVED
                  blog drafts become a campaign-ready email template in the client's Sender
                  tenant (same review gate as publish-to-site; the worker enforces it too).
                  Templates are exempt — the Templates library sits outside the review queue,
                  so a client can never approve one. Hidden on suggestions (promote first). */}
              {!isSuggestion && onPushToSender && (post.isTemplate || (post.platform === 'blog' && post.approvalStatus === APPROVAL_STATUS.APPROVED)) && (
                <button onClick={(e) => { e.stopPropagation(); onPushToSender(post); }} title="Push to Sender (email template)" aria-label="Push to Sender (email template)" className="p-2 sm:p-1.5 text-slate-400 hover:text-violet-600 rounded-md"><Send size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              {/* Publish to site (operator-only via handler presence): APPROVED blog drafts stage
                  a deterministic agent PR on the client's repo — two human gates follow (POM
                  dispatch + PR merge), nothing goes live from this click. */}
              {!isSuggestion && onPublishToSite && post.platform === 'blog' && post.approvalStatus === APPROVAL_STATUS.APPROVED && (
                <button onClick={(e) => { e.stopPropagation(); onPublishToSite(post); }} title="Publish to site (opens a PR via POM dispatch)" aria-label="Publish to site (opens a PR via POM dispatch)" className="p-2 sm:p-1.5 text-slate-400 hover:text-emerald-600 rounded-md"><UploadCloud size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              {!isSuggestion && onCloneToAll && <button onClick={(e) => { e.stopPropagation(); onCloneToAll(post); }} title="Blast: Clone to All Clients" aria-label="Blast: Clone to All Clients" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><Layers size={16} className="sm:w-3.5 sm:h-3.5" /></button>}
              {!isSuggestion && <button onClick={(e) => { e.stopPropagation(); onDuplicate(post); }} title="Clone Draft" aria-label="Clone Draft" className="p-2 sm:p-1.5 text-slate-400 hover:text-blue-600 rounded-md"><CopyPlus size={16} className="sm:w-3.5 sm:h-3.5" /></button>}
              <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} title="Edit Thread" aria-label="Edit Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-emerald-700 rounded-md"><Edit3 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(post.id); }} title="Delete Thread" aria-label="Delete Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-rose-600 rounded-md"><Trash2 size={16} className="sm:w-3.5 sm:h-3.5" /></button>
            </div>
          )}
        </div>

        {/* Compact caps the tag row: a post with eight traceability tags would otherwise
            spend the line the thumbnail just bought back. `+N` keeps the count honest. */}
        {post.tags && post.tags.length > 0 && (
          <div className={`flex flex-wrap gap-1 ${D.tagMb}`}>
            {post.tags.slice(0, D.tagMax).map((tag, i) => <span key={i} className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-100 text-slate-500 border border-slate-200">{tag}</span>)}
            {post.tags.length > D.tagMax && (
              <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-slate-50 text-slate-400 border border-slate-200" title={post.tags.slice(D.tagMax).join(' · ')}>
                +{post.tags.length - D.tagMax}
              </span>
            )}
          </div>
        )}
        {/* ⚡ OPTIMIZATION: Use native browser-level lazy loading for post images to reduce initial network and memory usage for off-screen items. */}
        <div className={`${D.bodyMb} flex-1 ${compact ? 'flex gap-2.5' : ''} ${selectable ? '' : 'cursor-pointer'}`} onClick={selectable ? undefined : () => onEdit(post)}>
          {/* Compact: the image becomes a 56px square BESIDE the copy rather than a
              128px band under it — same recognition cue, a third of the height. */}
          {compact && post.imageUrl && (
            <div className="h-14 w-14 shrink-0 bg-slate-50 rounded-lg overflow-hidden border border-slate-100">
              <img src={post.imageUrl} alt={post.altText || 'Asset'} className="w-full h-full object-cover" loading="lazy" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            {post.title && <h5 className="font-bold text-slate-800 text-sm mb-1 line-clamp-1">{post.title}</h5>}
            <p className={`text-slate-600 text-sm ${D.clamp} leading-relaxed font-medium`}>{post.content || <span className="italic text-slate-300">Empty...</span>}</p>
          </div>
          {!compact && post.imageUrl && <div className="mt-3 relative h-32 w-full bg-slate-50 rounded-lg overflow-hidden border border-slate-100"><img src={post.imageUrl} alt={post.altText || 'Asset'} className="w-full h-full object-cover" loading="lazy" /></div>}
        </div>
        
        {/* What's still missing, so "is this finishable?" is answerable from the grid
            instead of by opening every card. Not shown to review guests — alt text and
            meta descriptions are our craft problems, not theirs. */}
        {!isReadOnly && !selectable && <ReadinessChips post={post} max={D.chipMax} className={D.chipMb} />}

        {/* Guests keep the single latest note (their own words, no history UI needed
            on a card — the review modal shows them the full thread). */}
        {isReadOnly
          ? (post.feedback && <div className={`${D.feedbackMb} p-2 bg-rose-50 rounded-lg border border-rose-100 text-xs text-rose-900 italic`}>“{post.feedback}”</div>)
          : <FeedbackTrail post={post} className={D.feedbackMb} />}

        {/* Template card: primary action is "Use as draft" (clone into a new post).
            !isSuggestion keeps the action rows mutually exclusive — a bad doc carrying both
            flags renders the suggestion row (its lane is the more restrictive one). */}
        {!isReadOnly && !selectable && onUseTemplate && !isSuggestion && (
          <div className={`flex items-center gap-2 ${D.footerPt} border-t border-slate-50 mt-auto`}>
            <button
              onClick={(e) => { e.stopPropagation(); copyToClipboard(post.content); }}
              className={`flex items-center gap-1.5 text-xs font-medium transition-colors active:scale-95 p-1 sm:p-0 ${copied ? 'text-emerald-600' : 'text-slate-500 hover:text-indigo-700'}`}
              title="Copy content to clipboard" aria-label="Copy content to clipboard"
            >
              {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
              {D.actionLabels && <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onUseTemplate(post); }}
              className="flex-1 flex items-center justify-center gap-1.5 whitespace-nowrap text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-2 transition-colors"
            >
              <FilePlus size={14} /> Use as draft
            </button>
          </div>
        )}

        {/* Suggestion card: parked automation output — the primary action is promoting it into
            the client's review queue; Dismiss deletes (it never reached the client). Replaces
            the status row: a suggestion has no workflow until it's promoted. */}
        {/* Provenance: WHY this suggestion exists — its automation seed and (when site-grounded)
            the real page it drew from — so "Use this" is an informed click. */}
        {(isSuggestion || isAutomationDraft) && (post.suggestPageTitle || post.suggestPageUrl || post.suggestSeed || generatedDate) && (
          <div className="text-[10px] text-slate-400 mb-2 flex items-start gap-1 min-w-0" title={post.suggestPageUrl || post.suggestSeed || ''}>
            <Sparkles size={11} className="text-amber-400 shrink-0 mt-px" />
            <span className="min-w-0 line-clamp-2">
              {/* Grounded (page) provenance wins; else the operator's seed (suggestions only); else a
                  bare "Generated <date>" so a plain auto draft still self-explains — no dangling label. */}
              {post.suggestPageTitle || post.suggestPageUrl ? (
                <>From your site:{' '}
                  {post.suggestPageUrl
                    ? <a href={post.suggestPageUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-slate-500 font-medium hover:text-indigo-600 hover:underline">{post.suggestPageTitle || post.suggestPageUrl}</a>
                    : <span className="text-slate-500 font-medium">{post.suggestPageTitle}</span>}
                  {generatedDate && <span className="text-slate-300"> · generated {generatedDate}</span>}
                </>
              ) : post.suggestSeed ? (
                <>From automation: <span className="text-slate-500 font-medium">{post.suggestSeed}</span>
                  {generatedDate && <span className="text-slate-300"> · generated {generatedDate}</span>}
                </>
              ) : (
                <>Generated {generatedDate}</>
              )}
            </span>
          </div>
        )}
        {!isReadOnly && !selectable && isSuggestion && (
          <div className={`flex items-center gap-2 ${D.footerPt} border-t border-slate-50 mt-auto`}>
            <button
              onClick={(e) => { e.stopPropagation(); onDismissSuggestion(post); }}
              className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-full px-3 py-2 transition-colors"
              title="Dismiss this suggestion (deletes it)" aria-label="Dismiss suggestion"
            >
              <X size={14} /> Dismiss
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onPromoteSuggestion(post); }}
              className="flex-1 flex items-center justify-center gap-1.5 whitespace-nowrap text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-2 transition-colors"
              title="Move this draft into the client's review queue" aria-label="Use this suggestion"
            >
              <CheckCircle size={14} /> Use this
            </button>
          </div>
        )}

        {!isReadOnly && !selectable && !onUseTemplate && !isSuggestion && (
          <div className={`flex items-center justify-between ${D.footerPt} border-t border-slate-50 mt-auto`}>
            <button
              onClick={(e) => { e.stopPropagation(); copyToClipboard(post.content); }}
              className={`flex items-center gap-1.5 text-xs font-medium transition-colors active:scale-95 p-1 sm:p-0 ${copied ? 'text-emerald-600' : 'text-slate-500 hover:text-indigo-700'}`}
              title="Copy content to clipboard"
              aria-label="Copy content to clipboard"
            >
              {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
              {D.actionLabels && <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>}
            </button>
            <a href={platform.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title="Open platform app" aria-label="Open platform app" className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors p-1 sm:p-0"><ExternalLink size={14} />{D.actionLabels && <span className="hidden sm:inline">Open App</span>}</a>
            {/* Changes requested → the primary action is sending the revised post
                back to the client (reset to pending), not moving toward posted. */}
            {!isArchived && isChangesRequested && onResubmit ? (
              <button
                onClick={(e) => { e.stopPropagation(); onResubmit(post); }}
                title="Send the revised post back to the client for review"
                className="flex items-center gap-1.5 shrink-0 whitespace-nowrap text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-1.5 transition-colors"
              >
                <RefreshCw size={13} /> Back for review
              </button>
            ) : !isArchived && isNotSent && onSendForReview ? (
              /* A staged post's only meaningful next step is showing it to the client —
                 so that's the button, in place of a status dropdown that changes nothing
                 the client can see. */
              <button
                onClick={(e) => { e.stopPropagation(); onSendForReview(post); }}
                title="Make this visible on the client's review link"
                className="flex items-center gap-1.5 shrink-0 whitespace-nowrap text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-1.5 transition-colors"
              >
                <SendHorizontal size={13} /> Send for review
              </button>
            ) : onStatusChange && canChangeCurrentStatus ? (
              <select
                value={post.status}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); onStatusChange(post.id, e.target.value); }}
                aria-label="Set post status"
                title="Set status"
                className={`text-xs font-bold rounded-full px-2.5 h-7 py-0 leading-none border cursor-pointer transition-colors ${statusPill}`}
              >
                {availableStatuses.map(status => (
                  <option key={status} value={status}>{status[0].toUpperCase() + status.slice(1)}</option>
                ))}
                {!statusOptions && isArchived && <option value={STATUS.ARCHIVED}>Archived</option>}
              </select>
            ) : (
              <span className={`text-xs font-bold rounded-full px-2.5 py-1 border capitalize ${statusPill}`}>
                {post.status || STATUS.DRAFT}
              </span>
            )}
          </div>
        )}

        {/* Guest reviewer quick-actions (approve / request changes from the card) */}
        {isReadOnly && (
          <div className={`flex items-center gap-2 ${D.footerPt} border-t border-slate-50 mt-auto`}>
            {post.approvalStatus === APPROVAL_STATUS.APPROVED ? (
              <span className="flex-1 text-center text-xs font-bold text-emerald-700 bg-emerald-50 rounded-lg py-2 flex items-center justify-center gap-1"><CheckCircle size={14} /> Approved</span>
            ) : (
              <>
                <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} className="flex-1 py-2 text-xs font-bold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">Request changes</button>
                <button onClick={(e) => { e.stopPropagation(); onStatusChange(post.id, STATUS.SCHEDULED, post); }} className="flex-1 py-2 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors flex items-center justify-center gap-1"><CheckCircle size={14} /> Approve</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default PostCard;
