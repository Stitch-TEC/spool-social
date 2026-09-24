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
