import { useState, useEffect, useRef } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../config/firebase';
import { OPERATOR_UID } from '../config/roles';
import { versionMediaUrl, versionSpoolMediaContent } from '../utils/helpers';
import { displayReviewScheduledDateAsDate } from '../utils/reviewIdentity';

// Firestore TERMINATES a listener when it errors and never re-attaches it. The
// dashboard's banner promised "Retrying automatically…" and nothing was: one
// transient blip (or a listener that raced ahead of the guest's sign-in) froze the
// workspace on stale data until a manual reload, with a message actively saying
// otherwise. These are the codes that can clear on their own — a permission error
// never will, so retrying it would just be a hot loop against the rules engine.
const RETRYABLE_CODES = new Set(['unavailable', 'resource-exhausted', 'aborted', 'internal', 'deadline-exceeded']);
const ACCESS_DENIED_CODES = new Set(['permission-denied', 'unauthenticated']);
const MAX_RETRIES = 6;
const emptySnapshot = (scopeKey, user = null) => ({
  scopeKey, user, posts: [], clientMap: {}, hasLoaded: false, error: null, isStalled: false,
});
const EMPTY_SNAPSHOT = emptySnapshot(null);

/**
 * Real-time posts + client-branding subscriptions for a workspace.
 *
 * Security model (mirrors firestore.rules):
 * - Operator: all posts + every client's branding (scoped by uid == OWNER_UID).
 * - Client member: their own clientId's in-review posts + branding.
 * - Share guest: their token's clientId, owner uid, and in-review posts.
 * Queries MUST filter so the rule resolves against the result set — the
 * immutable clientId is the scope key (never the free-text client name).
 */
export default function usePosts(user, sharedUid, clientId, shareClientId, isOperator = false, {
  authRevision, getAuthRevision, authLoading = false,
} = {}) {
  const [snapshotState, setSnapshotState] = useState(EMPTY_SNAPSHOT);
  // Bumping this re-runs the subscribe effect — the re-attach Firestore won't do.
  const [retryTick, setRetryTick] = useState(0);
  // Live updates have stopped for good: either the error can't clear on its own
  // (permission-denied — a revoked share link, a withdrawn grant) or the backoff
  // ladder ran out. State, not a derived ref read, so the UI actually re-renders
  // when it flips — and so it can offer a reload instead of a reassuring lie.
  const retriesRef = useRef({ scopeKey: null, user: null, count: 0, denied: false });

  // The operator query pins to the CANONICAL owner uid, not the signer's. Every post in Spool is
  // stamped `uid: OPERATOR_UID` by design (App.jsx — one attribution so the operator query and the
  // per-client review token both resolve across multi-author content), and firestore.rules admits
  // any isSuperAdmin() reader regardless of uid. Querying the signer's own uid therefore returned
  // NOTHING for a second super_admin: a fully-authorized operator saw a completely empty workspace,
  // with no error to explain it. Guests still use their share uid; members scope by clientId.
  const targetUid = sharedUid || (isOperator ? OPERATOR_UID : user?.uid);
  const isGuest = !!sharedUid && sharedUid !== user?.uid;
  const isClientMember = !isGuest && !!clientId;
  // Guests AND client members scope by the immutable clientId (matching the
  // firestore.rules guest + isEntityMember reads); the operator reads by uid.
  const scopeClientId = isClientMember ? clientId : (isGuest ? shareClientId : null);
  // 🔒 SECURITY: a guest with no clientId scope (e.g. a legacy ?uid= link, or a
  // link minted before the clientId re-key) reads nothing.
  const guestBlocked = isGuest && !shareClientId;
  // A CLIENTID-SCOPED subscription needs a signed-in principal for the rules to
  // resolve against. useAuth sets the share scope BEFORE signInWithCustomToken
  // resolves, so this used to open the guest listener while auth.currentUser was
  // still null: Firestore denied it, terminated the listener, and none of the
  // effect's deps changed when the guest actually signed in — a permanently empty
  // review page. Gating on `user` (with user.uid in the deps below) makes the
  // listener wait for the session it needs.
  const sessionCurrent = !getAuthRevision || getAuthRevision() === authRevision;
  const shouldSubscribe = !!user && !authLoading && sessionCurrent && !guestBlocked
    && (scopeClientId ? !!user : (!isGuest && !!targetUid));
  // Keep ownership with the data, not just with the listener. Effects run after
  // render: clearing old state only in cleanup would expose it for one render
  // under a new principal/tenant. The existing auth revision also separates
  // same-UID sign-out/sign-in sessions, including changes batched by React.
  const scopeKey = JSON.stringify([
    user?.uid || null, sharedUid || null, clientId || null, shareClientId || null,
    isOperator, authRevision ?? null, authLoading, shouldSubscribe,
  ]);
  if (snapshotState.scopeKey !== scopeKey || snapshotState.user !== user) {
    // Conditional ownership reset during render avoids a stale-data commit and
    // clears the prior in-memory snapshot even when the next listener never
    // answers. The returned-data fence below also covers this current render.
    setSnapshotState(emptySnapshot(scopeKey, user));
  }

  useEffect(() => {
    if (retriesRef.current.scopeKey !== scopeKey || retriesRef.current.user !== user) {
      retriesRef.current = { scopeKey, user, count: 0, denied: false };
    }
    if (!shouldSubscribe) {
      if (guestBlocked) console.warn("⛔ ACCESS DENIED: Missing clientId scope for guest.");
      return;
    }
    // A retry tick queued just before an explicit denial must not re-open the
    // same denied scope after cleanup. Only a new scope/session clears this.
    if (retriesRef.current.denied) return;

    let active = true;
    let accessDenied = false;
    let postsTerminated = false;
    let firstPostsSnapshot = true;
    let firstBrandingSnapshot = true;
    let retryTimer = null;
    const brandingDocs = new Map();
    const isCurrent = () => active && (!getAuthRevision || getAuthRevision() === authRevision);
    const updateCurrent = (update, allowDenied = false) => {
      if (!isCurrent() || (accessDenied && !allowDenied)) return;
      setSnapshotState(previous => {
        if (!isCurrent() || (accessDenied && !allowDenied)) return previous;
        return update(previous.scopeKey === scopeKey && previous.user === user
          ? previous : emptySnapshot(scopeKey, user));
      });
    };
    const denyAccess = (err) => {
      accessDenied = true;
      postsTerminated = true;
      retriesRef.current.denied = true;
      if (retryTimer) clearTimeout(retryTimer);
      // An explicit auth denial is not a connection warning. Neither the last
      // posts nor branding may keep displaying, and the other listener cannot
      // repopulate this attempt. A new authenticated scope or reload is needed.
      updateCurrent(previous => ({
        ...previous, posts: [], clientMap: {}, error: err, hasLoaded: true, isStalled: true,
      }), true);
    };

    // Scope by clientId + in_review (guest + client member) or by uid (operator). GUESTS additionally filter by
    // the owner uid: the rules' isShareGuest requires shareOwner == resource.data.uid, and Firestore
    // list evaluation can't prove that from a clientId-only query ("rules are not filters") — without
    // the uid clause the guest subscription is permission-denied wholesale. Members must NOT get the
    // uid filter (their targetUid is their own uid; posts carry the owner's).
    const constraints = scopeClientId
      ? (isGuest
          ? [where('clientId', '==', scopeClientId), where('uid', '==', targetUid), where('reviewStage', '==', 'in_review')]
          : [where('clientId', '==', scopeClientId), where('reviewStage', '==', 'in_review')])
      : [where('uid', '==', targetUid)];

    const q = query(collection(db, 'posts'), ...constraints);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!isCurrent() || postsTerminated) return;
      const replace = firstPostsSnapshot;
      firstPostsSnapshot = false;
      const changes = snapshot.docChanges();
      // ⚡ docChanges() gives O(M) updates: unchanged docs keep their object
      // (and Date) references, so memoized children don't re-render.
      updateCurrent(previous => {
        const previousPosts = new Map(previous.posts.map(post => [post.id, post]));
        // A newly attached listener starts with "added" changes for its WHOLE
        // result, not removals from the previous listener. Replace membership on
        // that first snapshot (including an empty one), also after a retry.
        const postMap = replace ? new Map() : new Map(previousPosts);

        let hasChanges = false;

        changes.forEach(change => {
          if (change.type === 'added' || change.type === 'modified') {
            const data = change.doc.data();
            const existing = previousPosts.get(change.doc.id);

            // Preserve Date object references by comparing raw strings.
            const getStableDate = (newVal, field) => {
              if (!newVal) return null;
              if (existing && existing[`_raw_${field}`] === newVal) {
                return existing[field];
              }
              // Firestore may return a Timestamp object. Date(Timestamp) is
              // invalid in the browser, which used to erase the hook baseline
              // even though the transaction still saw the real schedule. This
              // read path also tolerates the exact datetime-local shape written
              // by older Spool builds; approval identity remains strict.
              const d = field === 'scheduledDate'
                ? displayReviewScheduledDateAsDate(newVal)
                : new Date(newVal);
              return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
            };

            const scheduledDate = getStableDate(data.scheduledDate, 'scheduledDate');
            const createdAt = getStableDate(data.createdAt, 'createdAt') || new Date();
            // Media migration parsing used to run twice for every document in
            // the initial snapshot (once for display, once for search). Besides
            // doubling the work, that made a 400-post workspace a large
            // synchronous allocation spike on iPhone Safari. Normalize once and
            // reuse the exact string for both fields.
            const content = versionSpoolMediaContent(data.content || '');

            // Pre-calculate numeric timestamp for O(1) sort comparisons.
            const _sortTs = (scheduledDate || createdAt).getTime();

            postMap.set(change.doc.id, {
              id: change.doc.id,
              ...data,
              // Old /media URLs were browser-cacheable for one year. Read them
              // through the v2 cache key without mutating Firestore so the SPA
              // never reuses an already-cached legacy response.
              imageUrl: versionMediaUrl(data.imageUrl || ''),
              content,
              scheduledDate,
              createdAt,
              _raw_scheduledDate: data.scheduledDate,
              _raw_createdAt: data.createdAt,
              _sortTs,
              // Cached lowercase fields for fast search filtering. Title is folded
              // into content so long-form posts are findable by their headline.
              _searchContent: `${data.title || ""}\n${content}`.toLowerCase(),
              _searchClient: String(data.client || "").toLowerCase(),
              // A malformed legacy row must not make PostCard call slice/map on
              // a non-array and take down the full feed.
              tags: Array.isArray(data.tags)
                ? data.tags.filter((tag) => typeof tag === 'string').slice(0, 10)
                : [],
            });
            hasChanges = true;
          } else if (change.type === 'removed') {
            postMap.delete(change.doc.id);
            hasChanges = true;
          }
        });

        let posts = previous.posts;
        if (replace || hasChanges) {
          posts = Array.from(postMap.values());
          posts.sort((a, b) => b._sortTs - a._sortTs);
        }
        return { ...previous, posts, error: null, isStalled: false, hasLoaded: true };
      });

      retriesRef.current.count = 0; // a good snapshot clears the backoff ladder
    }, (err) => {
      if (!isCurrent() || postsTerminated) return;
      postsTerminated = true;
      console.error("🔥 Firestore Error:", err);
      if (ACCESS_DENIED_CODES.has(err?.code)) { denyAccess(err); return; }
      // Re-attach on codes that can clear by themselves, with capped exponential
      // backoff (1s → 30s, ~6 attempts). Anything else is left terminal and the UI
      // says so rather than claiming a retry that will never succeed.
      const isStalled = !RETRYABLE_CODES.has(err?.code) || retriesRef.current.count >= MAX_RETRIES;
      updateCurrent(previous => ({ ...previous, error: err, hasLoaded: true, isStalled }));
      if (isStalled) return;
      const delay = Math.min(30000, 1000 * 2 ** retriesRef.current.count);
      retriesRef.current.count += 1;
      retryTimer = setTimeout(() => { if (isCurrent() && !accessDenied) setRetryTick(t => t + 1); }, delay);
    });

    // 🔒 Client branding scoped to the workspace owner (multi-tenant isolation).
    // Keyed by client *name* so lookups by post.client resolve, even though the
    // doc id is `${uid}__${name}` (see ClientSettingsModal). Guests may read only
    // their own client's branding, so scope the query by name too.
    // Same guest uid-clause as the posts query above (rules list satisfiability).
    const clientConstraints = scopeClientId
      ? (isGuest
          ? [where('clientId', '==', scopeClientId), where('uid', '==', targetUid)]
          : [where('clientId', '==', scopeClientId)])
      : [where('uid', '==', targetUid)];
    const clientQuery = query(collection(db, 'clients'), ...clientConstraints);
    const clientUnsub = onSnapshot(clientQuery, (snapshot) => {
      if (!isCurrent() || accessDenied) return;
      const changes = snapshot.docChanges();
      if (!firstBrandingSnapshot && !changes.length) return;
      firstBrandingSnapshot = false;
      // This map belongs to ONE listener attempt and starts empty. Keep document
      // identity until deriving the name lookup so a rename also removes its old
      // name, and an empty initial result clears branding from a previous retry.
      for (const change of changes) {
        if (change.type === 'added' || change.type === 'modified') brandingDocs.set(change.doc.id, change.doc.data());
        else if (change.type === 'removed') brandingDocs.delete(change.doc.id);
      }
      const clientMap = Object.fromEntries([...brandingDocs.values()].filter(data => data.name).map(data => [data.name, data]));
      updateCurrent(previous => ({ ...previous, clientMap }));
    }, (err) => {
      if (!isCurrent() || accessDenied) return;
      console.error("🔥 Clients fetch error:", err);
      if (ACCESS_DENIED_CODES.has(err?.code)) denyAccess(err);
    });

    return () => {
      active = false;
      unsubscribe();
      clientUnsub();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [shouldSubscribe, guestBlocked, targetUid, scopeClientId, isGuest, isOperator, user, scopeKey, authRevision, getAuthRevision, retryTick]);

  const current = shouldSubscribe && sessionCurrent && snapshotState.scopeKey === scopeKey && snapshotState.user === user
    ? snapshotState : EMPTY_SNAPSHOT;
  // Loading = an active subscription that hasn't delivered its first snapshot.
  const isLoading = shouldSubscribe && !current.hasLoaded;

  return { posts: current.posts, clientMap: current.clientMap, isLoading, error: current.error, isStalled: current.isStalled };
}
