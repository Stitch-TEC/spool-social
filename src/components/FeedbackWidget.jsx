import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';
import { CURRENT_APP_ID, STITCH_APPS } from '../stitch-apps';
import CharCountCircle from './CharCountCircle';

// Suite Feedback Widget (SUITE-SHARED-COMPONENTS-PLAN.md §4). Floating
// bottom-right button → modal that posts the canonical feedback payload to the
// shared feedback endpoint, so every app feeds one inbox in one shape.
//
// This is the SUITE feedback channel — deliberately separate from Spool's
// per-post client review / change-request flow (handleRequestChanges in App).

const MAX_MESSAGE = 1000;
const FEEDBACK_URL = import.meta.env.VITE_FEEDBACK_URL || 'https://feedback.stitchtec.dev/feedback';
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'spool@dev';
const APP_NAME = STITCH_APPS.find(a => a.id === CURRENT_APP_ID)?.name || 'Spool';

const FeedbackWidget = ({ user, role, clientId, view, showToast }) => {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('bug');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);

  // Close on Escape (but never while a submit is in flight, so we don't lose
  // the typed message). Outside-click is intentionally NOT used here — a modal
  // backdrop click is the explicit dismiss affordance.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !sending) setOpen(false); };
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
    const payload = {
      app: CURRENT_APP_ID,
      appName: APP_NAME,
      category,
      message: text,
      page: window.location.href,
      route: window.location.pathname,
      view: view || null,
      user: user?.email || 'anonymous',
      role: role || null,
      clientId: clientId || null,
      appVersion: APP_VERSION,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      ts: new Date().toISOString()
    };

    setSending(true);
    try {
      const res = await fetch(FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`Feedback endpoint returned ${res.status}`);
      // Success — reset and close. Keep the chosen category sticky for re-use.
      setMessage('');
      setOpen(false);
      showToast?.('Thanks — feedback sent');
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
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Send feedback"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) setOpen(false); }}
        >
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <h2 className="font-bold text-slate-900 flex items-center gap-2">
                <MessageSquare size={18} className="text-indigo-600" /> Send feedback
              </h2>
              <button
                onClick={() => { if (!sending) setOpen(false); }}
                aria-label="Close"
                title="Close"
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
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
                  onClick={() => { if (!sending) setOpen(false); }}
                  className="px-4 py-2 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending || !message.trim()}
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
