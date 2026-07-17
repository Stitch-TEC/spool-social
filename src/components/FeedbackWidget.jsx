import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';
import { CURRENT_APP_ID, STITCH_APPS } from '../stitch-apps';
import CharCountCircle from './CharCountCircle';
import { buildFeedbackPayload, submitFeedback } from '../lib/feedbackClient';
import { imageFileToShot, shotFromDataTransfer, capturePageShot, dataTransferHasImage } from '../lib/screenshot';

// Keep in lockstep with the broker's SCREENSHOT_MAX_B64 — reject an oversized shot in the browser
// instead of wasting a round-trip that the worker would only drop.
const MAX_SHOT_B64 = 900_000;

// Suite Feedback Widget (SUITE-ARCHITECTURE.md §4). Floating
// bottom-right button → modal that posts the canonical feedback payload to the
// shared feedback endpoint, so every app feeds one inbox in one shape.
//
// This is the SUITE feedback channel — deliberately separate from Spool's
// per-post client review / change-request flow (handleRequestChanges in App).

const MAX_MESSAGE = 1000;
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'spool@dev';
const APP_NAME = STITCH_APPS.find(a => a.id === CURRENT_APP_ID)?.name || 'Spool';

const FeedbackWidget = ({ user, role, clientId, view, showToast }) => {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('bug');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);
  // One optional screenshot (paste / drop / file-pick / one-click page capture).
  const [shot, setShot] = useState('');
  const [shotBusy, setShotBusy] = useState('');
  const fileRef = useRef(null);
  const takeShot = async (fn, busy) => {
    if (shotBusy) return; // one capture at a time — ignore a second paste/drop mid-flight
    setShotBusy(busy);
    try {
      const u = await fn();
      if (!u) return;
      if (u.length > MAX_SHOT_B64) { showToast?.('That image is too large to attach — try a smaller crop', 'error'); return; }
      setShot(u);
    }
    catch (err) { showToast?.(err?.message || 'Could not add that image', 'error'); }
    finally { setShotBusy(''); }
  };
  // Only intercept a paste/drop that actually carries an image — a text/link drop must fall through
  // to the textarea.
  const onPaste = (e) => {
    if (dataTransferHasImage(e.clipboardData)) takeShot(() => shotFromDataTransfer(e.clipboardData), 'paste');
  };
  const onDrop = (e) => {
    if (dataTransferHasImage(e.dataTransfer)) { e.preventDefault(); takeShot(() => shotFromDataTransfer(e.dataTransfer), 'drop'); }
  };
  // Close resets the optional screenshot so a stale shot never lingers into the next open. Never
  // closes mid-submit (so a typed message isn't lost).
  const close = () => { if (sending) return; setShot(''); setOpen(false); };

  // Close on Escape (but never while a submit is in flight, so we don't lose
  // the typed message). Outside-click is intentionally NOT used here — a modal
  // backdrop click is the explicit dismiss affordance.
  useEffect(() => {
    if (!open) return;
    // Inline (not `close`) so the effect doesn't depend on that function's identity — same result.
    const onKey = (e) => { if (e.key === 'Escape' && !sending) { setShot(''); setOpen(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, sending]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const text = message.trim();
    if (!text || sending) return;

    // §4 canonical payload — identical shape across every suite app, plus
    // role/clientId/view for triage (route alone can't tell grid/calendar/editor).
    const payload = buildFeedbackPayload({
      app: CURRENT_APP_ID,
      category,
      message: text,
      user: user?.email || 'anonymous',
      appVersion: APP_VERSION,
      screenshot: shot,
      extra: {
        appName: APP_NAME,
        view: view || null,
        role: role || null,
        clientId: clientId || null,
      },
    });

    setSending(true);
    try {
      const res = await submitFeedback(payload);
      // Success — reset and close. Keep the chosen category sticky for re-use.
      setMessage('');
      setShot('');
      setOpen(false);
      // Be honest if the image didn't stick (too large / storage not configured yet).
      if (shot && res && res.screenshotStored === false) showToast?.('Feedback sent — the screenshot couldn’t be attached', 'error');
      else showToast?.('Thanks — feedback sent');
    } catch (err) {
      console.error('Feedback submit failed:', err);
      // Keep the modal open and the typed message intact so it isn't lost.
      showToast?.("Couldn't send feedback — please try again", 'error');
    } finally {
      setSending(false);
    }
  };

  const categories = [
    { id: 'bug', label: 'Bug' },
    { id: 'idea', label: 'Idea' },
    { id: 'other', label: 'Other' }
  ];

  return (
    <>
      {/* Floating trigger */}
      {!open && (
        <button
          data-feedback-widget
          onClick={() => setOpen(true)}
          title="Send feedback"
          aria-label="Send feedback"
          className="fixed bottom-6 right-6 z-[55] flex items-center gap-2 bg-indigo-600 text-white pl-3 pr-4 py-3 rounded-full shadow-lg hover:bg-indigo-700 hover:scale-105 transition-transform"
        >
          <MessageSquare size={18} />
          <span className="hidden sm:inline font-bold text-sm">Feedback</span>
        </button>
      )}

      {/* Modal */}
      {open && (
        <div
          data-feedback-widget
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Send feedback"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 flex items-center gap-2">
                <MessageSquare size={18} className="text-indigo-600" /> Send feedback
              </h2>
              <button
                onClick={close}
                aria-label="Close"
                title="Close"
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} className="p-5 space-y-4">
              {/* Category */}
              <div className="flex bg-slate-100 p-1 rounded-lg">
                {categories.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCategory(c.id)}
                    className={`flex-1 py-1.5 rounded-md text-sm font-bold transition-colors ${category === c.id ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              {/* Message */}
              <div>
                <div className="relative">
                  <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE))}
                    maxLength={MAX_MESSAGE}
                    rows={4}
                    required
                    placeholder="What's working, what's broken, or what you'd love to see…"
                    className="w-full p-3 pr-12 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all resize-none"
                  />
                  <div className="absolute bottom-2 right-2">
                    <CharCountCircle current={message.length} max={MAX_MESSAGE} />
                  </div>
                </div>
              </div>

              {/* Optional one screenshot — paste, drop, file-pick, or one-click capture. */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-1">Screenshot <span className="normal-case font-normal">(optional)</span></label>
                {shot ? (
                  <div className="relative inline-block">
                    <img src={shot} alt="Attached screenshot" className="max-h-36 rounded-lg border border-slate-200" />
                    <button type="button" onClick={() => setShot('')} aria-label="Remove screenshot" className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-800/80 text-white text-xs leading-none flex items-center justify-center hover:bg-red-600">✕</button>
                  </div>
                ) : (
                  <div onClick={() => fileRef.current?.click()} className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl border border-dashed border-slate-300 text-center cursor-pointer hover:border-indigo-400 transition-colors">
                    <span className="text-[11px] text-slate-500">{shotBusy ? (shotBusy === 'capture' ? 'Capturing the page…' : 'Adding image…') : 'Paste, drop, or click to choose an image'}</span>
                    <button type="button" disabled={!!shotBusy} onClick={(e) => { e.stopPropagation(); takeShot(capturePageShot, 'capture'); }} className="text-[11px] font-bold text-indigo-600 hover:underline disabled:opacity-50">📸 Capture this page</button>
                  </div>
                )}
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) takeShot(() => imageFileToShot(f), 'file'); e.target.value = ''; }} />
              </div>

              {/* Read-only context preview — what gets attached */}
              <div className="text-[11px] text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 leading-relaxed">
                <span className="font-bold uppercase tracking-wide text-slate-400">Attached</span>
                <div className="mt-1 space-y-0.5 text-slate-500">
                  <div>App: <span className="font-medium text-slate-600">{APP_NAME}</span>{view ? <span> · {view} view</span> : null}</div>
                  <div className="truncate">Page: <span className="font-medium text-slate-600">{window.location.pathname}</span></div>
                  <div>User: <span className="font-medium text-slate-600">{user?.email || 'anonymous'}</span></div>
                  <div>Viewport: <span className="font-medium text-slate-600">{window.innerWidth}×{window.innerHeight}</span></div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  className="px-4 py-2 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending || !message.trim() || !!shotBusy}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-md hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

export default FeedbackWidget;
