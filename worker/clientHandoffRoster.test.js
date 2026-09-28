import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchClientHandoffRoster, fetchClientRoster } from './suiteContext.js';

const env = { CONTEXT_KEY: 'synthetic-context-key' };
const client = { slug: 'acme-stable', name: 'Acme Studio', status: 'active', domains: ['acme.test'] };
const good = { ok: true, source: 'firestore', clients: [client] };
const reply = data => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('strict navigation roster, separate from fail-open legacy consumers', () => {
  it('confirms only projected eligible broker rows, without forwarding private fields', async () => {
    reply({ ...good, clients: [{ ...client, aiContext: 'private', connections: { secret: 'private' } }] });
    await expect(fetchClientHandoffRoster(env)).resolves.toEqual([client]);
    expect(fetch).toHaveBeenCalledWith('https://feedback.stitchtec.dev/clients', expect.objectContaining({ redirect: 'error' }));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('does not make a request without a configured server credential', async () => {
    reply(good);
    await expect(fetchClientHandoffRoster({})).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    {}, { ...good, ok: 'true' }, { ...good, source: 'fallback' }, { ...good, source: undefined },
    { ...good, clients: null }, { ...good, clients: [client, null] },
    { ...good, clients: [{ ...client, name: '' }] }, { ...good, clients: [{ ...client, name: ' Acme ' }] },
    { ...good, clients: [{ ...client, slug: 'Acme' }] }, { ...good, clients: [{ ...client, status: '' }] },
    { ...good, clients: [{ ...client, domains: [null] }] },
    { ...good, clients: Array.from({ length: 1001 }, () => client) },
  ])('refuses unconfirmed or partial/invalid roster %# without dropping individual rows', async data => {
    reply(data);
    await expect(fetchClientHandoffRoster(env)).resolves.toBeNull();
  });
  it('distinguishes a confirmed empty eligible roster from failed/fallback reads', async () => {
    reply({ ...good, clients: [] });
    await expect(fetchClientHandoffRoster(env)).resolves.toEqual([]);
  });
  it.each([
    () => new Response('unavailable upstream diagnostic', { status: 502 }),
    () => Response.json(good, { status: 206 }),
    () => new Response('{ malformed'),
    () => new Response('x'.repeat(512001)),
  ])('keeps failures and overlarge responses symbolic %#', async makeResponse => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse()));
    await expect(fetchClientHandoffRoster(env)).resolves.toBeNull();
  });
  it.each(['headers', 'body'])('bounds stalled %s and aborts the operation', async stage => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => stage === 'headers'
      ? new Promise(() => {})
      : Promise.resolve(new Response(new ReadableStream({ start() {} })))));
    const pending = fetchClientHandoffRoster(env);
    await vi.advanceTimersByTimeAsync(5001);
    await expect(pending).resolves.toBeNull();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('preserves legacy fail-open response behavior', async () => {
    reply({ ok: true, clients: [{ slug: 'legacy' }, null] });
    await expect(fetchClientRoster(env)).resolves.toEqual([{ slug: 'legacy', name: 'legacy', status: '', domains: [] }]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchClientRoster(env)).resolves.toEqual([]);
  });
});
