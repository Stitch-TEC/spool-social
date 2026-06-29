// Cross-app context seam — fetch a client's POM-side AI context + brand kit from the feedback worker's
// keyed /client-profile endpoint, so Spool's generated content is client-aware + on-brand (not just from
// Spool's local client settings). Server-to-server, gated by CONTEXT_KEY.
//
// NON-FATAL by design: returns null on any miss (no key, unknown slug, network) so generation always
// degrades gracefully to Spool's own client settings. The slug is the suite join key (= Spool's clientId,
// reconciled to the POM slug).

const DEFAULT_URL = 'https://feedback.stitchtec.dev';

export async function fetchClientProfile(env, slug) {
  if (!env || !env.CONTEXT_KEY || !slug) return null;
  const base = env.SUITE_FEEDBACK_URL || DEFAULT_URL;
  try {
    const res = await fetch(`${base}/client-profile?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${env.CONTEXT_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d || !d.ok) return null;
    return { name: d.name || '', aiContext: d.aiContext || '', brand: d.brand || '' };
  } catch {
    return null;
  }
}
