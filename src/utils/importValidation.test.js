import { describe, it, expect } from 'vitest';
import { PLATFORMS } from '../constants';
import { parseImportFile, postsToJSON } from './csv';
import {
  inspectImportFile, validateImportRows, getImportTemplate,
  MAX_IMPORT_ROWS, MAX_IMPORT_TEXT_CHARS, IMPORT_DRAFT_FIELDS,
} from './importValidation';

const draft = overrides => ({ client: 'Example Client', platform: 'linkedin', content: 'A draft.', ...overrides });
const check = overrides => validateImportRows([draft(overrides)]);
const codes = inspection => inspection.errors.map(error => error.code);

describe('strict draft-content row validation', () => {
  it('makes declared draft defaults explicit, preserves whitespace and does not invent a slug', () => {
    const raw = draft({ content: '  Caption\nwith trailing space  ', title: 'A title' });
    const inspected = validateImportRows([raw]);
    expect(inspected.errors).toEqual([]);
    expect(inspected.sourceRowCount).toBe(1);
    expect(inspected.rows[0]).toEqual({
      ...raw, altText: '', metaDescription: '', slug: '', imageUrl: '', tags: [],
      status: 'draft', approvalStatus: 'pending', feedback: '', isTemplate: false, scheduledDate: null,
    });
    expect(raw).not.toHaveProperty('scheduledDate');
  });

  it('reports every malformed row with stable one-based indices instead of dropping it', () => {
    const inspected = validateImportRows([null, draft({ content: '' }), draft(), [], 'text']);
    expect(inspected.sourceRowCount).toBe(5);
    expect(inspected.rows).toHaveLength(1);
    expect(inspected.errors.map(error => error.row)).toEqual([1, 2, 4, 5]);
    expect(inspected.errors.every(error => typeof error.message === 'string')).toBe(true);
  });

  it('reports sparse array holes rather than silently skipping source rows', () => {
    const input = new Array(2);
    input[1] = draft();
    const inspected = validateImportRows(input);
    expect(inspected.sourceRowCount).toBe(2);
    expect(inspected.errors).toContainEqual(expect.objectContaining({ row: 1, code: 'invalid_row' }));
    expect(inspected.rows).toHaveLength(1);
  });

  it.each(['client', 'content', 'platform'])('requires the %s field and does not default the platform', field => {
    const raw = draft(); delete raw[field];
    expect(validateImportRows([raw]).errors).toContainEqual(expect.objectContaining({ row: 1, field, code: 'required' }));
  });

  it.each(['myspace', 'toString', '__proto__', ' LinkedIn ', ''])('rejects unsupported or empty platform %j', platform => {
    expect(check({ platform }).rows).toEqual([]);
    expect(check({ platform }).errors.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PLATFORMS))('honors the %s content limit without shortening input', platform => {
    const max = PLATFORMS[platform].maxChars;
    const exact = draft({ platform, content: 'a'.repeat(max) });
    expect(validateImportRows([exact]).rows[0].content).toHaveLength(max);
    const long = { ...exact, content: `${exact.content}b` };
    expect(validateImportRows([long]).errors).toContainEqual(expect.objectContaining({ field: 'content', code: 'too_long' }));
    expect(long.content).toHaveLength(max + 1);
  });

  it.each([['client', 50], ['title', 200], ['altText', 300], ['metaDescription', 200], ['slug', 80], ['imageUrl', 500000]])('rejects over-limit %s rather than truncating it', (field, max) => {
      expect(check({ [field]: 'a'.repeat(max) }).errors).toEqual([]);
      const inspected = check({ [field]: 'a'.repeat(max + 1) });
      expect(inspected.errors).toContainEqual(expect.objectContaining({ field, code: 'too_long' }));
      expect(inspected.rows).toEqual([]);
    });

  it.each([42, true, {}, [], null])('does not coerce %j content into text', content => {
    expect(codes(check({ content }))).toContain('invalid_type');
  });

  it('does not strip slashes from client names or rewrite invalid slugs', () => {
    expect(codes(check({ client: 'Example/Client' }))).toContain('invalid_client');
    expect(codes(check({ slug: 'A title? with spaces' }))).toContain('invalid_slug');
  });

  it.each(['scheduled', 'posted', 'archived', 'bogus', null, true])('refuses imported status %j', status => {
    expect(codes(check({ status }))).toContain('review_state_unsupported');
  });

  it.each(['approved', 'changes_requested', 'bogus', null, true])('does not trust imported approval %j', approvalStatus => {
    expect(codes(check({ approvalStatus }))).toContain('review_state_unsupported');
  });

  it('refuses old feedback and history rather than mislabelling the import as a restore', () => {
    expect(codes(check({ feedback: 'Please change this.' }))).toContain('review_history_unsupported');
    for (const field of ['feedbackThread', 'reviewedBy', 'reviewedAt', 'reviewStage', 'sentForReviewAt']) {
      expect(check({ [field]: null }).errors).toContainEqual(expect.objectContaining({ field, code: 'unsupported_field' }));
    }
  });

  it('accepts only defined fields and keeps archival metadata loss visible', () => {
    const inspected = check({ id: 'old', uid: 'old-owner', clientId: 'old-tenant', createdAt: 'old-time', source: 'import' });
    expect(inspected.errors).toEqual([]);
    expect(inspected.warnings).toContainEqual(expect.objectContaining({ row: 1, code: 'new_thread_metadata' }));
    expect(Object.keys(inspected.rows[0]).sort()).toEqual([...IMPORT_DRAFT_FIELDS].sort());
    expect(check({ futureField: { secret: 'not echoed' } }).errors[0]).toMatchObject({ field: 'futureField', code: 'unsupported_field' });
    expect(check({ futureField: { secret: 'not echoed' } }).errors[0].message).not.toContain('not echoed');
  });

  it.each(['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'])('refuses protected %s presence even when empty/null', field => {
      for (const value of [null, '', [], {}, 1]) {
        expect(check({ [field]: value }).errors).toContainEqual(expect.objectContaining({ field, code: 'review_details_unsupported' }));
        expect(check({ [field]: value }).rows).toEqual([]);
      }
    });

  it.each(['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'])('refuses non-enumerable own %s presence without needing the App fence', field => {
    for (const value of [null, '', [], {}]) {
      const raw = draft();
      Object.defineProperty(raw, field, { value, enumerable: false });
      expect(Object.keys(raw)).not.toContain(field);
      const inspected = validateImportRows([raw]);
      expect(inspected.errors).toContainEqual(expect.objectContaining({ row: 1, field, code: 'review_details_unsupported' }));
      expect(inspected.rows).toEqual([]);
    }
  });

  it('validates tags without truncating or dropping blank items', () => {
    expect(check({ tags: ['a', 'b'] }).rows[0].tags).toEqual(['a', 'b']);
    expect(check({ tags: 'a | b' }).rows[0].tags).toEqual(['a', 'b']);
    expect(check({ tags: 'a,b' }).rows[0].tags).toEqual(['a', 'b']);
    expect(check({ tags: ['a'.repeat(20)] }).errors).toEqual([]);
    for (const tags of [['a'.repeat(21)], ['a', ''], ['a', 1], 'a||b', null, {}]) {
      expect(check({ tags }).errors.length).toBeGreaterThan(0);
    }
    expect(codes(check({ tags: new Array(11).fill('a') }))).toContain('too_many');
  });

  it.each([['tag', 'tag'], ['tag', ' tag '], 'tag| tag ', 'tag,tag'])('rejects editor-equivalent duplicate tags %j', tags => {
    expect(codes(check({ tags }))).toContain('duplicate_tags');
    expect(check({ tags }).rows).toEqual([]);
  });

  it('uses the editor tag normalization and exposes meaningful spacing changes', () => {
    const inspected = check({ tags: ['  one  ', 'two'] });
    expect(inspected.errors).toEqual([]);
    expect(inspected.rows[0].tags).toEqual(['one', 'two']);
    expect(inspected.warnings).toContainEqual(expect.objectContaining({ field: 'tags', code: 'tags_normalized' }));
  });

  it.each([true, false, 'true', 'false', ''])('accepts explicit template boolean %j', isTemplate => {
    expect(check({ isTemplate }).rows[0].isTemplate).toBe(isTemplate === true || isTemplate === 'true');
  });

  it.each(['TRUE', 'False', 'yes', 1, null, {}])('does not coerce invalid template flag %j', isTemplate => {
    expect(codes(check({ isTemplate }))).toContain('invalid_boolean');
  });

  it('bounds source row count and reports empty/invalid row containers', () => {
    expect(codes(validateImportRows({}))).toContain('invalid_rows');
    expect(codes(validateImportRows([]))).toContain('no_rows');
    expect(codes(validateImportRows(new Array(MAX_IMPORT_ROWS + 1).fill(draft())))).toContain('too_many_rows');
  });

  it('revalidates its own normalized rows without loss or new errors', () => {
    const inspected = check({ scheduledDate: null, tags: ['one'], content: '  unchanged  ' });
    const rechecked = validateImportRows(inspected.rows);
    expect(rechecked.errors).toEqual([]);
    expect(rechecked.rows).toEqual(inspected.rows);
  });
});

describe('explicit optional schedule', () => {
  it.each([undefined, null, ''])('keeps %j schedule unscheduled instead of now', scheduledDate => {
    expect(check({ scheduledDate }).rows[0].scheduledDate).toBeNull();
    expect(check({ scheduledDate }).warnings).toEqual([]);
  });
  it.each([
    ['2026-10-03T09:30:00-07:00', '2026-10-03T16:30:00.000Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['2000-02-29T12:30:01.2+01:00', '2000-02-29T11:30:01.200Z'],
    ['2026-10-03T16:30:00.000Z', '2026-10-03T16:30:00.000Z'],
  ])('canonicalizes the real timezone-explicit moment %s', (input, expected) => {
    const inspected = check({ scheduledDate: input });
    expect(inspected.errors).toEqual([]);
    expect(inspected.rows[0].scheduledDate).toBe(expected);
    expect(inspected.warnings.length).toBe(input === expected ? 0 : 1);
  });
  it.each([
    '2026-02-29T12:00:00Z', '1900-02-29T12:00:00Z', '2026-04-31T12:00:00Z',
    '2026-13-01T12:00:00Z', '2026-01-00T12:00:00Z', '2026-01-01T24:00:00Z',
    '2026-01-01T12:60:00Z', '2026-01-01T12:00:60Z', '2026-01-01T12:00:00+24:00',
    '2026-01-01T12:00:00+01:60', '2026-10-03', '2026-10-03T09:30', '10/03/2026',
    '2026-10-03T09:30:00', '2026-10-03T09:30:00.1234Z', 123, true, {},
    '9999-12-31T23:59:59-23:59', '0000-01-01T00:00:00+23:59',
  ])('refuses impossible, rolled-over or ambiguous schedule %j', scheduledDate => {
    expect(codes(check({ scheduledDate }))).toContain('invalid_date');
    expect(check({ scheduledDate }).rows).toEqual([]);
  });
});

describe('strict file dry-run and discoverable synthetic templates', () => {
  it('preserves quoted commas, escaped quotes, CRLF and meaningful caption whitespace', () => {
    const inspected = inspectImportFile('client,platform,content\r\nExample Client,linkedin,"  Hello, ""world""\r\nnext line  "\r\n');
    expect(inspected.errors).toEqual([]);
    expect(inspected.rows[0].content).toBe('  Hello, "world"\r\nnext line  ');
  });
  it.each([
    'client,platform,content\nExample Client,linkedin,"Unclosed',
    'client,platform,content\nExample Client,linkedin,un"quoted',
    'client,platform,content\nExample Client,linkedin,"Closed"trailing',
    'client,platform,content\nExample Client,linkedin,"Closed" ',
  ])('rejects malformed quoted CSV instead of altering its meaning %#', csv => {
    expect(codes(inspectImportFile(csv))).toContain('malformed_csv');
    expect(inspectImportFile(csv).rows).toEqual([]);
  });
  it.each([
    ['client,platform,content,content\nA,linkedin,B,C', 'duplicate_header'],
    ['client,platform,content,future\nA,linkedin,B,C', 'unsupported_header'],
    ['client,content\nA,B', 'missing_header'],
    ['client,platform,content\nA,linkedin,B,extra', 'column_count'],
    ['client,platform,content\nA,linkedin', 'column_count'],
    ['client,platform,content,\nA,linkedin,B,', 'unsupported_header'],
  ])('flags structural header/cell problem %s', (csv, expected) => {
    expect(codes(inspectImportFile(csv))).toContain(expected);
    expect(inspectImportFile(csv).rows).toEqual([]);
  });
  it('reports invalid rows while preserving valid preview rows without permitting a partial import', () => {
    const inspected = inspectImportFile('client,platform,content\nA,linkedin,Good\nA,linkedin,\nB,bogus,Body');
    expect(inspected.sourceRowCount).toBe(3);
    expect(inspected.rows).toHaveLength(1);
    expect(inspected.errors.map(error => error.row)).toEqual([2, 3]);
  });
  it('does not silently skip an explicitly quoted empty CSV record', () => {
    const inspected = inspectImportFile('client,platform,content\nA,linkedin,Good\n""');
    expect(codes(inspected)).toContain('column_count');
    expect(inspected.sourceRowCount).toBe(2);
    expect(inspected.rows).toEqual([]);
  });
  it('stops at the CSV row cap before reading a later malformed record', () => {
    const csv = `client,platform,content\n${new Array(MAX_IMPORT_ROWS + 1).fill('A,linkedin,Body').join('\n')}\n"unterminated`;
    const inspected = inspectImportFile(csv);
    expect(codes(inspected)).toEqual(['too_many_rows']);
    expect(inspected.sourceRowCount).toBe(MAX_IMPORT_ROWS + 1);
    expect(inspected.rows).toEqual([]);
  });
  it('allows the exact CSV row cap and bounds excessive cell allocation', () => {
    const csv = `client,platform,content\n${new Array(MAX_IMPORT_ROWS).fill('A,linkedin,Body').join('\n')}`;
    expect(inspectImportFile(csv).errors).toEqual([]);
    expect(inspectImportFile(csv).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(codes(inspectImportFile(new Array(100).fill('column').join(',')))).toContain('too_many_columns');
  });
  it('supports BOM and quoted current-format headers', () => {
    const inspected = inspectImportFile('\uFEFF"client","platform","content"\nA,linkedin,B');
    expect(inspected.errors).toEqual([]);
    expect(inspected.rows).toHaveLength(1);
  });
  it('rejects invalid JSON/envelopes and does not filter malformed items', () => {
    expect(codes(inspectImportFile('{bad', 'input.json'))).toContain('invalid_json');
    expect(codes(inspectImportFile('{"noPosts":[]}', 'input.json'))).toContain('invalid_json_shape');
    expect(codes(inspectImportFile('{"posts":[],"future":true}', 'input.json'))).toContain('unsupported_envelope');
    const inspected = inspectImportFile(JSON.stringify([draft(), null, { content: 'Missing client and platform' }]));
    expect(inspected.sourceRowCount).toBe(3);
    expect(inspected.rows).toHaveLength(1);
    expect(inspected.errors.some(error => error.row === 2)).toBe(true);
    expect(inspected.errors.some(error => error.row === 3)).toBe(true);
  });
  it('accepts supported export envelope metadata only as new-draft content, not historical restore', () => {
    const inspected = inspectImportFile(postsToJSON([draft({ id: 'old', createdAt: 'old-created', updatedAt: 'old-updated' })]), 'backup.json');
    expect(inspected.errors).toEqual([]);
    expect(inspected.warnings).toContainEqual(expect.objectContaining({ code: 'new_thread_metadata' }));
    expect(inspected.warnings).toContainEqual(expect.objectContaining({ row: null, code: 'archive_envelope' }));
    expect(inspected.rows[0]).not.toHaveProperty('id');
    expect(inspected.rows[0]).not.toHaveProperty('createdAt');
  });
  it('does not certify archival envelope counts or timestamps as restoration evidence', () => {
    const inspected = inspectImportFile(JSON.stringify({ posts: [draft()], count: 900, exportedAt: 'not-a-date' }), 'archive.json');
    expect(inspected.errors).toEqual([]);
    expect(inspected.sourceRowCount).toBe(1);
    expect(inspected.warnings).toContainEqual(expect.objectContaining({ code: 'archive_envelope', message: expect.stringContaining('not verified') }));
  });
  it('blocks even empty protected CSV headers and JSON fields', () => {
    expect(codes(inspectImportFile('client,platform,content,firstComment\nA,linkedin,B,'))).toContain('unsupported_header');
    expect(codes(inspectImportFile(JSON.stringify([draft({ reviewMediaLinks: null })])))).toContain('review_details_unsupported');
  });
  it('bounds the text file and rejects non-text data before parsing', () => {
    expect(codes(inspectImportFile(null))).toContain('invalid_file');
    expect(codes(inspectImportFile('a'.repeat(MAX_IMPORT_TEXT_CHARS + 1)))).toContain('file_too_large');
    expect(codes(inspectImportFile('client,platform,content'))).toContain('no_rows');
  });
  it.each(['csv', 'json'])('offers a valid synthetic %s draft template with no current date or real client data', format => {
    const template = getImportTemplate(format);
    expect(template.filename).toBe(`spool-draft-template.${format}`);
    const inspected = inspectImportFile(template.text, template.filename);
    expect(inspected.errors).toEqual([]);
    expect(inspected.warnings).toEqual([]);
    expect(inspected.rows).toHaveLength(1);
    expect(inspected.rows[0]).toMatchObject({ client: 'Example Client', status: 'draft', approvalStatus: 'pending', scheduledDate: null });
    expect(template.text).not.toContain('OMNI');
    expect(template.text).not.toContain('reviewDetails');
  });
  it('keeps the old CSV/export APIs untouched rather than claiming a global migration', () => {
    const [legacy] = parseImportFile('client,content,platform\nA,B,myspace');
    expect(legacy.platform).toBe('gmb');
    expect(() => getImportTemplate('xlsx')).toThrow('Choose CSV or JSON');
  });
});
