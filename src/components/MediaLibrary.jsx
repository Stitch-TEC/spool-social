import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Trash2, UploadCloud, Loader2, Video, Plus, ImageOff, AlertCircle, Images, FolderPlus } from 'lucide-react';
import { listClientMedia, uploadMedia, addVideoUrl, deleteMedia } from '../utils/generationApi';
import { processImageFile, imageContentId } from '../utils/helpers';
import useEscapeKey from '../hooks/useEscapeKey';

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
const MediaLibrary = ({ onClose, uniqueClients = [], initialClient = '', clientIdFor, postImagesByClient = {}, showToast }) => {
  useEscapeKey(onClose);
  const [client, setClient] = useState(initialClient || uniqueClients[0] || '');
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  // Two-step delete: first tap arms ("Delete?"), second tap within 3s commits.
  // Deletion is permanent and unconfirmed was the only destructive action
  // without a guard — and the hover-only button was invisible on touch.
  const [confirmKey, setConfirmKey] = useState(null);
  const fileRef = useRef(null);

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

  useEffect(() => {
    if (!clientKey) return; // render shows the "select a client" state
    let live = true;
    listClientMedia(clientKey)
      .then(m => { if (live) { setItems(m); setError(null); } })
      .catch(err => { if (live) { setError(err.message || 'Could not load media'); setItems([]); } });
    return () => { live = false; };
  }, [clientKey, reloadKey]);

  const refresh = () => { setItems(null); setError(null); setReloadKey(k => k + 1); };
  const pickClient = (e) => { setItems(null); setError(null); setClient(e.target.value); };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !client || busy) return;
    setBusy(true);
    try {
      const optimized = await processImageFile(file, { maxWidth: 2048, quality: 0.82 });
      await uploadMedia(clientKey, optimized);
      showToast?.('Image added to library');
      refresh();
    } catch (err) {
      showToast?.(err.message || 'Upload failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleAddVideo = async () => {
    const v = videoUrl.trim();
    if (!v || !client || busy) return;
    setBusy(true);
    try {
      await addVideoUrl(clientKey, v);
      showToast?.('Video added');
      setVideoUrl('');
      refresh();
    } catch (err) {
      showToast?.(err.message || 'Could not add video', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (key) => {
    if (busy) return;
    setConfirmKey(null);
    setBusy(true);
    try {
      await deleteMedia(key);
      refresh();
    } catch (err) {
      showToast?.(err.message || 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Promote an image already used on a post into the curated (POM-shared) library.
  const handleSaveToLibrary = async (srcUrl) => {
    if (busy || !client) return;
    setBusy(true);
    try {
      const dataUrl = await toDataUrl(srcUrl);
      await uploadMedia(clientKey, dataUrl);
      showToast?.('Saved to library');
      refresh();
    } catch (err) {
      showToast?.(err.message || 'Could not save to library', 'error');
    } finally {
      setBusy(false);
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

  return (
    <div role="dialog" aria-modal="true" aria-label="Media Library" onClick={onClose}
      className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-slate-800">Media Library</h2>
          <div className="flex items-center gap-2">
            {uniqueClients.length > 0 || client ? (
              <select value={client} onChange={pickClient} className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-slate-50 font-medium max-w-[160px]">
                {client && !uniqueClients.includes(client) && <option value={client}>{client}</option>}
                {uniqueClients.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : <span className="text-xs text-slate-400">No clients yet</span>}
            <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors"><X size={20} /></button>
          </div>
        </div>

        <div className="p-3 border-b border-slate-100 flex flex-wrap items-center gap-2 bg-slate-50">
          <button onClick={() => fileRef.current?.click()} disabled={!client || busy}
            className="flex items-center gap-1.5 bg-indigo-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 disabled:opacity-50">
            <UploadCloud size={14} /> Upload image
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
          <div className="flex items-center gap-1 flex-1 min-w-[200px]">
            <input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddVideo(); } }}
              placeholder="Paste a YouTube / Vimeo / .mp4 URL…" disabled={!client || busy}
              className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white disabled:opacity-50" />
            <button onClick={handleAddVideo} disabled={!client || busy || !videoUrl.trim()}
              className="flex items-center gap-1 border border-indigo-200 text-indigo-700 px-2.5 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-50 disabled:opacity-50">
              <Plus size={14} /> Video
            </button>
          </div>
          <span className="text-[11px] text-slate-400 font-medium ml-auto">{count} / {MEDIA_CAP}</span>
        </div>

        <div className="p-4 overflow-y-auto">
          {!client ? (
            <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Select or create a client to manage its media.</div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-sm">
              <AlertCircle size={26} className="mb-2 text-rose-400" />{error}
              <button onClick={refresh} className="mt-3 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700">Retry</button>
            </div>
          ) : items === null ? (
            <div className="flex items-center justify-center h-40 text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
          ) : (
            <div className="space-y-6">
              {items.length === 0 ? (
                <div className={`flex flex-col items-center justify-center text-slate-400 text-sm ${postImages.length > 0 ? 'h-20' : 'h-40'}`}>
                  <ImageOff size={26} className="mb-2" /> No media in the library yet — upload an image or add a video URL.
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {items.map(m => (
                    <div key={m.key} className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
                      {m.type === 'video' ? (
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="w-full h-full flex flex-col items-center justify-center text-slate-500 p-2 text-center">
                          <Video size={26} />
                          <span className="text-[10px] mt-1 font-bold uppercase">{m.provider}</span>
                          <span className="text-[9px] text-slate-400 truncate w-full mt-0.5">{m.url}</span>
                        </a>
                      ) : (
                        <img src={m.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                      )}
                      <button
                        onClick={() => (confirmKey === m.key ? handleDelete(m.key) : setConfirmKey(m.key))}
                        disabled={busy}
                        title={confirmKey === m.key ? 'Tap again to delete permanently' : 'Delete'}
                        aria-label={confirmKey === m.key ? 'Tap again to delete permanently' : 'Delete'}
                        className={`absolute top-1.5 right-1.5 flex items-center gap-1 p-1.5 text-white rounded-full transition-all ${
                          confirmKey === m.key
                            ? 'bg-rose-600 opacity-100'
                            : 'bg-black/50 hover:bg-rose-600 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 focus:opacity-100'
                        }`}
                      >
                        <Trash2 size={13} />{confirmKey === m.key && <span className="text-[10px] font-bold pr-0.5">Delete?</span>}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Everything already used on this client's posts but not curated yet —
                  previously invisible here, which made the library look empty even
                  when the client had plenty of content. */}
              {postImages.length > 0 && (
                <section aria-label="Images used on posts">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">
                    <Images size={13} className="text-indigo-400" /> Used on {client}&rsquo;s posts
                  </h3>
                  <p className="text-[11px] text-slate-400 mb-2">Not in the library yet — save one to share it with the rest of the suite (e.g. POM&rsquo;s Assets card).</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {postImages.map(u => (
                      <div key={u} className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50">
                        <img src={u} alt="" loading="lazy" className="w-full h-full object-cover" />
                        <button onClick={() => handleSaveToLibrary(u)} disabled={busy} title="Save to library"
                          className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-2 py-1 bg-black/50 text-white rounded-full text-[10px] font-bold hover:bg-indigo-600 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100 focus:opacity-100 transition-opacity">
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
