import { Component, lazy, Suspense, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const HelpGuides = lazy(() => import('./HelpGuides'));

class GuideBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert" className="text-slate-700">Guides could not load. Close help to keep working; preserve any unsaved text before reloading Spool.</p>
      : this.props.children;
  }
}

// The lightweight shell mounts immediately so even a slow guide chunk has Close,
// focus containment and Escape. It never uses the app's broadcast Escape hook.
export default function HelpDialog({ audience, onClose, returnFocus }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const closeCurrent = useRef(onClose);
  const restoreRef = useRef(false);
  const triggerRef = useRef(returnFocus);
  useLayoutEffect(() => { closeCurrent.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = triggerRef.current instanceof HTMLElement ? triggerRef.current : document.activeElement;
    const siblings = [...document.body.children].filter(element => element !== dialog).map(element => ({
      element, hidden: element.getAttribute('aria-hidden'), inert: element.hasAttribute('inert'),
    }));
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    for (const { element } of siblings) { element.setAttribute('aria-hidden', 'true'); element.setAttribute('inert', ''); }
    const focusClose = () => closeRef.current?.focus();
    const containFocus = event => { if (!dialog.contains(event.target)) focusClose(); };
    const keys = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        restoreRef.current = true;
        closeCurrent.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('*')]
        .filter(element => element.matches('button, input, [tabindex="0"]') && !element.disabled && !element.closest('[hidden]'));
      const first = controls[0], last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!controls.includes(active)) {
        // Topic headings are focused for orientation, but are not tab stops.
        // Explicitly find the adjacent control so Tab cannot escape to browser
        // chrome when the heading follows the final button in an article.
        const direction = event.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
        const adjacent = controls.filter(element => active?.compareDocumentPosition(element) & direction);
        const destination = event.shiftKey ? adjacent[adjacent.length - 1] || last : adjacent[0] || first;
        event.preventDefault(); destination?.focus();
      } else {
        // Safari can skip ordinary buttons under its default keyboard setting.
        // Route every Tab, not only boundary tabs, through these visible controls.
        const next = (controls.indexOf(active) + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault(); controls[next]?.focus();
      }
    };
    document.addEventListener('focusin', containFocus);
    document.addEventListener('keydown', keys, true);
    focusClose();
    return () => {
      document.removeEventListener('focusin', containFocus);
      document.removeEventListener('keydown', keys, true);
      document.body.style.overflow = previousOverflow;
      for (const { element, hidden, inert } of siblings) {
        if (hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', hidden);
        if (!inert) element.removeAttribute('inert');
      }
      const ownedFocus = dialog.contains(document.activeElement) || document.activeElement === document.body;
      if (restoreRef.current && ownedFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 p-2 sm:p-4">
      <div className="max-h-[95vh] supports-[height:100dvh]:max-h-[95dvh] w-full max-w-3xl min-w-0 overflow-y-auto overscroll-contain rounded-2xl bg-white shadow-xl [overflow-wrap:anywhere]">
        <div className="flex min-w-0 items-start justify-between gap-3 border-b border-slate-200 p-4 sm:p-6">
          <div className="min-w-0"><h2 id={titleId} className="text-xl font-bold text-slate-900">Help &amp; guides</h2><p className="mt-1 text-sm text-slate-600">Spool by Stitch TEC</p></div>
          <button ref={closeRef} type="button" onClick={() => { restoreRef.current = true; onClose(); }} aria-label="Close help" className="min-h-11 min-w-11 shrink-0 flex items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"><X size={20} aria-hidden="true" /></button>
        </div>
        <div className="min-w-0 p-4 sm:p-6"><GuideBoundary><Suspense fallback={<p role="status" className="text-slate-700">Loading guides…</p>}><HelpGuides audience={audience} /></Suspense></GuideBoundary></div>
      </div>
    </div>, document.body,
  );
}
