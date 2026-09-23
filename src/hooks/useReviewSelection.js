import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const ACCESS_DENIED = new Set(['permission-denied', 'unauthenticated']);

// Membership is about immutable ownership and review eligibility, not the
// current content revision. The selected original content must remain the CAS
// baseline; silently replacing it would approve words the reviewer did not see.
const hasMembership = (post, context) => Boolean(
  post?.id && post.clientId && post.uid
  && post.reviewStage === 'in_review' && post.source !== 'suggestion'
  && post.clientId === context.shareClientId && post.uid === context.sharedUid
  && context.posts.some(live => live.id === post.id
    && live.clientId === post.clientId && live.uid === post.uid
    && live.reviewStage === 'in_review' && live.source !== 'suggestion'),
);
const sessionCurrent = context => Boolean(context?.allowed
  && (!context.getAuthRevision || context.getAuthRevision() === context.authRevision));

/** Own only the guest review selection and its UI completion, not the write. */
export default function useReviewSelection({
  user, authRevision, getAuthRevision, authLoading, role, clientId,
  sharedUid, shareClientId, isReadOnly, isOperator, isClientMember, posts, error,
}) {
  const [selection, setSelection] = useState(null);
  const sequenceRef = useRef(0);
  const selectionRef = useRef(null);
  const liveRef = useRef(null);
  const identity = JSON.stringify([
    user?.uid || null, authRevision ?? null, role ?? null, clientId || null,
    sharedUid || null, shareClientId || null, isReadOnly, isOperator, isClientMember,
  ]);
  const context = {
    user, identity, authRevision, getAuthRevision, sharedUid, shareClientId, posts,
    allowed: !!user && !authLoading && isReadOnly && !ACCESS_DENIED.has(error?.code),
  };
  const visible = selection && selection.user === user && selection.identity === identity
    && sessionCurrent(context) && hasMembership(selection.post, context)
    ? selection : null;

  if (selection && !visible) {
    // Retire during this render, not only in an effect: returning to the old
    // viewer/scope or seeing the same ID again must not resurrect old feedback.
    setSelection(null);
  }

  useLayoutEffect(() => {
    liveRef.current = context;
    selectionRef.current = visible;
    return () => { liveRef.current = null; selectionRef.current = null; };
  });

  const isCurrent = useCallback(expected => {
    const live = liveRef.current;
    return Boolean(expected && selectionRef.current === expected && sessionCurrent(live)
      && expected.user === live.user && expected.identity === live.identity
      && hasMembership(expected.post, live));
  }, []);

  const open = useCallback(post => {
    const live = liveRef.current;
    if (!sessionCurrent(live) || !hasMembership(post, live)) return;
    const next = { post, user: live.user, identity: live.identity, sequence: ++sequenceRef.current };
    // Event-time ownership matters too: old promises may settle in the same
    // React batch as close/reopen, before a new layout effect has committed.
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const close = useCallback(expected => {
    if (!expected || selectionRef.current !== expected) return;
    selectionRef.current = null;
    setSelection(current => current === expected ? null : current);
  }, []);

  return { selection: visible, open, close, isCurrent };
}
