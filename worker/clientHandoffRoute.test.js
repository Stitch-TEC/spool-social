import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), getUserRecord: vi.fn(), checkRateLimit: vi.fn() }));
vi.mock('./auth.js', async importOriginal => ({ ...await importOriginal(), authenticate: mocks.authenticate }));
vi.mock('./firestore.js', async importOriginal => ({ ...await importOriginal(), getUserRecord: mocks.getUserRecord }));
vi.mock('./ratelimit.js', () => ({ checkRateLimit: mocks.checkRateLimit }));
import worker from './index.js';
const env = { CONTEXT_KEY: 'synthetic-context-key', OWNER_UID: 'operator', ALLOWED_ORIGINS: '*' };
const client = { slug: 'acme-stable', name: 'Acme Studio', status: 'active', domains: [] };
const request = (query = '?handoff=1', method = 'GET') => worker.fetch(new Request(`https://spool.example/api/clients${query}`, { method }), env, {});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ mode: 'firebase', principal: 'operator', email: 'operator@example.test' });
  mocks.getUserRecord.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true, source: 'firestore', clients: [client] }))));
});
afterEach(() => vi.unstubAllGlobals());
describe('strict roster route retains the existing auth and rate-limit boundary', () => {
  it('returns only a no-store verified response to an operator', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, confirmed: true, clients: [client] });
  });
  it.each(['anonymous', 'member', 'unprovisioned', 'rate-limited', 'method'])('does not fetch roster for %s', async kind => {
    if (kind === 'anonymous') mocks.authenticate.mockResolvedValue(null);
    if (kind === 'member' || kind === 'unprovisioned') mocks.authenticate.mockResolvedValue({ mode: 'firebase', principal: 'other', email: 'other@example.test' });
    if (kind === 'member') mocks.getUserRecord.mockResolvedValue({ roles: ['client_admin'], clientId: 'acme-stable' });
    if (kind === 'rate-limited') mocks.checkRateLimit.mockResolvedValue({ ok: false, limit: 10, scope: 'minute', retryAfter: 30 });
    const response = await request('?handoff=1', kind === 'method' ? 'POST' : 'GET');
    if (kind !== 'anonymous' && kind !== 'method') expect(mocks.checkRateLimit).toHaveBeenCalledOnce();
    expect(response.status).toBe({ anonymous: 401, member: 403, unprovisioned: 403, 'rate-limited': 429, method: 405 }[kind]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['?handoff=', '?handoff=0', '?handoff=1&handoff=1'])('rejects malformed opt-in %s', async query => {
    expect((await request(query)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('marks upstream failure unavailable, without a fake empty success', async () => {
    fetch.mockImplementation(() => Promise.resolve(Response.json({ ok: true, source: 'fallback', clients: [] })));
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'Client list could not be verified' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('leaves the original no-opt-in response unchanged', async () => {
    fetch.mockImplementation(() => Promise.reject(new Error('offline')));
    const response = await request('');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, clients: [] });
  });
});
