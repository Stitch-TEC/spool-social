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
import { resolveDraftImage } from './media.js';
import { checkRateLimit } from './ratelimit.js';
import { buildTextContext, buildImagePrompt, contextTierForPlatform, PLATFORM_META } from '../src/generation/prompts.js';
import { createPost, getClientSettings, listAutomations, updateAutomation } from './firestore.js';
import { fetchClientProfile } from './suiteContext.js';

const MAX_SEED = 2000; // matches the generation API's MAX_PROMPT

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

  // Reserve the FULL budget this draft needs BEFORE any paid Gemini call, so a
  // budget hit throws cleanly up front (the cron retries next tick, nothing
  // wasted) instead of stranding completed text work mid-draft.
  const unitsNeeded = (wantText ? 1 : 0) + (wantImage ? 1 : 0);
  for (let i = 0; i < unitsNeeded; i++) await spendBudget(env, principal);

  // Client branding/AI settings make the output on-brand. Missing is non-fatal.
  let settings = null;
  try { settings = await getClientSettings(env, auto.clientId); }
  catch (err) { console.error('Automation client lookup failed:', err?.message || err); }
  const clientSettings = settings || {};

  // POM per-client context + brand (the cross-app seam) — makes the copy client-aware + imagery on-brand.
  // Non-fatal: null on any miss falls back to Spool's local clientSettings above.
  // Tier-based injection depth: long-form (blog/job) earns the FULL client context; social copy gets
  // the standard slice (the broker sizes it — policy lives there; the rule is the shared
  // contextTierForPlatform, also used by the interactive generation paths in index.js).
  const profile = await fetchClientProfile(env, auto.clientId, contextTierForPlatform(platform));
  // Presence-safe observability (no secret/content) so `wrangler tail` shows whether the seam is feeding
  // this run — silent degradation was the one ops gap flagged in review.
  if (env.CONTEXT_KEY) {
    console.log(
      profile
        ? `[suite-context] ${auto.clientId}: profile loaded (ctx=${(profile.aiContext || '').length} chars, brand=${profile.brand ? 'yes' : 'no'}, assets=${profile.assets ? (profile.assets.count ?? 0) : 'n/a'})`
        : `[suite-context] ${auto.clientId}: no profile — falling back to local settings`,
    );
  }

  let content = '';
  if (wantText) {
    const { system, maxTokens } = buildTextContext({
      platform, tone: auto.tone, length: auto.length,
      clientName: auto.client, clientSettings, pomContext: profile?.aiContext, pomAssets: profile?.assets
    });
    const out = await generateText(env, seed, { system, maxTokens, clientId: auto.clientId });
    content = String(out || '').trim().slice(0, max);
  }

  let imageUrl = '';
  if (wantImage) {
    const imgPrompt = buildImagePrompt({
      prompt: seed, style: auto.imageStyle, platform,
      clientName: auto.client, clientSettings, pomBrand: profile?.brand
    });
    try {
      imageUrl = (await resolveDraftImage(env, origin, { prompt: imgPrompt, clientId: auto.clientId })) || '';
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

  // An image-only automation still needs non-empty content (the post model / UI
  // require it) — fall back to the seed as a starting caption.
  if (!content) content = seed.trim().slice(0, max);

  const nowIso = new Date().toISOString();
  const postId = await createPost(env, {
    uid: env.OWNER_UID,
    clientId: auto.clientId,            // <-- so the client sees it in review
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
    tags: [],
    scheduledDate: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    source: 'automation',
    automationId: auto.id
  });
  return { postId, content, imageUrl };
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
      await generateForAutomation(env, origin, auto);
      ran++;
      await updateAutomation(env, auto.id, {
        lastRunAt: nowIso, lastStatus: 'ok', lastError: '',
        runCount: (parseInt(auto.runCount, 10) || 0) + 1,
        nextRunAt: advancedIso, updatedAt: nowIso
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
          nextRunAt: advancedIso, updatedAt: nowIso
        });
      } catch (e2) {
        console.error('Automation status update failed:', e2?.message || e2);
      }
    }
  }
  if (ran > 0) console.log(`Automation tick: generated ${ran} draft(s).`);
}
