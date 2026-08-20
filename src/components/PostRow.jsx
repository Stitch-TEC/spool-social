import React, { memo, useMemo } from 'react';
import {
  Clock, CheckCircle, AlertCircle, Edit3, Trash2, Archive, ArchiveRestore, Check,
  FilePlus, RefreshCw, X, Sparkles, Zap, EyeOff, SendHorizontal, ImageOff
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import { PLATFORMS, STATUS, APPROVAL_STATUS, REVIEW_STATE } from '../constants';
import { DATE_FORMATTERS } from '../utils/helpers';
import { reviewStateOf, daysAwaiting } from '../utils/review';
import { readinessOf, READINESS_LABELS } from '../utils/readiness';

// Same four review states, same colours as the card — an operator switching density
// must not have to re-learn what a colour means. Only the label is dropped on narrow
// screens; the rail and icon carry the state on their own.
const REVIEW_BADGES = {
  [REVIEW_STATE.NOT_SENT]: { label: 'Not sent', icon: EyeOff, cls: 'text-slate-500 bg-slate-100 border-slate-200', rail: 'border-l-slate-300' },
  [REVIEW_STATE.AWAITING]: { label: 'Awaiting', icon: Clock, cls: 'text-sky-700 bg-sky-50 border-sky-100', rail: 'border-l-sky-400' },
  [REVIEW_STATE.CHANGES]: { label: 'Changes', icon: AlertCircle, cls: 'text-rose-600 bg-rose-50 border-rose-100', rail: 'border-l-rose-500' },
  [REVIEW_STATE.APPROVED]: { label: 'Approved', icon: CheckCircle, cls: 'text-emerald-600 bg-emerald-50 border-emerald-100', rail: 'border-l-emerald-500' },
};

const STATUS_PILLS = {
  [STATUS.POSTED]: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  [STATUS.SCHEDULED]: 'bg-amber-100 text-amber-800 border-amber-200',
  [STATUS.ARCHIVED]: 'bg-slate-200 text-slate-500 border-slate-300',
  [STATUS.DRAFT]: 'bg-slate-100 text-slate-600 border-slate-200',
};

// ONE fixed-width status slot, whether it's editable or not — so the column stays a
// column. (Editable and read-only variants of different widths made the right-hand
// side of the list jitter from row to row.)
const STATUS_SLOT = 'w-[78px] text-center appearance-none text-[10px] font-bold px-1 py-0.5 rounded-full border capitalize shrink-0';

const iconBtn = 'p-1.5 text-slate-400 rounded-md transition-colors';

// A 32px square: enough to recognise "the one with the recording studio photo"
// without spending a card's worth of vertical space on it. When the channel wants
// an image and there is none, the same square becomes the gap indicator — so the
// column reads consistently instead of collapsing to nothing.
const Thumb = ({ post, wantsImage }) => {
  if (post.imageUrl) {
    return (
      <img
        src={post.imageUrl}
        alt={post.altText || ''}
        loading="lazy"
        className="w-8 h-8 rounded object-cover border border-slate-200 shrink-0"
      />
    );
  }
  return (
    <span
      className={`w-8 h-8 rounded border flex items-center justify-center shrink-0 ${
        wantsImage ? 'border-rose-100 bg-rose-50 text-rose-300' : 'border-slate-100 bg-slate-50 text-slate-300'
      }`}
      title={wantsImage ? 'No image yet' : 'Text-only'}
      aria-hidden="true"
    >
      <ImageOff size={13} />
    </span>
  );
};

/**
 * One post as a single ~48px row — the LIST density (see constants.DENSITY).
 *
 * The trade is explicit: a row shows what you scan by (channel, copy opening,
 * client, date, review state, what's missing) and drops what you act by. The
 * per-post verbs that only make sense once you've read the whole thing —
 * clone-to-all, duplicate, hold, push-to-Sender, publish-to-site — stay on the
 * Cards/Compact densities, and clicking the row opens the editor where everything
 * lives. Keeping ten hover buttons here would have cost the legibility the row exists for.
 *
 * Operator/member surface only: PostGrid pins review guests to the card densities,
 * so nothing here has to reason about a read-only viewer.
 */
const PostRow = memo(({
  post, clientSettings = {}, onEdit, onDelete, onStatusChange, onArchive, onRestore,
  onUseTemplate, onResubmit, onSendForReview, onPromoteSuggestion, onDismissSuggestion,
  showProvenance = false, selectable = false, selected = false, onToggleSelect,
}) => {
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isArchived = post.status === STATUS.ARCHIVED;
  const isChangesRequested = post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED;
  const reviewState = reviewStateOf(post);
  const isNotSent = reviewState === REVIEW_STATE.NOT_SENT;
  const waiting = daysAwaiting(post);
  const isSuggestion = post.source === 'suggestion' && !!onPromoteSuggestion && !!onDismissSuggestion;
  const isAutomationDraft = post.source === 'automation' && showProvenance && !isSuggestion;
  const isTemplateRow = !!onUseTemplate && !isSuggestion;

  const { blockers, warnings } = readinessOf(post);
  const gaps = [...blockers, ...warnings];

  const formattedDate = useMemo(
    () => (post.scheduledDate ? DATE_FORMATTERS.short.format(post.scheduledDate) : null),
    [post.scheduledDate]
  );

  // Same precedence the card uses: the client asking for changes outranks staging,
  // and either one takes over the row's action slot from the status control.
  const primaryVerb = isChangesRequested && onResubmit ? 'resubmit'
    : isNotSent && onSendForReview ? 'send'
    : null;

  const brandColor = clientSettings.brandColor || '#4338ca';
  const badge = REVIEW_BADGES[reviewState];
  const BadgeIcon = badge.icon;
  const rail = isSuggestion ? 'border-l-amber-400' : (post.isTemplate ? 'border-l-indigo-300' : badge.rail);

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div
      onClick={selectable ? () => onToggleSelect?.(post.id) : () => onEdit(post)}
      className={`group flex items-center gap-2 sm:gap-3 pl-2 pr-2 sm:pr-3 py-2 border-l-4 ${rail} cursor-pointer transition-colors ${
        selected ? 'bg-indigo-50/70' : 'hover:bg-slate-50'
      }`}
    >
      {selectable && (
        <span className={`w-5 h-5 rounded flex items-center justify-center border-2 shrink-0 ${
          selected ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300'
        }`}>
          {selected && <Check size={13} strokeWidth={3} />}
        </span>
      )}

      {/* The row conveys the channel by icon alone (the name would cost the copy a
          third of its width), so the name has to be reachable some other way. */}
      <span className="shrink-0 flex" title={platform.name}>
        <PlatformIcon platformId={post.platform} size={22} />
        <span className="sr-only">{platform.name}</span>
      </span>
      <Thumb post={post} wantsImage={blockers.includes('image_missing') || warnings.includes('image_suggested')} />

      {/* The copy itself, one line. Title first when there is one (long-form posts are
          found by their headline), then the opening of the body in a lighter weight. */}
      <div className="min-w-0 flex-1 truncate text-sm">
        {post.title && <span className="font-bold text-slate-800 mr-1.5">{post.title}</span>}
        <span className={post.content ? 'text-slate-600' : 'italic text-slate-300'}>
          {post.content || 'Empty…'}
        </span>
      </div>

      {/* Everything from here right is a fixed-width scanning column, dropped
          progressively on narrower screens so the copy never gets squeezed out. */}
      {isAutomationDraft && (
        <span className="hidden xl:inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-100 px-1.5 py-0.5 rounded shrink-0" title="Generated by an automation">
          <Zap size={9} /> Auto
        </span>
      )}
      {isSuggestion && (
        <span className="hidden xl:inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded shrink-0">
          <Sparkles size={9} /> Suggested
        </span>
      )}

      {gaps.length > 0 && (
        <span
          className={`hidden sm:inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 tabular-nums ${
            blockers.length ? 'text-rose-700 bg-rose-50 border-rose-100' : 'text-slate-500 bg-slate-50 border-slate-200'
          }`}
          title={gaps.map((c) => READINESS_LABELS[c] || c).join(' · ')}
        >
          <AlertCircle size={10} /> {gaps.length}
        </span>
      )}

      {post.client && (
        <span
          className="hidden lg:inline-block text-[10px] px-1.5 py-0.5 rounded border border-slate-100 bg-slate-50 font-medium truncate max-w-[110px] shrink-0"
          style={{ color: brandColor }}
        >
          {post.client}
        </span>
      )}

      {/* Fixed width so the dates line up as a column across rows, and wide enough for
          the longest value the short formatter produces ("Sep 30, 12:00 PM") — at 104px
          a two-digit August day wrapped and made that one row taller than its neighbours. */}
      <span className={`hidden md:flex items-center gap-1 text-xs shrink-0 w-[126px] justify-end whitespace-nowrap tabular-nums ${formattedDate ? 'text-slate-400' : 'text-slate-300 italic'}`}>
        <Clock size={10} /> {formattedDate || 'No date'}
      </span>

      {/* Status: editable when changing it is the meaningful next step, static when the
          primary verb (send / back for review) has taken the action slot instead. */}
      {!isSuggestion && (primaryVerb || !onStatusChange ? (
        <span className={`hidden md:inline-block ${STATUS_SLOT} ${STATUS_PILLS[post.status] || STATUS_PILLS[STATUS.DRAFT]}`}>
          {post.status || STATUS.DRAFT}
        </span>
      ) : (
        <select
          value={post.status || STATUS.DRAFT}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { e.stopPropagation(); onStatusChange(post.id, e.target.value); }}
          aria-label="Set post status"
          title="Set status"
          /* appearance-none costs the native arrow, so hover is what says "editable". */
          className={`hidden md:inline-block cursor-pointer hover:ring-1 hover:ring-indigo-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none ${STATUS_SLOT} ${STATUS_PILLS[post.status] || STATUS_PILLS[STATUS.DRAFT]}`}
        >
          <option value={STATUS.DRAFT}>Draft</option>
          <option value={STATUS.SCHEDULED}>Scheduled</option>
          <option value={STATUS.POSTED}>Posted</option>
          {isArchived && <option value={STATUS.ARCHIVED}>Archived</option>}
        </select>
      ))}

      {!isSuggestion && !post.isTemplate && (
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border flex items-center gap-1 shrink-0 ${badge.cls}`} title={isNotSent ? 'In staging — the client cannot see this yet' : undefined}>
          <BadgeIcon size={10} />
          <span className="hidden lg:inline">{badge.label}</span>
          {waiting > 0 && <span className="opacity-70 tabular-nums">{waiting}d</span>}
        </span>
      )}
      {post.isTemplate && (
        <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.5 rounded shrink-0">Template</span>
      )}

      {/* Actions. The primary verb is always visible (it's the whole point of the row);
          the rest fade in on hover on pointer devices and stay put on touch. */}
      <div className="flex items-center gap-0.5 shrink-0">
        {isSuggestion ? (
          <>
            <button onClick={stop(() => onDismissSuggestion(post))} title="Dismiss this suggestion (deletes it)" aria-label="Dismiss suggestion" className={`${iconBtn} hover:text-rose-600`}><X size={15} /></button>
            <button onClick={stop(() => onPromoteSuggestion(post))} title="Move this draft into the client's review queue" aria-label="Use this suggestion" className="flex items-center gap-1 text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-2 py-1 transition-colors"><CheckCircle size={12} /> Use</button>
          </>
        ) : isTemplateRow ? (
          <>
            <span className="flex gap-0.5 transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100">
              <button onClick={stop(() => onDelete(post.id))} title="Delete Thread" aria-label="Delete Thread" className={`${iconBtn} hover:text-rose-600`}><Trash2 size={15} /></button>
            </span>
            <button onClick={stop(() => onUseTemplate(post))} title="Spin off a new draft from this template" aria-label="Use as draft" className="flex items-center gap-1 text-[11px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-2 py-1 transition-colors"><FilePlus size={12} /> Use</button>
          </>
        ) : (
          <>
            {/* hidden below sm: on a phone these three buttons are always visible (no
                hover to gate them) and cost ~90px of a 390px row — most of the copy.
                Tapping the row opens the editor, which is where all of this lives. */}
            <span className="hidden sm:flex gap-0.5 transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100">
              <button onClick={stop(() => onEdit(post))} title="Edit Thread" aria-label="Edit Thread" className={`${iconBtn} hover:text-emerald-700`}><Edit3 size={15} /></button>
              {isArchived
                ? <button onClick={stop(() => onRestore(post.id))} title="Restore Thread" aria-label="Restore Thread" className={`${iconBtn} hover:text-indigo-600`}><ArchiveRestore size={15} /></button>
                : <button onClick={stop(() => onArchive(post.id))} title="Archive Thread" aria-label="Archive Thread" className={`${iconBtn} hover:text-amber-600`}><Archive size={15} /></button>}
              <button onClick={stop(() => onDelete(post.id))} title="Delete Thread" aria-label="Delete Thread" className={`${iconBtn} hover:text-rose-600`}><Trash2 size={15} /></button>
            </span>
            {/* The status control lives in its own column; this slot is for the verb that
                REPLACES it — so the two can never both claim the row. */}
            {primaryVerb === 'resubmit' && (
              <button onClick={stop(() => onResubmit(post.id))} title="Send the revised post back to the client for review" aria-label="Back for review" className={`${iconBtn} text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50`}><RefreshCw size={15} /></button>
            )}
            {primaryVerb === 'send' && (
              <button onClick={stop(() => onSendForReview(post))} title="Make this visible on the client's review link" aria-label="Send for review" className={`${iconBtn} text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50`}><SendHorizontal size={15} /></button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export default PostRow;
