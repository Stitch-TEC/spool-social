import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  signInWithPopup,
  signInAnonymously,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import { auth, googleProvider } from '../config/firebase';

/**
 * Auth session + share-link semantics.
 *
 * A `?uid=` query param marks a share link: the owner opening their own link
 * keeps their session (full dashboard); anyone else becomes a read-only
 * anonymous guest.
 */
export default function useAuth(showToast) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const sharedUid = useMemo(
    () => new URLSearchParams(window.location.search).get('uid'),
    []
  );
  const isReadOnly = !!sharedUid && sharedUid !== user?.uid;

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        // A real session (the owner, or an already-signed-in guest).
        setUser(currentUser);
        setAuthLoading(false);
      } else if (sharedUid) {
        // No session but viewing a share link → sign in as an anonymous guest.
        // (Done here, not eagerly, so an owner opening their own link keeps their session.)
        signInAnonymously(auth).catch(err => {
          console.error("Guest Auth Failed", err);
          setAuthLoading(false);
        });
      } else {
        setUser(null);
        setAuthLoading(false);
      }
    });
    return () => unsubscribe();
  }, [sharedUid]);

  const signIn = useCallback(() => {
    signInWithPopup(auth, googleProvider).catch((err) => {
      // Closing the popup isn't an error worth surfacing.
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      console.error("Sign-in Error:", err);
      showToast?.("Sign-in failed. Please try again.", "error");
    });
  }, [showToast]);

  // Sign out and strip query params. Reloading with ?uid= intact would
  // instantly re-sign a guest in anonymously (an inescapable loop).
  const signOutAndExit = useCallback(() => {
    signOut(auth)
      .catch(() => {})
      .finally(() => {
        window.location.href = window.location.origin + window.location.pathname;
      });
  }, []);

  return { user, authLoading, sharedUid, isReadOnly, signIn, signOutAndExit };
}
