// Client for the Worker's content-automation API (super-admin only).
//
// Sends the signed-in operator's Firebase ID token; the Worker re-verifies the
// caller is the operator (resolveShareCaller) — the UI gate is convenience only.
// Same-origin /api in prod (the Worker serves the app).

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

/** List all automations (operator-wide). */
export async function listAutomations() {
  const { automations } = await authedFetch('/api/automations');
  return automations || [];
}

/**
 * Create an automation. `config` carries: client (display name), clientId
 * (immutable tenant key), platform, contentType, tone, length, imageStyle,
 * promptSeed, intervalHours. Returns { id, automation }.
 */
export function createAutomation(config) {
  return authedFetch('/api/automations', { method: 'POST', body: JSON.stringify(config) });
}

/** Patch an automation — e.g. { enabled: false } to pause, or edited fields. */
export function updateAutomation(id, patch) {
  return authedFetch(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Delete an automation. */
export function deleteAutomation(id) {
  return authedFetch(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Generate one draft right now (preview) without disturbing the schedule. */
export function runAutomation(id) {
  return authedFetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
}
