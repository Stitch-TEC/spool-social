// Hook: load the canonical POM client roster (slug/name/status). ONE instance lives in App.jsx
// (gated to operators — the Worker's /api/clients is operator-only) and feeds BOTH the clientIdFor
// resolution ladder and AdminPanel's picker (via props) — do not add a second fetch.
// `enabled` gates the fetch: it starts false while auth resolves and flips true for an operator,
// which triggers the (single) load. Degrades gracefully — on error it returns an empty list with
// `error` set, so callers fall back (manual entry / slugify) rather than blocking.

import { useState, useEffect } from 'react';
import { listClients } from '../lib/clientsClient';

// Module-level singletons for the disabled state. A fresh `{ clients: [] }` per render would give
// every non-operator session (client members + share-link guests, where `enabled` stays false
// forever) a new roster identity each render — cascading through App's rosterSlugByName memo →
// clientIdFor → every CRUD callback → every memoized PostCard, silently defeating the
// hash-stabilization invariant App.jsx documents. Frozen so nobody can mutate the shared array.
const EMPTY_CLIENTS = Object.freeze([]);
const DISABLED = Object.freeze({ clients: EMPTY_CLIENTS, loading: false, error: null });

export function useClients(enabled = true) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Disabled = no fetch; the disabled return value below is DERIVED (no setState-in-effect).
    if (!enabled) return undefined;
    let alive = true;
    listClients()
      .then((rows) => { if (alive) { setClients(rows); setError(null); } })
      .catch((err) => { if (alive) { setClients([]); setError(err.message || 'Failed to load clients'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled]);

  // While disabled, consumers see a settled empty roster (fail open) — the SAME module-level
  // reference every render (referential stability matters downstream, see DISABLED above). Because
  // `loading` starts true and is only cleared by a finished fetch, flipping `enabled` on (auth
  // resolved) presents loading=true until the single load completes.
  if (!enabled) return DISABLED;
  return { clients, loading, error };
}
