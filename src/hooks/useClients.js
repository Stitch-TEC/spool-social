// Hook: load the canonical POM client roster (slug/name/status) for pickers. Loads once on mount.
// Degrades gracefully — on error it returns an empty list with `error` set, so a caller (e.g. the
// "add users" picker) can fall back to manual entry rather than blocking the operator.

import { useState, useEffect } from 'react';
import { listClients } from '../lib/clientsClient';

export function useClients() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // loading starts true; this effect runs once on mount, so no synchronous setState needed here.
    let alive = true;
    listClients()
      .then((rows) => { if (alive) { setClients(rows); setError(null); } })
      .catch((err) => { if (alive) { setClients([]); setError(err.message || 'Failed to load clients'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  return { clients, loading, error };
}
