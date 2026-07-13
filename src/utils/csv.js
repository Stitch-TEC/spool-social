import { PLATFORMS, STATUS, APPROVAL_STATUS } from '../constants';

// Data transfer (CSV + JSON) for posts.
//
// CSV is the human-friendly, spreadsheet-editable format; JSON is the
// full-fidelity backup. Both round-trip through the SAME normalizer
// (`normalizeImportedPost`) so an import is consistent regardless of source.

// Lossless column set — order is the on-disk CSV column order. Adding
// title/altText/metaDescription/slug/tags here is what makes long-form (blog/
// job) content survive an export → edit → import round-trip.
export const CSV_COLUMNS = [
  'id', 'client', 'platform', 'title', 'content', 'altText', 'metaDescription',
  'slug', 'status', 'approvalStatus', 'tags', 'scheduledDate', 'createdAt',
  'updatedAt', 'feedback', 'imageUrl', 'isTemplate'
];

// Multi-value fields (tags) are joined with this so they survive inside a
// single CSV cell without colliding with the comma field-separator.
const TAG_DELIM = '|';

const toISO = (value) => {
  if (!value) return '';
  if (value instanceof Date) return isNaN(value) ? '' : value.toISOString();
  return String(value);
};

const serializeCell = (header, post) => {
  if (header === 'tags') {
    return Array.isArray(post.tags) ? post.tags.join(TAG_DELIM) : (post.tags || '');
  }
  const value = post[header];
  if (value instanceof Date) return toISO(value);
  return value == null ? '' : String(value);
};

/**
 * Converts an array of post objects into a CSV string.
 * Handles escaping quotes and wrapping fields that contain commas or newlines.
 */
export const convertToCSV = (posts) => {
  const rows = (posts || []).map(post =>
    CSV_COLUMNS.map(header => {
      const stringValue = serializeCell(header, post);
      const escaped = stringValue.replace(/"/g, '""');
      return /[,\n\r"]/.test(stringValue) ? `"${escaped}"` : stringValue;
    }).join(',')
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
};

/**
 * A robust CSV parser that handles:
 * 1. Quoted fields containing commas
 * 2. Quoted fields containing newlines
 * 3. Escaped double quotes ("")
 * Returns normalized, validated post objects (see normalizeImportedPost).
 */
export const parseCSV = (csvText) => {
  const result = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++; // skip next quote
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\n' || char === '\r') {
        currentRow.push(currentField.trim());
        if (currentRow.length > 0 && (currentRow.length > 1 || currentRow[0] !== '')) {
          result.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        if (char === '\r' && nextChar === '\n') i++; // skip \n in \r\n
      } else {
        currentField += char;
      }
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    result.push(currentRow);
  }

  if (result.length < 2) return [];

  const headers = result[0].map(h => h.replace(/^"|"$/g, ''));
  const posts = [];

  for (let i = 1; i < result.length; i++) {
    const row = result[i];
    if (row.length === 0 || (row.length === 1 && row[0] === '')) continue;

    const raw = {};
    headers.forEach((header, index) => {
      raw[header] = row[index] ?? '';
    });

    const normalized = normalizeImportedPost(raw);
    if (normalized) posts.push(normalized);
  }

  return posts;
};

/**
 * Parses a JSON backup (an array of posts, or { posts: [...] }) into the same
 * normalized shape that parseCSV produces. Throws on malformed JSON.
 */
export const parseJSON = (jsonText) => {
  const data = JSON.parse(jsonText);
  const arr = Array.isArray(data) ? data : Array.isArray(data?.posts) ? data.posts : null;
  if (!arr) return [];
  return arr.map(normalizeImportedPost).filter(Boolean);
};

/**
 * Detects the format from filename/content and parses accordingly.
 * Returns normalized post objects ready for import.
 */
export const parseImportFile = (text, filename = '') => {
  const isJSON = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);
  return isJSON ? parseJSON(text) : parseCSV(text);
};

const splitTags = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  // Accept either our pipe delimiter or a plain comma list.
  return String(value).split(value.includes(TAG_DELIM) ? TAG_DELIM : ',');
};

/**
 * The single source of truth for sanitizing an incoming row (CSV cell-map or
 * JSON object) into a safe post. Mirrors the server-side limits in the Worker
 * and the explicit field-mapping in App's save path (no mass-assignment).
 * Returns null for rows missing the required client/content.
 */
export const normalizeImportedPost = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  const client = String(raw.client || '').trim().replace(/\//g, '').slice(0, 50);
  const content = String(raw.content || '').trim();
  if (!client || !content) return null;

  const platform = PLATFORMS[raw.platform] ? raw.platform : 'gmb';
  const status = Object.values(STATUS).includes(raw.status) ? raw.status : STATUS.DRAFT;
  const approvalStatus = Object.values(APPROVAL_STATUS).includes(raw.approvalStatus)
    ? raw.approvalStatus
    : APPROVAL_STATUS.PENDING;

  const tags = splitTags(raw.tags)
    .map(t => String(t).trim().replace(/^#/, '').slice(0, 20))
    .filter(Boolean)
    .slice(0, 10);

  let scheduledDate = null;
  if (raw.scheduledDate) {
    const d = new Date(raw.scheduledDate);
    scheduledDate = isNaN(d.getTime()) ? null : d.toISOString();
  }

  const title = String(raw.title || '').trim().slice(0, 200);
  const slug = (String(raw.slug || '') || title)
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  return {
    client,
    content: content.slice(0, PLATFORMS[platform].maxChars),
    title,
    altText: String(raw.altText || '').trim().slice(0, 300),
    metaDescription: String(raw.metaDescription || '').trim().slice(0, 200),
    slug,
    platform,
    status,
    approvalStatus,
    feedback: String(raw.feedback || '').trim().slice(0, 500),
    imageUrl: String(raw.imageUrl || '').slice(0, 500000),
    tags,
    // Survives the backup round-trip (JSON boolean or CSV "true") so restoring a
    // full export doesn't flood the dated queue with evergreen templates.
    isTemplate: raw.isTemplate === true || String(raw.isTemplate).toLowerCase() === 'true',
    scheduledDate
  };
};

/**
 * Full-fidelity JSON backup of posts. Strips the runtime-only `_*` cache fields
 * and converts Date objects back to ISO strings.
 */
export const postsToJSON = (posts) => {
  const clean = (posts || []).map(p => {
    const out = {};
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith('_')) continue;
      out[k] = v instanceof Date ? toISO(v) : v;
    }
    return out;
  });
  return JSON.stringify({ exportedAt: new Date().toISOString(), count: clean.length, posts: clean }, null, 2);
};

/** A content fingerprint used to detect duplicate posts on import. */
export const postFingerprint = (p) =>
  `${(p.client || '').trim().toLowerCase()}|${p.platform || ''}|${(p.content || '').trim()}`;

/**
 * Restrict a post list to an explicit set of client display names. A null /
 * empty selection means "no filter" (return everything) — the caller decides
 * whether that's "all clients" or "nothing" before calling. Used by both the
 * export scope picker and the operator's per-client import filter.
 */
export const filterPostsByClients = (posts, clientNames) => {
  if (!clientNames || clientNames.length === 0) return (posts || []).slice();
  const keep = new Set(clientNames);
  return (posts || []).filter((p) => keep.has(p.client));
};

/**
 * Force every row's display `client` to a single name — used when a client
 * member imports: their content can only ever land in their OWN tenant, so the
 * `client` column in the uploaded file is ignored (the immutable clientId is
 * pinned server-side on write, and the Firestore rules enforce it regardless).
 * Idempotent: the App write path re-pins as defense-in-depth.
 */
export const repinPostsToClient = (posts, clientName) =>
  (posts || []).map((p) => ({ ...p, client: clientName }));

/** Triggers a browser download of a text file. */
export const downloadFile = (text, filename, mime = 'text/csv;charset=utf-8;') => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// Back-compat alias.
export const downloadCSV = (csvText, filename) => downloadFile(csvText, filename);
