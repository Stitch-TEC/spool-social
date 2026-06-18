import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../config/firebase';

/**
 * Real-time posts + client-branding subscriptions for a workspace.
 *
 * Security model (mirrors firestore.rules):
 * - Owner: all their posts + every client's branding.
 * - Share guest: scoped to a single (owner, client). Queries MUST filter on
 *   uid + client (posts) and uid + name (branding) so the claim-based read
 *   rules resolve against the result set.
 */
export default function usePosts(user, sharedUid, shareClient) {
  const [posts, setPosts] = useState([]);
  const [clientMap, setClientMap] = useState({});
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState(null);

  const targetUid = sharedUid || user?.uid;
  const isGuest = !!sharedUid && sharedUid !== user?.uid;
  // 🔒 SECURITY: Real guests (anyone but the owner) MUST scope to a client.
  const guestBlocked = isGuest && !shareClient;
  const shouldSubscribe = !!targetUid && !guestBlocked;

  useEffect(() => {
    if (!shouldSubscribe) {
      if (guestBlocked) console.warn("⛔ ACCESS DENIED: Missing client filter for guest.");
      return;
    }

    // Guests are scoped to one client; owners read everything.
    const scopeClient = isGuest ? shareClient : null;
    const constraints = [where('uid', '==', targetUid)];
    if (scopeClient) {
      constraints.push(where('client', '==', scopeClient));
    }

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
    const clientConstraints = [where('uid', '==', targetUid)];
    if (scopeClient) clientConstraints.push(where('name', '==', scopeClient));
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
  }, [shouldSubscribe, guestBlocked, targetUid, isGuest, shareClient]);

  // Loading = an active subscription that hasn't delivered its first snapshot.
  const isLoading = shouldSubscribe && !hasLoaded;

  return { posts, clientMap, isLoading, error };
}
