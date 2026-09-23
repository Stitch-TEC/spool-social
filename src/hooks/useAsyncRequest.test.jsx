import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import useAsyncRequest from './useAsyncRequest';

describe('mounted asynchronous request identity', () => {
  it('blocks repeated begins, but lets independent fields work concurrently', () => {
    const { result } = renderHook(() => useAsyncRequest('alpha'));
    const a = result.current.begin();
    expect(result.current.begin()).toBeNull();
    expect(result.current.current(a)).toBe(true);
    expect(result.current.begin('metadata')).not.toBeNull();
    result.current.finish(a);
    expect(result.current.begin()).not.toBeNull();
  });
  it('does not revive A results after A to B to A, or let their finalizers release a new request', () => {
    const { result, rerender } = renderHook(({ context }) => useAsyncRequest(context), { initialProps: { context: 'alpha' } });
    const a = result.current.begin();
    rerender({ context: 'beta' });
    rerender({ context: 'alpha' });
    const latest = result.current.begin();
    expect(result.current.current(a)).toBe(false);
    result.current.finish(a);
    expect(result.current.current(latest)).toBe(true);
    expect(result.current.begin()).toBeNull();
  });
  it('invalidates on explicit cancel and unmount, including StrictMode setup replay', () => {
    const { result, unmount } = renderHook(() => useAsyncRequest('alpha'), { wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode> });
    const first = result.current.begin();
    expect(result.current.current(first)).toBe(true);
    result.current.cancel();
    expect(result.current.current(first)).toBe(false);
    const second = result.current.begin();
    expect(result.current.current(second)).toBe(true);
    unmount();
    expect(result.current.current(second)).toBe(false);
    expect(result.current.begin()).toBeNull();
  });
});
