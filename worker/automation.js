// Scheduled content automation — the cron-driven generator.
//
// A super-admin configures per-client/per-platform automations (see the
// /api/automations routes in index.js). On each tick, runDueAutomations() finds
// the ones whose nextRunAt has passed, generates branded copy (and optionally a
// hero image) with the SAME prompt builders the in-app editor uses, and writes a
// review-ready draft into `posts` — assigned to the client (clientId) so it
// lands in their normal review queue.
//
// Critical: the cron path runs IN-PROCESS and never passes through
// fetch()/authenticate()/checkRateLimit, so it would otherwise bypass all rate
// limiting and the owner's Gemini-quota protection. Every Gemini call is
// therefore gated here by a DEDICATED 'automation' rate-limit principal, and the
// loop is capped per tick (MAX_GEN_PER_TICK).

import { generateText } from './gemini.js';
import { resolveDraftImage, storeImage } from './media.js';
import { checkRateLimit } from './ratelimit.js';
import { buildTextContext, buildImagePrompt, contextTierForPlatform, PLATFORM_META } from '../src/generation/prompts.js';
import { createPost, getClientSettings, listAutomations, updateAutomation } from './firestore.js';
import { fetchClientProfile, fetchClientRoster, fetchClientSignals, fetchClientPage } from './suiteContext.js';

const MAX_SEED = 2000; // matches the generation API's MAX_PROMPT

// Mirrors index.js `slugifyClient` / src/config/roles.js `slugifyClientId` EXACTLY (inline copy so
// the Worker bundle stays self-contained; the algorithm is stable — if roles.js ever changes,
// change all three). Used only for the roster name→slug repair below.
const slugifyClient = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

// Raster formats only — NEVER svg: the /media route serves the stored content-type inline on
// our own origin, so an accepted image/svg+xml would be stored XSS on spool.stitchtec.dev.
const REHOST_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Public-host guard at PARITY with feedback-worker's validatePublicHttpUrl: reject IP-literal /
// loopback / internal-suffix hosts (and userinfo) so the Worker never fetches into private address
// space. We deliberately do NOT domain-pin image hosts — legit sites hot-link CDN imagery — so
// "public http(s) host" is the boundary, not "the client's domain".
function isPublicHttpUrl(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;                          // no userinfo (http://user:pass@host)
  // Strip a trailing FQDN dot BEFORE the suffix checks: WHATWG keeps the dot on NAMED hosts, so
  // 'metadata.google.internal.' would otherwise slip the '.internal' guard. (Numeric hosts are
  // already dot-normalized by the URL parser, so the IP checks below are unaffected.)
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return false;
  if (h.startsWith('[') || h.includes(':')) return false;              // IPv6 literal
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.]+$/i.test(h)) return false; // IPv4 / integer / hex literal
  return true;
}

// Re-host a page image from the grounded page into R2 (content-addressed) instead of
// hot-linking it: a /media URL is what the SPA, pickers, and the reference-based GC understand,
// and it survives the client's site redeploys. IMPORTANT: the broker domain-pins only the PAGE
// url — the image URLs inside the page are untrusted page content and may point at any host, so
// treat this as an untrusted fetch: public-host guard before AND after redirects, a raster-only
// content-type allowlist (no svg), and the upload route's 5MB cap. Best-effort by design: ANY
// check failure returns '' (a missing hero image must never fail the run — same posture as the
// AI-image path's text salvage).
async function rehostPageImage(env, origin, imgUrl, clientId) {
  try {
    let target = new URL(String(imgUrl));
    if (!isPublicHttpUrl(target)) return '';
    // Follow redirects MANUALLY so EVERY hop's host is validated BEFORE the Worker fetches it.
    // Default redirect:'follow' would make each intermediate request itself and only expose the
    // FINAL url via res.url — a public image URL could 30x-bounce us into private address space
    // on an intermediate hop (SSRF) and land back on a public URL undetected. Bounded to <=3
    // redirects, re-validating each Location, exactly matching feedback-worker's fetchGuarded.
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(target.href, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (res.status < 300 || res.status >= 400) break; // not a redirect — this is the response
      if (hop >= 3) return '';                           // redirect budget exhausted
      const loc = res.headers.get('location');
      if (!loc) return '';
      let next;
      try { next = new URL(loc, target); } catch { return ''; }
      if (!isPublicHttpUrl(next)) return '';             // validate the NEXT hop before fetching it
      target = next;
    }
    if (!res.ok) return '';
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!REHOST_MIMES.includes(mime)) return '';
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 5_000_000) return '';
    return (await storeImage(env, origin, bytes, mime, 'internal', clientId)).url;
  } catch (err) {
    console.error('Automation page-image rehost failed:', err?.message || err);
    return '';
  }
}

// Thrown when the automation budget (its KV tier) is exhausted. The tick stops
// rather than skipping one, so the budget is a true ceiling for the run.
class BudgetExhaustedError extends Error {
  constructor(message) { super(message); this.budgetExhausted = true; }
}

// One Gemini call's worth of budget against a dedicated automation tier (so it
// never shares the internal key's generous quota). `principal` separates the
// counter so interactive "Run now" previews can't drain the cron's daily budget.
async function spendBudget(env, principal = 'automation') {
  const rl = await checkRateLimit(env, principal, 'automation', Date.now());
  if (!rl.ok) throw new BudgetExhaustedError(`Automation budget reached (max ${rl.limit}/${rl.scope}).`);
}

/**
 * Generate ONE draft for a single automation config and persist it to `posts`.
 * Reused by the cron loop and the "Run now" endpoint. Returns
 * { postId, content, imageUrl }. Throws on generation failure (the caller
 * records lastError); throws a BudgetExhaustedError when the budget is hit.
 */
export async function generateForAutomation(env, origin, auto, principal = 'automation') {
  // Own-property check, not `in` (prototype-chain walk would let 'constructor'/'toString'/… validate).
  const platform = Object.prototype.hasOwnProperty.call(PLATFORM_META, auto.platform) ? auto.platform : 'gmb';
  const max = PLATFORM_META[platform].maxChars;
  const contentType = auto.contentType || 'text';
  const wantText = contentType.includes('text');
  const wantImage = contentType.includes('image');
  const seed = String(auto.promptSeed || '').slice(0, MAX_SEED);

  // Repair the tenant key against the canonical ROSTER before any keyed use (context seam,
  // grounding fetches, quota attribution, the draft itself). Stored automations may carry a
  // posts-derived phantom slug — Spool's known self-referential resolution bug — which the
  // broker 404s on and the quota mirror never matches. Same name→slug repair as /api/ideas;
  // roster unreachable/empty = keep the stored id (fail-open).
  let clientId = auto.clientId;
  const roster = await fetchClientRoster(env);
  if (roster.length && !roster.some((c) => c.slug === clientId)) {
    const byName = roster.find((c) => slugifyClient(c.name) === slugifyClient(auto.client));
    if (byName) clientId = byName.slug;
  }

  // Reserve the FULL budget this draft needs BEFORE any paid Gemini call, so a
  // budget hit throws cleanly up front (the cron retries next tick, nothing
  // wasted) instead of stranding completed text work mid-draft.
  const unitsNeeded = (wantText ? 1 : 0) + (wantImage ? 1 : 0);
  for (let i = 0; i < unitsNeeded; i++) await spendBudget(env, principal);

  // Client branding/AI settings make the output on-brand. Missing is non-fatal.
  let settings = null;
  try {
    settings = await getClientSettings(env, clientId);
    // Branding docs key clientId off posts, so a just-repaired slug may not match an older
    // doc — fall back to the stored id rather than silently losing the brand voice.
    if (!settings && clientId !== auto.clientId) settings = await getClientSettings(env, auto.clientId);
  }
  catch (err) { console.error('Automation client lookup failed:', err?.message || err); }
  const clientSettings = settings || {};

  // POM per-client context + brand (the cross-app seam) — makes the copy client-aware + imagery on-brand.
  // Non-fatal: null on any miss falls back to Spool's local clientSettings above.
  // Tier-based injection depth: long-form (blog/job) earns the FULL client context; social copy gets
  // the standard slice (the broker sizes it — policy lives there; the rule is the shared
  // contextTierForPlatform, also used by the interactive generation paths in index.js).
  const profile = await fetchClientProfile(env, clientId, contextTierForPlatform(platform));
  // Presence-safe observability (no secret/content) so `wrangler tail` shows whether the seam is feeding
  // this run — silent degradation was the one ops gap flagged in review.
  if (env.CONTEXT_KEY) {
    console.log(
      profile
        ? `[suite-context] ${clientId}: profile loaded (ctx=${(profile.aiContext || '').length} chars, brand=${profile.brand ? 'yes' : 'no'}, assets=${profile.assets ? (profile.assets.count ?? 0) : 'n/a'})`
        : `[suite-context] ${clientId}: no profile — falling back to local settings`,
    );
  }

  // Site grounding: rotate over the client's real page index and pull ONE page fresh (title/
  // excerpt/images — domain-pinned to the client's own site broker-side) so this run is anchored
  // in what the site actually says, not just the static promptSeed. Every miss (seam
  // unconfigured, unknown slug, empty index, dead page) degrades to the ungrounded generation —
  // a grounding miss must never fail the run. `nextCursor` is RETURNED, not written here, so the
  // advance persists in the caller's single updateAutomation alongside the schedule.
  let groundedPage = null;
  let nextCursor;
  if (auto.grounding === 'site') {
    const sig = await fetchClientSignals(env, clientId);
    // Prefer the full page index (every URL on the site); fall back to the crawled-pages
    // sample for old brokers that don't send an index yet.
    const pages = sig.ok
      ? (sig.signals.site.index.length ? sig.signals.site.index : sig.signals.site.pages)
      : [];
    if (pages.length) {
      const cursor = Math.max(0, parseInt(auto.pageCursor, 10) || 0);
      const pick = pages[cursor % pages.length];
      if (typeof pick?.url === 'string' && pick.url) {
        const out = await fetchClientPage(env, clientId, pick.url);
        if (out.ok) groundedPage = out.page;
      }
      // Advance even on a page miss so one dead URL can't wedge the rotation on itself.
      nextCursor = (cursor + 1) % pages.length;
    }
    if (env.CONTEXT_KEY) {
      console.log(`[grounding] ${clientId}: ${groundedPage
        ? `page loaded (${groundedPage.url}, ${(groundedPage.text || groundedPage.excerpt || '').length} chars)`
        : 'no page — running ungrounded'}`);
    }
  }

  try {
    let content = '';
    if (wantText) {
      const { system, maxTokens } = buildTextContext({
        platform, tone: auto.tone, length: auto.length,
        clientName: auto.client, clientSettings, pomContext: profile?.aiContext, pomAssets: profile?.assets,
        // Structured brand theme + auto-refreshed recent-activity digest (same seam, newer fields —
        // absent on old brokers, and the builder renders nothing for them: fail-open unchanged).
        pomRecent: profile?.recentActivity, pomBrandKit: profile?.brandKit,
        // Operator-authored SEO strategy (seoKit) — a directive line, absent on old brokers.
        pomSeo: profile?.seoKit,
        // The grounded page rides in as UNTRUSTED reference data (renderPomPageLine) — never
        // appended to promptSeed, which is capped and injection-defended separately.
        pomPage: groundedPage
      });
      const out = await generateText(env, seed, { system, maxTokens, clientId });
      content = String(out || '').trim().slice(0, max);
    }

    let imageUrl = '';
    if (wantImage) {
      const imgPrompt = buildImagePrompt({
        prompt: seed, style: auto.imageStyle, platform,
        // The structured kit (palette hexes + theme) wins inside the builder; the one-line
        // pomBrand string stays as the fallback for old brokers that send no brandKit.
        clientName: auto.client, clientSettings, pomBrand: profile?.brand, pomBrandKit: profile?.brandKit,
        // Grounded runs steer the AI image toward the page's subject too (title-only hint,
        // capped inside the builder) — grounded copy under an off-topic render reads broken.
        pomPage: groundedPage
      });
      try {
        imageUrl = (await resolveDraftImage(env, origin, { prompt: imgPrompt, clientId })) || '';
      } catch (err) {
        // Best-effort image: for text+image, persist the already-generated text
        // rather than discarding it. Image-only has nothing to salvage, so let
        // the failure surface (recorded as lastStatus:'error', schedule advances).
        // A QUOTA denial always surfaces — swallowing it would record lastStatus 'ok'
        // and hide the exhausted budget from the operator.
        if (!wantText || err?.quotaExceeded) throw err;
        console.error('Automation image failed; persisting text-only draft:', err?.message || err);
      }
    }

    // Grounded TEXT drafts attach the chosen page's own hero image (re-hosted into R2) — the
    // site's real imagery beats a generic AI render for grounded copy. Also the fallback when
    // a grounded text+image run's AI image failed above (never overwrites a successful AI
    // render); image-only keeps its surface-the-failure semantics. A rehost miss just means a
    // draft without an image.
    if (auto.grounding === 'site' && wantText && !imageUrl && groundedPage?.images?.[0]) {
      imageUrl = await rehostPageImage(env, origin, groundedPage.images[0], clientId);
    }

    // An image-only automation still needs non-empty content (the post model / UI
    // require it) — fall back to the seed as a starting caption.
    if (!content) content = seed.trim().slice(0, max);

    const suggest = auto.mode === 'suggest';
    const nowIso = new Date().toISOString();
    const postId = await createPost(env, {
      uid: env.OWNER_UID,
      // 'suggest' parks the draft operator-only: visibility is clientId-keyed (firestore.rules +
      // the app's subscriptions both query on it), so an EMPTY clientId is invisible to client
      // members and share guests while the operator's uid-scoped query still sees it.
      // `forClientId` carries the real slug for the one-click promote in the app.
      // 'auto' keeps the classic straight-to-review behavior.
      clientId: suggest ? '' : clientId,
      ...(suggest ? { forClientId: clientId } : {}),
      client: auto.client,
      content,
      title: '',
      altText: '',
      metaDescription: '',
      slug: '',
      platform,
      status: 'draft',
      approvalStatus: 'pending',
      feedback: '',
      imageUrl,
      tags: suggest ? ['suggested'] : [],
      scheduledDate: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      source: suggest ? 'suggestion' : 'automation',
      automationId: auto.id,
      // PROVENANCE (operator-only in the UI): which real site page this drew from and, for
      // suggestions, the prompt seed — so a parked suggestion's "Use this" and a queue draft's
      // "Auto" badge both explain where the content came from. The grounded page is the client's
      // OWN site, so it's safe to stamp on an 'auto' draft (which carries the real clientId and is
      // client-visible); the prompt SEED is the operator's instruction text, so it stays on the
      // operator-only suggestion doc (empty clientId) and is never written to a client-visible draft.
      // Strings only, additive.
      ...(groundedPage ? {
        suggestPageUrl: String(groundedPage.url || '').slice(0, 500),
        suggestPageTitle: String(groundedPage.title || '').slice(0, 140),
      } : {}),
      ...(suggest ? { suggestSeed: String(auto.promptSeed || '').slice(0, 140) } : {}),
    });
    // pageCursor is undefined unless this run rotated the site index — callers only persist it
    // when defined, so ungrounded automations never gain the field.
    return { postId, content, imageUrl, pageCursor: nextCursor };
  } catch (err) {
    // A page that fetches fine but then breaks generation must not re-pick itself forever:
    // carry the advanced cursor on the error so the callers' error-path updates persist it.
    // Budget exhaustion throws BEFORE the rotation above, so its no-advance / retry-next-tick
    // semantics are untouched.
    if (nextCursor !== undefined && err && typeof err === 'object') err.pageCursor = nextCursor;
    throw err;
  }
}

/**
 * Cron entry point: generate drafts for every automation that is due.
 * Called from scheduled() on the automation cron tick.
 */
export async function runDueAutomations(env, origin) {
  // Without the service account we can't write drafts; without OWNER_UID we
  // don't know the tenant root. Either missing → nothing to do.
  if (!env.OWNER_UID || !env.FIREBASE_SERVICE_ACCOUNT) return;

  const maxPerTick = Math.max(1, parseInt(env.MAX_GEN_PER_TICK || '10', 10));
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  let autos;
  try { autos = await listAutomations(env, env.OWNER_UID); }
  catch (err) { console.error('Automation list failed:', err?.message || err); return; }

  // Due = enabled and the next-run timestamp has passed. Oldest-due first so a
  // per-tick cap is fair across automations.
  const due = autos
    .filter(a => a.enabled === true && String(a.nextRunAt || '') <= nowIso)
    .sort((a, b) => String(a.nextRunAt || '').localeCompare(String(b.nextRunAt || '')));

  let ran = 0;
  for (const auto of due) {
    if (ran >= maxPerTick) {
      console.log(`Automation tick: hit MAX_GEN_PER_TICK (${maxPerTick}); ${due.length - ran} deferred.`);
      break;
    }
    const intervalHours = Math.max(1, parseInt(auto.intervalHours, 10) || 24);
    const advancedIso = new Date(nowMs + intervalHours * 3_600_000).toISOString();
    try {
      const result = await generateForAutomation(env, origin, auto);
      ran++;
      await updateAutomation(env, auto.id, {
        lastRunAt: nowIso, lastStatus: 'ok', lastError: '',
        runCount: (parseInt(auto.runCount, 10) || 0) + 1,
        nextRunAt: advancedIso, updatedAt: nowIso,
        // Site-grounding rotation advances atomically with the schedule (ONE write per run —
        // a separate cursor write could strand rotation state if either write failed).
        ...(result.pageCursor !== undefined ? { pageCursor: result.pageCursor } : {})
      });
    } catch (err) {
      if (err?.budgetExhausted) {
        // Stop the whole tick; do NOT advance — these retry next tick.
        console.warn('Automation tick stopped:', err?.message || err);
        break;
      }
      // One bad config must not hot-loop: record the error but still advance.
      console.error(`Automation ${auto.id} failed:`, err?.message || err);
      try {
        await updateAutomation(env, auto.id, {
          lastRunAt: nowIso, lastStatus: 'error',
          lastError: String(err?.message || err).slice(0, 300),
          nextRunAt: advancedIso, updatedAt: nowIso,
          // The rotation advances on failed runs too (the error carries the cursor when a
          // page was picked) — otherwise one generation-breaking page wedges the rotation.
          ...(err?.pageCursor !== undefined ? { pageCursor: err.pageCursor } : {})
        });
      } catch (e2) {
        console.error('Automation status update failed:', e2?.message || e2);
      }
    }
  }
  if (ran > 0) console.log(`Automation tick: generated ${ran} draft(s).`);
}
