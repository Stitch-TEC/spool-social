import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useHelpSession from './useHelpSession';

const fixture = () => {
  const user = { uid: 'synthetic' };
  return { user, authRevision: 1, getAuthRevision: () => 1, authLoading: false, role: 'super_admin', isOperator: true, isClientMember: false, isReadOnly: false, clientId: null, sharedUid: null, shareClientId: null, getCurrentUser: () => user };
};

describe('help identity lifetime', () => {
  it.each([
    [{}, 'operator'],
    [{ role: 'client', isOperator: false, isClientMember: true }, 'member'],
    [{ role: 'client_admin', isOperator: false, isClientMember: true }, 'member'],
    [{ role: null, isOperator: false, isReadOnly: true }, 'guest'],
    [{ role: 'unknown' }, 'unknown'],
    [{ role: 'super_admin', isOperator: false }, 'unknown'],
  ])('resolves only the actual UI audience %j', (fields, audience) => {
    const context = { ...fixture(), ...fields };
    const { result } = renderHook(() => useHelpSession(context));
    act(() => result.current.open());
    expect(result.current.selection.audience).toBe(audience);
    act(() => result.current.close());
    expect(result.current.selection).toBeNull();
  });
  it.each(['user', 'revision', 'role', 'client', 'share', 'loading'])('retires open help on %s change without resurrection', changed => {
    const original = fixture();
    const { result, rerender } = renderHook(context => useHelpSession(context), { initialProps: original });
    act(() => result.current.open());
    expect(result.current.selection).not.toBeNull();
    const next = { ...original };
    if (changed === 'user') { next.user = { uid: 'synthetic' }; next.getCurrentUser = () => next.user; }
    if (changed === 'revision') { next.authRevision = 2; next.getAuthRevision = () => 2; }
    if (changed === 'role') { next.role = 'client'; next.isOperator = false; next.isClientMember = true; }
    if (changed === 'client') next.clientId = 'other';
    if (changed === 'share') next.shareClientId = 'other';
    if (changed === 'loading') next.authLoading = true;
    rerender(next); expect(result.current.selection).toBeNull();
    rerender(original); expect(result.current.selection).toBeNull();
  });
  it.each(['revision', 'sdk-user'])('blocks an opening after unrendered %s change', changed => {
    let revision = 1;
    let currentUser;
    const context = fixture(); currentUser = context.user;
    context.getAuthRevision = () => revision; context.getCurrentUser = () => currentUser;
    const { result } = renderHook(() => useHelpSession(context));
    if (changed === 'revision') revision = 2; else currentUser = { uid: 'other' };
    act(() => result.current.open());
    expect(result.current.selection).toBeNull();
  });
  it('refuses to nest help inside another modal or retain a callback after unmount', () => {
    const existing = document.createElement('div'); existing.setAttribute('role', 'dialog'); document.body.append(existing);
    const { result, unmount } = renderHook(() => useHelpSession(fixture()));
    act(() => result.current.open()); expect(result.current.selection).toBeNull();
    existing.remove();
    const open = result.current.open;
    unmount(); expect(() => open()).not.toThrow();
  });
  it('does not let a retired close callback close a newly opened session', () => {
    const original = fixture();
    const { result, rerender } = renderHook(context => useHelpSession(context), { initialProps: original });
    act(() => result.current.open()); const oldClose = result.current.close;
    act(() => result.current.close()); act(() => result.current.open());
    const reopened = result.current.selection;
    act(() => oldClose()); expect(result.current.selection).toBe(reopened);
    rerender({ ...original, authRevision: 2, getAuthRevision: () => 2 });
    act(() => result.current.open()); const nextSession = result.current.selection;
    act(() => oldClose()); expect(result.current.selection).toBe(nextSession);
  });
  it('does not fetch, persist preferences, or modify a handoff URL', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    window.history.replaceState({}, '', '/?s=synthetic&clientSlug=keep');
    const url = window.location.href;
    const { result } = renderHook(() => useHelpSession(fixture()));
    act(() => result.current.open()); act(() => result.current.close());
    expect(fetch).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled(); expect(window.location.href).toBe(url);
    fetch.mockRestore(); setItem.mockRestore(); window.history.replaceState({}, '', '/');
  });
});
