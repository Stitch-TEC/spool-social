import { PLATFORMS, STATUS } from '../constants';

const normalizedName = value => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
const validClientId = value => typeof value === 'string' && value.length <= 64
  && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

// Display-only: a partial/ambiguous name must not select another tenant's evidence.
export function confirmedUsualClientId(name, clients) {
  const selected = normalizedName(name);
  if (!selected || !Array.isArray(clients)) return null;
  const matches = clients.filter(client => normalizedName(client?.name) === selected);
  if (!matches.length || matches.some(client => !validClientId(client?.slug))) return null;
  const ids = new Set(matches.map(client => client.slug));
  return ids.size === 1 ? [...ids][0] : null;
}

// Observed preference only, never a publishing connection or a fallback default.
export function usualPlatformForClient(posts, clientId) {
  if (!validClientId(clientId) || !Array.isArray(posts)) return null;
  const counts = Object.fromEntries(Object.keys(PLATFORMS).map(key => [key, 0]));
  for (const post of posts) {
    if (post?.clientId === clientId && !post.isTemplate && post.source !== 'suggestion'
      && post.status !== STATUS.ARCHIVED && Object.prototype.hasOwnProperty.call(counts, post.platform)) {
      counts[post.platform]++;
    }
  }
  const best = Object.keys(counts).reduce((current, key) => counts[key] > counts[current] ? key : current, 'gmb');
  return counts[best] > 0 ? best : null;
}
