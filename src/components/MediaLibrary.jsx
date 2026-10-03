import React, { useState, useEffect, useMemo, useRef, useId } from 'react';
import { X, Trash2, UploadCloud, Loader2, Video, Plus, ImageOff, AlertCircle, Images, FolderPlus, Search } from 'lucide-react';
import { listClientMedia, uploadMedia, addVideoUrl, deleteMedia } from '../utils/generationApi';
import { processImageFile, imageContentId } from '../utils/helpers';
import { useMediaSession, useMediaDialog } from '../hooks/useMediaSession';
import { readableMediaItems, videoMediaPresentation, mediaMatchesSearch, confirmedLibraryItem } from '../utils/mediaPresentation';
import { VIDEO_TITLE_LIMIT, normalizeVideoTitle } from '../utils/videoLibrary';
import MediaTypeFilter from './MediaTypeFilter';

const MEDIA_CAP = 50; // mirrors MEDIA_PER_CLIENT in wrangler.toml

// Resolve any image URL to a data URL for the library-upload endpoint. Data URLs
// pass through; /media URLs are same-origin fetches; an external URL may fail
// CORS — callers surface that as a toast.
const toDataUrl = async (src) => {
  if (typeof src === 'string' && src.startsWith('data:')) return src;
  const res = await fetch(src);
  if (!res.ok) throw new Error('Could not fetch the image');
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the image'));
    r.readAsDataURL(blob);
  });
};

/**
 * Standalone per-client media library: browse, upload (optimized), add video-URL
 * references, delete, and promote images already used on the client's posts into
 * the curated (POM-shared) library. Opened from the sidebar.
 */
const MediaLibrary = ({ onClose, uniqueClients = [], initialClient = '', clientIdFor, postImagesByClient = {}, showToast, sessionKey = '', isSessionCurrent }) => {
  const [client, setClient] = useState(initialClient || uniqueClients[0] || '');
  const [clientSession, setClientSession] = useState(sessionKey);
  const [read, setRead] = useState(null);
  const [operation, setOperation] = useState(null);
  const [uncertain, setUncertain] = useState(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [search, setSearch] = useState('');
  const [mediaType, setMediaType] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);
  // Two-step delete: first tap arms ("Delete?"), second tap within 3s commits.
  // Deletion is permanent and unconfirmed was the only destructive action
  // without a guard — and the hover-only button was invisible on touch.
  const [confirmKey, setConfirmKey] = useState(null);
  const fileRef = useRef(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const operationRef = useRef(null);
  const titleId = useId();
  if (clientSession !== sessionKey) {
    setClientSession(sessionKey);
    setClient(initialClient || uniqueClients[0] || '');
    setConfirmKey(null); setVideoUrl(''); setVideoTitle(''); setSearch(''); setMediaType('all');
  }

  useEffect(() => {
    if (!confirmKey) return;
    const t = setTimeout(() => setConfirmKey(null), 3000);
    return () => clearTimeout(t);
  }, [confirmKey]);

  // The library is keyed by the canonical SLUG (the universal join key), so it lines up with the
  // POM Assets card + the AI's asset manifest. The dropdown still shows/holds the display name;
  // this resolves it to the slug for the API. Falls back to the raw value if no resolver is passed
  // (the worker slugifies either form, so a name still works — it just may not match a hand-authored
  // short slug for the ~half of clients whose slug isn't slugify(name)).
  const clientKey = client ? (clientIdFor ? clientIdFor(client) : client) : '';
  const { scope, isCurrent, retire } = useMediaSession(sessionKey, clientKey, isSessionCurrent);
  const close = () => { retire(); onClose(); };
  useMediaDialog(dialogRef, closeRef, close);
  const items = read?.scope === scope ? read.items : null;
  const error = read?.scope === scope ? read.error : null;
  const busy = operation?.scope === scope;
  const needsCheck = uncertain?.scope === scope;

  useEffect(() => {
    if (!clientKey || !isCurrent()) return;
    let live = true;
    listClientMedia(clientKey)
      .then(m => { if (live && isCurrent()) setRead({ scope, items: readableMediaItems(m), error: null }); })
      .catch(() => { if (live && isCurrent()) setRead({ scope, items: [], error: 'Library could not load. Try again.' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, reloadKey]);

  const refresh = () => { if (!isCurrent()) return; setRead(null); setReloadKey(k => k + 1); };
  const pickClient = (e) => {
    if (!isCurrent() || busy) return;
    setClient(e.target.value); setConfirmKey(null); setVideoUrl(''); setVideoTitle(''); setSearch(''); setMediaType('all');
  };
  const begin = () => {
    if (!isCurrent() || !clientKey || items === null || error || needsCheck || operationRef.current?.scope === scope) return null;
    const attempt = { scope, dispatched: false };
    operationRef.current = attempt; setOperation(attempt); return attempt;
  };
  const owns = attempt => isCurrent() && operationRef.current === attempt;
  const failure = (attempt, text) => {
    if (!owns(attempt)) return;
    if (attempt.dispatched) setUncertain({ scope, checked: false });
    showToast?.(text, 'error');
  };
  const finish = attempt => {
    if (!owns(attempt)) return;
    operationRef.current = null; setOperation(null);
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const attempt = begin(); if (!attempt) return;
    try {
      const optimized = await processImageFile(file, { maxWidth: 2048, quality: 0.82 });
      if (!owns(attempt)) return;
      attempt.dispatched = true;
      const result = await uploadMedia(clientKey, optimized);
      if (!owns(attempt)) return;
      confirmedLibraryItem(result, 'image', clientKey);
      showToast?.('Image added to library');
      refresh();
    } catch {
      failure(attempt, attempt.dispatched ? 'Upload result not confirmed. Check the library before trying again.' : 'Image could not be prepared. Try another file.');
    } finally {
      finish(attempt);
    }
  };

  const handleAddVideo = async () => {
    const v = videoUrl.trim();
    if (!v) return;
    const title = normalizeVideoTitle(videoTitle);
    if (title === null) return;
    const reference = videoMediaPresentation({ type: 'video', url: v });
    if (!reference || !['YouTube', 'Vimeo', 'Video file'].includes(reference.provider)) {
      if (isCurrent()) showToast?.('Use a YouTube, Vimeo or direct HTTPS video-file link.', 'error');
      return;
    }
    const attempt = begin(); if (!attempt) return;
    try {
      attempt.dispatched = true;
      const result = await addVideoUrl(clientKey, v, { title, isCurrent: () => owns(attempt) });
      if (!owns(attempt)) return;
      confirmedLibraryItem(result, 'video', clientKey, v, title);
      showToast?.('Video added');
      setVideoUrl('');
      setVideoTitle('');
      refresh();
    } catch {
      failure(attempt, 'Video result not confirmed. Check the library before trying again.');
    } finally {
      finish(attempt);
    }
  };

  const handleDelete = async (key) => {
    if (!items?.some(item => item.key === key) || confirmKey?.scope !== scope || confirmKey.key !== key) return;
    const attempt = begin(); if (!attempt) return;
    setConfirmKey(null);
    try {
      attempt.dispatched = true;
      const result = await deleteMedia(key);
      if (!owns(attempt)) return;
      if (result?.deleted !== key) throw new Error('Unconfirmed delete');
      refresh();
    } catch {
      failure(attempt, 'Delete result not confirmed. Check the library before trying again.');
    } finally {
      finish(attempt);
    }
  };

  // Promote an image already used on a post into the curated (POM-shared) library.
  const handleSaveToLibrary = async (srcUrl) => {
    const attempt = begin(); if (!attempt) return;
    try {
      const dataUrl = await toDataUrl(srcUrl);
      if (!owns(attempt)) return;
      attempt.dispatched = true;
      const result = await uploadMedia(clientKey, dataUrl);
      if (!owns(attempt)) return;
      confirmedLibraryItem(result, 'image', clientKey);
      showToast?.('Saved to library');
      refresh();
    } catch {
      failure(attempt, attempt.dispatched ? 'Save result not confirmed. Check the library before trying again.' : 'Image could not be read. Try another image.');
    } finally {
      finish(attempt);
    }
  };

  // Images in use on this client's posts that aren't in the curated library yet —
  // the "available content" that used to be invisible here. Compared by canonical
  // R2 key so a library image reused on a post doesn't show twice.
  const postImages = useMemo(() => {
    if (!client) return [];
    const curatedKeys = new Set((Array.isArray(items) ? items : []).map(m => imageContentId(m.url)));
    return (postImagesByClient[client] || []).filter(u => !curatedKeys.has(imageContentId(u)));
  }, [client, items, postImagesByClient]);

  const count = Array.isArray(items) ? items.length : 0;
  const visibleItems = (items || []).filter(item => (mediaType === 'all' || item.type === mediaType) && mediaMatchesSearch(item, search));
  const visiblePostImages = mediaType === 'video' ? [] : postImages.filter(url => mediaMatchesSearch({ type: 'image', key: url, url }, search));
  const invalidTitle = normalizeVideoTitle(videoTitle) === null;
  const blocked = !client || busy || items === null || Boolean(error) || needsCheck;

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Media Library" onClick={close}
      className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-xl w-full min-w-0 max-w-3xl max-h-[88vh] supports-[height:100dvh]:max-h-[88dvh] flex flex-col overflow-y-auto overscroll-contain [overflow-wrap:anywhere]">
        <div className="p-4 shrink-0 border-b border-slate-100 flex min-w-0 flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-800">Media Library</h2>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {uniqueClients.length > 0 || client ? (
              <select aria-label="Library client" value={client} onChange={pickClient} disabled={busy} className="h-11 min-w-0 py-0 px-3 border border-slate-500 rounded-lg text-sm bg-slate-50 font-medium max-w-[160px]">
                {client && !uniqueClients.includes(client) && <option value={client}>{client}</option>}
                {uniqueClients.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : <span className="text-xs text-slate-400">No clients yet</span>}
            <button ref={closeRef} type="button" onClick={close} aria-label="Close" className="min-h-11 min-w-11 flex items-center justify-center text-slate-700 hover:bg-slate-100 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-colors"><X size={20} /></button>
          </div>
        </div>

        <div className="p-3 shrink-0 border-b border-slate-100 flex flex-wrap items-center gap-2 bg-slate-50">
          <button type="button" onClick={() => { if (isCurrent() && !blocked) fileRef.current?.click(); }} disabled={blocked}
            className="min-h-11 flex items-center gap-1.5 bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50">
            <UploadCloud size={14} /> Upload image
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
          <div className="min-w-0 basis-52 grow space-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
            <input aria-label="Video library URL" type="url" value={videoUrl} maxLength={4096} onChange={(e) => setVideoUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); handleAddVideo(); } }}
              placeholder="YouTube / Vimeo / .mp4 link" disabled={blocked}
              className="min-h-11 min-w-0 basis-36 grow px-3 py-1.5 border border-slate-500 rounded-lg text-base bg-white disabled:opacity-50" />
            <button type="button" onClick={handleAddVideo} disabled={blocked || !videoUrl.trim() || invalidTitle}
              className="min-h-11 min-w-11 flex items-center gap-1 border border-indigo-400 text-indigo-700 px-2.5 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50">
              <Plus size={14} /> Add link
            </button>
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-1 text-xs text-slate-700">
                <label htmlFor={titleId}>Video title (optional)</label>
                <span id={`${titleId}-count`}>{videoTitle.length} / {VIDEO_TITLE_LIMIT}</span>
              </div>
              <input id={titleId} type="text" value={videoTitle} onChange={event => setVideoTitle(event.target.value)}
                aria-invalid={invalidTitle} aria-describedby={`${titleId}-count${invalidTitle ? ` ${titleId}-error` : ''}`}
                onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); handleAddVideo(); } }}
                placeholder="A label to find this video" disabled={blocked}
                className="min-h-11 w-full min-w-0 rounded-lg border border-slate-500 bg-white px-3 py-1.5 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50" />
              {invalidTitle && <p id={`${titleId}-error`} role="alert" className="mt-1 text-sm text-rose-800">Use a single-line title of {VIDEO_TITLE_LIMIT} characters or fewer, without control characters.</p>}
            </div>
          </div>
          <span className="text-xs text-slate-600 font-medium ml-auto">{items === null || error ? 'Count not checked' : `${count} / ${MEDIA_CAP}`}</span>
        </div>

        <div className="p-4 shrink-0">
          <div className="mb-3"><MediaTypeFilter value={mediaType} onChange={value => { if (isCurrent()) setMediaType(value); }} /></div>
          <label className="mb-4 flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-slate-500 px-3 text-slate-700 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-indigo-600">
            <Search size={17} aria-hidden="true" />
            <input type="search" aria-label="Search media" placeholder="Search labels, video IDs or filenames" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} className="min-h-11 w-full min-w-0 bg-transparent text-base outline-none" />
          </label>
          {needsCheck && <div role="alert" className="mb-4 space-y-2 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950">
            <p>Result not confirmed. Check the library before trying again.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => { if (!isCurrent()) return; setUncertain({ scope, checked: true }); refresh(); }} disabled={busy} className="min-h-11 rounded-lg border border-amber-700 px-3">Check library</button>
              {uncertain.checked && items !== null && !error && <button type="button" onClick={() => { if (isCurrent()) setUncertain(null); }} className="min-h-11 rounded-lg border border-amber-700 px-3">I’ve checked — continue</button>}
            </div>
          </div>}
          {!client ? (
            <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Select or create a client to manage its media.</div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-sm">
              <AlertCircle size={26} className="mb-2 text-rose-400" />{error}
              <button type="button" onClick={refresh} className="mt-3 min-h-11 px-3 py-1.5 bg-indigo-700 text-white rounded-lg text-xs font-bold hover:bg-indigo-800">Retry</button>
            </div>
          ) : items === null ? (
            <div className="flex items-center justify-center h-40 text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
          ) : (
            <div className="space-y-6">
              {items.length === 0 ? (
                <div className={`flex flex-col items-center justify-center text-slate-400 text-sm ${postImages.length > 0 ? 'h-20' : 'h-40'}`}>
                  <ImageOff size={26} className="mb-2" /> No media in the library yet — upload an image or add a video URL.
                </div>
              ) : visibleItems.length === 0 ? <p role="status" className="text-sm text-slate-700">No matching library items.</p> : (
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-3">
                  {visibleItems.map(m => {
                    const reference = videoMediaPresentation(m);
                    const armed = confirmKey?.scope === scope && confirmKey.key === m.key;
                    return (
                    <div key={m.key} className="group relative min-h-44 rounded-lg overflow-hidden border border-slate-500 bg-slate-50">
                      {m.type === 'video' ? (
                        reference ? <a href={reference.url} onClick={event => { if (!isCurrent()) event.preventDefault(); }} target="_blank" rel="noopener noreferrer" aria-label={`Open video link: ${reference.label}`} className="w-full min-h-44 flex flex-col items-center justify-center text-slate-700 p-3 pt-12 text-center focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-indigo-600 [overflow-wrap:anywhere]">
                          <Video size={26} />
                          <span className="text-sm mt-1 font-semibold">{reference.label}</span>
                          <span className="text-xs text-slate-600 mt-1">{reference.provider}{reference.label.includes(reference.detail) ? '' : ` · ${reference.detail}`}</span>
                        </a> : <span className="flex h-full items-center justify-center p-3 pt-12 text-sm text-slate-700">Unsupported video link</span>
                      ) : (
                        <img src={m.url} alt="" loading="lazy" className="w-full aspect-square object-cover" />
                      )}
                      <button
                        type="button"
                        onClick={() => { if (!isCurrent() || blocked) return; armed ? handleDelete(m.key) : setConfirmKey({ scope, key: m.key }); }}
                        disabled={blocked}
                        title={armed ? 'Tap again to delete permanently' : 'Delete library item'}
                        aria-label={armed ? 'Tap again to delete permanently' : `Delete library item: ${reference?.label || m.key}`}
                        className={`absolute top-1.5 right-1.5 min-h-11 min-w-11 flex items-center justify-center gap-1 p-1.5 text-white rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-all ${
                          armed
                            ? 'bg-rose-600 opacity-100'
                            : 'bg-black/50 hover:bg-rose-600 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 focus:opacity-100'
                        }`}
                      >
                        <Trash2 size={16} />{armed && <span className="text-xs font-bold pr-0.5">Delete?</span>}
                      </button>
                      {armed && <p className="border-t border-rose-900 bg-rose-950 p-2 text-xs text-white">{m.type === 'video' ? 'Remove this library link permanently. The source video stays.' : 'Delete stored image permanently. Drafts using it may lose their image.'}</p>}
                    </div>
                  ); })}
                </div>
              )}

              {/* Everything already used on this client's posts but not curated yet —
                  previously invisible here, which made the library look empty even
                  when the client had plenty of content. */}
              {visiblePostImages.length > 0 && (
                <section aria-label="Images used on posts">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                    <Images size={13} className="text-indigo-400" /> Used on {client}&rsquo;s posts
                  </h3>
                  <p className="text-[11px] text-slate-400 mb-2">Not in the library yet — save one to share it with the rest of the suite (e.g. POM&rsquo;s Assets card).</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {visiblePostImages.map(u => (
                      <div key={u} className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
                        <img src={u} alt="" loading="lazy" className="w-full h-full object-cover" />
                        <button type="button" onClick={() => handleSaveToLibrary(u)} disabled={blocked} title="Save to library"
                          className="absolute bottom-1.5 right-1.5 min-h-11 min-w-11 flex items-center justify-center gap-1 px-2 py-1 bg-black/70 text-white rounded-full text-xs font-bold hover:bg-indigo-700 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 transition-opacity">
                          <FolderPlus size={12} /> Save
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MediaLibrary;
