import { PLATFORMS } from '../constants';
import { CSV_COLUMNS, convertToCSV } from './csv';
import { REVIEW_DETAILS_PROTECTED_FIELDS } from './reviewDetails';
import { validatedTags } from './editorInputs';

// Draft-content import is deliberately separate from the legacy backup/parser
// APIs. Validation never silently drops rows, shortens content or trusts review
// history. A valid preview is not a permission or commit-success check.
export const MAX_IMPORT_TEXT_CHARS = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
export const IMPORT_DRAFT_FIELDS = Object.freeze([
  'client', 'platform', 'title', 'content', 'altText', 'metaDescription', 'slug',
  'status', 'approvalStatus', 'tags', 'scheduledDate', 'feedback', 'imageUrl', 'isTemplate',
]);
const ARCHIVAL_FIELDS = ['id', 'uid', 'clientId', 'createdAt', 'updatedAt', 'source'];
const KNOWN_FIELDS = new Set([...IMPORT_DRAFT_FIELDS, ...ARCHIVAL_FIELDS]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const issue = (row, field, code, message) => ({ row, field, code, message });
const result = (rows = [], errors = [], warnings = [], sourceRowCount = 0) =>
  ({ rows, errors, warnings, sourceRowCount });

function stringField(raw, field, max, row, errors, required = false) {
  const value = own(raw, field) ? raw[field] : '';
  if (typeof value !== 'string') {
    errors.push(issue(row, field, 'invalid_type', `${field} must be text.`));
    return '';
  }
  if (required && !value.trim()) {
    errors.push(issue(row, field, 'required', `${field} is required.`));
  }
  if (value.length > max) {
    errors.push(issue(row, field, 'too_long', `${field} must be ${max} characters or fewer.`));
  }
  return value;
}

function parseSchedule(value, row, errors, warnings) {
  if (value === undefined || value === null || value === '') return null;
  // A date-only/locale-dependent value is not an intentional scheduled moment.
  const match = typeof value === 'string' && value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) {
    errors.push(issue(row, 'scheduledDate', 'invalid_date', 'scheduledDate needs an ISO date/time with Z or a numeric timezone offset, or must be blank.'));
    return null;
  }
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetValid = zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59);
  const date = new Date(value);
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23
    || Number(minute) > 59 || Number(second) > 59 || !offsetValid || !Number.isFinite(date.getTime())) {
    errors.push(issue(row, 'scheduledDate', 'invalid_date', 'scheduledDate is not a real calendar date/time.'));
    return null;
  }
  const canonical = date.toISOString();
  if (!/^\d{4}-/.test(canonical)) {
    errors.push(issue(row, 'scheduledDate', 'invalid_date', 'scheduledDate must stay within a four-digit UTC calendar year.'));
    return null;
  }
  if (canonical !== value) warnings.push(issue(row, 'scheduledDate', 'date_normalized', 'Schedule is shown in equivalent UTC ISO format.'));
  return canonical;
}

function parseTags(value, row, errors, warnings) {
  if (value === undefined || value === '') return [];
  let tags;
  if (Array.isArray(value)) tags = value.slice();
  else if (typeof value === 'string') tags = value.split(value.includes('|') ? '|' : ',');
  else {
    errors.push(issue(row, 'tags', 'invalid_type', 'tags must be a list of text or a pipe/comma-separated cell.'));
    return [];
  }
  try {
    const normalized = validatedTags(tags);
    if (normalized.some((tag, index) => tag !== tags[index])) {
      warnings.push(issue(row, 'tags', 'tags_normalized', 'Tag spacing is trimmed, as in the editor.'));
    }
    return normalized;
  } catch (error) {
    const code = tags.length > 10 ? 'too_many' : error.message.includes('duplicate') ? 'duplicate_tags' : 'invalid_tag';
    errors.push(issue(row, 'tags', code, error.message));
    return [];
  }
}

/** Validate all source rows. Errors block the whole file; valid rows are preview-only. */
export function validateImportRows(input) {
  if (!Array.isArray(input)) return result([], [issue(null, '', 'invalid_rows', 'Use an array of draft-content rows.')]);
  if (input.length > MAX_IMPORT_ROWS) return result([], [issue(null, '', 'too_many_rows', `Use ${MAX_IMPORT_ROWS} rows or fewer.`)], [], input.length);
  const rows = [], errors = [], warnings = [];
  Array.from(input).forEach((raw, index) => {
    const row = index + 1, start = errors.length;
    if (!record(raw)) {
      errors.push(issue(row, '', 'invalid_row', 'Each row must be a plain draft-content object.'));
      return;
    }
    // Admission is own-property presence, independent of enumerability. The
    // App keeps its raw-input fence too; JSON/CSV parsing is not the only caller.
    for (const field of REVIEW_DETAILS_PROTECTED_FIELDS) {
      if (own(raw, field)) {
        errors.push(issue(row, field, 'review_details_unsupported', 'Review media, first comments and their acknowledgments cannot be imported yet.'));
      }
    }
    for (const field of Object.keys(raw)) {
      if (!REVIEW_DETAILS_PROTECTED_FIELDS.includes(field) && !KNOWN_FIELDS.has(field)) {
        errors.push(issue(row, field, 'unsupported_field', `${field} is not supported by draft-content import.`));
      }
    }
    const archival = ARCHIVAL_FIELDS.filter(field => own(raw, field) && raw[field] !== '' && raw[field] !== null && raw[field] !== undefined);
    if (archival.length) warnings.push(issue(row, archival.join(', '), 'new_thread_metadata', 'Import creates new IDs and timestamps; saved ownership, IDs and review history are not restored.'));
    const client = stringField(raw, 'client', 50, row, errors, true);
    if (client.includes('/')) errors.push(issue(row, 'client', 'invalid_client', 'client cannot contain a slash.'));
    const platform = stringField(raw, 'platform', 30, row, errors, true);
    const validPlatform = own(PLATFORMS, platform);
    if (platform && !validPlatform) errors.push(issue(row, 'platform', 'invalid_platform', `Use a platform key: ${Object.keys(PLATFORMS).join(', ')}.`));
    const content = stringField(raw, 'content', validPlatform ? PLATFORMS[platform].maxChars : 100000, row, errors, true);
    const title = stringField(raw, 'title', 200, row, errors);
    const altText = stringField(raw, 'altText', 300, row, errors);
    const metaDescription = stringField(raw, 'metaDescription', 200, row, errors);
    const imageUrl = stringField(raw, 'imageUrl', 500000, row, errors);
    const slug = stringField(raw, 'slug', 80, row, errors);
    if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) errors.push(issue(row, 'slug', 'invalid_slug', 'slug must use lowercase letters, numbers and single hyphens.'));
    for (const [field, expected] of [['status', 'draft'], ['approvalStatus', 'pending']]) {
      if (own(raw, field) && raw[field] !== '' && raw[field] !== expected) {
        errors.push(issue(row, field, 'review_state_unsupported', `Draft-content import only accepts ${field}=${expected}. It does not restore workflow or approvals.`));
      }
    }
    const feedback = stringField(raw, 'feedback', 500, row, errors);
    if (feedback !== '') errors.push(issue(row, 'feedback', 'review_history_unsupported', 'Existing review feedback cannot be restored through draft-content import.'));
    const template = own(raw, 'isTemplate') ? raw.isTemplate : false;
    if (![true, false, 'true', 'false', ''].includes(template)) errors.push(issue(row, 'isTemplate', 'invalid_boolean', 'isTemplate must be true or false.'));
    const tags = parseTags(raw.tags, row, errors, warnings);
    const scheduledDate = parseSchedule(raw.scheduledDate, row, errors, warnings);
    if (errors.length === start) rows.push({
      client, platform, content, title, altText, metaDescription, slug, imageUrl, tags,
      status: 'draft', approvalStatus: 'pending', feedback: '',
      isTemplate: template === true || template === 'true', scheduledDate,
    });
  });
  if (input.length === 0) errors.push(issue(null, '', 'no_rows', 'No draft-content rows were found.'));
  return result(rows, errors, warnings, input.length);
}

function readCSV(text) {
  const table = [];
  let cells = [], field = '', state = 'start', rowStarted = false;
  const endField = () => {
    if (cells.length >= KNOWN_FIELDS.size) throw issue(table.length || null, '', 'too_many_columns', `Use ${KNOWN_FIELDS.size} CSV columns or fewer.`);
    cells.push(field); field = ''; state = 'start';
  };
  const endRow = () => {
    endField();
    if (rowStarted) {
      // The first table entry is the header. Stop before allocating every row
      // of an excessive file, while retaining the declared whole-file refusal.
      if (table.length > MAX_IMPORT_ROWS) throw issue(null, '', 'too_many_rows', `Use ${MAX_IMPORT_ROWS} rows or fewer.`);
      table.push(cells);
    }
    cells = []; rowStarted = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\n' && char !== '\r') rowStarted = true;
    if (state === 'quoted') {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') state = 'closed';
      else field += char;
    } else if (char === ',') endField();
    else if (char === '\n' || char === '\r') {
      endRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (state === 'closed' || (char === '"' && state !== 'start')) {
      throw issue(table.length || null, '', 'malformed_csv', 'CSV has an invalid quote or text after a closing quote.');
    } else if (char === '"') state = 'quoted';
    else { field += char; state = 'bare'; }
  }
  if (state === 'quoted') throw issue(table.length || null, '', 'malformed_csv', 'CSV has an unclosed quoted cell.');
  if (rowStarted) endRow();
  return table;
}

/** Pure dry-run: no downloads, storage, network, IDs or Firestore operations. */
export function inspectImportFile(text, filename = '') {
  if (typeof text !== 'string') return result([], [issue(null, '', 'invalid_file', 'The import file must contain text.')]);
  if (text.length > MAX_IMPORT_TEXT_CHARS) return result([], [issue(null, '', 'file_too_large', `Use ${MAX_IMPORT_TEXT_CHARS} text characters or fewer.`)]);
  const content = text.replace(/^\uFEFF/, '');
  const json = /\.json$/i.test(filename) || /^\s*[[{]/.test(content);
  let input, envelopeWarning = null;
  if (json) {
    let parsed;
    try { parsed = JSON.parse(content); } catch { return result([], [issue(null, '', 'invalid_json', 'JSON could not be read. Check its brackets, commas and quotes.')]); }
    if (Array.isArray(parsed)) input = parsed;
    else if (record(parsed) && Array.isArray(parsed.posts)) {
      const unknown = Object.keys(parsed).filter(field => !['posts', 'exportedAt', 'count'].includes(field));
      if (unknown.length) return result([], unknown.map(field => issue(null, field, 'unsupported_envelope', `${field} is not supported in the JSON envelope.`)), [], parsed.posts.length);
      input = parsed.posts;
      if (own(parsed, 'exportedAt') || own(parsed, 'count')) {
        envelopeWarning = issue(null, 'exportedAt, count', 'archive_envelope', 'Export metadata is ignored, not verified. Draft-content import creates new threads; it does not restore a backup or its history.');
      }
    } else return result([], [issue(null, '', 'invalid_json_shape', 'Use a JSON array or an object containing a posts array.')]);
  } else {
    let table;
    try { table = readCSV(content); } catch (error) { return result([], [error], [], error.code === 'too_many_rows' ? MAX_IMPORT_ROWS + 1 : 0); }
    if (!table.length) return result([], [issue(null, '', 'no_rows', 'No draft-content rows were found.')]);
    const [headers, ...data] = table;
    const errors = [];
    const seen = new Set();
    for (const header of headers) {
      if (seen.has(header)) errors.push(issue(null, header, 'duplicate_header', `CSV repeats the ${header || 'blank'} column.`));
      seen.add(header);
      if (!header || !KNOWN_FIELDS.has(header)) errors.push(issue(null, header, 'unsupported_header', `${header || 'A blank column'} is not supported by draft-content import.`));
    }
    for (const field of ['client', 'content', 'platform']) {
      if (!seen.has(field)) errors.push(issue(null, field, 'missing_header', `CSV needs a ${field} column.`));
    }
    data.forEach((cells, index) => {
      if (cells.length !== headers.length) errors.push(issue(index + 1, '', 'column_count', 'CSV row has a different number of cells than its header.'));
    });
    if (errors.length) return result([], errors, [], data.length);
    input = data.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index]])));
  }
  const inspected = validateImportRows(input);
  if (envelopeWarning) inspected.warnings.unshift(envelopeWarning);
  return inspected;
}

/** Synthetic current-format examples; downloads are the UI's explicit action. */
export function getImportTemplate(format = 'csv') {
  const row = {
    client: 'Example Client', platform: 'linkedin', title: '',
    content: 'Replace this with your draft caption.', altText: '', metaDescription: '', slug: '',
    status: 'draft', approvalStatus: 'pending', tags: [], scheduledDate: null,
    feedback: '', imageUrl: '', isTemplate: false,
  };
  if (format === 'json') return { text: JSON.stringify([row], null, 2), filename: 'spool-draft-template.json', mime: 'application/json' };
  if (format !== 'csv') throw new Error('Choose CSV or JSON for the draft template.');
  // Keep the existing exporter untouched, including its historical column set.
  return { text: convertToCSV([Object.fromEntries(CSV_COLUMNS.map(field => [field, row[field] ?? '']))]), filename: 'spool-draft-template.csv', mime: 'text/csv;charset=utf-8;' };
}
