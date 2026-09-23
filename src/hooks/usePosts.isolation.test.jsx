import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

const firestore = vi.hoisted(() => ({ subscriptions: [] }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, name) => ({ name })),
  query: vi.fn((base, ...constraints) => ({ base, constraints })),
  where: vi.fn((...args) => args),
  onSnapshot: vi.fn((query, next, error) => {
    const unsubscribe = vi.fn();
    firestore.subscriptions.push({ query, next, error, unsubscribe });
    return unsubscribe;
  }),
}));
vi.mock('../config/firebase', () => ({ db: {} }));
import usePosts from './usePosts';
import { OPERATOR_UID } from '../config/roles';

const alpha = { uid: 'alpha-user' };
const beta = { uid: 'beta-user' };
const baseProps = () => ({ user: alpha, clientId: 'alpha', sharedUid: null, shareClientId: null, isOperator: false });
const change = (id, data = {}, type = 'added') => ({ type, doc: { id, data: () => ({
  content: 'Synthetic only', clientId: 'alpha', client: 'Alpha', reviewStage: 'in_review',
  createdAt: '2026-09-23T12:00:00Z', scheduledDate: '2026-10-01T12:00:00Z', ...data,
}) } });
const emit = (subscription, changes) => act(() => subscription.next({ docChanges: () => changes }));
const fail = (subscription, code) => act(() => subscription.error({ code }));
const postsListeners = () => firestore.subscriptions.filter(s => s.query.base.name === 'posts');
const brandListeners = () => firestore.subscriptions.filter(s => s.query.base.name === 'clients');
const latestPosts = () => postsListeners().at(-1);
const latestBrand = () => brandListeners().at(-1);
const ids = (result) => result.current.posts.map(post => post.id);
const mount = (props = baseProps(), options = {}) => {
  const renders = [];
  const hook = renderHook(p => {
    const state = usePosts(p.user, p.sharedUid, p.clientId, p.shareClientId, p.isOperator, p.session);
    renders.push({ props: p, state });
    return state;
  }, { initialProps: props, ...options });
  return { ...hook, renders };
};

describe('usePosts listener and session ownership', () => {
  beforeEach(() => {
    firestore.subscriptions.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('fences the very first render of a new principal before effects and waits for its own snapshot', () => {
    const hook = mount();
    emit(latestPosts(), [change('alpha-only')]);
    emit(latestBrand(), [change('alpha-brand', { name: 'Alpha' })]);
    const oldPosts = latestPosts(), oldBrand = latestBrand();
    const start = hook.renders.length;
    hook.rerender({ ...baseProps(), user: beta, clientId: 'beta' });
    for (const render of hook.renders.slice(start)) {
      expect(render.state.posts).toEqual([]);
      expect(render.state.clientMap).toEqual({});
      expect(render.state.isLoading).toBe(true);
      expect(render.state.error).toBeNull();
      expect(render.state.isStalled).toBe(false);
    }
    expect(oldPosts.unsubscribe).toHaveBeenCalledOnce();
    expect(oldBrand.unsubscribe).toHaveBeenCalledOnce();
    emit(latestPosts(), [change('beta-only', { clientId: 'beta' })]);
    emit(latestBrand(), [change('beta-brand', { name: 'Beta', clientId: 'beta' })]);
    expect(ids(hook.result)).toEqual(['beta-only']);
    expect(Object.keys(hook.result.current.clientMap)).toEqual(['Beta']);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it.each([
    ['tenant', { clientId: 'beta' }],
    ['operator role', { clientId: null, isOperator: true }],
    ['share owner', { sharedUid: 'other-owner', shareClientId: 'alpha' }],
    ['share tenant', { sharedUid: 'owner', shareClientId: 'beta' }],
  ])('clears old state when %s query identity changes', (_label, next) => {
    const hook = mount();
    emit(latestPosts(), [change('old')]);
    fail(latestPosts(), 'permission-denied');
    hook.rerender({ ...baseProps(), ...next });
    expect(ids(hook.result)).toEqual([]);
    expect(hook.result.current).toMatchObject({ isLoading: true, error: null, isStalled: false });
    emit(latestPosts(), []);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('clears immediately on sign-out and blocks callbacks from unsubscribed listeners', () => {
    const hook = mount();
    emit(latestPosts(), [change('old')]);
    emit(latestBrand(), [change('old-brand', { name: 'Old' })]);
    const oldPosts = latestPosts(), oldBrand = latestBrand();
    hook.rerender({ ...baseProps(), user: null, clientId: null });
    emit(oldPosts, [change('late-old')]);
    emit(oldBrand, [change('late-brand', { name: 'Late' })]);
    fail(oldPosts, 'unavailable');
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: false, error: null, isStalled: false });
    expect(postsListeners()).toHaveLength(1);
  });

  it('waits for authorization and never subscribes from unresolved user/role data', () => {
    const hook = mount({ ...baseProps(), isOperator: true, session: { authLoading: true } });
    expect(firestore.subscriptions).toHaveLength(0);
    expect(ids(hook.result)).toEqual([]);
    hook.rerender({ ...baseProps(), isOperator: true, session: { authLoading: false } });
    expect(postsListeners()).toHaveLength(1);
    expect(hook.result.current.isLoading).toBe(true);
  });

  it('never subscribes a signed-out operator even if the old role flag remains true', () => {
    const props = { ...baseProps(), clientId: null, isOperator: true };
    const hook = mount(props);
    emit(latestPosts(), [change('old')]);
    hook.rerender({ ...props, user: null });
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: false, error: null, isStalled: false });
    expect(postsListeners()).toHaveLength(1);
  });

  it.each([
    ['posts', 'permission-denied'], ['posts', 'unauthenticated'],
    ['branding', 'permission-denied'], ['branding', 'unauthenticated'],
  ])('clears both data sets and blocks later callbacks after %s %s', (listener, code) => {
    vi.useFakeTimers();
    const hook = mount();
    const posts = latestPosts(), branding = latestBrand();
    emit(posts, [change('old')]);
    emit(branding, [change('brand', { name: 'Old' })]);
    fail(listener === 'posts' ? posts : branding, code);
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: false, error: { code }, isStalled: true });
    emit(posts, [change('late')]);
    emit(branding, [change('late-brand', { name: 'Late' })]);
    act(() => vi.advanceTimersByTime(60000));
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: false, error: { code }, isStalled: true });
    expect(postsListeners()).toHaveLength(1);
  });

  it('cancels a pending posts retry if branding subsequently denies access', () => {
    vi.useFakeTimers();
    const hook = mount();
    emit(latestPosts(), [change('old')]);
    fail(latestPosts(), 'unavailable');
    fail(latestBrand(), 'permission-denied');
    act(() => vi.advanceTimersByTime(60000));
    expect(postsListeners()).toHaveLength(1);
    expect(hook.result.current).toMatchObject({ posts: [], error: { code: 'permission-denied' }, isStalled: true });
  });

  it('does not re-open a denied scope when its retry tick was already queued', () => {
    vi.useFakeTimers();
    const hook = mount();
    const branding = latestBrand();
    fail(latestPosts(), 'unavailable');
    act(() => {
      vi.advanceTimersByTime(1000);
      branding.error({ code: 'permission-denied' });
    });
    expect(postsListeners()).toHaveLength(1);
    expect(hook.result.current).toMatchObject({ posts: [], error: { code: 'permission-denied' }, isStalled: true });
  });

  it('blocks guests without a client scope, including after a previously valid scope', () => {
    const props = { ...baseProps(), user: { uid: 'guest' }, clientId: null, sharedUid: 'owner', shareClientId: 'alpha' };
    const hook = mount(props);
    emit(latestPosts(), [change('old')]);
    hook.rerender({ ...props, shareClientId: null });
    expect(ids(hook.result)).toEqual([]);
    expect(hook.result.current.isLoading).toBe(false);
    expect(postsListeners()).toHaveLength(1);
  });

  it('waits for a signed-in guest even when a valid share scope resolved first', () => {
    const props = { ...baseProps(), user: null, clientId: null, sharedUid: 'owner', shareClientId: 'alpha' };
    const hook = mount(props);
    expect(firestore.subscriptions).toHaveLength(0);
    hook.rerender({ ...props, user: { uid: 'guest' } });
    expect(postsListeners()).toHaveLength(1);
  });

  it('fences a changed auth revision synchronously and rejects pre-render callbacks and timers', () => {
    vi.useFakeTimers();
    let revision = 1;
    const getAuthRevision = () => revision;
    const props = { ...baseProps(), session: { authRevision: 1, getAuthRevision } };
    const hook = mount(props);
    emit(latestPosts(), [change('first-session')]);
    const oldPosts = latestPosts(), oldBrand = latestBrand();
    fail(oldPosts, 'unavailable');
    revision = 3; // Same UID signed out and in before React committed props.
    emit(oldBrand, [change('late-brand', { name: 'Late' })]);
    act(() => vi.advanceTimersByTime(1000));
    expect(postsListeners()).toHaveLength(1);
    hook.rerender(props); // Deliberately stale authRevision from the old render.
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: false, error: null, isStalled: false });
    hook.rerender({ ...props, session: { authRevision: 3, getAuthRevision } });
    expect(hook.result.current.isLoading).toBe(true);
    emit(oldPosts, [change('late-old')]);
    fail(oldPosts, 'permission-denied');
    emit(latestPosts(), [change('new-session')]);
    expect(ids(hook.result)).toEqual(['new-session']);
    expect(hook.result.current.error).toBeNull();
  });

  it('rejects success and error callbacks before cleanup when the auth counter advanced', () => {
    let revision = 1;
    const getAuthRevision = () => revision;
    const props = { ...baseProps(), session: { authRevision: 1, getAuthRevision } };
    const hook = mount(props);
    emit(latestPosts(), [change('old')]);
    revision = 2;
    emit(latestPosts(), [change('late')]);
    fail(latestPosts(), 'permission-denied');
    expect(ids(hook.result)).toEqual(['old']); // No stale callback-triggered state change.
    hook.rerender(props);
    expect(ids(hook.result)).toEqual([]); // Any render applies the synchronous fence.
    expect(hook.result.current.error).toBeNull();
  });

  it('treats a new Firebase User object with the same UID as a new owner', () => {
    const hook = mount();
    emit(latestPosts(), [change('old')]);
    const oldPosts = latestPosts();
    hook.rerender({ ...baseProps(), user: { uid: alpha.uid } });
    expect(ids(hook.result)).toEqual([]);
    expect(hook.result.current.isLoading).toBe(true);
    expect(oldPosts.unsubscribe).toHaveBeenCalledOnce();
    emit(oldPosts, [change('late')]);
    expect(ids(hook.result)).toEqual([]);
  });

  it('does not resurrect an old scope when A to B to A completes before B ever answers', () => {
    const hook = mount();
    emit(latestPosts(), [change('old-alpha')]);
    emit(latestBrand(), [change('old-brand', { name: 'Alpha' })]);
    hook.rerender({ ...baseProps(), clientId: 'beta' });
    hook.rerender(baseProps());
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: true, error: null, isStalled: false });
    emit(latestPosts(), []);
    expect(ids(hook.result)).toEqual([]);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('replaces posts and branding on retry, removing rows absent from the new initial snapshot', () => {
    vi.useFakeTimers();
    const hook = mount();
    emit(latestPosts(), [change('kept'), change('deleted-during-gap')]);
    emit(latestBrand(), [change('kept-brand', { name: 'Kept' }), change('gone-brand', { name: 'Gone' })]);
    const oldPosts = latestPosts(), oldBrand = latestBrand();
    fail(oldPosts, 'unavailable');
    expect(ids(hook.result)).toEqual(['kept', 'deleted-during-gap']);
    expect(hook.result.current).toMatchObject({ isLoading: false, error: { code: 'unavailable' }, isStalled: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(oldPosts.unsubscribe).toHaveBeenCalledOnce();
    expect(oldBrand.unsubscribe).toHaveBeenCalledOnce();
    emit(latestPosts(), [change('kept')]);
    emit(latestBrand(), [change('kept-brand', { name: 'Kept' })]);
    emit(oldPosts, [change('late')]);
    emit(oldBrand, [change('late-brand', { name: 'Late' })]);
    expect(ids(hook.result)).toEqual(['kept']);
    expect(Object.keys(hook.result.current.clientMap)).toEqual(['Kept']);
    expect(hook.result.current).toMatchObject({ error: null, isStalled: false, isLoading: false });
  });

  it('accepts empty initial snapshots after retry as authoritative empty results', () => {
    vi.useFakeTimers();
    const hook = mount();
    emit(latestPosts(), [change('gone')]);
    emit(latestBrand(), [change('gone-brand', { name: 'Gone' })]);
    fail(latestPosts(), 'unavailable');
    act(() => vi.advanceTimersByTime(1000));
    emit(latestBrand(), []);
    emit(latestPosts(), []);
    expect(hook.result.current).toEqual({ posts: [], clientMap: {}, isLoading: false, error: null, isStalled: false });
  });

  it('keeps incremental removals, ordering and unchanged post/Date identities', () => {
    const hook = mount();
    emit(latestPosts(), [change('older', { scheduledDate: '2026-09-01T12:00:00Z' }), change('newer')]);
    const newer = hook.result.current.posts[0], older = hook.result.current.posts[1];
    const posts = hook.result.current.posts;
    emit(latestPosts(), []);
    expect(hook.result.current.posts).toBe(posts);
    emit(latestPosts(), [change('older', { scheduledDate: '2026-09-01T12:00:00Z', content: 'Changed text' }, 'modified')]);
    expect(ids(hook.result)).toEqual(['newer', 'older']);
    expect(hook.result.current.posts[0]).toBe(newer);
    expect(hook.result.current.posts[1].scheduledDate).toBe(older.scheduledDate);
    emit(latestPosts(), [change('newer', {}, 'removed')]);
    expect(ids(hook.result)).toEqual(['older']);
  });

  it('removes a branding document old name on rename and handles removal/empty names', () => {
    const hook = mount();
    emit(latestBrand(), [change('brand', { name: 'Alpha' })]);
    emit(latestBrand(), [change('brand', { name: 'Renamed' }, 'modified')]);
    expect(Object.keys(hook.result.current.clientMap)).toEqual(['Renamed']);
    const unchanged = hook.result.current.clientMap;
    emit(latestBrand(), []);
    expect(hook.result.current.clientMap).toBe(unchanged);
    emit(latestBrand(), [change('brand', { name: '' }, 'modified')]);
    expect(hook.result.current.clientMap).toEqual({});
    emit(latestBrand(), [change('brand2', { name: 'Second' })]);
    emit(latestBrand(), [change('brand2', { name: 'Second' }, 'removed')]);
    expect(hook.result.current.clientMap).toEqual({});
  });

  it('retains exact operator, member and guest query constraints', () => {
    const hook = mount({ ...baseProps(), clientId: null, isOperator: true });
    expect(latestPosts().query.constraints).toEqual([['uid', '==', OPERATOR_UID]]);
    expect(latestBrand().query.constraints).toEqual([['uid', '==', OPERATOR_UID]]);
    hook.rerender(baseProps());
    expect(latestPosts().query.constraints).toEqual([['clientId', '==', 'alpha'], ['reviewStage', '==', 'in_review']]);
    expect(latestBrand().query.constraints).toEqual([['clientId', '==', 'alpha']]);
    hook.rerender({ ...baseProps(), user: { uid: 'guest' }, clientId: null, sharedUid: 'owner', shareClientId: 'alpha' });
    expect(latestPosts().query.constraints).toEqual([['clientId', '==', 'alpha'], ['uid', '==', 'owner'], ['reviewStage', '==', 'in_review']]);
    expect(latestBrand().query.constraints).toEqual([['clientId', '==', 'alpha'], ['uid', '==', 'owner']]);
  });

  it('caps retries, ignores duplicate errors and late success, and resets the ladder for a new scope', () => {
    vi.useFakeTimers();
    const hook = mount();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000]) {
      const listener = latestPosts();
      const before = postsListeners().length;
      fail(listener, 'unavailable');
      fail(listener, 'unavailable');
      emit(listener, [change('terminated-late')]);
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(postsListeners()).toHaveLength(before);
      act(() => vi.advanceTimersByTime(1));
      expect(postsListeners()).toHaveLength(before + 1);
    }
    fail(latestPosts(), 'unavailable');
    expect(hook.result.current.isStalled).toBe(true);
    act(() => vi.advanceTimersByTime(120000));
    expect(postsListeners()).toHaveLength(7);
    hook.rerender({ ...baseProps(), clientId: 'beta' });
    expect(hook.result.current).toMatchObject({ isLoading: true, error: null, isStalled: false });
    fail(latestPosts(), 'unavailable');
    act(() => vi.advanceTimersByTime(1000));
    expect(postsListeners()).toHaveLength(9);
  });

  it('cancels retry timers on scope change and unmount', () => {
    vi.useFakeTimers();
    const hook = mount();
    fail(latestPosts(), 'unavailable');
    hook.rerender({ ...baseProps(), clientId: 'beta' });
    act(() => vi.advanceTimersByTime(60000));
    expect(postsListeners()).toHaveLength(2);
    const oldPosts = latestPosts(), oldBrand = latestBrand();
    fail(oldPosts, 'unavailable');
    hook.unmount();
    emit(oldPosts, [change('after-unmount')]);
    emit(oldBrand, [change('after-unmount-brand', { name: 'Old' })]);
    act(() => vi.advanceTimersByTime(60000));
    expect(postsListeners()).toHaveLength(2);
    expect(oldPosts.unsubscribe).toHaveBeenCalledOnce();
    expect(oldBrand.unsubscribe).toHaveBeenCalledOnce();
  });

  it('survives StrictMode setup/cleanup without accepting the abandoned listener', () => {
    const hook = mount(baseProps(), { wrapper: StrictMode });
    expect(postsListeners()).toHaveLength(2);
    emit(postsListeners()[0], [change('abandoned')]);
    expect(ids(hook.result)).toEqual([]);
    expect(hook.result.current.isLoading).toBe(true);
    emit(latestPosts(), [change('current')]);
    expect(ids(hook.result)).toEqual(['current']);
  });
});
