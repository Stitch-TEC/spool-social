import React, { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Mail } from 'lucide-react';
import { senderEmailPreview } from '../utils/generationApi';

/**
 * "Email" preview tab: shows the draft as the EMAIL it would become if pushed
 * to Sender — rendered by Sender's real pipeline (sanitize → 600px scaffold →
 * merge tags) with the client's tenant branding, relayed through the broker.
 * A network render, so it snapshots on mount + manual Refresh rather than
 * re-rendering per keystroke; switching tabs re-mounts (and re-renders) it.
 */
// The seam speaks in wire codes; the operator reads sentences. Unmapped
// messages (roster/auth errors) are already human-written server-side.
const ERROR_TEXT = {
  html_too_large: 'This draft is too large to render as an email preview.',
  preview_too_large: 'This draft is too large to render as an email preview.',
  sender_unreachable: 'Sender couldn’t be reached — try Refresh in a moment.',
  not_configured: 'The suite seam isn’t configured for previews yet.',
  sender_not_configured: 'The suite seam isn’t configured for previews yet.',
  unknown_client: 'This client isn’t on the suite roster.',
};
const humanError = (msg) => {
  const m = String(msg || '');
  if (ERROR_TEXT[m]) return ERROR_TEXT[m];
  if (m.startsWith('sender_bad_response')) return ERROR_TEXT.sender_unreachable;
  return m || 'Preview failed';
};

const SenderEmailPreview = ({ draft }) => {
  const [state, setState] = useState({ loading: true, html: '', tenant: true, heroOmitted: false, error: '', empty: false });
  // The draft prop updates every parent render — the Refresh button should use
  // the LATEST fields, not the ones captured at mount. (Assigned in an effect:
  // writing a ref during render is a react-hooks/refs lint error.)
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  });

  // No synchronous setState here: the initial state is already loading:true
  // for the mount fetch, and Refresh flips it in its own click handler —
  // setState inside an effect body is a react-hooks/set-state-in-effect error.
  const load = async () => {
    try {
      const out = await senderEmailPreview(draftRef.current);
      setState({ loading: false, html: out.html || '', tenant: out.tenant !== false, heroOmitted: out.heroOmitted === true, error: '', empty: false });
    } catch (err) {
      const msg = String(err?.message || '');
      // A brand-new draft with no content is an expected state, not a failure.
      const empty = msg.startsWith('Nothing to preview');
      setState({ loading: false, html: '', tenant: true, heroOmitted: false, error: empty ? msg : humanError(msg), empty });
    }
  };

  const refresh = () => {
    setState((s) => ({ ...s, loading: true, error: '', empty: false }));
    load();
  };

  useEffect(() => {
    load();
    // Mount-only by design (see the component comment).
  }, []);

  return (
    <div className="w-full h-full flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between gap-2 shrink-0">
        <p className="text-xs text-slate-500 flex items-center gap-1.5 min-w-0">
          <Mail size={12} className="shrink-0" />
          <span className="truncate">
            Rendered by Sender&apos;s real email pipeline — sample contact &ldquo;Alex Rivera&rdquo; stands in.
            {!state.loading && !state.error && !state.tenant && (
              <span className="text-amber-600"> Generic branding — this client has no Sender workspace yet.</span>
            )}
            {!state.loading && !state.error && state.heroOmitted && (
              <span className="text-amber-600"> Hero image omitted — it&apos;s still uploading (or too large); it WILL ride the real push once hosted.</span>
            )}
          </span>
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={state.loading}
          className="flex items-center gap-1 text-indigo-600 text-xs font-bold hover:underline disabled:opacity-50 shrink-0"
        >
          <RefreshCw size={12} className={state.loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {state.loading ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm gap-2">
            <Loader2 size={16} className="animate-spin" /> Rendering email…
          </div>
        ) : state.error ? (
          <div className="h-full flex items-center justify-center p-6">
            <p className={`text-sm text-center ${state.empty ? 'text-slate-400' : 'text-rose-600'}`}>{state.error}</p>
          </div>
        ) : (
          <iframe
            title="Email preview"
            // Sandbox the render: it's Sender-sanitized, but this authenticated
            // SPA origin should never execute script from ANY srcDoc.
            sandbox=""
            className="w-full h-full border-0 bg-white"
            srcDoc={state.html}
          />
        )}
      </div>
    </div>
  );
};

export default SenderEmailPreview;
