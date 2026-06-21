// Client for the Worker's share-link API.
//
// Owner endpoints send the signed-in user's Firebase ID token; the public
// session-exchange endpoint is unauthenticated (the token in the URL is the
// credential). In prod the Worker serves the app, so /api is same-origin.

import { auth } from '../config/firebase';

const API_BASE = import.meta.env.VITE_API_BASE || '';

async function authedFetch(path, opts = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('You must be signed in');
  const token = await user.getIdToken();
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** List the owner's share links (optionally for one client). */
export async function listShareLinks(client) {
  const { shares } = await authedFetch(`/api/share${client ? `?client=${encodeURIComponent(client)}` : ''}`);
  return shares || [];
}

/**
 * Create a new review link for a client. `clientId` is the stable tenant key
 * (the Worker forces it to the caller's own for a client member; an operator
 * supplies it for the chosen client). Returns { token, url, client, clientId, label }.
 */
export function createShareLink(client, label = '', clientId = '') {
  return authedFetch('/api/share', { method: 'POST', body: JSON.stringify({ client, label, clientId }) });
}

/** Revoke a link by its token. */
export function revokeShareLink(token) {
  return authedFetch(`/api/share/${encodeURIComponent(token)}`, { method: 'DELETE' });
}

/**
 * Exchange a share token (from ?s= in the URL) for a Firebase custom token +
 * the (ownerUid, clientId) it scopes to. PUBLIC — no auth header.
 */
export async function exchangeShareToken(token) {
  const res = await fetch(`${API_BASE}/api/share/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'This review link is no longer valid.');
  return data; // { customToken, ownerUid, client, clientId, label }
}
