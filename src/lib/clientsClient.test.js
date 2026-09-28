import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../config/firebase', () => ({ auth: { currentUser: null } }));
import { auth } from '../config/firebase';
import { HANDOFF_ROSTER_LIMITS, listClients } from './clientsClient';

const row = { slug: 'example-client', name: 'Example Studio', status: 'active', domains: ['example.test'] };
const response = (body = { ok: true, confirmed: true, clients: [row] }, init = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject })); return d; };
const strict = overrides => listClients({ strict: true, isCurrent: () => true, ...overrides });
beforeEach(() => { auth.currentUser = { uid: 'a', email: 'a@example.test', getIdToken: vi.fn().mockResolvedValue('synthetic-token') }; vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response()))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('opt-in strict client-roster transport', () => {
  it('requests only the strict same-origin path and returns the trusted projection', async () => {
    fetch.mockResolvedValue(response({ ok: true, confirmed: true, clients: [{ ...row, secret: 'not returned' }] }));
    expect(await strict()).toEqual([row]);
    expect(fetch).toHaveBeenCalledWith('/api/clients?handoff=1', expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('leaves ordinary response degradation and URL untouched', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ clients: null }) });
    expect(await listClients()).toEqual([]);
    expect(fetch.mock.calls[0][0]).toBe('/api/clients');
  });
  it.each([{ ok: true, clients: [row] }, { ok: false, confirmed: true, clients: [row] },
    { ok: true, confirmed: true, clients: {} }, { ok: true, confirmed: true, clients: [{ ...row, status: '' }] },
    { ok: true, confirmed: true, clients: [{ ...row, domains: 'bad' }] },
    { ok: true, confirmed: true, clients: [{ ...row, domains: Array(101).fill('a') }] },
  ])('refuses malformed/unconfirmed envelope %j', async body => {
    fetch.mockResolvedValue(response(body));
    await expect(strict()).rejects.toThrow('Client list could not be verified.');
  });
  it.each([201, 204, 401, 403, 404, 429, 503])('refuses HTTP%s without exposing provider errors', async status => {
    fetch.mockResolvedValue({ status, headers: new Headers(), text: () => Promise.resolve('private upstream text') });
    await expect(strict()).rejects.toThrow('Client list could not be verified. Reload it before continuing.');
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('refuses unexpected redirects', async () => {
    const r = response(); Object.defineProperty(r, 'redirected', { value: true }); fetch.mockResolvedValue(r);
    await expect(strict()).rejects.toThrow('could not be verified');
  });
  it('refuses streamless adapters rather than buffering an unbounded body', async () => {
    const text = vi.fn(); fetch.mockResolvedValue({ status: 200, headers: new Headers(), text });
    await expect(strict()).rejects.toThrow('could not be verified'); expect(text).not.toHaveBeenCalled();
  });
  it('requires an initiating actor and live guard before token or request', async () => {
    const token = auth.currentUser.getIdToken;
    await expect(listClients({ strict: true })).rejects.toThrow('could not be verified');
    await expect(strict({ isCurrent: () => false })).rejects.toThrow('could not be verified');
    auth.currentUser = null;
    await expect(strict()).rejects.toThrow('could not be verified');
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not dispatch after actor drift during token resolution, including same-label replacement', async () => {
    const token = deferred(); auth.currentUser.getIdToken.mockReturnValue(token.promise);
    const p = strict(); auth.currentUser = { ...auth.currentUser };
    token.resolve('late-token'); await expect(p).rejects.toThrow('could not be verified'); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not dispatch after scope retirement during token resolution', async () => {
    let current = true; const token = deferred(); auth.currentUser.getIdToken.mockReturnValue(token.promise);
    const p = strict({ isCurrent: () => current }); current = false;
    token.resolve('late-token'); await expect(p).rejects.toThrow('could not be verified'); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not commit a response after actor replacement', async () => {
    const pending = deferred(); fetch.mockReturnValue(pending.promise);
    const p = strict(); await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    auth.currentUser = { ...auth.currentUser }; pending.resolve(response());
    await expect(p).rejects.toThrow('could not be verified');
  });
  it.each(['', null, 4])('refuses missing token %s before dispatch', async token => {
    auth.currentUser.getIdToken.mockResolvedValue(token);
    await expect(strict()).rejects.toThrow('could not be verified'); expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds token wait and observes a late rejection', async () => {
    vi.useFakeTimers(); const token = deferred(); auth.currentUser.getIdToken.mockReturnValue(token.promise);
    const p = strict(); const assertion = expect(p).rejects.toThrow('could not be verified');
    await vi.advanceTimersByTimeAsync(HANDOFF_ROSTER_LIMITS.tokenMs); await assertion;
    token.reject(Error('late')); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds fetch wait and retires its request signal', async () => {
    vi.useFakeTimers(); fetch.mockReturnValue(new Promise(() => {}));
    const p = strict(); const assertion = expect(p).rejects.toThrow('could not be verified');
    await vi.advanceTimersByTimeAsync(HANDOFF_ROSTER_LIMITS.requestMs); await assertion;
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('bounds response-body wait and cancels the stream', async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const p = strict(); const assertion = expect(p).rejects.toThrow('could not be verified');
    await vi.advanceTimersByTimeAsync(HANDOFF_ROSTER_LIMITS.requestMs); await assertion;
    expect(cancel).toHaveBeenCalled();
  });
  it('refuses declared over-cap bodies before reading and retires the network', async () => {
    const read = vi.fn(); fetch.mockResolvedValue({ status: 200, headers: new Headers({ 'content-length': '262145' }), body: { getReader: read } });
    await expect(strict()).rejects.toThrow('could not be verified'); expect(read).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('bounds actual streamed bytes and chunk count', async () => {
    const cancel = vi.fn();
    fetch.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(262145)); }, cancel })));
    await expect(strict()).rejects.toThrow('could not be verified'); expect(cancel).toHaveBeenCalled();
    const excessive = new ReadableStream({ start(c) { for (let i = 0; i < 4097; i++) c.enqueue(new Uint8Array()); c.close(); } });
    fetch.mockResolvedValue(new Response(excessive)); await expect(strict()).rejects.toThrow('could not be verified');
  });
  it('rejects malformed JSON and malformed UTF-8', async () => {
    fetch.mockResolvedValue(new Response('{bad'));
    await expect(strict()).rejects.toThrow('could not be verified');
    fetch.mockResolvedValue(new Response(new Uint8Array([255])));
    await expect(strict()).rejects.toThrow('could not be verified');
  });
  it('aborts on caller retirement before dispatch or during a body wait', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(strict({ signal: controller.signal })).rejects.toThrow('could not be verified'); expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController(); fetch.mockResolvedValue(new Response(new ReadableStream()));
    const p = strict({ signal: active.signal }); const assertion = expect(p).rejects.toThrow('could not be verified');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); active.abort(); await assertion;
  });
});
