import { useLayoutEffect, useRef, useState } from 'react';

// UI ownership only; never stores actor, tenant or media data. Capture handlers
// share one document, so propagation alone cannot distinguish stacked dialogs.
const dialogOwners = [];

// Local UI admission only. Retires late reads/selections and pre-dispatch work,
// not a server write already submitted. New-video API calls separately recheck
// this admission around their token await; other API writers remain separate.
export function useMediaSession(sessionKey, clientKey, isSessionCurrent) {
  const key = JSON.stringify([sessionKey, clientKey]);
  const [scope, setScope] = useState(() => ({ key }));
  if (scope.key !== key) setScope({ key });
  const currentScope = useRef(scope);
  const checker = useRef(isSessionCurrent);
  const mounted = useRef(false);
  const retired = useRef(new WeakSet());
  useLayoutEffect(() => { checker.current = isSessionCurrent; }, [isSessionCurrent]);
  useLayoutEffect(() => {
    currentScope.current = scope;
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [scope]);
  const isCurrent = () => {
    if (currentScope.current !== scope || !mounted.current || retired.current.has(scope)) return false;
    try { return !checker.current || checker.current() === true; } catch { return false; }
  };
  const retire = () => { retired.current.add(scope); };
  return { scope, isCurrent, retire };
}

// The picker nests inside Editor. Capture Escape locally so it closes only this
// dialog, rather than reaching the editor's inherited window Escape handler.
export function useMediaDialog(dialogRef, closeRef, onClose) {
  const currentClose = useRef(onClose);
  useLayoutEffect(() => { currentClose.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    const owner = { dialog };
    dialogOwners.push(owner);
    closeRef.current?.focus();
    const keydown = event => {
      if (dialogOwners[dialogOwners.length - 1] !== owner) return;
      const focusedDialog = document.activeElement?.closest?.('[role="dialog"][aria-modal="true"]');
      // A separate higher shell (for example Help) may own focus without using
      // this hook. Leave its keys alone instead of closing an underlying dialog.
      if (focusedDialog && focusedDialog !== dialog && !dialog.contains(focusedDialog)) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        currentClose.current();
      } else if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll('button, input, select, a[href], [tabindex="0"]')]
          .filter(element => {
            if (element.disabled || element.type === 'hidden' || element.closest('[hidden], [inert], .hidden')) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });
        if (!controls.length) { event.preventDefault(); return; }
        const index = controls.indexOf(document.activeElement);
        const next = index === -1 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault(); event.stopImmediatePropagation(); controls[next].focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      const ownedTop = dialogOwners[dialogOwners.length - 1] === owner;
      const index = dialogOwners.indexOf(owner);
      if (index !== -1) dialogOwners.splice(index, 1);
      if (ownedTop && (dialog.contains(document.activeElement) || document.activeElement === document.body)
        && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [dialogRef, closeRef]);
}
