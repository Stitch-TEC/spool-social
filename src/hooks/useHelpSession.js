import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const current = context => Boolean(context?.user && !context.authLoading
  && context.getCurrentUser() === context.user
  && (!context.getAuthRevision || context.getAuthRevision() === context.authRevision));

// Help owns only local UI. Never consume the handoff, edit a draft, or change a grant.
export default function useHelpSession(context) {
  const [selection, setSelection] = useState(null);
  const liveRef = useRef(null);
  const identity = JSON.stringify([
    context.user?.uid || null, context.authRevision, context.role, context.clientId,
    context.sharedUid, context.shareClientId, context.isReadOnly, context.isOperator, context.isClientMember,
  ]);
  const audience = context.isReadOnly ? 'guest'
    : context.isOperator && context.role === 'super_admin' ? 'operator'
      : context.isClientMember && ['client', 'client_admin'].includes(context.role) ? 'member' : 'unknown';
  const live = { ...context, identity, audience };
  const visible = selection?.identity === identity && selection.user === context.user && current(live) ? selection : null;
  if (selection && !visible) setSelection(null);
  useLayoutEffect(() => {
    liveRef.current = live;
    return () => { liveRef.current = null; };
  });
  const open = useCallback(event => {
    const latest = liveRef.current;
    // Existing modals use independent Escape/focus handlers. Do not nest them.
    if (!current(latest) || document.querySelector('[role="dialog"], dialog[open]')) return;
    const trigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    setSelection({ identity: latest.identity, user: latest.user, audience: latest.audience, trigger });
  }, []);
  const close = useCallback(() => setSelection(active => active === visible ? null : active), [visible]);
  return { selection: visible, open, close };
}
