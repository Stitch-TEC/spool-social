// Client for the Worker's /api/clients endpoint — the canonical POM client roster (slug/name/status).
// Backs the "add users" client picker so a granted clientId is always a real POM slug, never a
// free-text typo that joins to nothing. Sends the signed-in operator's Firebase ID token; the Worker
// does the keyed server-to-server hop to feedback-worker (the CONTEXT_KEY never reaches the browser).
// Same-origin /api in prod (the Worker serves the app).

import { auth } from '../config/firebase';
import { validClientHandoffRows } from '../utils/clientHandoff';

const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Fetch the canonical client roster from POM (via the Worker). Returns [{ slug, name, status }],
 * already sorted by name with 'internal' rows filtered out upstream. The slug is the suite join key
 * (== Spool's clientId) and must be used VERBATIM — never re-slugify the display name. Throws on a
 * hard failure (auth/network) so the hook can surface it; an empty roster returns [].
 */
export async function listClients(options) {
  if (options?.strict === true) return listHandoffClients(options);
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

export const HANDOFF_ROSTER_LIMITS = Object.freeze({ tokenMs: 15000, requestMs: 15000, bytes: 262144, chunks: 4096 });
const unavailable = () => new Error('Client list could not be verified. Reload it before continuing.');

function waitFor(work, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { signal.removeEventListener('abort', abort); callback(value); };
    const abort = () => finish(reject, unavailable());
    // Observe an already-created promise even if its adapter aborted synchronously.
    Promise.resolve(work).then(value => finish(resolve, value), () => finish(reject, unavailable()));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function boundedStep(parentSignal, milliseconds, work) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  try {
    if (controller.signal.aborted) throw unavailable();
    return await waitFor(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

async function boundedJson(response, signal) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > HANDOFF_ROSTER_LIMITS.bytes)) throw unavailable();
  let raw = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, chunks = 0;
    try {
      while (true) {
        const { done, value } = await waitFor(reader.read(), signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > HANDOFF_ROSTER_LIMITS.bytes || ++chunks > HANDOFF_ROSTER_LIMITS.chunks) throw unavailable();
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      Promise.resolve(reader.cancel()).catch(() => {});
    }
  } else throw unavailable();
  return JSON.parse(raw);
}

async function listHandoffClients({ isCurrent, signal }) {
  const user = auth.currentUser;
  const current = () => !!user && auth.currentUser === user && !signal?.aborted
    && typeof isCurrent === 'function' && isCurrent();
  try {
    if (!current()) throw unavailable();
    const token = await boundedStep(signal, HANDOFF_ROSTER_LIMITS.tokenMs, () => user.getIdToken());
    if (!current() || typeof token !== 'string' || !token) throw unavailable();
    return await boundedStep(signal, HANDOFF_ROSTER_LIMITS.requestMs, async requestSignal => {
      if (!current()) throw unavailable();
      const response = await waitFor(fetch(`${API_BASE}/api/clients?handoff=1`, {
        headers: { Authorization: `Bearer ${token}` }, signal: requestSignal, redirect: 'error', cache: 'no-store',
      }), requestSignal);
      if (!current() || response.status !== 200 || response.redirected) throw unavailable();
      const data = await boundedJson(response, requestSignal);
      if (!current() || data?.ok !== true || data.confirmed !== true || !validClientHandoffRows(data.clients)) throw unavailable();
      return data.clients.map(row => {
        if (row.domains !== undefined && (!Array.isArray(row.domains) || row.domains.length > 100
          || row.domains.some(domain => typeof domain !== 'string' || domain.length > 255))) throw unavailable();
        return { slug: row.slug, name: row.name, status: row.status, domains: row.domains ? [...row.domains] : [] };
      });
    });
  } catch { throw unavailable(); }
}
