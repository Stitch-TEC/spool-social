// Cross-app context seam — fetch a client's POM-side AI context + brand kit from the feedback worker's
// keyed /client-profile endpoint, so Spool's generated content is client-aware + on-brand (not just from
// Spool's local client settings). Server-to-server, gated by CONTEXT_KEY.
//
// NON-FATAL by design: returns null on any miss (no key, unknown slug, network) so generation always
// degrades gracefully to Spool's own client settings. The slug is the suite join key (= Spool's clientId,
// reconciled to the POM slug).

const DEFAULT_URL = 'https://feedback.stitchtec.dev';

// `tier` (cheap|standard|hard) = the TASK's difficulty — the broker sizes the aiContext slice to it
// (tier-based injection depth; the policy lives broker-side). Default 'standard' fits Spool's copy
// work; pass 'hard' for long-form (blog) so it gets the full context. Back-compatible: an old broker
// simply ignores the param and returns the full context.
export async function fetchClientProfile(env, slug, tier = 'standard') {
  if (!env || !env.CONTEXT_KEY || !slug) return null;
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/client-profile?slug=${encodeURIComponent(slug)}&tier=${encodeURIComponent(tier)}`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.ok) return null;
    return {
      name: d.name || '',
      aiContext: d.aiContext || '',
      brand: d.brand || '',
      // Optional asset-library manifest (standard/hard tiers only): { count, images, videos,
      // recent:[{name,type,provider?}] } — counts + filenames, never blobs. Absent on old
      // brokers / cheap tier / any broker-side miss; consumers must treat it as optional.
      assets: d.assets && typeof d.assets === 'object' ? d.assets : undefined,
    };
  } catch {
    return null;
  }
}

// Diagnostic twin of fetchClientProfile: same authorized round-trip, but surfaces WHY it failed so an
// operator can tell a key mismatch between the two workers (401) from an unknown client (404) from a
// network/timeout miss. Presence-safe — never returns or logs the CONTEXT_KEY. Backs GET /api/context-check.
export async function probeClientProfile(env, slug) {
  if (!env || !env.CONTEXT_KEY) return { ok: false, reason: 'not_configured' };
  if (!slug) return { ok: false, reason: 'slug_required' };
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/client-profile?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return { ok: false, status: 401, reason: 'unauthorized' }; // keys differ across workers
    if (res.status === 404) return { ok: false, status: 404, reason: 'client_not_found' };
    if (res.status === 429) return { ok: false, status: 429, reason: 'rate_limited' };
    if (res.status === 503) return { ok: false, status: 503, reason: 'not_configured_upstream' };
    if (!res.ok) return { ok: false, status: res.status, reason: 'upstream_error' };
    const d = await res.json();
    if (!d || !d.ok) return { ok: false, status: res.status, reason: 'bad_payload' };
    return {
      ok: true,
      status: 200,
      profile: { name: d.name || '', aiContext: d.aiContext || '', brand: d.brand || '' },
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

// The canonical client roster from POM (via feedback-worker's keyed /clients). Server-to-server,
// CONTEXT_KEY-gated — backs Spool's "add users" client picker so a granted clientId is always a real
// POM slug, never a free-text typo that joins to nothing. Returns [] on any miss (no key, network,
// bad payload) so the picker degrades to empty rather than erroring. feedback-worker already filters
// out 'internal' rows; the slug is returned verbatim and must NOT be re-slugified by the caller.
export async function fetchClientRoster(env) {
  if (!env || !env.CONTEXT_KEY) return [];
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/clients`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    if (!d || !d.ok || !Array.isArray(d.clients)) return [];
    return d.clients
      .filter((c) => c && c.slug)
      .map((c) => ({
        slug: c.slug,
        name: c.name || c.slug,
        status: c.status || '',
        domains: Array.isArray(c.domains) ? c.domains : [], // drives the picker's email-domain inference
      }));
  } catch {
    return [];
  }
}
