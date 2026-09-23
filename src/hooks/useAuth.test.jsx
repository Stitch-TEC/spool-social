import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import useAuth from './useAuth';

const transport = vi.hoisted(() => ({ callback: null, reads: [], signOut: vi.fn(async () => {}) }));
vi.mock('../config/firebase', () => ({ auth: {}, db: {}, googleProvider: {} }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth, callback) => { transport.callback = callback; return () => {}; },
  signOut: transport.signOut, signInWithPopup: vi.fn(), signInAnonymously: vi.fn(), signInWithCustomToken: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  doc: (_db, _collection, email) => ({ email }),
  getDoc: ref => new Promise((resolve, reject) => transport.reads.push({ ref, resolve, reject })),
}));
const user = name => ({ uid: `${name}-uid`, email: `${name}@example.test` });
const grant = (read, clientId) => read.resolve({ exists: () => true, data: () => ({ roles: ['client'], clientId }) });

describe('authentication principal transitions', () => {
  beforeEach(() => { transport.reads = []; localStorage.clear(); window.history.replaceState({}, '', '/'); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
  it('clears old authorization immediately and ignores old account resolution finishing last', async () => {
    const { result } = renderHook(() => useAuth(vi.fn()));
    act(() => { void transport.callback(user('alpha')); });
    await act(async () => grant(transport.reads[0], 'alpha'));
    expect(result.current.clientId).toBe('alpha');
    act(() => { void transport.callback(user('beta')); });
    expect(result.current.user).toBeNull();
    expect(result.current.role).toBeNull();
    expect(result.current.clientId).toBeNull();
    expect(result.current.authLoading).toBe(true);
    act(() => { void transport.callback(user('gamma')); });
    await act(async () => grant(transport.reads[2], 'gamma'));
    await act(async () => grant(transport.reads[1], 'beta'));
    expect(result.current.user.uid).toBe('gamma-uid');
    expect(result.current.clientId).toBe('gamma');
  });
  it('does not revive a signed-out account when its role lookup completes', async () => {
    const { result } = renderHook(() => useAuth(vi.fn()));
    act(() => { void transport.callback(user('alpha')); });
    await act(async () => transport.callback(null));
    await act(async () => grant(transport.reads[0], 'alpha'));
    expect(result.current.user).toBeNull();
    expect(result.current.role).toBeNull();
    expect(result.current.clientId).toBeNull();
  });
  it('preserves legacy recovery bytes on explicit sign-out instead of deleting unowned work', async () => {
    localStorage.setItem('spool:autosave:new', 'legacy owner unknown');
    const { result } = renderHook(() => useAuth(vi.fn()));
    await act(async () => { result.current.signOutAndExit(); });
    expect(transport.signOut).toHaveBeenCalled();
    expect(localStorage.getItem('spool:autosave:new')).toBe('legacy owner unknown');
  });
  it('invalidates captured create sessions synchronously across same-object sign-out/sign-in and unmount', async () => {
    const principal = user('alpha');
    const { result, unmount } = renderHook(() => useAuth(vi.fn()));
    act(() => { void transport.callback(principal); });
    await act(async () => grant(transport.reads[0], 'alpha'));
    const revision = result.current.authRevision;
    const getRevision = result.current.getAuthRevision;
    await act(async () => transport.callback(null));
    expect(getRevision()).toBeGreaterThan(revision);
    act(() => { void transport.callback(principal); });
    const pendingRevision = getRevision();
    expect(pendingRevision).toBeGreaterThan(revision);
    expect(result.current.authLoading).toBe(true);
    await act(async () => grant(transport.reads[1], 'alpha'));
    expect(result.current.user).toBe(principal);
    expect(result.current.authRevision).toBe(pendingRevision);
    unmount();
    expect(getRevision()).toBeGreaterThan(pendingRevision);
  });
});
