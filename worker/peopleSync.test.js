// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index.js';
import { syncClientUserAccess } from './firestore.js';
import { admitPeopleSyncRecord, parsePeopleSyncIntent } from './peopleSync.js';

const email = 'dillon@omni-nde.com';
const clientId = 'omni-nde';
const env = {
  INTERNAL_API_KEY: 'synthetic-people-sync-key',
  FIREBASE_PROJECT_ID: 'synthetic-people-sync',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'synthetic@example.invalid', private_key: 'AA==' }),
};
const name = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${email}`;
const initialTime = '2026-10-01T17:01:00.123456Z';
const nextTime = '2026-10-01T17:02:00.987654Z';
const clientFields = {
  roles: { arrayValue: { values: [{ stringValue: 'client' }] } },
  clientId: { stringValue: clientId },
  email: { stringValue: email },
  displayName: { stringValue: 'Preserve this name' },
  preferences: { mapValue: { fields: { compact: { booleanValue: true } } } },
};
const document = (fields = clientFields, updateTime = initialTime) => ({ name, fields: structuredClone(fields), updateTime });
const intent = action => ({ email, clientId, action });
const response = (body, status = 200) => Response.json(body, { status });
const providerError = (status, code) => response({ error: { status: code, message: 'never expose provider text' } }, status);
const commitAck = (action = 'grant', updateTime = nextTime) => ({
  writeResults: [action === 'grant' ? { updateTime } : {}], commitTime: nextTime,
});

function storeFixture({ initial = document(), race, readResponse, writeResponse, readFailure, writeFailure, loseAfterCommit } = {}) {
  let stored = initial === null ? null : structuredClone(initial);
  const reads = [], writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    if (input === 'https://oauth2.googleapis.com/token') return response({ access_token: 'synthetic-token', expires_in: 3600 });
    const url = new URL(input);
    expect(url.origin).toBe('https://firestore.googleapis.com');
    expect(options.headers.Authorization).toBe('Bearer synthetic-token');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe('error');
    if (!options.method || options.method === 'GET') {
      expect(decodeURIComponent(url.pathname)).toBe(`/v1/${name}`);
      reads.push({ url, options });
      if (readFailure) throw new Error('synthetic read failure');
      if (readResponse) return readResponse();
      return stored === null ? providerError(404, 'NOT_FOUND') : response(stored);
    }
    expect(decodeURIComponent(url.pathname)).toBe(`/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`);
    expect(url.search).toBe('');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(Object.keys(body)).toEqual(['writes']);
    expect(body.writes).toHaveLength(1);
    const write = body.writes[0];
    writes.push({ url, options, write });
    if (race) stored = race(stored);
    if (writeFailure) throw new Error('synthetic lost response');
    if (writeResponse) return writeResponse({ stored, url, options });
    if (write.currentDocument.exists === false) {
      expect(write.currentDocument).toEqual({ exists: false });
      if (stored) return providerError(409, 'ALREADY_EXISTS');
    } else {
      expect(Object.keys(write.currentDocument)).toEqual(['updateTime']);
      if (!stored || write.currentDocument.updateTime !== stored.updateTime) {
        return providerError(400, 'FAILED_PRECONDITION');
      }
    }
    if (write.delete) {
      expect(write).toEqual({ delete: name, currentDocument: { updateTime: stored.updateTime } });
      stored = null;
      if (loseAfterCommit) throw new Error('synthetic committed delete with lost acknowledgement');
      return response(commitAck('revoke'));
    }
    expect(Object.keys(write)).toEqual(['update', 'updateMask', 'currentDocument']);
    expect(write.update.name).toBe(name);
    const patch = write.update.fields;
    expect(write.updateMask).toEqual({ fieldPaths: Object.keys(patch) });
    expect(Object.keys(patch)).toEqual(['roles', 'email', 'clientId', 'updatedAt', 'source']);
    stored = { name, fields: { ...(stored?.fields || {}), ...patch }, updateTime: nextTime };
    if (loseAfterCommit) throw new Error('synthetic committed update with lost acknowledgement');
    return response(commitAck());
  }));
  return { reads, writes, current: () => stored };
}

async function request(body = intent('grant'), { method = 'POST', token = env.INTERNAL_API_KEY, overrides = {} } = {}) {
  return worker.fetch(new Request('https://spool.example/api/people-sync', {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), { ...env, ...overrides }, {});
}

beforeEach(() => {
  vi.stubGlobal('crypto', { subtle: {
    importKey: vi.fn().mockResolvedValue({ synthetic: true }),
    sign: vi.fn().mockResolvedValue(new Uint8Array([0]).buffer),
  } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded people-sync intent and ordinary client admission', () => {
  it('preserves normalized historical input and accepts the intended OMNI shape', () => {
    expect(parsePeopleSyncIntent({ email: ` ${email.toUpperCase()} `, clientId: ' OMNI-NDE ', action: 'grant' }))
      .toEqual(intent('grant'));
    expect(() => admitPeopleSyncRecord(intent('grant'), { roles: ['client'], clientId, email })).not.toThrow();
    expect(() => admitPeopleSyncRecord(intent('grant'), { roles: ['client'], clientId })).not.toThrow();
  });
  it.each([null, [], 'text', 42])('rejects a nonobject intent %j', body => {
    expect(() => parsePeopleSyncIntent(body)).toThrow('invalid_sync_request');
  });
  it.each(['', 'not-email', 'x/y@omni-nde.com', 'x\u0000@omni-nde.com', `${'a'.repeat(250)}@example.test`, {}, []])('rejects malformed email %j', value => {
    expect(() => parsePeopleSyncIntent({ ...intent('grant'), email: value })).toThrow('valid_email_required');
  });
  it.each(['', 'other/slug', 'a'.repeat(65), '../a', {}, [], null])('requires a valid tenant even for revoke: %j', value => {
    expect(() => parsePeopleSyncIntent({ ...intent('revoke'), clientId: value })).toThrow('valid_clientId_required');
  });
  it.each(['Grant', '', false, {}, []])('rejects action %j', action => {
    expect(() => parsePeopleSyncIntent({ ...intent('grant'), action })).toThrow('invalid_sync_action');
  });
  it.each([
    {}, { roles: null }, { roles: 'client', clientId }, { roles: [], clientId },
    { roles: ['client', 'client'], clientId }, { roles: ['unknown'], clientId },
    { roles: ['client', 'unknown'], clientId }, { roles: ['client'], clientId: '' },
    { roles: ['client'], clientId: 'OMNI-NDE' }, { roles: ['client'], clientId, email: 'someone@example.test' },
    { roles: ['client'], clientId, email: null },
  ])('refuses malformed existing identity %j', record => {
    expect(() => admitPeopleSyncRecord(intent('grant'), record)).toThrow('malformed_access_record');
  });
});

describe('actual people-sync router with conditional Firestore transport', () => {
  it.each(['grant', 'revoke'])('acknowledges ordinary same-tenant %s with an exact revision', async action => {
    const store = storeFixture();
    const result = await request(intent(action));
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ ok: true, status: action === 'grant' ? 'granted' : 'revoked', ...intent(action) });
    expect(store.reads).toHaveLength(1);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].write.currentDocument).toEqual({ updateTime: initialTime });
    if (action === 'grant') {
      expect(store.current().fields.displayName).toEqual(clientFields.displayName);
      expect(store.current().fields.preferences).toEqual(clientFields.preferences);
      expect(store.current().fields.roles).toEqual(clientFields.roles);
    } else expect(store.current()).toBeNull();
  });
  it('adds a missing ordinary user only with exists:false', async () => {
    const store = storeFixture({ initial: null });
    expect((await request()).status).toBe(200);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].write.currentDocument).toEqual({ exists: false });
    expect(store.current().fields.clientId).toEqual({ stringValue: clientId });
  });
  it('treats an absent revoke as an observed no-op, without writing', async () => {
    const store = storeFixture({ initial: null });
    const result = await request(intent('revoke'));
    expect(result.status).toBe(200);
    expect((await result.json()).status).toBe('revoked');
    expect(store.writes).toEqual([]);
  });
  it('accepts a same-tenant legacy client without an email field', async () => {
    const fields = structuredClone(clientFields); delete fields.email;
    const store = storeFixture({ initial: document(fields) });
    expect((await request()).status).toBe(200);
    expect(store.current().fields.email).toEqual({ stringValue: email });
  });
  it.each(['grant', 'revoke'])('refuses cross-tenant %s without mutation', async action => {
    const store = storeFixture({ initial: document({ ...clientFields, clientId: { stringValue: 'other-client' } }) });
    const result = await request(intent(action));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ ok: false, error: 'client_mismatch' });
    expect(store.writes).toEqual([]);
  });
  it.each(['super_admin', 'client_admin'])('protects %s for both grant and revoke', async role => {
    const store = storeFixture({ initial: document({ ...clientFields, roles: { arrayValue: { values: [{ stringValue: role }] } } }) });
    for (const action of ['grant', 'revoke']) {
      const result = await request(intent(action));
      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ ok: false, error: 'privileged_account_hand_managed' });
    }
    expect(store.writes).toEqual([]);
  });
  it.each([
    ['unknown role', { roles: { arrayValue: { values: [{ stringValue: 'operator' }] } } }],
    ['duplicate roles', { roles: { arrayValue: { values: [{ stringValue: 'client' }, { stringValue: 'client' }] } } }],
    ['malformed client', { clientId: { stringValue: 'OMNI-NDE' } }],
    ['mismatched email', { email: { stringValue: 'other@example.test' } }],
    ['null email', { email: { nullValue: null } }],
  ])('refuses typed but malformed identity %s before either mutation', async (_label, malformed) => {
    const store = storeFixture({ initial: document({ ...clientFields, ...malformed }) });
    for (const action of ['grant', 'revoke']) {
      const result = await request(intent(action));
      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ ok: false, error: 'malformed_access_record' });
    }
    expect(store.writes).toEqual([]);
  });
  it.each(['grant', 'revoke'])('refuses a racing role promotion during %s without retry', async action => {
    const store = storeFixture({ race: live => document({ ...live.fields, roles: { arrayValue: { values: [{ stringValue: 'super_admin' }] } } }, nextTime) });
    const result = await request(intent(action));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ ok: false, error: 'access_changed' });
    expect(store.reads).toHaveLength(1); expect(store.writes).toHaveLength(1);
    expect(store.current().fields.roles.arrayValue.values[0].stringValue).toBe('super_admin');
  });
  it.each(['grant', 'revoke'])('refuses a racing tenant reassignment during %s without retry', async action => {
    const store = storeFixture({ race: live => document({ ...live.fields, clientId: { stringValue: 'new-client' } }, nextTime) });
    const result = await request(intent(action));
    expect(result.status).toBe(409); expect((await result.json()).error).toBe('access_changed');
    expect(store.reads).toHaveLength(1); expect(store.writes).toHaveLength(1);
    expect(store.current().fields.clientId.stringValue).toBe('new-client');
  });
  it('does not recreate a record revoked after its read', async () => {
    const store = storeFixture({ race: () => null });
    expect((await request()).status).toBe(409);
    expect(store.current()).toBeNull(); expect(store.writes).toHaveLength(1);
  });
  it('does not overwrite a record created after an absent read', async () => {
    const store = storeFixture({ initial: null, race: () => document({ ...clientFields, clientId: { stringValue: 'new-client' } }, nextTime) });
    expect((await request()).status).toBe(409);
    expect(store.current().fields.clientId.stringValue).toBe('new-client');
    expect(store.writes).toHaveLength(1);
  });
  it.each([
    ['other identity', () => ({ ...document(), name: name.replace(email, 'other@example.test') })],
    ['other project', () => ({ ...document(), name: name.replace('synthetic-people-sync', 'other-project') })],
    ['no revision', () => ({ name, fields: clientFields })],
    ['bad revision', () => document(clientFields, 'yesterday')],
    ['bad fields', () => ({ ...document(), fields: [] })],
    ['ambiguous role type', () => document({ ...clientFields, roles: { arrayValue: {}, stringValue: 'client' } })],
    ['unexpected envelope', () => ({ ...document(), partial: true })],
  ])('refuses malformed provider read: %s', async (_label, make) => {
    const store = storeFixture({ readResponse: () => response(make()) });
    const result = await request();
    expect(result.status).toBe(502); expect((await result.json()).error).toBe('access_record_unverifiable');
    expect(store.writes).toEqual([]);
  });
  it.each([401, 403, 429, 500, 503])('a failed read %i is never absence', async status => {
    const store = storeFixture({ readResponse: () => providerError(status, 'UNAVAILABLE') });
    expect((await request()).status).toBe(502); expect(store.writes).toEqual([]);
  });
  it('a lost read performs no write', async () => {
    const store = storeFixture({ readFailure: true });
    expect((await request()).status).toBe(502); expect(store.writes).toEqual([]);
  });
  it.each(['grant', 'revoke'])('lost %s acknowledgement is unknown, never retried', async action => {
    const store = storeFixture({ writeFailure: true });
    const result = await request(intent(action));
    expect(result.status).toBe(502); expect(await result.json()).toEqual({ ok: false, error: 'sync_outcome_unknown' });
    expect(store.reads).toHaveLength(1); expect(store.writes).toHaveLength(1);
  });
  it.each(['grant', 'revoke'])('a committed %s with a lost acknowledgement stays unknown without retry', async action => {
    const store = storeFixture({ loseAfterCommit: true });
    const result = await request(intent(action));
    expect(result.status).toBe(502); expect(await result.json()).toEqual({ ok: false, error: 'sync_outcome_unknown' });
    expect(store.reads).toHaveLength(1); expect(store.writes).toHaveLength(1);
    if (action === 'grant') expect(store.current().updateTime).toBe(nextTime);
    else expect(store.current()).toBeNull();
  });
  it.each([
    ['empty grant', 'grant', () => response({})],
    ['document instead of commit', 'grant', () => response(document())],
    ['no write result', 'grant', () => response({ writeResults: [], commitTime: nextTime })],
    ['multiple write results', 'grant', () => response({ writeResults: [{ updateTime: nextTime }, { updateTime: nextTime }], commitTime: nextTime })],
    ['no commit revision', 'grant', () => response({ writeResults: [{ updateTime: nextTime }] })],
    ['no update revision', 'grant', () => response(commitAck('revoke'))],
    ['invalid update revision', 'grant', () => response(commitAck('grant', 'yesterday'))],
    ['delete returned update revision', 'revoke', () => response(commitAck())],
    ['unexpected transformations', 'grant', () => response({ ...commitAck(), writeResults: [{ updateTime: nextTime, transformResults: [{ stringValue: 'unexpected' }] }] })],
    ['unknown write field', 'grant', () => response({ ...commitAck(), writeResults: [{ updateTime: nextTime, extra: true }] })],
    ['unknown envelope', 'grant', () => response({ ...commitAck(), partial: true })],
    ['malformed JSON', 'grant', () => new Response('{')],
    ['nonempty delete', 'revoke', () => response({ ignored: true })],
    ['partial failure', 'grant', () => providerError(503, 'UNAVAILABLE')],
    ['untyped conflict', 'grant', () => response({}, 409)],
    ['untyped bad request', 'grant', () => response({}, 400)],
    ['invalid argument', 'grant', () => providerError(400, 'INVALID_ARGUMENT')],
    ['oversized acknowledgement', 'grant', () => response({ large: 'x'.repeat(70_000) })],
  ])('does not claim or repeat an unconfirmed mutation: %s', async (_label, action, make) => {
    const store = storeFixture({ writeResponse: make });
    const result = await request(intent(action));
    expect(result.status).toBe(502); expect((await result.json()).error).toBe('sync_outcome_unknown');
    expect(store.reads).toHaveLength(1); expect(store.writes).toHaveLength(1);
  });
  it('repeated same-tenant requests remain safe without replacing other fields', async () => {
    const store = storeFixture();
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(store.writes[1].write.currentDocument).toEqual({ updateTime: nextTime });
    expect(store.current().fields.preferences).toEqual(clientFields.preferences);
  });
  it('accepts a no-change update revision and explicit empty transform results', async () => {
    const store = storeFixture({ writeResponse: () => response({
      writeResults: [{ updateTime: initialTime, transformResults: [] }], commitTime: nextTime,
    }) });
    expect((await request()).status).toBe(200);
    expect(store.writes).toHaveLength(1);
  });
  it('accepts native delete acknowledgement with explicit empty transform results', async () => {
    const store = storeFixture({ writeResponse: () => response({
      writeResults: [{ transformResults: [] }], commitTime: nextTime,
    }) });
    expect((await request(intent('revoke'))).status).toBe(200);
    expect(store.writes).toHaveLength(1);
  });
  it('preserves internal-key, POST, rate-limit and malformed-body boundaries', async () => {
    const store = storeFixture();
    expect((await request(null)).status).toBe(400);
    expect((await request(intent('grant'), { method: 'GET' })).status).toBe(405);
    // No Firebase configuration avoids any external verification for this invalid credential test.
    expect((await request(intent('grant'), { token: 'wrong', overrides: { FIREBASE_PROJECT_ID: '' } })).status).toBe(401);
    expect((await request(intent('grant'), { overrides: {
      RATE_LIMIT: { get: async () => '10000', put: async () => {} },
    } })).status).toBe(429);
    expect(store.reads).toEqual([]); expect(store.writes).toEqual([]);
  });
  it('keeps Firebase owner authentication separate: owner UID is not an internal key', async () => {
    const store = storeFixture();
    const result = await request(intent('grant'), { token: 'owner-uid', overrides: { OWNER_UID: 'owner-uid', FIREBASE_PROJECT_ID: '' } });
    expect(result.status).toBe(401); expect(store.reads).toEqual([]);
  });
  it('validates direct writer callers before contacting Firestore', async () => {
    const store = storeFixture();
    await expect(syncClientUserAccess(env, { ...intent('revoke'), clientId: '' })).rejects.toMatchObject({ code: 'valid_clientId_required' });
    expect(store.reads).toEqual([]); expect(store.writes).toEqual([]);
  });
});
