// Canonical client for the shared feedback ingress Worker (feedback.stitchtec.dev). ONE place per app
// for the endpoint URL, the canonical payload shape, validation, and a client-side cooldown — so the
// FeedbackWidget and the login "Request access" form don't each reassemble it (and can't drift).
const DEFAULT_FEEDBACK_URL = 'https://feedback.stitchtec.dev/feedback';

export const FEEDBACK_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_FEEDBACK_URL) ||
  DEFAULT_FEEDBACK_URL;

export const MESSAGE_MAX = 1000;

export const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());

export const stripHtml = (s) => String(s || '').replace(/<[^>]*>?/gm, '');

// Build the canonical feedback payload. Fills the auto-captured context uniformly; the caller passes the
// semantic fields plus any app-specific extras (role, view, appName, clientId) via `extra`.
export function buildFeedbackPayload({ app, category, message, user = 'anonymous', email = '', hp = '', appVersion = '', extra = {} }) {
  return {
    app,
    category,
    message: stripHtml(message).slice(0, MESSAGE_MAX),
    page: window.location.href,
    route: window.location.pathname,
    user: user || 'anonymous',
    email: email || '',
    hp: hp || '',
    appVersion: appVersion || '',
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    ts: new Date().toISOString(),
    ...extra,
  };
}

// POST to the Worker. Throws on non-2xx so callers can surface an error.
export async function submitFeedback(payload) {
  const res = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`feedback request failed: ${res.status}`);
  return res;
}

// Client-side cooldown (cosmetic — the Worker KV rate limit is the real control). Check before submit,
// stamp on success so a failed submit doesn't burn the window.
export const isOnCooldown = (key, ms = 5 * 60 * 1000) => {
  try { const last = localStorage.getItem(key); return !!(last && Date.now() - parseInt(last, 10) < ms); }
  catch { return false; }
};
export const stampCooldown = (key) => { try { localStorage.setItem(key, String(Date.now())); } catch {} };
