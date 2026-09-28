import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inspectHandoffContent, parseClientHandoff, resolveClientHandoff } from '../utils/clientHandoff';

export const CLIENT_HANDOFF_WAIT_MS = 30000;
const revisionCurrent = context => {
  try {
    if (typeof context.getAuthRevision !== 'function' || context.getAuthRevision() !== context.authRevision) return false;
    if (typeof context.getCurrentUser !== 'function' || context.getCurrentUser() !== context.user) return false;
    return true;
  } catch { return false; }
};
const principal = context => JSON.stringify([
  context.user?.uid || null, context.user?.email || null, context.authRevision ?? null,
  context.role ?? null, context.clientId || null, context.sharedUid || null,
  context.shareClientId || null, context.isOperator === true, context.isReadOnly === true,
  context.scopeKey,
]);

/**
 * Own a URL's one-time navigation intent, not authentication or data writes.
 * The caller must gate ordinary content while active && status !== 'ready',
 * and derive the active client name directly from this return, never an effect.
 */
export default function useClientHandoff(context) {
  const { search, user, authLoading, isOperator, isReadOnly, roster, scopeKey } = context;
  const [state, setState] = useState(() => ({
    search, intent: parseClientHandoff(search), owner: null,
    retired: false, dismissed: false, acceptedName: null, review: false, expired: false, epoch: 0,
  }));
  const liveRef = useRef(null);
  let next = state;
  const identity = principal(context);
  const current = revisionCurrent(context);
  const present = state.intent.status !== 'absent';
  if (present && !state.dismissed && !state.retired) {
    if (search !== state.search || (state.owner !== null && (state.owner !== identity || authLoading || !current))) {
      next = { ...next, retired: true, epoch: next.epoch + 1 };
    } else if (state.owner === null && user?.uid && !authLoading && current) {
      next = { ...next, owner: identity, epoch: next.epoch + 1 };
    }
  }

  let resolution = null;
  let contentResult = null;
  let status = 'absent', code = null;
  if (present && next.dismissed) status = 'dismissed';
  else if (present && next.retired) { status = 'retired'; code = 'session_changed'; }
  else if (present) {
    if (next.intent.status === 'blocked') { status = 'blocked'; code = next.intent.code; }
    else if (authLoading || !current) { status = 'pending'; code = 'auth_loading'; }
    else if (!user?.uid) { status = 'pending'; code = 'sign_in_required'; }
    else if (!isOperator || isReadOnly || context.sharedUid || context.shareClientId) { status = 'blocked'; code = 'operator_required'; }
    else {
      resolution = resolveClientHandoff(next.intent, roster, scopeKey);
      if (resolution.status === 'resolved') {
        contentResult = inspectHandoffContent({ ...context.content, clientName: resolution.name, slug: resolution.slug });
        if (next.acceptedName !== null && next.acceptedName !== resolution.name && !next.review) {
          next = { ...next, review: true, epoch: next.epoch + 1 };
        }
        if (contentResult.status !== 'ready') {
          status = contentResult.status; code = contentResult.code;
          if (status === 'blocked' && !next.review) next = { ...next, review: true, epoch: next.epoch + 1 };
        }
        else if (next.review || next.expired) { status = 'blocked'; code = 'review_required'; }
        else {
          status = 'ready';
          if (next.acceptedName === null) next = { ...next, acceptedName: resolution.name };
        }
      } else {
        status = resolution.status; code = resolution.code;
        if (status === 'blocked' && !next.review) next = { ...next, review: true, epoch: next.epoch + 1 };
      }
    }
    if (next.expired && status === 'pending') { status = 'blocked'; code = 'wait_expired'; }
  }
  // Retire observed lifetimes during render. An A→B→A return or a repaired
  // roster must not revive selection/consent from an earlier render.
  if (next !== state) setState(next);
  const active = present && !next.dismissed;
  const canRevalidate = active && !next.retired && next.intent.status === 'requested'
    && !!user?.uid && !authLoading && current && isOperator && !isReadOnly
    && !context.sharedUid && !context.shareClientId && resolution?.status === 'resolved' && contentResult?.status === 'ready';
  const viewKey = JSON.stringify([
    next.epoch, identity, status, code, resolution?.name || null, roster?.readVersion || null,
  ]);
  const selectionKey = status === 'ready' ? viewKey : null;
  const live = { context, state: next, identity, viewKey, selectionKey, status, canRevalidate, resolution };
  useLayoutEffect(() => {
    liveRef.current = live;
    return () => { liveRef.current = null; };
  });

  const ownsCurrentView = useCallback(() => {
    const latest = liveRef.current;
    return latest && latest.viewKey === viewKey && revisionCurrent(latest.context) ? latest : null;
  }, [viewKey]);
  const isCurrent = useCallback((expected = selectionKey) => {
    const latest = ownsCurrentView();
    return Boolean(expected && latest?.selectionKey === expected && latest.status === 'ready');
  }, [ownsCurrentView, selectionKey]);
  const dismiss = useCallback(() => {
    const latest = ownsCurrentView();
    if (!latest || latest.state.dismissed) return false;
    const dismissed = { ...latest.state, dismissed: true, epoch: latest.state.epoch + 1 };
    // Invalidate same-tick captured actions, before the next React render.
    liveRef.current = null;
    setState(dismissed);
    return true;
  }, [ownsCurrentView]);
  const revalidate = useCallback(() => {
    const latest = ownsCurrentView();
    if (!latest?.canRevalidate || latest.status === 'ready') return false;
    const reviewed = { ...latest.state, review: false, expired: false,
      acceptedName: latest.resolution.name, epoch: latest.state.epoch + 1 };
    liveRef.current = null;
    setState(reviewed);
    return true;
  }, [ownsCurrentView]);

  const waiting = active && status === 'pending' && code !== 'sign_in_required';
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => {
      const latest = liveRef.current;
      if (!latest || latest.viewKey !== viewKey) return;
      const expired = { ...latest.state, expired: true, review: true, epoch: latest.state.epoch + 1 };
      liveRef.current = null;
      setState(expired);
    }, CLIENT_HANDOFF_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting, viewKey]);

  return {
    active, status, code, slug: next.intent.status === 'requested' ? next.intent.slug : null,
    clientName: status === 'ready' ? resolution.name : null,
    selectionKey, canRevalidate, candidateName: canRevalidate ? resolution.name : null, isCurrent, dismiss, revalidate,
  };
}
