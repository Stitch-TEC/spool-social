import { MEDIA_FILTER, NEEDS_FILTER, PLATFORMS, REVIEW_STATE, STATUS } from '../constants';
import { SORT_ORDERS } from './helpers';

export const MAX_SAVED_VIEWS = 12;
export const MAX_VIEW_NAME = 48;
const MAX_STORAGE_LENGTH = 12000;
const FILTER_KEYS = ['clientSlug', 'review', 'status', 'platform', 'media', 'needs', 'sort'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const slugValid = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 128;
const oneOf = (value, options) => value === null || options.includes(value);
const nameKey = name => name.toLocaleLowerCase('en-US');
export const normalizeViewName = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
export const validViewName = value => typeof value === 'string' && value === normalizeViewName(value) && value.length > 0 && value.length <= MAX_VIEW_NAME && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function savedViewsKey(projectId, uid) {
  if (typeof projectId !== 'string' || !projectId || typeof uid !== 'string' || !uid) return null;
  return `spool.savedViews.v1:${encodeURIComponent(projectId)}:${encodeURIComponent(uid)}`;
}

export function validViewFilters(filters) {
  return exactKeys(filters, FILTER_KEYS)
    && (filters.clientSlug === null || slugValid(filters.clientSlug))
    && oneOf(filters.review, Object.values(REVIEW_STATE))
    && oneOf(filters.status, [STATUS.DRAFT, STATUS.SCHEDULED, STATUS.POSTED])
    && oneOf(filters.platform, Object.keys(PLATFORMS))
    && oneOf(filters.media, Object.values(MEDIA_FILTER))
    && oneOf(filters.needs, Object.values(NEEDS_FILTER))
    && Object.values(SORT_ORDERS).includes(filters.sort);
}

export function parseSavedViews(raw) {
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > MAX_STORAGE_LENGTH) throw new Error('invalid_saved_views');
  const data = JSON.parse(raw);
  if (!exactKeys(data, ['version', 'views']) || data.version !== 1 || !Array.isArray(data.views) || data.views.length > MAX_SAVED_VIEWS) throw new Error('invalid_saved_views');
  const names = new Set();
  for (const view of data.views) {
    if (!exactKeys(view, ['name', 'filters']) || !validViewName(view.name) || !validViewFilters(view.filters) || names.has(nameKey(view.name))) throw new Error('invalid_saved_views');
    names.add(nameKey(view.name));
  }
  return data.views;
}

export function serializeSavedViews(views) {
  const raw = JSON.stringify({ version: 1, views });
  parseSavedViews(raw); // Never write a broader/malformed schema than we can read.
  return raw;
}

export const hasViewName = (views, name) => views.some(view => nameKey(view.name) === nameKey(name));

// This is deliberately NOT clientIdFor's optional-generation fallback ladder.
// Saved views only accept an unambiguous canonical roster mapping. No guessed
// slug or display name is persisted; a failed lookup must never mean all clients.
export function resolveViewClient({ clients, loading, error }, { name, slug }) {
  if (name === null || slug === null) return { ok: true, slug: null, name: null };
  if (loading || error || !Array.isArray(clients)) return { ok: false };
  const normalized = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  const rows = clients.filter(row => row && slugValid(row.slug) && typeof row.name === 'string' && row.name.trim());
  const matches = rows.filter(row => slug !== undefined ? row.slug === slug : normalized(row.name) === normalized(name));
  if (matches.length !== 1) return { ok: false };
  const chosen = matches[0];
  // The existing feed filter is name-based. Refuse a shared label, even if the
  // saved slug itself is unique, rather than accidentally selecting two clients.
  if (rows.filter(row => row.slug === chosen.slug).length !== 1 || rows.filter(row => normalized(row.name) === normalized(chosen.name)).length !== 1) return { ok: false };
  return { ok: true, slug: chosen.slug, name: chosen.name };
}
