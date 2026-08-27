import { describe, expect, it, vi } from 'vitest';
import {
  STALE_ASSET_RECOVERY_PARAM,
  clearStaleAssetRecoveryMarker,
  installStaleAssetRecovery,
  staleAssetRecoveryUrl,
} from './staleAssetRecovery';

describe('stale asset recovery', () => {
  it('preserves the current same-origin route and permits only one automatic refresh', () => {
    const original = 'https://spool.stitchtec.dev/?s=share-token&next=https%3A%2F%2Fevil.example#review';
    const first = staleAssetRecoveryUrl(original, 1234);
    const recovered = new URL(first);

    expect(recovered.origin).toBe('https://spool.stitchtec.dev');
    expect(recovered.pathname).toBe('/');
    expect(recovered.searchParams.get('s')).toBe('share-token');
    expect(recovered.searchParams.get('next')).toBe('https://evil.example');
    expect(recovered.searchParams.get(STALE_ASSET_RECOVERY_PARAM)).toBe('1234');
    expect(recovered.hash).toBe('#review');
    expect(staleAssetRecoveryUrl(first, 5678)).toBeNull();
  });

  it('refuses non-web and malformed destinations', () => {
    expect(staleAssetRecoveryUrl('javascript:alert(1)', 1)).toBeNull();
    expect(staleAssetRecoveryUrl('not a url', 1)).toBeNull();
  });

  it('cleans a successful recovery marker without navigating', () => {
    const replaceState = vi.fn();
    const cleared = clearStaleAssetRecoveryMarker({
      location: { href: `https://spool.stitchtec.dev/?s=share-token&client=acme&${STALE_ASSET_RECOVERY_PARAM}=2#posts` },
      history: { state: { ok: true }, replaceState },
    });
    const cleaned = new URL(replaceState.mock.calls[0][2]);
    expect(cleared).toBe(true);
    expect(cleaned.searchParams.get('s')).toBe('share-token');
    expect(cleaned.searchParams.get('client')).toBe('acme');
    expect(cleaned.searchParams.has(STALE_ASSET_RECOVERY_PARAM)).toBe(false);
    expect(cleaned.hash).toBe('#posts');
  });

  it('handles Vite preload failures with the same one-shot same-origin refresh', () => {
    const listeners = new Map();
    const replace = vi.fn();
    const win = {
      location: { href: 'https://spool.stitchtec.dev/clients/acme?s=token', replace },
      history: { state: null, replaceState: vi.fn() },
      addEventListener: vi.fn((name, fn) => listeners.set(name, fn)),
      removeEventListener: vi.fn((name) => listeners.delete(name)),
    };
    const uninstall = installStaleAssetRecovery(win);
    const event = { preventDefault: vi.fn() };
    listeners.get('vite:preloadError')(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(new URL(replace.mock.calls[0][0]).origin).toBe('https://spool.stitchtec.dev');

    // A second failure in the same document is allowed to reach the app-level
    // error boundary; it must not schedule another automatic navigation.
    listeners.get('vite:preloadError')({ preventDefault: vi.fn() });
    expect(replace).toHaveBeenCalledOnce();
    uninstall();
    expect(listeners.has('vite:preloadError')).toBe(false);
  });

  it('removes a successful marker but retains an in-memory loop guard', () => {
    const listeners = new Map();
    const replace = vi.fn();
    const replaceState = vi.fn();
    const win = {
      location: {
        href: `https://spool.stitchtec.dev/?s=token&client=acme&${STALE_ASSET_RECOVERY_PARAM}=123#review`,
        replace,
      },
      history: { state: null, replaceState },
      addEventListener: vi.fn((name, fn) => listeners.set(name, fn)),
      removeEventListener: vi.fn(),
    };

    installStaleAssetRecovery(win);
    const event = { preventDefault: vi.fn() };
    listeners.get('vite:preloadError')(event);

    const cleaned = new URL(replaceState.mock.calls[0][2]);
    expect(cleaned.searchParams.get('s')).toBe('token');
    expect(cleaned.searchParams.get('client')).toBe('acme');
    expect(cleaned.hash).toBe('#review');
    expect(replace).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
