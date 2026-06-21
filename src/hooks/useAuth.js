import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  signInWithPopup,
  signInAnonymously,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, googleProvider, db } from '../config/firebase';
import { exchangeShareToken } from '../utils/shareApi';
import { OPERATOR_UID, ROLES } from '../config/roles';

/**
 * Auth session, role/scope resolution, and share-link semantics.
 *
 * Three principals (enforced server-side in firestore.rules; this hook mirrors
 * the same model for the UI):
 *   - Operator (super_admin): Google sign-in resolved against users/{email}.
 *     Falls back to super_admin when uid === OPERATOR_UID, so the owner is never
 *     locked out — even before their users doc exists or under old rules.
 *   - Client member (client / client_admin): users/{email} carrying a clientId.
 *     Scoped to that one client.
 *   - Review guest: `?s=<token>` → Worker-minted custom token with share claims
 *     (no email). Unchanged. `?uid=&client=` (legacy) → anonymous, being retired.
 * A signed-in account with no users/{email} grant (and not the operator) is
 * DENIED via `authzError` — the whitelist gate.
 *
 * `shareScope` = the { ownerUid, client } a guest view is bound to (null for a
 * normal dashboard). `isReadOnly` is true only for a review guest.
 */
export default function useAuth(showToast) {
  const { shareToken, legacyUid, legacyClient } = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return { shareToken: p.get('s'), legacyUid: p.get('uid'), legacyClient: p.get('client') };
  }, []);

  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [shareError, setShareError] = useState(null);
  const [authzError, setAuthzError] = useState(null);
  const [role, setRole] = useState(null);         // 'super_admin' | 'client_admin' | 'client'
  const [clientId, setClientId] = useState(null);  // set for client members
  // Legacy links know their scope synchronously; token links resolve via exchange.
  const [shareScope, setShareScope] = useState(
    legacyUid ? { ownerUid: legacyUid, client: legacyClient || null } : null
  );

  useEffect(() => {
    let cancelled = false;

    // Resolve role + clientId from users/{email} for a real (non-guest) sign-in.
    // Returns { role, clientId } or null (= not authorized).
    const resolveRole = async (currentUser) => {
      const email = (currentUser.email || '').toLowerCase();
      try {
        if (email) {
          const snap = await getDoc(doc(db, 'users', email));
          if (snap.exists()) {
            const data = snap.data();
            const roles = Array.isArray(data.roles) ? data.roles : [];
            if (roles.includes(ROLES.SUPER_ADMIN)) return { role: ROLES.SUPER_ADMIN, clientId: null };
            if ((roles.includes(ROLES.CLIENT_ADMIN) || roles.includes(ROLES.CLIENT)) && data.clientId) {
              return { role: roles.includes(ROLES.CLIENT_ADMIN) ? ROLES.CLIENT_ADMIN : ROLES.CLIENT, clientId: data.clientId };
            }
          }
        }
        // The owner is always super_admin — covers pre-bootstrap and the
        // deploy window where users reads are still denied by old rules.
        if (currentUser.uid === OPERATOR_UID) return { role: ROLES.SUPER_ADMIN, clientId: null };
        return null;
      } catch (err) {
        console.error('Role resolution failed:', err);
        if (currentUser.uid === OPERATOR_UID) return { role: ROLES.SUPER_ADMIN, clientId: null };
        throw err;
      }
    };

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (cancelled) return;

      if (currentUser) {
        // Review guests sign in via a custom/anonymous token with NO email claim.
        const isGuest = currentUser.isAnonymous || !currentUser.email;
        if (isGuest) {
          setUser(currentUser);
          setRole(null);
          setClientId(null);
          setAuthLoading(false);
          return;
        }

        // A real signed-in user (Google) — resolve authorization.
        try {
          const resolved = await resolveRole(currentUser);
          if (cancelled) return;
          if (!resolved) {
            setAuthzError(`${currentUser.email || 'This account'} isn't set up for Spool yet. Ask your administrator to grant access.`);
            setUser(null); setRole(null); setClientId(null);
            setAuthLoading(false);
            return;
          }
          setAuthzError(null);
          setRole(resolved.role);
          setClientId(resolved.clientId);
          setUser(currentUser);
          setAuthLoading(false);
        } catch {
          if (cancelled) return;
          setAuthzError('Could not verify your access — please try signing in again.');
          setUser(null); setRole(null); setClientId(null);
          setAuthLoading(false);
        }
        return;
      }

      // No session yet.
      if (shareToken) {
        // Exchange the URL token for a scoped guest session.
        try {
          const { customToken, ownerUid, client, clientId: scopeId } = await exchangeShareToken(shareToken);
          if (cancelled) return;
          setShareScope({ ownerUid, client, clientId: scopeId || null });
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
  const isOperator = role === ROLES.SUPER_ADMIN;
  const isClientMember = role === ROLES.CLIENT || role === ROLES.CLIENT_ADMIN;

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
    authzError,
    role,
    clientId,
    isOperator,
    isClientMember,
    sharedUid: shareScope?.ownerUid || null,
    shareClient: shareScope?.client || null,
    shareClientId: shareScope?.clientId || null,
    signIn,
    signOutAndExit
  };
}
