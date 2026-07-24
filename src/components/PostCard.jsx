import React, { memo, useState, useCallback, useMemo } from 'react';
import {
  Clock, CheckCircle, AlertCircle, Layers, CopyPlus,
  Edit3, Trash2, Copy, ExternalLink, Archive, ArchiveRestore, Check, FilePlus, RefreshCw, X, Send, Zap, Sparkles, UploadCloud
} from 'lucide-react';
import PlatformIcon from './PlatformIcon';
import { PLATFORMS, STATUS, APPROVAL_STATUS } from '../constants';
import { DATE_FORMATTERS } from '../utils/helpers';

const PostCard = memo(({ post, clientSettings = {}, onEdit, onDelete, onDuplicate, onCloneToAll, onStatusChange, onArchive, onRestore, onUseTemplate, onResubmit, onPromoteSuggestion, onDismissSuggestion, onPushToSender, onPublishToSite, showProvenance = false, isReadOnly, selectable = false, selected = false, onToggleSelect }) => {
  const [copied, setCopied] = useState(false);
  const platform = PLATFORMS[post.platform] || PLATFORMS.gmb;
  const isScheduled = post.status === STATUS.SCHEDULED;
  const isPosted = post.status === STATUS.POSTED;
  const isArchived = post.status === STATUS.ARCHIVED;
  const isChangesRequested = post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED;
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

  const getStatusColor = () => {
      // Parked suggestions get an amber rail so they're distinguishable at a glance in a mixed grid.
      if (isSuggestion) return 'border-l-4 border-l-amber-400';
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
                          <div className="flex items-center gap-1 text-xs text-slate-400"><Clock size={10} /><span>{formattedDate}</span></div>
                        </div>
                      )}
                    {post.client && <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-100 bg-slate-50 font-medium truncate max-w-[80px]" style={{ color: brandColor }}>{post.client}</span>}
                </div>
            </div>
          </div>
          
          {post.approvalStatus === APPROVAL_STATUS.APPROVED && <div className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded flex items-center gap-1"><CheckCircle size={12} /> Approved</div>}
          {post.approvalStatus === APPROVAL_STATUS.CHANGES_REQUESTED && <div className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded flex items-center gap-1"><AlertCircle size={12} /> Review</div>}

          {!isReadOnly && !selectable && (
            <div className="flex gap-1 transition-opacity [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100">
              {/* Suggestion cards keep only Edit + Delete: Archive is a dead end for a parked
                  post, and Duplicate / Clone-to-All mint client-visible drafts — the ONLY way
                  off the suggestions lane is the explicit "Use this" promote below. */}
              {!isSuggestion && (isArchived ? (
                <button onClick={(e) => { e.stopPropagation(); onRestore(post.id); }} title="Restore Thread" aria-label="Restore Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><ArchiveRestore size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); onArchive(post.id); }} title="Archive Thread" aria-label="Archive Thread" className="p-2 sm:p-1.5 text-slate-400 hover:text-amber-600 rounded-md"><Archive size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              ))}
              {/* Push to Sender (operator-only via handler presence): templates + blog/long-form
                  become a campaign-ready email template in the client's Sender tenant. Hidden on
                  suggestions (no tenant yet — promote first). */}
              {!isSuggestion && onPushToSender && (post.isTemplate || post.platform === 'blog') && (
                <button onClick={(e) => { e.stopPropagation(); onPushToSender(post); }} title="Push to Sender (email template)" aria-label="Push to Sender (email template)" className="p-2 sm:p-1.5 text-slate-400 hover:text-violet-600 rounded-md"><Send size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              {/* Publish to site (operator-only via handler presence): APPROVED blog drafts stage
                  a deterministic agent PR on the client's repo — two human gates follow (POM
                  dispatch + PR merge), nothing goes live from this click. */}
              {!isSuggestion && onPublishToSite && post.platform === 'blog' && post.approvalStatus === APPROVAL_STATUS.APPROVED && (
                <button onClick={(e) => { e.stopPropagation(); onPublishToSite(post); }} title="Publish to site (opens a PR via POM dispatch)" aria-label="Publish to site (opens a PR via POM dispatch)" className="p-2 sm:p-1.5 text-slate-400 hover:text-emerald-600 rounded-md"><UploadCloud size={16} className="sm:w-3.5 sm:h-3.5" /></button>
              )}
              {!isSuggestion && <button onClick={(e) => { e.stopPropagation(); onCloneToAll(post); }} title="Blast: Clone to All Clients" aria-label="Blast: Clone to All Clients" className="p-2 sm:p-1.5 text-slate-400 hover:text-indigo-600 rounded-md"><Layers size={16} className="sm:w-3.5 sm:h-3.5" /></button>}
              {!isSuggestion && <button onClick={(e) => { e.stopPropagation(); onDuplicate(post); }} title="Clone Draft" aria-label="Clone Draft" className="p-2 sm:p-1.5 text-slate-400 hover:text-blue-600 rounded-md"><CopyPlus size={16} className="sm:w-3.5 sm:h-3.5" /></button>}
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

        {/* Template card: primary action is "Use as draft" (clone into a new post).
            !isSuggestion keeps the action rows mutually exclusive — a bad doc carrying both
            flags renders the suggestion row (its lane is the more restrictive one). */}
        {!isReadOnly && !selectable && onUseTemplate && !isSuggestion && (
          <div className="flex items-center gap-2 pt-3 border-t border-slate-50 mt-auto">
            <button
              onClick={(e) => { e.stopPropagation(); copyToClipboard(post.content); }}
              className={`flex items-center gap-1.5 text-xs font-medium transition-colors active:scale-95 p-1 sm:p-0 ${copied ? 'text-emerald-600' : 'text-slate-500 hover:text-indigo-700'}`}
              title="Copy content to clipboard" aria-label="Copy content to clipboard"
            >
              {copied ? <CheckCircle size={14} /> : <Copy size={14} />}
              <span className="hidden sm:inline">{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onUseTemplate(post); }}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-2 transition-colors"
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
          <div className="flex items-center gap-2 pt-3 border-t border-slate-50 mt-auto">
            <button
              onClick={(e) => { e.stopPropagation(); onDismissSuggestion(post); }}
              className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded-full px-3 py-2 transition-colors"
              title="Dismiss this suggestion (deletes it)" aria-label="Dismiss suggestion"
            >
              <X size={14} /> Dismiss
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onPromoteSuggestion(post); }}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-2 transition-colors"
              title="Move this draft into the client's review queue" aria-label="Use this suggestion"
            >
              <CheckCircle size={14} /> Use this
            </button>
          </div>
        )}

        {!isReadOnly && !selectable && !onUseTemplate && !isSuggestion && (
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
            {/* Changes requested → the primary action is sending the revised post
                back to the client (reset to pending), not moving toward posted. */}
            {isChangesRequested && onResubmit ? (
              <button
                onClick={(e) => { e.stopPropagation(); onResubmit(post.id); }}
                title="Send the revised post back to the client for review"
                className="flex items-center gap-1.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-full px-3 py-1.5 transition-colors"
              >
                <RefreshCw size={13} /> Back for review
              </button>
            ) : (
              <select
                value={post.status}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); onStatusChange(post.id, e.target.value); }}
                aria-label="Set post status"
                title="Set status"
                className={`text-xs font-bold rounded-full px-2.5 py-1.5 border cursor-pointer transition-colors ${statusPill}`}
              >
                <option value={STATUS.DRAFT}>Draft</option>
                <option value={STATUS.SCHEDULED}>Scheduled</option>
                <option value={STATUS.POSTED}>Posted</option>
                {isArchived && <option value={STATUS.ARCHIVED}>Archived</option>}
              </select>
            )}
          </div>
        )}

        {/* Guest reviewer quick-actions (approve / request changes from the card) */}
        {isReadOnly && (
          <div className="flex items-center gap-2 pt-3 border-t border-slate-50 mt-auto">
            {post.approvalStatus === APPROVAL_STATUS.APPROVED ? (
              <span className="flex-1 text-center text-xs font-bold text-emerald-700 bg-emerald-50 rounded-lg py-2 flex items-center justify-center gap-1"><CheckCircle size={14} /> Approved</span>
            ) : (
              <>
                <button onClick={(e) => { e.stopPropagation(); onEdit(post); }} className="flex-1 py-2 text-xs font-bold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">Request changes</button>
                <button onClick={(e) => { e.stopPropagation(); onStatusChange(post.id, STATUS.SCHEDULED); }} className="flex-1 py-2 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors flex items-center justify-center gap-1"><CheckCircle size={14} /> Approve</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default PostCard;