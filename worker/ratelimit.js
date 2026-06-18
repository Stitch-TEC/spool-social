// Coarse per-principal rate limiting backed by Workers KV.
//
// KV is eventually consistent and not transactional, so these are SOFT abuse
// caps, not exact counters — good enough to stop runaway loops and limit the
// blast radius if a token/key is abused. For exact limits, move to a Durable
// Object later. If the RATE_LIMIT binding is absent, this no-ops (allows all).

function limitsFor(mode, env) {
  if (mode === 'apikey') {
    // Trusted server-to-server key — generous; mainly runaway-loop protection.
    return {
      perMin: parseInt(env.RL_INTERNAL_PER_MIN || '120', 10),
      perDay: parseInt(env.RL_INTERNAL_PER_DAY || '10000', 10),
    };
  }
  // Firebase users (the public-facing path).
  return {
    perMin: parseInt(env.RL_PER_MIN || '10', 10),
    perDay: parseInt(env.RL_PER_DAY || '100', 10),
  };
}

async function bump(kv, key, ttlSeconds) {
  const current = parseInt((await kv.get(key)) || '0', 10);
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

/**
 * Returns { ok: true } when under limits, or
 *         { ok: false, scope: 'minute'|'day', limit, retryAfter } when exceeded.
 * A limit of 0 (or unset → default) disables that tier.
 */
export async function checkRateLimit(env, principal, mode, now) {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true }; // binding not configured → no limiting

  const { perMin, perDay } = limitsFor(mode, env);
  const minBucket = Math.floor(now / 60000);
  const dayBucket = Math.floor(now / 86400000);

  if (perMin > 0) {
    const minCount = await bump(kv, `rl:${principal}:m:${minBucket}`, 120);
    if (minCount > perMin) {
      return { ok: false, scope: 'minute', limit: perMin, retryAfter: 60 - (Math.floor(now / 1000) % 60) };
    }
  }
  if (perDay > 0) {
    const dayCount = await bump(kv, `rl:${principal}:d:${dayBucket}`, 90000);
    if (dayCount > perDay) {
      return { ok: false, scope: 'day', limit: perDay, retryAfter: 3600 };
    }
  }
  return { ok: true };
}
