// A navigation hint, never a grant or a client-creation fallback.
export const CLIENT_HANDOFF_LIMITS = Object.freeze({ query: 4096, parameters: 16, slug: 128, rows: 1000, name: 200 });
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = new Set(['active', 'project', 'nonprofit', 'prospect', 'internal', 'archived']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSlug = value => typeof value === 'string' && value.length <= CLIENT_HANDOFF_LIMITS.slug && SLUG.test(value);
const nameKey = value => value.trim().toLowerCase().replace(/\s+/g, ' ');
const validName = value => typeof value === 'string' && value.length > 0
  && value.length <= CLIENT_HANDOFF_LIMITS.name && value === value.trim()
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const blocked = code => ({ status: 'blocked', code });
const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));

// Discover only the exact parameter name without constructing an unbounded
// URLSearchParams object. Unrelated/legacy URLs keep their existing behavior.
function containsKey(query, key) {
  let start = 0;
  while (start <= query.length) {
    const amp = query.indexOf('&', start);
    const end = amp === -1 ? query.length : amp;
    const equals = query.slice(start, Math.min(end, start + 31)).indexOf('=');
    const keyEnd = equals !== -1 ? start + equals : end;
    if (keyEnd - start <= 30) {
      try { if (decode(query.slice(start, keyEnd)) === key) return true; } catch { /* unrelated invalid key */ }
    }
    if (amp === -1) return false;
    start = amp + 1;
  }
  return false;
}

export function parseClientHandoff(search) {
  if (typeof search !== 'string') return { status: 'absent' };
  const query = search.startsWith('?') ? search.slice(1) : search;
  // Existing guest links own their URL/session contract even if an additional
  // handoff parameter was pasted onto them. Do not intercept their sign-in.
  if (containsKey(query, 's') || containsKey(query, 'uid') || !containsKey(query, 'clientSlug')) return { status: 'absent' };
  if (query.length > CLIENT_HANDOFF_LIMITS.query) return blocked('invalid_link');
  const parts = query.split('&');
  if (parts.length > CLIENT_HANDOFF_LIMITS.parameters) return blocked('invalid_link');
  const entries = [];
  try {
    for (const part of parts) {
      if (!part) return blocked('invalid_link');
      const equals = part.indexOf('=');
      if (equals === -1) return blocked('invalid_link');
      entries.push([decode(part.slice(0, equals)), decode(part.slice(equals + 1))]);
    }
  } catch { return blocked('invalid_link'); }
  if (entries.filter(([key]) => key === 'clientSlug').length !== 1) return blocked('invalid_link');
  if (entries.some(([key]) => key === 'client' || key === 'uid' || key === 's')) return blocked('mixed_link');
  // This first contract has no redirect, account, draft, or extra URL options.
  if (entries.length !== 1 || entries[0][0] !== 'clientSlug') return blocked('invalid_link');
  const slug = entries[0][1];
  return validSlug(slug) ? { status: 'requested', slug } : blocked('invalid_link');
}

/** Resolve only a complete, current read; never infer a name from posts or slug. */
export function resolveClientHandoff(intent, roster, scopeKey) {
  if (intent?.status !== 'requested') return intent?.status === 'absent' ? intent : blocked(intent?.code || 'invalid_link');
  if (!validSlug(intent.slug)) return blocked('invalid_link');
  if (roster?.loading) return { status: 'pending', code: 'roster_loading' };
  if (!roster || roster.error || roster.confirmed !== true || roster.scopeKey !== scopeKey
    || typeof scopeKey !== 'string' || !scopeKey || typeof roster.readVersion !== 'string' || !roster.readVersion) return blocked('roster_unavailable');
  const rows = roster.clients;
  if (!validClientHandoffRows(rows)) return blocked('roster_invalid');
  const matches = rows.filter(row => row.slug === intent.slug);
  if (matches.length === 0) return blocked('client_unavailable');
  if (matches.length !== 1) return blocked('client_ambiguous');
  const chosen = matches[0];
  // The existing feed filters names. Even an archived duplicate can still have
  // posts, so include every returned row in the collision check.
  if (rows.filter(row => nameKey(row.name) === nameKey(chosen.name)).length !== 1) return blocked('client_ambiguous');
  if (chosen.status === 'archived') return blocked('client_archived');
  return { status: 'resolved', slug: chosen.slug, name: chosen.name, readVersion: roster.readVersion };
}

export function validClientHandoffRows(rows) {
  return Array.isArray(rows) && rows.length <= CLIENT_HANDOFF_LIMITS.rows
    && rows.every(row => record(row) && validSlug(row.slug) && validName(row.name) && STATUSES.has(row.status));
}

/** Name-based legacy consumers must not resolve this label to a different ID. */
export function inspectHandoffContent({ clientName, slug, posts, clientMap, loading, error } = {}) {
  if (error) return blocked('content_unavailable');
  if (loading) return { status: 'pending', code: 'content_loading' };
  if (!validName(clientName) || !validSlug(slug) || !Array.isArray(posts) || !record(clientMap)) return blocked('content_unavailable');
  if (clientName.trim().replace(/\//g, '').slice(0, 50) !== clientName) return blocked('client_name_unsupported');
  const selected = nameKey(clientName);
  const conflict = stamp => stamp !== undefined && stamp !== null && stamp !== '' && stamp !== slug;
  for (const post of posts) {
    if (!record(post) || typeof post.client !== 'string' || nameKey(post.client) !== selected) continue;
    if (conflict(post.clientId) || (post.source === 'suggestion' && conflict(post.forClientId))) return blocked('content_conflict');
  }
  for (const [name, branding] of Object.entries(clientMap)) {
    if (nameKey(name) === selected && (!record(branding) || conflict(branding.clientId))) return blocked('content_conflict');
  }
  // Missing legacy stamps are not ownership proof. This only detects observed
  // conflicts; it does not certify historical/off-roster name uniqueness.
  return { status: 'ready', code: null };
}
