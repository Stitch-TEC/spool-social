import { useLayoutEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

const button = 'min-h-11 rounded-xl px-3 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700';

// Fixed messages deliberately exclude raw query strings, auth/provider errors,
// and unverified client names. This is navigation, never an access grant.
export default function ClientHandoffNotice({ handoff, onContinue, onRetry, onRevalidate, onGateUnmount, readyRef, canRetry = false }) {
  const heading = useRef(null);
  const gate = useRef(null);
  const pending = handoff.status === 'pending';
  const ready = handoff.status === 'ready';
  useLayoutEffect(() => {
    if (!ready) heading.current?.focus();
  }, [ready, handoff.status, handoff.code]);
  useLayoutEffect(() => {
    const panel = gate.current;
    return () => {
      if (panel?.contains(document.activeElement)) onGateUnmount?.(document.activeElement);
    };
  }, [onGateUnmount]);

  if (ready) return (
    <section ref={readyRef} tabIndex={-1} aria-label="Client opened from a link" className="border-b border-indigo-200 bg-indigo-50 px-4 py-3 text-indigo-950 focus:outline-none sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="min-w-0 text-sm [overflow-wrap:anywhere]">Client selected from a link: <strong>{handoff.clientName}</strong></p>
        <button type="button" className={`${button} border border-indigo-300 bg-white`} onClick={onContinue}>Show all clients</button>
      </div>
      <details className="mt-1 text-sm">
        <summary className="min-h-11 cursor-pointer content-center font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700">Missing an older draft?</summary>
        <p className="max-w-2xl pb-2">This view uses the client’s current Spool name. Drafts saved under an older name may be elsewhere. Show all clients to look for them. No drafts were moved or changed.</p>
      </details>
    </section>
  );

  let title = 'This client link could not be verified';
  let message = 'Spool has not selected a client. You can continue to Spool and choose a client yourself. No drafts were changed.';
  if (pending) {
    title = 'Opening this client in Spool';
    message = 'Checking your Spool access and matching this client. Nothing has been changed.';
  } else if (handoff.code === 'operator_required') {
    title = 'This link is for the operator workspace';
    message = 'Your existing Spool access has not changed. Continue to your workspace to use the content already available to you.';
  } else if (handoff.status === 'retired') {
    title = 'Your sign-in changed';
    message = 'For safety, this client link was not applied to your new session. Continue to Spool to choose what to open.';
  } else if (handoff.code === 'content_conflict') {
    title = 'This client needs a mapping check';
    message = 'Some loaded Spool records use this name with a different client ID. Continue to Spool to review those records before drafting. Nothing was moved or changed.';
  } else if (handoff.canRevalidate) {
    title = 'Confirm this client';
    message = 'The client details changed or an earlier check failed. Review the verified name below before opening its view.';
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-3 text-slate-900">
      <section ref={gate} aria-labelledby="client-handoff-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-8 [overflow-wrap:anywhere]">
        <p className="mb-4 text-sm font-bold text-indigo-700">Stitch TEC · Spool</p>
        <h1 id="client-handoff-title" ref={heading} tabIndex={-1} className="text-xl font-bold focus:outline-none sm:text-2xl">{title}</h1>
        <div role="status" aria-live="polite" className="mt-3 text-sm leading-6 text-slate-700">
          {pending && <Loader2 aria-hidden="true" className="mb-2 h-5 w-5 animate-spin motion-reduce:animate-none" />}
          <p>{message}</p>
        </div>
        {handoff.canRevalidate && <p className="mt-4 rounded-lg bg-indigo-50 p-3 font-bold text-indigo-950">{handoff.candidateName}</p>}
        <div className="mt-6 flex flex-wrap gap-3">
          {handoff.canRevalidate && <button type="button" className={`${button} bg-indigo-700 text-white hover:bg-indigo-800`} onClick={onRevalidate}>Open verified client</button>}
          {!pending && !handoff.canRevalidate && canRetry && <button type="button" className={`${button} bg-indigo-700 text-white hover:bg-indigo-800`} onClick={onRetry}>Retry client check</button>}
          <button type="button" className={`${button} border border-slate-400 bg-white text-slate-800 hover:bg-slate-100`} onClick={onContinue}>Continue to Spool</button>
        </div>
      </section>
    </main>
  );
}
