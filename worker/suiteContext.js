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
      // Operator-authored SEO strategy (POM clients/{slug}.seoKit): { targetKeywords[], topics[],
      // audience?, geo?, notes? } — standard/hard tiers only, absent on old brokers. Rendered by
      // renderPomSeoLine as drafting guidance (operator-authored, but re-capped defensively).
      seoKit: d.seoKit && typeof d.seoKit === 'object' ? d.seoKit : null,
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
        // `site` carries the full page INDEX (url/title only, under site.index) — the "browse all
        // pages" picker menu — passed through verbatim from the broker. Optional on old brokers
        // (absent → the picker just shows nothing).
        site: d.site && typeof d.site === 'object' && Array.isArray(d.site.pages)
          ? { ...d.site, index: Array.isArray(d.site.index) ? d.site.index : [] }
          : { pages: [], index: [] },
        repos: Array.isArray(d.repos) ? d.repos : [],
      },
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

// The DURABLE per-client content index (broker GET /client-content/index, D1-backed): every
// discovered page with SEO metafields + a once-per-version AI summary, and optionally the image
// inventory (source page + alt + spoolUrl once imported). Richer and longer-lived than the
// signals pack's url/title index — backs GET /api/content-index (picker summaries + the media
// picker's "Client site" section). Typed failures like fetchClientSignals; CONTEXT_KEY never
// leaves this worker.
export async function fetchContentIndex(env, slug, includeImages = false) {
  if (!env || !env.CONTEXT_KEY) return { ok: false, reason: 'not_configured' };
  if (!slug) return { ok: false, reason: 'slug_required' };
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const qs = `slug=${encodeURIComponent(slug)}${includeImages ? '&include=images' : ''}`;
    const res = await fetch(`${base}/client-content/index?${qs}`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    // 503 = the broker predates the index or its D1 is unbound — a NORMAL degrade (callers fall
    // back to the signals index), distinct from a real failure.
    if (res.status === 503) return { ok: false, reason: 'not_configured' };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, status: res.status, reason: 'upstream_error' };
    const d = await res.json();
    if (!d || !d.ok) return { ok: false, reason: 'bad_payload' };
    return {
      ok: true,
      counts: d.counts && typeof d.counts === 'object' ? d.counts : {},
      pages: Array.isArray(d.pages)
        ? d.pages.filter((p) => p && typeof p.url === 'string').map((p) => ({
            url: p.url,
            source: p.source === 'repo' ? 'repo' : 'site',
            title: typeof p.title === 'string' ? p.title : '',
            summary: typeof p.summary === 'string' ? p.summary : '',
            metaDescription: typeof p.metaDescription === 'string' ? p.metaDescription : '',
            ogImage: typeof p.ogImage === 'string' ? p.ogImage : '',
            publishedAt: typeof p.publishedAt === 'string' ? p.publishedAt : '',
            lastCrawled: typeof p.lastCrawled === 'string' ? p.lastCrawled : '',
          }))
        : [],
      images: Array.isArray(d.images)
        ? d.images.filter((i) => i && typeof i.url === 'string').map((i) => ({
            url: i.url,
            pageUrl: typeof i.pageUrl === 'string' ? i.pageUrl : '',
            alt: typeof i.alt === 'string' ? i.alt : '',
            kind: typeof i.kind === 'string' ? i.kind : 'img',
            spoolUrl: typeof i.spoolUrl === 'string' ? i.spoolUrl : '',
          }))
        : [],
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

// Import ONE indexed site image into the client's curated library (broker POST /spool/assets
// { slug, imageUrl } on the CONTEXT_KEY path — the broker validates the URL against the D1 image
// index, downloads it SSRF-guarded with the site-sync type/size gates, and stores it via this
// worker's own /api/media). Idempotent: an already-imported image returns its existing library
// URL. Backs POST /api/site-image-import. CONTEXT_KEY never leaves this worker.
export async function importSiteImage(env, slug, imageUrl) {
  if (!env || !env.CONTEXT_KEY) return { ok: false, reason: 'not_configured' };
  if (!slug || !imageUrl) return { ok: false, reason: 'bad_request' };
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/spool/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CONTEXT_KEY}` },
      body: JSON.stringify({ slug, imageUrl }),
      // Generous: the broker downloads up to 5MB then re-uploads to this worker inside this window.
      signal: AbortSignal.timeout(30000),
    });
    const d = await res.json().catch(() => null);
    if (res.status === 409) return { ok: false, reason: 'library_full', message: (d && d.message) || 'Library is full.' };
    if (res.status === 404) return { ok: false, reason: 'unknown_image' };
    if (res.status === 415) return { ok: false, reason: 'unsupported_type' };
    if (res.status === 503) return { ok: false, reason: 'not_configured' };
    if (!res.ok || !d || !d.ok || !d.asset || typeof d.asset.url !== 'string' || !d.asset.url) {
      return { ok: false, status: res.status, reason: 'upstream_error' };
    }
    return { ok: true, url: d.asset.url, alreadySynced: !!d.alreadySynced };
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
        // The broker's fuller page text (the excerpt is only a teaser) — this is what lets a
        // grounded generation's ~1800-char budget actually fill. Optional on old brokers;
        // consumers fall back to the excerpt.
        text: typeof p.text === 'string' ? p.text : '',
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
// Push a Spool-authored template into the client's Sender tenant via the broker relay
// (POST /sender/template — same CONTEXT_KEY seam; the broker alone holds SENDER_INTERNAL_KEY).
// Returns { status, body } so the route can pass Sender's outcome through HONESTLY: 200 =
// { templateId, builderUrl, updated }, 409 = the client has no Sender tenant yet, 503 = a seam
// key is missing somewhere. Throws only on network failure — the caller maps that to 502.
export async function pushSenderTemplate(env, { slug, name, html, preheader, spoolPostId }) {
  if (!env || !env.CONTEXT_KEY) return { status: 503, body: { ok: false, error: 'not_configured' } };
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  const res = await fetch(`${base}/sender/template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CONTEXT_KEY}` },
    body: JSON.stringify({ slug, name, html, preheader, spoolPostId }),
    signal: AbortSignal.timeout(15000), // broker adds its own 10s Sender timeout inside this
  });
  const body = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  return { status: res.status, body };
}

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
