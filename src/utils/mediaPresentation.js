import { parseVideoReference } from './videoReferences';

const text = value => typeof value === 'string' && value.length <= 240
  // eslint-disable-next-line no-control-regex
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';

// Display only: no oEmbed, external thumbnails, provider authorization or URL
// shortening. Keep the full normalized URL for the deliberate external action.
export function videoMediaPresentation(item) {
  if (item?.type !== 'video') return null;
  const reference = parseVideoReference(item.url);
  if (!reference) return null;
  const url = new URL(reference.url);
  const parts = url.pathname.split('/').filter(Boolean);
  let identifier = '';
  if (reference.provider === 'YouTube') {
    identifier = url.hostname === 'youtu.be' ? parts[0]
      : url.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : '');
    identifier = /^[A-Za-z0-9_-]{1,100}$/.test(identifier || '') ? identifier : '';
  } else if (reference.provider === 'Vimeo') {
    identifier = parts.find(part => /^\d{1,30}$/.test(part)) || '';
  } else {
    try { identifier = text(decodeURIComponent(parts[parts.length - 1] || '')); } catch { /* Use host below. */ }
  }
  const detail = identifier || `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  const savedLabel = text(item.title) || text(item.label) || text(item.name);
  return {
    url: reference.url,
    provider: reference.provider,
    label: savedLabel || `${reference.provider} · ${detail}`,
    detail,
  };
}

export function readableMediaItems(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid media response');
  // A malformed response must not become an empty-library or selectable-item
  // claim. Unknown legacy metadata is retained, not rewritten or uploaded.
  if (value.some(item => !item || typeof item !== 'object'
    || typeof item.key !== 'string' || !item.key || item.key.length > 2048
    || typeof item.url !== 'string' || !item.url || item.url.length > 4096
    || !['image', 'video'].includes(item.type))) throw new Error('Invalid media response');
  if (new Set(value.map(item => item.key)).size !== value.length) throw new Error('Duplicate media identity');
  return value;
}

export function confirmedLibraryItem(value, type, clientKey, expectedUrl = '') {
  readableMediaItems([value]);
  const pieces = value.key.split('/');
  if (value.type !== type || pieces[0] !== 'library' || !pieces[1] || pieces[2] !== clientKey || pieces.length < 4) throw new Error('Unconfirmed media result');
  if (type === 'video') {
    const actual = videoMediaPresentation(value);
    const expected = videoMediaPresentation({ type: 'video', url: expectedUrl });
    if (!actual || !expected || actual.url !== expected.url) throw new Error('Unconfirmed video result');
  } else {
    let url;
    try { url = new URL(value.url, 'https://spool.stitchtec.dev'); } catch { throw new Error('Unconfirmed image result'); }
    const prefix = url.pathname.startsWith('/media/v2/') ? '/media/v2/' : '/media/';
    let decoded;
    try { decoded = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { throw new Error('Unconfirmed image result'); }
    if (url.origin !== 'https://spool.stitchtec.dev' || !url.pathname.startsWith(prefix) || decoded !== value.key) throw new Error('Unconfirmed image result');
  }
  return value;
}

export function mediaMatchesSearch(item, query) {
  const needle = String(query || '').slice(0, 200).trim().toLocaleLowerCase();
  if (!needle) return true;
  const video = videoMediaPresentation(item);
  // Do not search signed query strings: their tokens are not useful labels.
  const fields = video ? [video.label, video.provider, video.detail]
    : [text(item.title), text(item.label), text(item.name), text(item.alt), item.key];
  return fields.join(' ').toLocaleLowerCase().includes(needle);
}
