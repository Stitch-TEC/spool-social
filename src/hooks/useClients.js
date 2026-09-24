// Hook: load the canonical POM client roster (slug/name/status). ONE instance lives in App.jsx
// (gated to operators — the Worker's /api/clients is operator-only) and feeds BOTH the clientIdFor
// resolution ladder and AdminPanel's picker (via props) — do not add a second fetch.
// `enabled` gates the fetch: it starts false while auth resolves and flips true for an operator,
// which triggers the (single) load. Degrades gracefully — on error it returns an empty list with
// `error` set, so callers fall back (manual entry / slugify) rather than blocking.
// STALENESS guard: a client onboarded mid-session was invisible until a tab reload — the SPA
// save then minted a phantom slug that self-perpetuates via the stamped-posts map. The roster
// now refetches when the tab becomes visible again, throttled to once per 15 minutes so focus
// flapping can't spam the Worker. Referential stability holds: a refetch only calls setClients
// when the roster CONTENT actually changed (row-signature compare), so an unchanged roster
// keeps the same array identity and the App.jsx memo cascade stays quiet.

import { useState, useEffect } from 'react';
import { listClients } from '../lib/clientsClient';

// Module-level singletons for the disabled state. A fresh `{ clients: [] }` per render would give
// every non-operator session (client members + share-link guests, where `enabled` stays false
// forever) a new roster identity each render — cascading through App's rosterSlugByName memo →
// clientIdFor → every CRUD callback → every memoized PostCard, silently defeating the
// hash-stabilization invariant App.jsx documents. Frozen so nobody can mutate the shared array.
const EMPTY_CLIENTS = Object.freeze([]);
const DISABLED = Object.freeze({ clients: EMPTY_CLIENTS, loading: false, error: null });
const PENDING = Object.freeze({ clients: EMPTY_CLIENTS, loading: true, error: null });

// Minimum gap between roster fetches (visibility-triggered refreshes only).
const REFRESH_MIN_MS = 15 * 60 * 1000;

// Content signature over every field a consumer reads (ladder uses slug|name; the AdminPanel
// picker also shows status and infers from domains) — if any of it changed, the roster "actually
// differs" and is worth a state commit.
const rosterSig = (rows) =>
  rows.map((c) => `${c.slug}\u0000${c.name}\u0000${c.status}\u0000${(c.domains || []).join(',')}`).join('\u0001');

export function useClients(enabled = true, scopeKey = '') {
  // Retire the previous return synchronously, not one effect/paint after a new
  // session. A fresh owner object also prevents A→B→A from reviving old A data.
  const [owner, setOwner] = useState(() => ({ enabled, scopeKey }));
  const [result, setResult] = useState(null);
  if (owner.enabled !== enabled || owner.scopeKey !== scopeKey) setOwner({ enabled, scopeKey });

  useEffect(() => {
    // Disabled = no fetch; the disabled return value below is DERIVED (no setState-in-effect).
    if (!owner.enabled) return undefined;
    let alive = true;
    let lastFetchAt = Date.now();
    // Only commit a roster whose content differs from what's already in state.
    const commit = (rows) => {
      if (!alive) return;
      const sig = rosterSig(rows);
      setResult(previous => ({ owner, sig, clients: previous?.owner === owner && previous.sig === sig ? previous.clients : rows, loading: false, error: null }));
    };
    // Initial load — unchanged semantics: a failure clears the list and surfaces `error`.
    listClients()
      .then(commit)
      .catch((err) => { if (alive) setResult({ owner, sig: '', clients: EMPTY_CLIENTS, loading: false, error: err.message || 'Failed to load clients' }); });
    // Visibility refresh — background-quiet: never touches `loading`, and a FAILED refresh keeps
    // the roster we already have (stale beats empty — same fail-open posture as the ladder; the
    // throttled timestamp still advances so a flapping broker isn't hammered on every focus).
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastFetchAt < REFRESH_MIN_MS) return;
      lastFetchAt = Date.now();
      listClients()
        .then(commit)
        .catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [owner]);

  // While disabled, consumers see a settled empty roster (fail open) — the SAME module-level
  // reference every render (referential stability matters downstream, see DISABLED above). Because
  // `loading` starts true and is only cleared by a finished fetch, flipping `enabled` on (auth
  // resolved) presents loading=true until the single load completes.
  if (!enabled) return DISABLED;
  if (owner.enabled !== enabled || owner.scopeKey !== scopeKey || result?.owner !== owner) return PENDING;
  return { clients: result.clients, loading: result.loading, error: result.error };
}
