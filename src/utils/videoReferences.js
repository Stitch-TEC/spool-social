// Link conveniences only: no provider lookup, media fetch, embed, or claim that
// a shared file is accessible/a video. In particular, source permissions and
// mutable files are not made private or versioned by Spool's review workflow.
export const VIDEO_REFERENCE_LIMIT = 10;
export const VIDEO_REFERENCE_URL_LIMIT = 4096;
const CONTENT_LIMIT = 100000;
// Deliberately reject URL control characters before URL() can normalize them.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\\<>"`]|%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i;
const PRIVATE_SUFFIX = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|home\.arpa|test|invalid|onion)$/i;
const PROVIDERS = new Map([
  ['drive.google.com', 'Google Drive'],
  ['1drv.ms', 'OneDrive'],
  ['onedrive.live.com', 'OneDrive'],
  ['youtube.com', 'YouTube'],
  ['www.youtube.com', 'YouTube'],
  ['m.youtube.com', 'YouTube'],
  ['youtu.be', 'YouTube'],
  ['vimeo.com', 'Vimeo'],
  ['www.vimeo.com', 'Vimeo'],
  ['player.vimeo.com', 'Vimeo'],
  ['dropbox.com', 'Dropbox'],
  ['www.dropbox.com', 'Dropbox'],
  ['dl.dropboxusercontent.com', 'Dropbox'],
]);

/** A syntactically public HTTPS destination. No DNS or access check is made. */
export function parseVideoReference(raw) {
  if (typeof raw !== 'string' || !raw || raw !== raw.trim()
    || raw.length > VIDEO_REFERENCE_URL_LIMIT || FORBIDDEN.test(raw)
    || !/^https:\/\//i.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const hostname = url.hostname;
  const labels = hostname.split('.');
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !hostname.includes('.') || hostname.endsWith('.') || PRIVATE_SUFFIX.test(hostname)
    || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(':')
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/i.test(labels[labels.length - 1])) return null;
  const provider = PROVIDERS.get(hostname)
    || (hostname === 'sharepoint.com' || hostname.endsWith('.sharepoint.com') ? 'SharePoint' : null)
    || (/\.(?:mp4|webm|mov|m4v)$/i.test(url.pathname) ? 'Video file' : null);
  if (!provider || url.href.length > VIDEO_REFERENCE_URL_LIMIT) return null;
  return { url: url.href, provider, hostname };
}

// Parentheses in Markdown destinations can themselves be balanced, e.g.
// [Clip](https://cdn.example.com/take(2).mp4). Only the enclosing delimiter is
// removed; a valid query/fragment is never shortened to guess a different URL.
function destinationFromToken(token, wrapped) {
  if (wrapped) {
    let depth = 0;
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '(') depth++;
      else if (token[i] === ')') {
        if (depth === 0) return token.slice(0, i);
        depth--;
      }
    }
  }
  // Only path-only bare links get ordinary prose punctuation removed. A
  // signed query may legitimately end in punctuation; leave that exact URL.
  return /[?#]/.test(token) ? token : token.replace(/[.,;:!?]+$/, '');
}

/** Extract up to ten unique links without rewriting the draft or fetching.
 * Oversize input/candidates are ignored whole, never sliced into destinations.
 * This is deliberately not a full Markdown parser: inline destinations, angle
 * autolinks and bare HTTPS links are supported, not reference-definition joins.
 */
function* referencesIn(content) {
  if (typeof content !== 'string' || content.length > CONTENT_LIMIT) return;
  for (const match of content.matchAll(/https:\/\/[^\s<>"`]+/gi)) {
    const previous = content[match.index - 1];
    if (previous && !/[\s([{<'"]/.test(previous)) continue;
    const raw = destinationFromToken(match[0], previous === '(');
    const parsed = parseVideoReference(raw);
    if (parsed) yield parsed;
  }
}

export function extractVideoReferences(content) {
  const links = [];
  const seen = new Set();
  for (const parsed of referencesIn(content)) {
    if (seen.has(parsed.url)) continue;
    seen.add(parsed.url);
    links.push(parsed);
    if (links.length === VIDEO_REFERENCE_LIMIT) break;
  }
  return links;
}

/** Exact normalized duplicate detection across the whole admitted text, not
 * merely the first ten links displayed by the convenience panel. */
export function hasVideoReference(content, normalizedUrl) {
  const wanted = parseVideoReference(normalizedUrl);
  if (!wanted) return false;
  for (const parsed of referencesIn(content)) {
    if (parsed.url === wanted.url) return true;
  }
  return false;
}
