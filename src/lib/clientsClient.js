// Client for the Worker's /api/clients endpoint — the canonical POM client roster (slug/name/status).
// Backs the "add users" client picker so a granted clientId is always a real POM slug, never a
// free-text typo that joins to nothing. Sends the signed-in operator's Firebase ID token; the Worker
// does the keyed server-to-server hop to feedback-worker (the CONTEXT_KEY never reaches the browser).
// Same-origin /api in prod (the Worker serves the app).

import { auth } from '../config/firebase';

const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Fetch the canonical client roster from POM (via the Worker). Returns [{ slug, name, status }],
 * already sorted by name with 'internal' rows filtered out upstream. The slug is the suite join key
 * (== Spool's clientId) and must be used VERBATIM — never re-slugify the display name. Throws on a
 * hard failure (auth/network) so the hook can surface it; an empty roster returns [].
 */
export async function listClients() {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in');
  const token = await user.getIdToken();
  const res = await fetch(`${API_BASE}/api/clients`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return Array.isArray(data.clients) ? data.clients : [];
}
