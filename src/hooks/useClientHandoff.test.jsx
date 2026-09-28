import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useClientHandoff, { CLIENT_HANDOFF_WAIT_MS } from './useClientHandoff';

const a = { uid: 'a', email: 'a@example.test' };
const b = { uid: 'b', email: 'b@example.test' };
const rows = [{ slug: 'stable-client', name: 'Different Display Name', status: 'active' }];
function fixture() {
  const sdk = { user: a, revision: 1 };
  const props = {
    search: '?clientSlug=stable-client', user: a, authRevision: 1,
    getAuthRevision: () => sdk.revision, getCurrentUser: () => sdk.user,
    authLoading: false, isOperator: true, isReadOnly: false, role: 'super_admin',
    clientId: null, sharedUid: null, shareClientId: null, scopeKey: 'a:1',
    roster: { clients: rows, loading: false, error: null, confirmed: true, scopeKey: 'a:1', readVersion: 'a:1:read1' },
    content: { posts: [], clientMap: {}, loading: false, error: null },
  };
  const frames = [];
  const hook = renderHook(value => { const r = useClientHandoff(value); frames.push(r); return r; }, { initialProps: props });
  const update = change => { Object.assign(props, change); hook.rerender({ ...props }); };
  return { sdk, props, frames, hook, update };
}
afterEach(() => vi.useRealTimers());

describe('scoped client handoff lifecycle', () => {
  it('derives the verified name in the first return; never yields an active unfiltered ready frame', () => {
    const { hook, frames } = fixture();
    expect(hook.result.current).toMatchObject({ active: true, status: 'ready', clientName: rows[0].name, slug: 'stable-client' });
    expect(frames.every(frame => frame.status !== 'ready' || frame.clientName === rows[0].name)).toBe(true);
    expect(hook.result.current.isCurrent()).toBe(true);
  });
  it.each(['', '?client=Legacy', '?s=guest&clientSlug=stable-client', '?uid=owner&clientSlug=stable-client'])('does not intercept legacy/absent search %s', search => {
    const hook = renderHook(() => useClientHandoff({ search }));
    expect(hook.result.current).toMatchObject({ active: false, status: 'absent', clientName: null });
  });
  it('blocks malformed intent without using its text as a draft name', () => {
    const hook = renderHook(() => useClientHandoff({ search: '?clientSlug=../bad' }));
    expect(hook.result.current).toMatchObject({ active: true, status: 'blocked', code: 'invalid_link', clientName: null });
  });
  it('waits for first sign-in and allows that initial operator session to resolve', () => {
    const sdk = { user: null, revision: 0 };
    const base = { search: '?clientSlug=stable-client', user: null, authRevision: 0, authLoading: false,
      isOperator: false, role: null, scopeKey: 'none', getAuthRevision: () => sdk.revision, getCurrentUser: () => sdk.user };
    const hook = renderHook(props => useClientHandoff(props), { initialProps: base });
    expect(hook.result.current).toMatchObject({ status: 'pending', code: 'sign_in_required' });
    sdk.user = a; sdk.revision = 1;
    hook.rerender({ ...base, user: a, authRevision: 1, isOperator: true, role: 'super_admin', scopeKey: 'a:1',
      content: { posts: [], clientMap: {}, loading: false, error: null },
      roster: { clients: rows, loading: false, error: null, confirmed: true, scopeKey: 'a:1', readVersion: 'one' } });
    expect(hook.result.current.status).toBe('ready');
  });
  it('does not time out waiting for an explicit signed-out sign-in', () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useClientHandoff({ search: '?clientSlug=x', user: null, authRevision: 0,
      getAuthRevision: () => 0, getCurrentUser: () => null, authLoading: false }));
    act(() => vi.advanceTimersByTime(120000));
    expect(hook.result.current.code).toBe('sign_in_required');
  });
  it.each([
    { isOperator: false, role: 'client', clientId: 'stable-client' },
    { isReadOnly: true }, { sharedUid: 'owner' }, { shareClientId: 'stable-client' },
  ])('refuses a non-operator/share context %j', changed => {
    const sdk = { user: a, revision: 1 };
    const hook = renderHook(() => useClientHandoff({ search: '?clientSlug=stable-client', user: a, authRevision: 1,
      getAuthRevision: () => sdk.revision, getCurrentUser: () => sdk.user, isOperator: true, ...changed }));
    expect(hook.result.current).toMatchObject({ status: 'blocked', code: 'operator_required', clientName: null });
  });
  it('irreversibly retires observed actor A→B→A even with the same original roster', () => {
    const f = fixture(); const old = f.hook.result.current;
    f.sdk.user = b; f.sdk.revision = 2;
    f.update({ user: b, authRevision: 2, scopeKey: 'b:2' });
    expect(f.hook.result.current.status).toBe('retired');
    f.sdk.user = a; f.sdk.revision = 1;
    f.update({ user: a, authRevision: 1, scopeKey: 'a:1' });
    expect(f.hook.result.current).toMatchObject({ status: 'retired', clientName: null });
    expect(old.isCurrent()).toBe(false); expect(old.dismiss()).toBe(false);
  });
  it.each([{ authRevision: 2 }, { role: 'client' }, { clientId: 'another' }, { isOperator: false },
    { isReadOnly: true }, { sharedUid: 'owner' }, { shareClientId: 'other' }, { scopeKey: 'new-project' },
    { authLoading: true }, { search: '?clientSlug=other' }])('retires on changed authority/URL %j', changed => {
    const f = fixture(); f.update(changed);
    expect(f.hook.result.current.status).toBe('retired');
  });
  it('guards callbacks against synchronous SDK changes before a React render', () => {
    const f = fixture(); const current = f.hook.result.current;
    f.sdk.revision = 2;
    expect(current.isCurrent()).toBe(false); expect(current.dismiss()).toBe(false); expect(current.revalidate()).toBe(false);
    f.update({}); expect(f.hook.result.current.status).toBe('retired');
  });
  it('requires exact SDK user object even for identical UID/email', () => {
    const f = fixture(); f.sdk.user = { ...a };
    expect(f.hook.result.current.isCurrent()).toBe(false);
    f.update({}); expect(f.hook.result.current.status).toBe('retired');
  });
  it('fails closed for missing or throwing current-identity getters', () => {
    for (const changed of [{ getCurrentUser: undefined }, { getAuthRevision: undefined }, { getCurrentUser: () => { throw Error('test'); } }]) {
      const f = fixture(); f.update(changed); expect(f.hook.result.current.status).toBe('retired'); f.hook.unmount();
    }
  });
  it('manual dismissal retires callbacks synchronously and does not reapply on roster change', () => {
    const f = fixture(); const ready = f.hook.result.current;
    act(() => { expect(ready.dismiss()).toBe(true); expect(ready.isCurrent()).toBe(false); expect(ready.dismiss()).toBe(false); });
    f.update({ roster: { ...f.props.roster, clients: [{ ...rows[0], name: 'Renamed' }], readVersion: 'new' } });
    expect(f.hook.result.current).toMatchObject({ status: 'dismissed', active: false, clientName: null });
  });
  it('requires explicit revalidation for a changed name, including a name round trip', () => {
    const f = fixture(); const prior = f.hook.result.current;
    f.update({ roster: { ...f.props.roster, clients: [{ ...rows[0], name: 'New Name' }], readVersion: 'two' } });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'review_required', canRevalidate: true, clientName: null });
    expect(prior.isCurrent()).toBe(false);
    const staleReview = f.hook.result.current;
    f.update({ roster: { ...f.props.roster, clients: rows, readVersion: 'three' } });
    expect(f.hook.result.current.status).toBe('blocked'); expect(staleReview.revalidate()).toBe(false);
    act(() => expect(f.hook.result.current.revalidate()).toBe(true));
    expect(f.hook.result.current).toMatchObject({ status: 'ready', clientName: rows[0].name });
  });
  it('invalidates read failure and requires fresh confirmed data plus deliberate review', () => {
    const f = fixture();
    f.update({ roster: { ...f.props.roster, error: 'failed', confirmed: false } });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', canRevalidate: false });
    expect(f.hook.result.current.revalidate()).toBe(false);
    f.update({ roster: { ...f.props.roster, error: null, confirmed: true, readVersion: 'new' } });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'review_required', canRevalidate: true });
    act(() => f.hook.result.current.revalidate());
    expect(f.hook.result.current.status).toBe('ready');
  });
  it('allows successful unchanged-name refresh without deliberate review and retires old read key', () => {
    const f = fixture(); const first = f.hook.result.current;
    f.update({ roster: { ...f.props.roster, loading: true, confirmed: false, readVersion: 'two' } });
    expect(f.hook.result.current.status).toBe('pending'); expect(first.isCurrent()).toBe(false);
    f.update({ roster: { ...f.props.roster, loading: false, confirmed: true } });
    expect(f.hook.result.current.status).toBe('ready'); expect(first.isCurrent()).toBe(false);
  });
  it('bounds a hanging roster, rejects late automatic application, then permits deliberate revalidation', () => {
    vi.useFakeTimers(); const f = fixture();
    f.update({ roster: { ...f.props.roster, loading: true, confirmed: false } });
    act(() => vi.advanceTimersByTime(CLIENT_HANDOFF_WAIT_MS));
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'wait_expired' });
    f.update({ roster: { ...f.props.roster, loading: false, confirmed: true, readVersion: 'late' } });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'review_required' });
    act(() => f.hook.result.current.revalidate()); expect(f.hook.result.current.status).toBe('ready');
  });
  it('cleans pending timers and callbacks on unmount', () => {
    vi.useFakeTimers(); const f = fixture();
    f.update({ roster: { ...f.props.roster, loading: true, confirmed: false } });
    const before = f.hook.result.current; f.hook.unmount();
    expect(before.dismiss()).toBe(false); act(() => vi.advanceTimersByTime(CLIENT_HANDOFF_WAIT_MS));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for current content before permitting defaults', () => {
    const f = fixture(); f.update({ content: { posts: [], clientMap: {}, loading: true, error: null } });
    expect(f.hook.result.current).toMatchObject({ status: 'pending', code: 'content_loading', clientName: null });
    f.update({ content: { ...f.props.content, loading: false } });
    expect(f.hook.result.current.status).toBe('ready');
  });
  it.each([
    { posts: [{ client: rows[0].name, clientId: 'conflicting' }], clientMap: {} },
    { posts: [{ client: rows[0].name, source: 'suggestion', forClientId: 'conflicting' }], clientMap: {} },
    { posts: [], clientMap: { [rows[0].name]: { clientId: 'conflicting' } } },
  ])('latches content conflict until deliberate fresh review %j', content => {
    const f = fixture(); f.update({ content: { ...content, loading: false, error: null } });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'content_conflict', canRevalidate: false });
    f.update({ content: { posts: [], clientMap: {}, loading: false, error: null } });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'review_required', candidateName: rows[0].name });
    act(() => f.hook.result.current.revalidate()); expect(f.hook.result.current.status).toBe('ready');
  });
  it('requires content evidence and never publishes an unverified candidate name', () => {
    const f = fixture(); f.update({ content: undefined });
    expect(f.hook.result.current).toMatchObject({ status: 'blocked', code: 'content_unavailable', candidateName: null });
  });
});
