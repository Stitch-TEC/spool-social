import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/clientsClient', () => ({ listClients: vi.fn() }));
import { listClients } from '../lib/clientsClient';
import { useClients } from './useClients';

const rows = [{ slug: 'lyf-fit', name: 'Lyf Fit', status: 'active' }];
const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject })); return d; };
const visible = () => document.dispatchEvent(new Event('visibilitychange'));
describe('roster scope ownership for local saved views', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('keeps one stable disabled empty result and makes no request', () => {
    const hook = renderHook(({ scope }) => useClients(false, scope), { initialProps: { scope: 'a' } });
    const original = hook.result.current;
    hook.rerender({ scope: 'b' });
    expect(hook.result.current).toBe(original);
    expect(listClients).not.toHaveBeenCalled();
  });
  it('loads once and preserves row reference on an unchanged background refresh', async () => {
    listClients.mockResolvedValue(rows);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const hook = renderHook(() => useClients(true, 'a'));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const original = hook.result.current.clients;
    listClients.mockResolvedValue(rows.map(row => ({ ...row })));
    act(visible); expect(listClients).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(900001); await act(async () => visible());
    expect(listClients).toHaveBeenCalledTimes(2);
    expect(hook.result.current.clients).toBe(original);
  });
  it('does not expose A in the first rendered B return and ignores late A results', async () => {
    const a = deferred(), b = deferred(); listClients.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const observations = [];
    const hook = renderHook(({ scope }) => { const value = useClients(true, scope); observations.push({ scope, value }); return value; }, { initialProps: { scope: 'a' } });
    hook.rerender({ scope: 'b' });
    await act(async () => a.resolve(rows));
    expect(hook.result.current).toMatchObject({ clients: [], loading: true });
    await act(async () => b.resolve([{ slug: 'b', name: 'Beta' }]));
    expect(hook.result.current.clients[0].slug).toBe('b');
    expect(observations.filter(row => row.scope === 'b').every(row => row.value.clients.every(client => client.slug === 'b'))).toBe(true);
  });
  it('does not resurrect A after A→B→A or disabled→enabled', async () => {
    listClients.mockResolvedValueOnce(rows).mockReturnValue(new Promise(() => {}));
    const hook = renderHook(({ enabled, scope }) => useClients(enabled, scope), { initialProps: { enabled: true, scope: 'a' } });
    await waitFor(() => expect(hook.result.current.clients).toEqual(rows));
    hook.rerender({ enabled: true, scope: 'b' }); hook.rerender({ enabled: true, scope: 'a' });
    expect(hook.result.current).toMatchObject({ clients: [], loading: true });
    hook.rerender({ enabled: false, scope: 'a' }); hook.rerender({ enabled: true, scope: 'a' });
    expect(hook.result.current).toMatchObject({ clients: [], loading: true });
  });
  it('reports initial failure with no roster; an old failure cannot clear B', async () => {
    const a = deferred(); listClients.mockReturnValueOnce(a.promise).mockResolvedValueOnce(rows);
    const hook = renderHook(({ scope }) => useClients(true, scope), { initialProps: { scope: 'a' } });
    hook.rerender({ scope: 'b' }); await waitFor(() => expect(hook.result.current.clients).toEqual(rows));
    await act(async () => a.reject(new Error('Old failure')));
    expect(hook.result.current.error).toBeNull();
    listClients.mockRejectedValueOnce(new Error('Current failure')); hook.rerender({ scope: 'c' });
    await waitFor(() => expect(hook.result.current.error).toBe('Current failure'));
    expect(hook.result.current.clients).toEqual([]);
  });
  it('keeps the last verified same-session roster on quiet refresh failure', async () => {
    listClients.mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error('Refresh unavailable'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const hook = renderHook(() => useClients(true, 'a'));
    await waitFor(() => expect(hook.result.current.clients).toEqual(rows));
    clock.mockReturnValue(900001); await act(async () => visible());
    expect(hook.result.current).toEqual({ clients: rows, loading: false, error: null });
  });
  it('retires visibility refresh and pending completion on unmount', async () => {
    const pending = deferred(); listClients.mockReturnValue(pending.promise);
    const hook = renderHook(() => useClients(true, 'a')); hook.unmount();
    await act(async () => pending.resolve(rows)); act(visible);
    expect(listClients).toHaveBeenCalledTimes(1);
  });
});

describe('opt-in verified handoff roster', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); });
  afterEach(() => vi.restoreAllMocks());
  const options = { strict: true, isCurrent: () => true };
  it('uses one strict request and exposes exact scope/read confirmation', async () => {
    listClients.mockResolvedValue(rows);
    const hook = renderHook(() => useClients(true, 'a', options));
    await waitFor(() => expect(hook.result.current.confirmed).toBe(true));
    expect(listClients).toHaveBeenCalledTimes(1);
    expect(listClients).toHaveBeenCalledWith(expect.objectContaining({ strict: true, isCurrent: expect.any(Function), signal: expect.any(AbortSignal) }));
    expect(hook.result.current).toMatchObject({ clients: rows, loading: false, error: null, scopeKey: 'a', readVersion: 'a:1' });
  });
  it('invalidates confirmation immediately when refresh begins and admits only one refresh', async () => {
    const pending = deferred(); listClients.mockResolvedValueOnce(rows).mockReturnValue(pending.promise);
    const hook = renderHook(() => useClients(true, 'a', options));
    await waitFor(() => expect(hook.result.current.confirmed).toBe(true));
    act(() => { expect(hook.result.current.refresh()).toBe(true); expect(hook.result.current.refresh()).toBe(false); });
    expect(hook.result.current).toMatchObject({ confirmed: false, loading: true, readVersion: 'a:2' });
    await act(async () => pending.resolve(rows));
    expect(hook.result.current.confirmed).toBe(true); expect(listClients).toHaveBeenCalledTimes(2);
  });
  it('does not hide a failed background refresh or retain confirmed stale rows', async () => {
    listClients.mockResolvedValueOnce(rows).mockRejectedValueOnce(Error('private provider text'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const hook = renderHook(() => useClients(true, 'a', options));
    await waitFor(() => expect(hook.result.current.confirmed).toBe(true));
    clock.mockReturnValue(900001); await act(async () => visible());
    expect(hook.result.current).toMatchObject({ confirmed: false, loading: false, clients: [] });
    expect(hook.result.current.error).toBe('Client list could not be verified. Reload it before continuing.');
  });
  it('allows manual fresh-read recovery after failure', async () => {
    listClients.mockRejectedValueOnce(Error('failed')).mockResolvedValueOnce(rows);
    const hook = renderHook(() => useClients(true, 'a', options));
    await waitFor(() => expect(hook.result.current.error).toBeTruthy());
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current).toMatchObject({ confirmed: true, error: null, clients: rows, readVersion: 'a:2' });
  });
  it('hides old rows in the first new-scope render and invalidates captured refresh', async () => {
    const pending = deferred(); listClients.mockResolvedValueOnce(rows).mockReturnValue(pending.promise);
    const frames = [];
    const hook = renderHook(({ scope }) => { const value = useClients(true, scope, options); frames.push({ scope, value }); return value; }, { initialProps: { scope: 'a' } });
    await waitFor(() => expect(hook.result.current.confirmed).toBe(true)); const old = hook.result.current;
    hook.rerender({ scope: 'b' }); expect(old.refresh()).toBe(false);
    expect(frames.filter(f => f.scope === 'b').every(f => !f.value.confirmed && f.value.clients.length === 0)).toBe(true);
    await act(async () => pending.resolve(rows)); expect(hook.result.current.scopeKey).toBe('b');
  });
  it('rejects late old completions and aborts the retired transport', async () => {
    const a = deferred(), b = deferred(); listClients.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const hook = renderHook(({ scope }) => useClients(true, scope, options), { initialProps: { scope: 'a' } });
    const oldArgs = listClients.mock.calls[0][0]; hook.rerender({ scope: 'b' });
    expect(oldArgs.signal.aborted).toBe(true); expect(oldArgs.isCurrent()).toBe(false);
    await act(async () => a.resolve(rows)); expect(hook.result.current.confirmed).toBe(false);
    await act(async () => b.resolve([{ slug: 'b', name: 'Beta', status: 'active' }]));
    expect(hook.result.current.clients[0].slug).toBe('b');
  });
  it('never revives old A after A→B→A or enabled round trip', async () => {
    listClients.mockResolvedValueOnce(rows).mockReturnValue(new Promise(() => {}));
    const hook = renderHook(({ enabled, scope }) => useClients(enabled, scope, options), { initialProps: { enabled: true, scope: 'a' } });
    await waitFor(() => expect(hook.result.current.confirmed).toBe(true));
    hook.rerender({ enabled: true, scope: 'b' }); hook.rerender({ enabled: true, scope: 'a' });
    expect(hook.result.current).toMatchObject({ confirmed: false, clients: [] });
    hook.rerender({ enabled: false, scope: 'a' }); hook.rerender({ enabled: true, scope: 'a' });
    expect(hook.result.current).toMatchObject({ confirmed: false, clients: [] });
  });
  it('uses a synchronous current-session guard on refresh and completion', async () => {
    let current = true; const pending = deferred(); listClients.mockReturnValue(pending.promise);
    const hook = renderHook(() => useClients(true, 'a', { strict: true, isCurrent: () => current }));
    current = false; await act(async () => pending.resolve(rows));
    expect(hook.result.current.confirmed).toBe(false); expect(hook.result.current.refresh()).toBe(false);
  });
  it('makes no strict request without a current-session guard, including a throwing one', () => {
    const hook = renderHook(() => useClients(true, 'a', { strict: true }));
    expect(listClients).not.toHaveBeenCalled(); hook.unmount();
    const throwing = renderHook(() => useClients(true, 'a', { strict: true, isCurrent: () => { throw Error('unknown'); } }));
    expect(listClients).not.toHaveBeenCalled(); throwing.unmount();
  });
  it('disables requests and retires pending actions on unmount', () => {
    listClients.mockReturnValue(new Promise(() => {}));
    const disabled = renderHook(() => useClients(false, 'a', options));
    expect(listClients).not.toHaveBeenCalled(); expect(disabled.result.current.refresh()).toBe(false); disabled.unmount();
    const hook = renderHook(() => useClients(true, 'a', options)); const refresh = hook.result.current.refresh;
    const args = listClients.mock.calls[0][0]; hook.unmount();
    expect(args.signal.aborted).toBe(true); expect(args.isCurrent()).toBe(false); expect(refresh()).toBe(false);
  });
});
