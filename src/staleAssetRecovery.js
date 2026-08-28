// One-shot recovery for a browser shell that outlives the hashed Vite assets it
// references. The marker stays on the URL only until the current entry module
// executes; main.jsx then removes it without another navigation.
export const STALE_ASSET_RECOVERY_PARAM = '__spool_asset_refresh';

export function staleAssetRecoveryUrl(href, nonce = Date.now()) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.searchParams.has(STALE_ASSET_RECOVERY_PARAM)) return null;
  url.searchParams.set(STALE_ASSET_RECOVERY_PARAM, String(nonce));
  return url.toString();
}

export function clearStaleAssetRecoveryMarker(win = window) {
  let url;
  try { url = new URL(win.location.href); } catch { return false; }
  if (!url.searchParams.has(STALE_ASSET_RECOVERY_PARAM)) return false;
  url.searchParams.delete(STALE_ASSET_RECOVERY_PARAM);
  win.history.replaceState(win.history.state, '', url.toString());
  return true;
}

export function installStaleAssetRecovery(win = window) {
  // Reaching this module proves the current entry asset loaded successfully.
  // Remember the marker in this document before removing it from the visible
  // share/client URL. If a lazy chunk still fails, that in-memory guard keeps a
  // recovered page from entering an automatic refresh loop.
  let refreshAttempted = clearStaleAssetRecoveryMarker(win);
  const onPreloadError = (event) => {
    if (refreshAttempted) return;
    const target = staleAssetRecoveryUrl(win.location.href);
    if (!target) return;
    refreshAttempted = true;
    event.preventDefault();
    win.location.replace(target);
  };
  win.addEventListener('vite:preloadError', onPreloadError);
  return () => win.removeEventListener('vite:preloadError', onPreloadError);
}
