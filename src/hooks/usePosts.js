import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../config/firebase';

/**
 * Real-time posts + client-branding subscriptions for a workspace.
 *
 * Security model (mirrors firestore.rules):
 * - Operator: all posts + every client's branding (scoped by uid == OWNER_UID).
 * - Client member: only their own clientId's posts + branding (where clientId ==).
 * - Share guest: only their token's clientId (where clientId == shareClientId).
 * Queries MUST filter so the rule resolves against the result set — the
 * immutable clientId is the scope key (never the free-text client name).
 */
export default function usePosts(user, sharedUid, clientId, shareClientId) {
  const [posts, setPosts] = useState([]);
  const [clientMap, setClientMap] = useState({});
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState(null);

  const targetUid = sharedUid || user?.uid;
  const isGuest = !!sharedUid && sharedUid !== user?.uid;
  const isClientMember = !isGuest && !!clientId;
  // Guests AND client members scope by the immutable clientId (matching the
  // firestore.rules guest + isEntityMember reads); the operator reads by uid.
  const scopeClientId = isClientMember ? clientId : (isGuest ? shareClientId : null);
  // 🔒 SECURITY: a guest with no clientId scope (e.g. a legacy ?uid= link, or a
  // link minted before the clientId re-key) reads nothing.
  const guestBlocked = isGuest && !shareClientId;
  const shouldSubscribe = !guestBlocked && (scopeClientId ? true : (!isGuest && !!targetUid));

  useEffect(() => {
    if (!shouldSubscribe) {
      if (guestBlocked) console.warn("⛔ ACCESS DENIED: Missing clientId scope for guest.");
      return;
    }

    // Scope by clientId (guest + client member) or by uid (operator). GUESTS additionally filter by
    // the owner uid: the rules' isShareGuest requires shareOwner == resource.data.uid, and Firestore
    // list evaluation can't prove that from a clientId-only query ("rules are not filters") — without
    // the uid clause the guest subscription is permission-denied wholesale. Members must NOT get the
    // uid filter (their targetUid is their own uid; posts carry the owner's).
    const constraints = scopeClientId
      ? (isGuest
          ? [where('clientId', '==', scopeClientId), where('uid', '==', targetUid)]
          : [where('clientId', '==', scopeClientId)])
      : [where('uid', '==', targetUid)];

    const q = query(collection(db, 'posts'), ...constraints);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      // ⚡ docChanges() gives O(M) updates: unchanged docs keep their object
      // (and Date) references, so memoized children don't re-render.
      setPosts(prevPosts => {
        const postMap = new Map();
        prevPosts.forEach(p => postMap.set(p.id, p));

        let hasChanges = false;

        snapshot.docChanges().forEach(change => {
          if (change.type === 'added' || change.type === 'modified') {
            const data = change.doc.data();
            const existing = postMap.get(change.doc.id);

            // Preserve Date object references by comparing raw strings.
            const getStableDate = (newVal, field) => {
              if (!newVal) return null;
              if (existing && existing[`_raw_${field}`] === newVal) {
                return existing[field];
              }
              const d = new Date(newVal);
              return isNaN(d.getTime()) ? null : d;
            };

            const scheduledDate = getStableDate(data.scheduledDate, 'scheduledDate');
            const createdAt = getStableDate(data.createdAt, 'createdAt') || new Date();

            // Pre-calculate numeric timestamp for O(1) sort comparisons.
            const _sortTs = (scheduledDate || createdAt).getTime();

            postMap.set(change.doc.id, {
              id: change.doc.id,
              ...data,
              scheduledDate,
              createdAt,
              _raw_scheduledDate: data.scheduledDate,
              _raw_createdAt: data.createdAt,
              _sortTs,
              // Cached lowercase fields for fast search filtering.
              _searchContent: (data.content || "").toLowerCase(),
              _searchClient: (data.client || "").toLowerCase()
            });
            hasChanges = true;
          } else if (change.type === 'removed') {
            postMap.delete(change.doc.id);
            hasChanges = true;
          }
        });

        if (!hasChanges) return prevPosts;

        const newPosts = Array.from(postMap.values());
        newPosts.sort((a, b) => b._sortTs - a._sortTs);
        return newPosts;
      });

      setError(null);
      setHasLoaded(true);
    }, (err) => {
      console.error("🔥 Firestore Error:", err);
      setError(err);
      setHasLoaded(true);
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
      setClientMap(prev => {
        let hasChanges = false;
        const next = { ...prev };
        snapshot.docChanges().forEach(change => {
          const data = change.doc.data();
          if (!data.name) return;
          if (change.type === 'added' || change.type === 'modified') {
            next[data.name] = data;
            hasChanges = true;
          } else if (change.type === 'removed') {
            delete next[data.name];
            hasChanges = true;
          }
        });
        return hasChanges ? next : prev;
      });
    }, (err) => console.error("🔥 Clients fetch error:", err));

    return () => { unsubscribe(); clientUnsub(); };
  }, [shouldSubscribe, guestBlocked, targetUid, scopeClientId, isGuest]);

  // Loading = an active subscription that hasn't delivered its first snapshot.
  const isLoading = shouldSubscribe && !hasLoaded;

  return { posts, clientMap, isLoading, error };
}
