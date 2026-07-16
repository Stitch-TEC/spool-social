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
      // The STRUCTURED brand kit ({ colors:[{hex,name?}], fonts:[], theme?, logoUrl?, … }) alongside
      // the lossy one-line `brand` summary above — the image builder renders palette hexes/theme
      // from it directly instead of round-tripping through prose. null on old brokers; consumers
      // must keep the `brand` string fallback.
      brandKit: d.brandKit && typeof d.brandKit === 'object' ? d.brandKit : null,
      // Auto-refreshed "recent activity" digest (POM clients/{slug}.autoContext, written by the
      // broker's cron/refresh — see feedback-worker). { text, updatedAt } or null; standard/hard
      // tiers only, same policy as `assets`. Rendered as UNTRUSTED reference data in prompts.
      recentActivity:
        d.recentActivity && typeof d.recentActivity === 'object' && typeof d.recentActivity.text === 'string'
          ? { text: d.recentActivity.text, updatedAt: d.recentActivity.updatedAt || '' }
          : null,
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
      profile: {
        name: d.name || '',
        aiContext: d.aiContext || '',
        brand: d.brand || '',
        // Structured extras so /api/context-check can report theme/logo/palette/auto-context
        // presence — same optional-on-old-brokers posture as fetchClientProfile above.
        brandKit: d.brandKit && typeof d.brandKit === 'object' ? d.brandKit : null,
        recentActivity:
          d.recentActivity && typeof d.recentActivity === 'object' && typeof d.recentActivity.text === 'string'
            ? { text: d.recentActivity.text, updatedAt: d.recentActivity.updatedAt || '' }
            : null,
      },
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

// Content-idea signals for a client — site pages + repo releases/commits collected by the broker's
// GET /client-signals (it crawls the client's siteUrls/repos server-side; results are KV-cached
// broker-side for ~6h). Backs Spool's GET /api/ideas. Unlike fetchClientProfile this returns a
// TYPED failure instead of null so the route can distinguish "seam not configured" (feature hidden,
// ok:false) from a real upstream error (502). 10s timeout — a cache miss does live site/GitHub
// fetches broker-side, so it legitimately runs longer than the profile's 5s. CONTEXT_KEY never
// leaves this worker.
export async function fetchClientSignals(env, slug) {
  if (!env || !env.CONTEXT_KEY) return { ok: false, reason: 'not_configured' };
  if (!slug) return { ok: false, reason: 'slug_required' };
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/client-signals?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    // 404 = the broker roster simply doesn't know this slug — a NORMAL outcome in Spool (free-text
    // client names), distinct from a real upstream failure so the route can stay quiet about it.
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, status: res.status, reason: 'upstream_error' };
    const d = await res.json();
    if (!d || !d.ok) return { ok: false, reason: 'bad_payload' };
    return {
      ok: true,
      // Normalized to the wire shape /api/ideas re-emits — coerce defensively so a mis-shaped
      // broker payload degrades to empty lists rather than throwing in the route.
      signals: {
        fetchedAt: typeof d.fetchedAt === 'string' ? d.fetchedAt : '',
        cached: !!d.cached,
        site: d.site && typeof d.site === 'object' && Array.isArray(d.site.pages) ? d.site : { pages: [] },
        // Full page INDEX (url/title only) — the "browse all pages" picker menu. Optional on old
        // brokers; the picker just shows fewer/none. Lives under site so the /api/ideas passthrough
        // and the panel both find it in one place.
        index: d.site && Array.isArray(d.site.index) ? d.site.index : [],
        repos: Array.isArray(d.repos) ? d.repos : [],
      },
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

// Pull ONE selected page on demand (broker GET /client-page, domain-pinned to the client's own
// site). Backs Spool's GET /api/page — the picker's "I want this page". Returns { ok, page } or a
// typed failure. CONTEXT_KEY never leaves this worker.
export async function fetchClientPage(env, slug, url) {
  if (!env || !env.CONTEXT_KEY) return { ok: false, reason: 'not_configured' };
  if (!slug || !url) return { ok: false, reason: 'bad_request' };
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/client-page?slug=${encodeURIComponent(slug)}&url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 403) return { ok: false, reason: 'off_site' };
    if (!res.ok) return { ok: false, status: res.status, reason: 'upstream_error' };
    const d = await res.json();
    if (!d || !d.ok || !d.page) return { ok: false, reason: 'bad_payload' };
    const p = d.page;
    return {
      ok: true,
      page: {
        url: typeof p.url === 'string' ? p.url : url,
        title: typeof p.title === 'string' ? p.title : '',
        excerpt: typeof p.excerpt === 'string' ? p.excerpt : '',
        images: Array.isArray(p.images) ? p.images.filter((u) => typeof u === 'string') : [],
      },
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
