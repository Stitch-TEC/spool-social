import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, ImageOff, Loader2, AlertCircle, FolderHeart, Images, Info, Globe, Video, Search } from 'lucide-react';
import { listMedia, listClientMedia, fetchContentIndex, importSiteImage } from '../utils/generationApi';
import { imageContentId } from '../utils/helpers';
import { useMediaSession, useMediaDialog } from '../hooks/useMediaSession';
import { readableMediaItems, videoMediaPresentation, mediaMatchesSearch } from '../utils/mediaPresentation';
import MediaTypeFilter from './MediaTypeFilter';
const EMPTY_ITEMS = [];

// One selectable thumbnail — shared by all sections so they look identical. `busy` marks the one
// site image currently being imported into the library (pick disabled meanwhile).
const Thumb = ({ item, onPick, busy = false }) => (
  <button
    type="button"
    onClick={onPick}
    disabled={busy}
    title={item.alt || 'Use this image'}
    aria-label={item.alt ? `Use image: ${item.alt}` : 'Use this image'}
    className="group relative min-h-11 min-w-11 aspect-square rounded-lg overflow-hidden border border-slate-300 hover:border-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-all disabled:opacity-60"
  >
    <img src={item.url} alt={item.alt || ''} loading="lazy" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
    {busy && (
      <span className="absolute inset-0 bg-white/60 flex items-center justify-center">
        <Loader2 size={18} className="animate-spin text-indigo-600" />
      </span>
    )}
  </button>
);

/**
 * Modal for reusable cover images and separately identified video links.
 *
 * Three sections, deduplicated across each other (an image already shown in an
 * earlier section never repeats in a later one):
 *   1. Images already used on this client's posts (`clientImages`) — the most
 *      relevant reuse source, no re-upload needed.
 *   2. The client's curated library (the slug-keyed folder shared with POM's
 *      Assets card) when `clientKey` is resolved. Video references use an
 *      explicit separate callback; they never become imageUrl or native videos.
 *   3. The user's generated/uploaded AI-cache pool.
 * onSelect receives the image URL.
 */
const MediaPicker = ({ onClose, onSelect, onSelectVideo, showToast, clientKey = '', clientName = '', clientImages = [], sessionKey = '', isSessionCurrent }) => {
  const { scope, isCurrent, retire } = useMediaSession(sessionKey, clientKey, isSessionCurrent);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const dispatchRef = useRef(null);
  const close = () => { retire(); onClose(); };
  useMediaDialog(dialogRef, closeRef, close);
  const [poolRead, setPoolRead] = useState(null);
  const [clientRead, setClientRead] = useState(null);
  const [siteRead, setSiteRead] = useState(null);
  const [importing, setImporting] = useState(null);
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState('all');
  const [controlsScope, setControlsScope] = useState(scope);
  if (controlsScope !== scope) {
    setControlsScope(scope); setSearch(''); setMediaType('all');
  }
  const items = poolRead?.scope === scope ? poolRead.items : null;
  const error = poolRead?.scope === scope ? poolRead.error : null;
  const clientItems = clientRead?.scope === scope ? clientRead.items : null;
  const clientError = clientRead?.scope === scope ? clientRead.error : null;
  const siteItems = siteRead?.scope === scope ? siteRead.items : null;
  const siteError = siteRead?.scope === scope ? siteRead.error : null;
  const importingUrl = importing?.scope === scope ? importing.url : '';
  const [reloadKey, setReloadKey] = useState(0);
  const [siteReloadKey, setSiteReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    if (!isCurrent()) return;
    listMedia(clientKey)
      .then(m => { if (live && isCurrent()) setPoolRead({ scope, items: readableMediaItems(m), error: null }); })
      .catch(() => {
        if (!live || !isCurrent()) return;
        setPoolRead({ scope, items: [], error: 'Generated images could not load. Try again.' });
      });
    return () => { live = false; };
    // The scope owns the captured checker; callback churn does not repeat reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, scope]);

  // Keep images and video references separate, but admit the whole saved list.
  useEffect(() => {
    if (!clientKey || !isCurrent()) return;
    let live = true;
    listClientMedia(clientKey)
      .then(m => { if (live && isCurrent()) setClientRead({ scope, items: readableMediaItems(m), error: null }); })
      .catch(() => {
        if (!live || !isCurrent()) return;
        setClientRead({ scope, items: [], error: 'Client library could not load. Try again.' });
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, reloadKey]);

  // The client's SITE images from the durable content index (crawled inventory w/ page attribution
  // + alt). A failed optional read remains distinct from a confirmed empty index. Images
  // already imported carry spoolUrl — those dedupe against the curated section via that URL.
  useEffect(() => {
    if (!clientKey || !isCurrent()) return;
    let live = true;
    fetchContentIndex(clientKey, { images: true })
      .then((d) => {
        if (!live || !isCurrent()) return;
        if (!Array.isArray(d?.images) || d.images.length > 10000) throw new Error('Invalid site inventory');
        setSiteRead({ scope, items: d.images.filter(i => i && typeof i.url === 'string' && i.kind !== 'logo'), error: null });
      })
      .catch(() => { if (live && isCurrent()) setSiteRead({ scope, items: [], error: 'Site images could not load. Try again.' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, reloadKey, siteReloadKey]);

  // Cross-section dedupe: an image kept by an earlier (higher-priority) section is
  // dropped from every later one. This is the fix for the same photo showing 2-3
  // times when it's on a post AND in the curated library AND in the generated pool.
  const sections = useMemo(() => {
    const seen = new Set();
    // Dedupe key: `dedupeUrl` (a site image's imported LIBRARY copy) wins over the display url, so
    // an already-imported site image collapses into its curated twin instead of showing twice.
    const take = (list) => (list || []).filter(m => {
      const k = imageContentId(m.dedupeUrl || m.url);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      used: take(clientImages.map((url) => ({ key: url, url, type: 'image' }))),
      curated: clientItems === null ? null : take(clientItems.filter(m => m.type === 'image')),
      videos: (clientItems || []).filter(m => m.type === 'video').map(m => ({ ...m, reference: videoMediaPresentation(m) })),
      generated: items === null ? null : take(items.filter(m => m.type === 'image')),
      site: take((siteItems || EMPTY_ITEMS).map((i) => ({ key: `site:${i.url}`, url: i.url, type: 'image', alt: i.alt, spoolUrl: i.spoolUrl, dedupeUrl: i.spoolUrl || '' }))),
    };
  }, [clientImages, clientItems, items, siteItems]);
  const searchComplete = items !== null && (!clientKey || (clientItems !== null && (mediaType === 'video' || siteItems !== null)));
  const matches = item => (mediaType === 'all' || item.type === mediaType) && mediaMatchesSearch(item, search);
  const visibleUsed = sections.used.filter(matches);
  const visibleCurated = (sections.curated || []).filter(matches);
  const visibleVideos = sections.videos.filter(matches);
  const visibleGenerated = (sections.generated || []).filter(matches);
  const visibleSite = sections.site.filter(matches);
  const hasMatch = [...sections.used, ...(sections.curated || []), ...sections.videos,
    ...(sections.generated || []), ...sections.site].some(matches);

  // The ref closes the same-tick double-click gap; Close retires late callbacks
  // immediately, even if the parent does not unmount until a later render.
  const pick = (url) => {
    if (!isCurrent() || dispatchRef.current?.scope === scope) return;
    dispatchRef.current = { scope };
    onSelect(url);
    close();
  };
  const pickVideo = (item) => {
    if (!isCurrent() || dispatchRef.current?.scope === scope || !onSelectVideo || !item.reference) return;
    dispatchRef.current = { scope };
    const { url, label, provider } = item.reference;
    onSelectVideo({ url, label, provider });
    close();
  };

  // Picking a SITE image imports it into the curated library first (broker-validated + downloaded,
  // idempotent) so the post references a durable /media URL, never a hotlink that can rot or shift.
  const pickSiteImage = async (item) => {
    if (!isCurrent() || dispatchRef.current?.scope === scope) return;
    if (item.spoolUrl) { pick(item.spoolUrl); return; }
    const attempt = { scope };
    dispatchRef.current = attempt;
    setImporting({ scope, url: item.url });
    try {
      const hosted = await importSiteImage(clientKey, item.url);
      if (!isCurrent() || dispatchRef.current !== attempt) return;
      if (typeof hosted !== 'string' || !hosted) throw new Error('Invalid image result');
      setImporting(null);
      onSelect(hosted);
      close();
    } catch (e) {
      if (!isCurrent() || dispatchRef.current !== attempt) return;
      dispatchRef.current = null;
      setImporting(null);
      const msg = String(e?.message || '');
      showToast?.(
        msg === 'library_full' ? 'The client library is full — remove some items first.'
          : msg === 'unsupported_type' ? 'That image format can’t be imported.'
            : 'Couldn’t import that image — try another.',
        'error'
      );
    }
  };

  const grid = (list) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {list.map(m => <Thumb key={m.key} item={m} busy={Boolean(importingUrl)} onPick={() => pick(m.url)} />)}
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media Library"
      ref={dialogRef}
      onClick={close}
      className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-xl w-full min-w-0 max-w-2xl max-h-[85vh] flex flex-col overflow-hidden [overflow-wrap:anywhere]"
      >
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Media Library</h2>
          <button ref={closeRef} type="button" onClick={close} aria-label="Close" className="min-h-11 min-w-11 flex items-center justify-center text-slate-700 hover:bg-slate-100 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto space-y-5">
          <MediaTypeFilter value={mediaType} onChange={value => { if (isCurrent()) setMediaType(value); }} />
          <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-slate-500 px-3 text-slate-700 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-indigo-600">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="Search media" placeholder="Search labels, video IDs or filenames" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} className="min-h-11 w-full min-w-0 bg-transparent text-base outline-none" />
          </label>
          {(search.trim() || mediaType !== 'all') && searchComplete && !error && !clientError && (mediaType === 'video' || !siteError) && !hasMatch && <p role="status" className="text-sm text-slate-700">No matching media. Try another type, video ID or filename.</p>}
          {/* No client context yet (new post, client not picked) — say so instead of
              silently hiding the per-client sections. */}
          {!clientKey && (
            <p className="flex items-center gap-1.5 text-xs text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
              <Info size={13} className="shrink-0 text-indigo-400" /> Pick a client in the editor to also see that client&rsquo;s post images and library.
            </p>
          )}

          {/* Images already used on this client's posts — the most relevant reuse
              source (e.g. the imported calendar's hero photos). No re-upload. */}
          {visibleUsed.length > 0 && (
            <section aria-label="Images used on this client's posts">
              <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                <Images size={13} className="text-indigo-400" /> Used on {clientName ? `${clientName}’s` : 'these'} posts
              </h3>
              {grid(visibleUsed)}
            </section>
          )}

          {/* Curated client library — its own labeled section when a client is resolved.
              Hidden when everything it holds is already shown above. */}
          {clientKey && (
            <section aria-label={`${clientName || clientKey}'s library`}>
              <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                <FolderHeart size={13} className="text-indigo-400" /> {clientName || clientKey}&rsquo;s library
              </h3>
              {clientError ? (
                <div className="text-sm text-slate-700 flex flex-wrap items-center gap-1.5" role="alert">
                  <AlertCircle size={13} className="text-rose-400" /> {clientError}
                  <button type="button" onClick={() => { if (!isCurrent()) return; setClientRead(null); setReloadKey(k => k + 1); }} className="min-h-11 rounded-lg border border-slate-400 px-3 text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-600">Retry client library</button>
                </div>
              ) : sections.curated === null ? (
                <div className="flex items-center text-slate-400 text-xs py-2">
                  <Loader2 className="animate-spin mr-2" size={14} /> Loading…
                </div>
              ) : clientItems.length === 0 ? (
                <p className="text-sm text-slate-600">No media in this client&rsquo;s library yet.</p>
              ) : mediaType === 'video' ? null
              : sections.curated.length === 0 && sections.videos.length > 0 ? null
              : sections.curated.length === 0 ? (
                <p className="text-xs text-slate-400">All of this library&rsquo;s images are shown above.</p>
              ) : (
                grid(visibleCurated)
              )}
            </section>
          )}

          {clientKey && !clientError && visibleVideos.length > 0 && (
            <section aria-label="Video links">
              <h3 className="mb-2 text-sm font-bold text-slate-700">Video links</h3>
              <p className="mb-2 text-sm text-slate-600">Choose a link, then confirm how to add it. This does not attach or publish a video.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {visibleVideos.map(m => (
                  <button key={m.key} type="button" onClick={() => pickVideo(m)} disabled={Boolean(importingUrl) || !onSelectVideo || !m.reference}
                    aria-label={m.reference ? `Choose video link: ${m.reference.label}` : 'Unavailable video link'}
                    className="min-h-11 min-w-0 rounded-lg border border-slate-500 p-3 text-left text-slate-700 hover:border-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60 [overflow-wrap:anywhere]">
                    <span className="flex items-start gap-2"><Video size={20} className="shrink-0" aria-hidden="true" /><span className="min-w-0 font-semibold">{m.reference?.label || 'Unsupported video link'}</span></span>
                    {m.reference && <span className="mt-1 block text-xs text-slate-600">{m.reference.provider}{m.reference.label.includes(m.reference.detail) ? '' : ` · ${m.reference.detail}`}</span>}
                  </button>
                ))}
              </div>
              {!onSelectVideo && <p className="mt-2 text-sm text-slate-600">This picker accepts cover images only.</p>}
            </section>
          )}

          {/* The client's SITE images (the durable content index's crawled inventory) — picking one
              imports it into the curated library first, so the post gets a hosted /media URL. */}
          {clientKey && siteError && <div role="alert" className="flex flex-wrap items-center gap-1.5 text-sm text-slate-700"><AlertCircle size={13} className="text-rose-400" aria-hidden="true" />{siteError}<button type="button" onClick={() => { if (!isCurrent()) return; setSiteRead(null); setSiteReloadKey(key => key + 1); }} className="min-h-11 rounded-lg border border-slate-400 px-3 text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-600">Retry site images</button></div>}
          {clientKey && siteItems === null && <div className="flex items-center text-sm text-slate-600" role="status"><Loader2 className="mr-2 animate-spin" size={14} aria-hidden="true" />Loading site images…</div>}
          {clientKey && visibleSite.length > 0 && (
            <section aria-label={`Images on ${clientName || clientKey}'s site`}>
              <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                <Globe size={13} className="text-indigo-400" /> On {clientName ? `${clientName}’s` : 'the client’s'} site
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {visibleSite.map(m => (
                  <Thumb key={m.key} item={m} busy={Boolean(importingUrl)} onPick={() => pickSiteImage(m)} />
                ))}
              </div>
            </section>
          )}

          {/* Generated / uploaded pool — the reuse cache. Scoped to the current client when one is
              resolved (so it isn't every client's images); the whole pool when no client is picked. */}
          {(mediaType !== 'video' || error || sections.generated === null) && <section aria-label="Generated images">
            {(clientKey || sections.used.length > 0) && (
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                {clientKey ? `Generated for ${clientName || clientKey}` : 'Generated images'}
              </h3>
            )}
            {error ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-sm">
                <AlertCircle size={28} className="mb-2 text-rose-400" />
                <p className="mb-3">{error}</p>
                <button type="button" onClick={() => { if (!isCurrent()) return; setPoolRead(null); setClientRead(null); setReloadKey(k => k + 1); }} className="min-h-11 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700">
                  Retry
                </button>
              </div>
            ) : sections.generated === null ? (
              <div className="flex items-center justify-center h-40 text-slate-400">
                <Loader2 className="animate-spin mr-2" size={20} /> Loading…
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-400 text-sm text-center px-4">
                <ImageOff size={28} className="mb-2" />
                {clientKey ? `No generated images for ${clientName || clientKey} yet — generate one first.` : 'No images yet — generate one first.'}
              </div>
            ) : sections.generated.length === 0 ? (
              <p className="text-xs text-slate-400">All generated images are shown above.</p>
            ) : (
              grid(visibleGenerated)
            )}
          </section>}
        </div>
      </div>
    </div>
  );
};

export default MediaPicker;
