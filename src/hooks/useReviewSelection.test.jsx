import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import useReviewSelection from './useReviewSelection';

const user = { uid: 'synthetic-guest' };
const post = { id: 'a', uid: 'owner', clientId: 'alpha', reviewStage: 'in_review', content: 'Original', status: 'draft' };
const base = () => ({
  user, authRevision: 1, authLoading: false, role: null, clientId: null,
  sharedUid: 'owner', shareClientId: 'alpha', isReadOnly: true,
  isOperator: false, isClientMember: false, posts: [post], error: null,
});
const mount = (initialProps = base(), options = {}) => {
  const renders = [];
  const hook = renderHook(props => {
    const value = useReviewSelection(props);
    renders.push(value.selection);
    return value;
  }, { initialProps, ...options });
  act(() => hook.result.current.open(post));
  return { ...hook, renders };
};
afterEach(cleanup);

describe('review selection ownership', () => {
  it.each([
    ['user UID', { user: { uid: 'other-guest' } }],
    ['same UID User replacement', { user: { uid: user.uid } }],
    ['auth revision', { authRevision: 3 }],
    ['auth resolution', { authLoading: true }],
    ['sign-out', { user: null }],
    ['role', { role: 'client' }],
    ['member client', { clientId: 'beta' }],
    ['share owner', { sharedUid: 'another-owner' }],
    ['share client', { shareClientId: 'beta' }],
    ['no longer review guest', { isReadOnly: false }],
    ['operator flag', { isOperator: true }],
    ['member flag', { isClientMember: true }],
    ['removed post', { posts: [] }],
    ['permission denied with retained rows', { error: { code: 'permission-denied' } }],
    ['unauthenticated with retained rows', { error: { code: 'unauthenticated' } }],
    ['same-ID tenant reassignment', { posts: [{ ...post, clientId: 'beta' }] }],
    ['same-ID owner reassignment', { posts: [{ ...post, uid: 'another-owner' }] }],
    ['post held private', { posts: [{ ...post, reviewStage: 'private' }] }],
    ['missing review stage', { posts: [{ ...post, reviewStage: undefined }] }],
    ['suggestion', { posts: [{ ...post, source: 'suggestion' }] }],
  ])('hides on the first render and never revives after %s', (_label, changed) => {
    const initial = base();
    const hook = mount(initial);
    const selected = hook.result.current.selection;
    expect(selected.post).toBe(post);
    const before = hook.renders.length;
    hook.rerender({ ...initial, ...changed });
    expect(hook.renders.slice(before).every(value => value === null)).toBe(true);
    expect(hook.result.current.isCurrent(selected)).toBe(false);
    hook.rerender(initial);
    expect(hook.result.current.selection).toBeNull();
  });

  it('keeps the captured object on ordinary same-ID copy/status/date/feedback changes', () => {
    const initial = base();
    const hook = mount(initial);
    const selected = hook.result.current.selection;
    hook.rerender({ ...initial, posts: [{ ...post, content: 'Not yet reviewed', status: 'archived', scheduledDate: 'not-a-date', feedback: 'Another reply' }] });
    expect(hook.result.current.selection).toBe(selected);
    expect(hook.result.current.selection.post).toBe(post);
    expect(hook.result.current.isCurrent(selected)).toBe(true);
  });

  it('keeps a same-scope transient connection warning without losing selection', () => {
    const initial = base();
    const hook = mount(initial);
    const selected = hook.result.current.selection;
    hook.rerender({ ...initial, error: { code: 'unavailable' } });
    expect(hook.result.current.selection).toBe(selected);
    expect(hook.result.current.isCurrent(selected)).toBe(true);
  });

  it('blocks action/open immediately when the synchronous auth counter changes before render', () => {
    let revision = 1;
    const hook = mount({ ...base(), getAuthRevision: () => revision });
    const selected = hook.result.current.selection;
    revision = 3;
    expect(hook.result.current.isCurrent(selected)).toBe(false);
    act(() => hook.result.current.open(post));
    expect(hook.result.current.selection).toBe(selected); // No stale dispatch or new opening.
    hook.rerender({ ...base(), authRevision: 3, getAuthRevision: () => revision });
    expect(hook.result.current.selection).toBeNull();
  });

  it('invalidates old actions immediately on close/reopen in one batch, including the same ID', () => {
    const hook = mount();
    const old = hook.result.current.selection;
    act(() => {
      hook.result.current.close(old);
      hook.result.current.open(post);
      expect(hook.result.current.isCurrent(old)).toBe(false);
      hook.result.current.close(old); // A late old completion must not close the new one.
    });
    expect(hook.result.current.selection.post).toBe(post);
    expect(hook.result.current.selection).not.toBe(old);
    expect(hook.result.current.selection.sequence).not.toBe(old.sequence);
  });

  it('does not allow new selections with foreign ownership or private/suggestion data', () => {
    const hook = renderHook(useReviewSelection, { initialProps: base() });
    for (const candidate of [
      { ...post, clientId: 'beta' }, { ...post, uid: 'other-owner' },
      { ...post, reviewStage: 'private' }, { ...post, source: 'suggestion' },
      { ...post, id: 'not-present' }, { ...post, uid: undefined },
    ]) act(() => hook.result.current.open(candidate));
    expect(hook.result.current.selection).toBeNull();
  });

  it('does not parse strict review identity during render; malformed legacy date remains viewable', () => {
    const malformed = { ...post, scheduledDate: null, _raw_scheduledDate: 'malformed-legacy-value' };
    const hook = renderHook(useReviewSelection, { initialProps: { ...base(), posts: [malformed] } });
    act(() => hook.result.current.open(malformed));
    expect(hook.result.current.selection.post).toBe(malformed);
  });

  it('keeps archived rows available for the existing disabled-action display', () => {
    const archived = { ...post, status: 'archived' };
    const hook = renderHook(useReviewSelection, { initialProps: { ...base(), posts: [archived] } });
    act(() => hook.result.current.open(archived));
    expect(hook.result.current.selection.post).toBe(archived);
  });

  it('survives StrictMode and invalidates action checks after unmount', () => {
    const hook = mount(base(), { wrapper: StrictMode });
    const selected = hook.result.current.selection;
    const guard = hook.result.current.isCurrent;
    expect(guard(selected)).toBe(true);
    hook.unmount();
    expect(guard(selected)).toBe(false);
  });
});
