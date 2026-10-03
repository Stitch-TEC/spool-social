// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

const protectedFields = ['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'];
const env = { FIREBASE_PROJECT_ID: 'synthetic-maintenance', OWNER_UID: 'owner',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'synthetic@example.invalid', private_key: 'AA==' }) };
const id = 'A'.repeat(20);
const name = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/posts/${id}`;
const time = '2026-10-02T00:00:00.000000Z';
const later = '2026-10-02T00:01:00.000000Z';
const fields = { clientId: { stringValue: 'acme' }, uid: { stringValue: 'owner' } };
const document = (extra = {}, updateTime = time) => ({ name, fields: { ...fields, ...extra }, updateTime });
const snapshot = (extra = {}) => ({ name, fields: { clientId: 'acme', ...extra }, updateTime: time });
let fs;
let requests;
let readDoc;
let commitResponse;
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(async () => {
  vi.resetModules();
  fs = await import('./firestore.js');
  requests = [];
  readDoc = document();
  commitResponse = body => response({ commitTime: later, writeResults: body.writes.map(write => write.delete ? {} : { updateTime: later }) });
  vi.stubGlobal('crypto', { ...webcrypto, subtle: {
    importKey: vi.fn().mockResolvedValue({ synthetic: true }),
    sign: vi.fn().mockResolvedValue(new Uint8Array([0]).buffer),
  } });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url === 'https://oauth2.googleapis.com/token') return response({ access_token: 'synthetic-only', expires_in: 3600 });
    requests.push({ url, options });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://firestore.googleapis.com');
    if (options.method === 'POST' && parsed.pathname.endsWith(':commit')) return commitResponse(JSON.parse(options.body));
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (options.method === 'POST' && parsed.pathname.endsWith('/posts')) throw new Error('No synthetic producer should dispatch');
    return typeof readDoc === 'function' ? readDoc(url) : response(readDoc);
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const writes = () => requests.filter(item => ['DELETE', 'PATCH', 'POST'].includes(item.options.method));

describe('privileged post maintenance protects field presence', () => {
  it.each(protectedFields)('refuses null/ack/alias presence before DELETE: %s', async field => {
    readDoc = document({ [field]: { nullValue: null } });
    await expect(fs.deletePost(env, id)).rejects.toMatchObject({ code: 'review_details_maintenance_unsupported' });
    expect(writes()).toEqual([]);
  });
  it('binds an ordinary single delete to the selected and fresh revision', async () => {
    await fs.deletePost(env, id, { expected: { id, _updateTime: time } });
    expect(JSON.parse(writes()[0].options.body).writes).toEqual([
      { delete: name, currentDocument: { updateTime: time } },
    ]);
    expect(writes()[0].options.method).toBe('POST');
  });
  it('does not delete an ordinary post that changed after selection', async () => {
    readDoc = document({}, later);
    await expect(fs.deletePost(env, id, { expected: { id, _updateTime: time } })).rejects.toMatchObject({ code: 'update_conflict' });
    expect(writes()).toEqual([]);
  });
  it('does not issue DELETE when the fresh revision is absent', async () => {
    readDoc = { ...document(), updateTime: undefined };
    await expect(fs.deletePost(env, id)).rejects.toThrow(/revision is unconfirmed/);
    expect(writes()).toEqual([]);
  });
  it('keeps an already absent single post idempotent', async () => {
    readDoc = () => new Response('{}', { status: 404 });
    await expect(fs.deletePost(env, id)).resolves.toBe(true);
    expect(writes()).toEqual([]);
  });
  it('does not count a single delete with an unconfirmed acknowledgement as complete', async () => {
    commitResponse = () => response({ commitTime: later, writeResults: [{ updateTime: later }] });
    await expect(fs.deletePost(env, id)).rejects.toMatchObject({ outcomeUnknown: true, committed: 0 });
    expect(writes()).toHaveLength(1);
  });
  it.each(protectedFields)('generic create and update refuse protected field %s before dispatch', async field => {
    await expect(fs.createPost(env, { [field]: null })).rejects.toMatchObject({ code: 'review_details_maintenance_unsupported' });
    await expect(fs.updatePost(env, id, { [field]: null })).rejects.toMatchObject({ code: 'review_details_maintenance_unsupported' });
    expect(requests).toEqual([]);
  });
  it('generic post upsert is refused even for a legacy-looking patch', async () => {
    await expect(fs.mergeDocRaw(env, 'posts', id, { client: { stringValue: 'Acme' } })).rejects.toThrow(/post upsert/);
    expect(requests).toEqual([]);
  });
  it.each(['update', 'delete'])('requires the inventory revision before batch %s', async verb => {
    await expect(verb === 'update' ? fs.batchUpdateDocs(env, [name], { client: 'New' }) : fs.batchDeleteDocs(env, [name]))
      .rejects.toThrow(/inventory revision is missing/);
    expect(requests).toEqual([]);
  });
  it.each(protectedFields)('refuses a protected fresh read before either lifecycle commit: %s', async field => {
    readDoc = document({ [field]: { nullValue: null } });
    await expect(fs.batchUpdateDocs(env, [name], { client: 'New' }, { postSnapshots: [snapshot()] }))
      .rejects.toMatchObject({ code: 'review_details_maintenance_unsupported' });
    await expect(fs.batchDeleteDocs(env, [name], { postSnapshots: [snapshot()] }))
      .rejects.toMatchObject({ code: 'review_details_maintenance_unsupported' });
    expect(writes()).toEqual([]);
  });
  it('does not adopt a tenant/content revision changed since the lifecycle inventory', async () => {
    readDoc = document({}, later);
    await expect(fs.batchUpdateDocs(env, [name], { client: 'New' }, { postSnapshots: [snapshot()] }))
      .rejects.toMatchObject({ code: 'update_conflict' });
    expect(writes()).toEqual([]);
  });
  it('rejects a foreign-project post resource before reading it', async () => {
    await expect(fs.batchDeleteDocs(env, [name.replace('synthetic-maintenance', 'foreign')]))
      .rejects.toThrow(/outside this project/);
    expect(requests).toEqual([]);
  });
  it.each(['update', 'delete'])('sends exact updateTime preconditions on a valid legacy batch %s', async verb => {
    const options = { postSnapshots: [snapshot()] };
    await expect(verb === 'update' ? fs.batchUpdateDocs(env, [name], { client: 'New' }, options) : fs.batchDeleteDocs(env, [name], options))
      .resolves.toBe(1);
    const write = JSON.parse(writes()[0].options.body).writes[0];
    expect(write.currentDocument).toEqual({ updateTime: time });
  });
  it('surfaces a race after the fresh read without retrying or counting the failed chunk', async () => {
    commitResponse = () => new Response('{"error":{"status":"FAILED_PRECONDITION"}}', { status: 412 });
    await expect(fs.batchDeleteDocs(env, [name], { postSnapshots: [snapshot()] })).rejects.toMatchObject({ committed: 0 });
    expect(writes()).toHaveLength(1);
  });
  it('does not commit an earlier row when a later fresh post read fails', async () => {
    const other = name.slice(0, -20) + 'B'.repeat(20);
    readDoc = url => url.includes('B'.repeat(20)) ? new Response('{}', { status: 503 }) : response(document());
    await expect(fs.batchDeleteDocs(env, [name, other], { postSnapshots: [snapshot(), { ...snapshot(), name: other }] }))
      .rejects.toThrow(/revision read is unconfirmed/);
    expect(writes()).toEqual([]);
  });
  it('a blank update result is not an acknowledgement of an update', async () => {
    commitResponse = () => response({ commitTime: later, writeResults: [{}] });
    await expect(fs.batchUpdateDocs(env, [name], { client: 'New' }, { postSnapshots: [snapshot()] }))
      .rejects.toMatchObject({ outcomeUnknown: true, committed: 0 });
  });
  it('does not accept update timestamps on a delete acknowledgement', async () => {
    commitResponse = () => response({ commitTime: later, writeResults: [{ updateTime: later }] });
    await expect(fs.batchDeleteDocs(env, [name], { postSnapshots: [snapshot()] }))
      .rejects.toMatchObject({ outcomeUnknown: true, committed: 0 });
  });
  it.each([{}, { commitTime: later, writeResults: [] }, { commitTime: later, writeResults: [null] }])(
    'a successful HTTP status does not prove an acknowledged commit: %j', async ack => {
      commitResponse = () => response(ack);
      await expect(fs.batchDeleteDocs(env, [name], { postSnapshots: [snapshot()] }))
        .rejects.toMatchObject({ committed: 0, outcomeUnknown: true });
      expect(writes()).toHaveLength(1);
    });
  it('preserves non-post branding helpers without requiring a post inventory', async () => {
    const clientName = name.replace('/posts/', '/clients/');
    await expect(fs.batchUpdateDocs(env, [clientName], { name: 'New' })).resolves.toBe(1);
    expect(JSON.parse(writes()[0].options.body).writes[0].currentDocument).toEqual({ exists: true });
    expect(requests).toHaveLength(1);
  });
});

describe('lifecycle preflight before any store changes', () => {
  it.each(protectedFields)('a protected later suggestion stops the whole rename: %s', async field => {
    const { propagateClientRename } = await import('./index.js');
    const list = vi.fn(async (_env, _collection, queryField) => queryField === 'clientId' ? [snapshot()]
      : [{ ...snapshot({ [field]: null }), fields: { clientId: '', [field]: null } }]);
    const result = await propagateClientRename(env, 'acme', 'New Acme', { list });
    expect(result.errors).toHaveLength(1);
    expect(result.counts.suggestions).toBe(0);
    expect(requests).toEqual([]);
    expect(list.mock.calls[0][4].select).toEqual(expect.arrayContaining(protectedFields));
  });
  it.each(protectedFields)('a protected post stops every purge store and R2: %s', async field => {
    const { purgeClient } = await import('./index.js');
    const list = vi.fn(async (_env, collection, queryField) => collection === 'posts' && queryField === 'clientId'
      ? [snapshot({ [field]: null })] : []);
    const remove = vi.fn(), removeObjects = vi.fn();
    const result = await purgeClient({ ...env, MEDIA: {} }, 'acme', {
      list, remove, removeObjects, listObjects: vi.fn().mockResolvedValue([]),
    });
    expect(result.errors).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
    expect(removeObjects).not.toHaveBeenCalled();
  });
  it('stops remaining purge stores and media after an uncertain first post commit', async () => {
    const { purgeClient } = await import('./index.js');
    const remove = vi.fn().mockRejectedValue(Object.assign(new Error('Outcome unconfirmed; inspect'), { committed: 0, outcomeUnknown: true }));
    const removeObjects = vi.fn();
    const result = await purgeClient({ ...env, MEDIA: {} }, 'acme', {
      list: vi.fn().mockResolvedValue([]), remove, removeObjects, listObjects: vi.fn().mockResolvedValue([]),
    });
    expect(result.errors).toHaveLength(1);
    expect(remove).toHaveBeenCalledOnce();
    expect(removeObjects).not.toHaveBeenCalled();
  });
});

describe('review details participate in complete GC reference collection', () => {
  const typed = value => value === null ? { nullValue: null }
    : Array.isArray(value) ? { arrayValue: { values: value.map(typed) } }
      : typeof value === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, v]) => [key, typed(v)])) } }
        : typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value };
  it('retains cover, caption, first-comment and direct review-media references', () => {
    const details = { reviewDetailsVersion: 1,
      firstComment: '![Proof](/media/generated/owner/comment.png)',
      reviewMedia: [{ id: 'M'.repeat(20), url: 'https://spool.stitchtec.dev/media/generated/owner/review.mp4', label: 'Cut', version: 'v1' }],
      content: '[Download](/media/generated/owner/caption.png)', imageUrl: '/media/generated/owner/cover.png' };
    const result = fs.collectPostImageReferences([{ fields: Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typed(value)])) }]);
    expect(result).toEqual(new Set(['/media/generated/owner/comment.png', '/media/generated/owner/comment.png)',
      'https://spool.stitchtec.dev/media/generated/owner/review.mp4',
      '/media/generated/owner/caption.png', '/media/generated/owner/cover.png']));
  });
  it.each(protectedFields)('malformed/ack-only/alias-only GC shape does not imply no references: %s', field => {
    expect(() => fs.collectPostImageReferences([{ fields: { [field]: { nullValue: null } } }])).toThrow();
  });
  it('rejects ambiguous typed review fields before extracting references', () => {
    expect(() => fs.collectPostImageReferences([{ fields: {
      reviewDetailsVersion: { integerValue: '1' }, firstComment: { stringValue: '', nullValue: null },
    } }])).toThrow(/ambiguous/);
  });
  it('legacy absence and sticky empty version remain valid without injecting metadata', () => {
    expect(fs.collectPostImageReferences([{ fields: {} }, { fields: { reviewDetailsVersion: { integerValue: '1' } } }])).toEqual(new Set());
  });
  it('plain first-comment URLs retain media even without Markdown syntax', () => {
    const refs = fs.collectPostImageReferences([{ fields: {
      reviewDetailsVersion: { integerValue: '1' },
      firstComment: { stringValue: 'See https://spool.stitchtec.dev/media/generated/owner/plain.png. Also /media/generated/owner/relative.png' },
    } }]);
    expect(refs).toContain('https://spool.stitchtec.dev/media/generated/owner/plain.png');
    expect(refs).toContain('/media/generated/owner/relative.png');
  });
});
