// Disconnected storage experiment. No env, network, auth, AI or runtime imports.
// A trusted caller supplies an already-authorized owner UID; this is NOT auth.
const AUTO_ID = /^[A-Za-z0-9]{20}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_HOURS = { gmb: 12, facebook: 12, linkedin: 24, twitter: 6, instagram: 12, blog: 72, job: 72 };
const ENUMS = {
  platform: Object.keys(MIN_HOURS), contentType: ['text', 'image', 'text+image'],
  tone: ['professional', 'friendly', 'bold', 'educational'], length: ['short', 'medium', 'long'],
  imageStyle: ['photo', 'studio', 'illustration', 'minimal', 'bold'],
  grounding: ['none', 'site'], mode: ['auto', 'suggest'], lastStatus: ['', 'ok', 'error'],
};
const REQUIRED = ['id', 'ownerUid', 'clientId', 'client', 'platform', 'contentType', 'tone', 'length',
  'imageStyle', 'promptSeed', 'intervalHours', 'enabled', 'nextRunAt', 'lastRunAt', 'lastStatus',
  'lastError', 'runCount', 'createdAt', 'updatedAt'];
const OPTIONAL = ['grounding', 'mode', 'pageCursor'];
const FIELDS = new Set([...REQUIRED, ...OPTIONAL]);
const IMMUTABLE = new Set(['id', 'ownerUid', 'clientId', 'platform', 'createdAt']);

export class PilotStoreError extends Error {
  constructor(code) { super(code); this.name = 'PilotStoreError'; this.code = code; }
}
const fail = code => { throw new PilotStoreError(code); };
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])));
const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
function text(value, max, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function iso(value, empty = false) {
  if (empty && value === '') return true;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function owner(value) {
  if (!text(value, 128) || /[\s/]/.test(value)) fail('invalid_owner');
  return value;
}
function slug(value) {
  if (typeof value !== 'string' || value.length > 64 || !SLUG.test(value)) fail('invalid_client_id');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !AUTO_ID.test(value)) fail('invalid_id');
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail('invalid_revision');
}
function pageLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 200) fail('invalid_limit');
  return value;
}

/** Exact normalized Firestore shape; unknown/invalid legacy rows are refused, never repaired. */
export function validateAutomation(record) {
  if (!plain(record) || Reflect.ownKeys(record).some(k => typeof k !== 'string' || !FIELDS.has(k))
      || REQUIRED.some(k => !Object.hasOwn(record, k))) fail('invalid_record');
  id(record.id); owner(record.ownerUid); slug(record.clientId);
  for (const [key, values] of Object.entries(ENUMS)) {
    if (Object.hasOwn(record, key) && !values.includes(record[key])) fail('invalid_record');
  }
  if (!text(record.client, 50) || record.client.includes('/') || !text(record.promptSeed, 2000)
      || !text(record.lastError, 300, true) || typeof record.enabled !== 'boolean'
      || !Number.isSafeInteger(record.intervalHours) || record.intervalHours < MIN_HOURS[record.platform]
      || record.intervalHours > 8760 || !Number.isSafeInteger(record.runCount) || record.runCount < 0
      || (Object.hasOwn(record, 'pageCursor') && (!Number.isSafeInteger(record.pageCursor) || record.pageCursor < 0))
      || !iso(record.createdAt) || !iso(record.updatedAt) || !iso(record.nextRunAt) || !iso(record.lastRunAt, true)
      || record.updatedAt < record.createdAt) fail('invalid_record');
  return JSON.parse(canonical(record));
}

function decode(row) {
  if (!row || row.deleted === 1) return null;
  try {
    const automation = validateAutomation(JSON.parse(row.record_json));
    if (row.deleted !== 0 || !Number.isSafeInteger(row.revision) || row.revision < 1
        || automation.id !== row.id || automation.ownerUid !== row.owner_uid || automation.clientId !== row.client_id
        || Number(automation.enabled) !== row.enabled || automation.nextRunAt !== row.next_run_at
        || automation.createdAt !== row.created_at) fail('invalid_record');
    return { automation, revision: row.revision };
  } catch { fail('corrupt_storage'); }
}

/** D1-style prepare/bind/first/all adapter; only exercised on local SQLite. */
export async function createAutomationStore(db, ownerUid) {
  owner(ownerUid);
  // Redacted errors only: SQL error messages can contain a prompt or other row data.
  async function first(sql, ...params) {
    try { return await db.prepare(sql).bind(...params).first(); }
    catch { fail('storage_failed'); }
  }
  const meta = await first('SELECT schema_version FROM automation_pilot_meta WHERE singleton = 1');
  if (meta?.schema_version !== 1) fail('unsupported_schema');
  const read = key => first('SELECT * FROM automation_configs_pilot WHERE owner_uid = ? AND id = ?', ownerUid, key);

  return Object.freeze({
    async get(key) { return decode(await read(id(key))); },

    async create(input) {
      const record = validateAutomation(input);
      if (record.ownerUid !== ownerUid) fail('owner_mismatch');
      const serialized = canonical(record);
      const inserted = await first(`INSERT INTO automation_configs_pilot
        (id, owner_uid, client_id, enabled, next_run_at, created_at, revision, record_json)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO NOTHING RETURNING *`,
      record.id, ownerUid, record.clientId, Number(record.enabled), record.nextRunAt, record.createdAt, serialized);
      if (inserted) return decode(inserted);
      const existing = await read(record.id);
      // Retry only the identical initial create. Never resurrect deleted IDs or reset a later edit.
      if (existing?.deleted === 0 && existing.revision === 1 && existing.record_json === serialized) return decode(existing);
      fail('conflict');
    },

    async list({ clientId = null, limit = 200, after = '' } = {}) {
      pageLimit(limit);
      if (clientId !== null) slug(clientId);
      if (after !== '') id(after);
      let result;
      try {
        result = await db.prepare(`SELECT * FROM automation_configs_pilot
          WHERE owner_uid = ? AND deleted = 0 AND id > ? ${clientId === null ? '' : 'AND client_id = ?'}
          ORDER BY id LIMIT ?`).bind(ownerUid, after, ...(clientId === null ? [] : [clientId]), limit + 1).all();
      } catch { fail('storage_failed'); }
      if (!result?.success || !Array.isArray(result.results)) fail('storage_failed');
      const rows = result.results.map(decode);
      return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].automation.id : null };
    },

    async due(now, limit = 200) {
      if (!iso(now)) fail('invalid_time');
      pageLimit(limit);
      let result;
      try {
        result = await db.prepare(`SELECT * FROM automation_configs_pilot
          WHERE owner_uid = ? AND deleted = 0 AND enabled = 1 AND next_run_at <= ?
          ORDER BY next_run_at, id LIMIT ?`).bind(ownerUid, now, limit).all();
      } catch { fail('storage_failed'); }
      if (!result?.success || !Array.isArray(result.results)) fail('storage_failed');
      return result.results.map(decode);
    },

    async patch(key, expectedRevision, input) {
      id(key); revision(expectedRevision);
      if (!plain(input) || !Object.hasOwn(input, 'updatedAt') || Reflect.ownKeys(input).some(k =>
        typeof k !== 'string' || !FIELDS.has(k) || IMMUTABLE.has(k))) fail('invalid_patch');
      // Freeze the patch bytes before the first await; caller mutation cannot change a retry identity.
      let patch;
      try { patch = JSON.parse(canonical(input)); } catch { fail('invalid_patch'); }
      if (Object.keys(patch).length !== Object.keys(input).length) fail('invalid_patch');
      const patchJson = canonical(patch);
      const existing = await read(key);
      if (!existing || existing.deleted === 1) fail('not_found');
      if (existing.revision === expectedRevision + 1 && existing.last_patch_json === patchJson) return decode(existing);
      if (existing.revision !== expectedRevision) fail('conflict');
      const current = decode(existing).automation;
      const next = validateAutomation({ ...current, ...patch });
      if (next.updatedAt < current.updatedAt) fail('invalid_time');
      const saved = await first(`UPDATE automation_configs_pilot SET
        enabled = ?, next_run_at = ?, record_json = ?, last_patch_json = ?, revision = revision + 1
        WHERE owner_uid = ? AND id = ? AND revision = ? AND deleted = 0 RETURNING *`,
      Number(next.enabled), next.nextRunAt, canonical(next), patchJson, ownerUid, key, expectedRevision);
      if (saved) return decode(saved);
      // A lost race may be an identical concurrent retry; any different edit is a conflict.
      const raced = await read(key);
      if (raced?.deleted === 0 && raced.revision === expectedRevision + 1 && raced.last_patch_json === patchJson) return decode(raced);
      fail('conflict');
    },

    async remove(key, expectedRevision) {
      id(key); revision(expectedRevision);
      const removed = await first(`UPDATE automation_configs_pilot SET deleted = 1, enabled = 0,
        next_run_at = '', record_json = NULL, last_patch_json = NULL, revision = revision + 1
        WHERE owner_uid = ? AND id = ? AND revision = ? AND deleted = 0 RETURNING revision`,
      ownerUid, key, expectedRevision);
      if (removed) return { deleted: true, revision: removed.revision };
      const existing = await read(key);
      if (!existing) fail('not_found');
      if (existing.deleted === 1 && existing.revision === expectedRevision + 1) return { deleted: true, revision: existing.revision };
      fail('conflict');
    },
  });
}
