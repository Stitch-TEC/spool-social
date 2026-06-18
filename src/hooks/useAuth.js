import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  signInWithPopup,
  signInAnonymously,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import { auth, googleProvider } from '../config/firebase';
import { exchangeShareToken } from '../utils/shareApi';

/**
 * Auth session + share-link semantics.
 *
 * Two share-link shapes:
 *   - `?s=<token>` (current) — a Worker-minted, per-(owner,client) token. The app
 *     exchanges it for a Firebase **custom token** carrying share claims, so the
 *     guest can read ONLY that one client (enforced by firestore.rules).
 *   - `?uid=<owner>&client=<name>` (legacy) — anonymous guest session. Works until
 *     the claim-based rules are deployed; afterwards the owner re-issues a `?s=` link.
 *
 * `shareScope` = the { ownerUid, client } the current view is bound to (null for a
 * normal owner dashboard). `isReadOnly` is true for anyone who isn't that owner.
 */
export default function useAuth(showToast) {
  const { shareToken, legacyUid, legacyClient } = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return { shareToken: p.get('s'), legacyUid: p.get('uid'), legacyClient: p.get('client') };
  }, []);

  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [shareError, setShareError] = useState(null);
  // Legacy links know their scope synchronously; token links resolve via exchange.
  const [shareScope, setShareScope] = useState(
    legacyUid ? { ownerUid: legacyUid, client: legacyClient || null } : null
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (cancelled) return;

      if (currentUser) {
        // A real session (owner via Google, or an already-signed-in guest).
        setUser(currentUser);
        setAuthLoading(false);
        return;
      }

      // No session yet.
      if (shareToken) {
        // Exchange the URL token for a scoped guest session.
        try {
          const { customToken, ownerUid, client } = await exchangeShareToken(shareToken);
          if (cancelled) return;
          setShareScope({ ownerUid, client });
          await signInWithCustomToken(auth, customToken); // re-fires onAuthStateChanged with the guest
        } catch (err) {
          console.error('Share session failed:', err);
          if (!cancelled) { setShareError(err.message || 'This review link is no longer valid.'); setAuthLoading(false); }
        }
      } else if (legacyUid) {
        // Transitional: old links sign in anonymously (until claim rules deploy).
        signInAnonymously(auth).catch(err => {
          console.error('Guest auth failed', err);
          if (!cancelled) setAuthLoading(false);
        });
      } else {
        setUser(null);
        setAuthLoading(false);
      }
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [shareToken, legacyUid, legacyClient]);

  // A guest is anyone viewing a share scope who isn't that scope's owner.
  const isReadOnly = !!shareScope && user?.uid !== shareScope.ownerUid;

  const signIn = useCallback(() => {
    signInWithPopup(auth, googleProvider).catch((err) => {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      console.error("Sign-in Error:", err);
      showToast?.("Sign-in failed. Please try again.", "error");
    });
  }, [showToast]);

  // Sign out and strip query params. Reloading with a share param intact would
  // instantly re-establish a guest session (an inescapable loop).
  const signOutAndExit = useCallback(() => {
    signOut(auth)
      .catch(() => {})
      .finally(() => {
        window.location.href = window.location.origin + window.location.pathname;
      });
  }, []);

  return {
    user,
    authLoading,
    isReadOnly,
    shareError,
    sharedUid: shareScope?.ownerUid || null,
    shareClient: shareScope?.client || null,
    signIn,
    signOutAndExit
  };
}
