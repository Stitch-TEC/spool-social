import React, { useState, useEffect } from 'react';
import { X, ImageOff, Loader2, AlertCircle, FolderHeart, Images } from 'lucide-react';
import { listMedia, listClientMedia } from '../utils/generationApi';
import useEscapeKey from '../hooks/useEscapeKey';

// One selectable thumbnail — shared by both sections so they look identical.
const Thumb = ({ item, onPick }) => (
  <button
    type="button"
    onClick={onPick}
    title="Use this image"
    className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 hover:border-indigo-500 hover:ring-2 hover:ring-indigo-500/30 transition-all"
  >
    <img src={item.url} alt="" loading="lazy" className="w-full h-full object-cover" />
  </button>
);

/**
 * Modal that lists reusable images so the editor can insert one instead of regenerating.
 *
 * Always shows the user's generated AI-cache pool. When `clientKey` (the client's canonical
 * suite SLUG) is passed, it ALSO shows that client's curated library (the slug-keyed folder
 * shared with POM's Assets card) as its own labeled section — images only, since a video
 * reference can't be inserted as the post's imageUrl. The curated fetch degrades gracefully
 * (inline note, never blocks the generated pool). onSelect receives the image URL.
 */
const MediaPicker = ({ onClose, onSelect, showToast, clientKey = '', clientName = '', clientImages = [] }) => {
  useEscapeKey(onClose);
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [clientItems, setClientItems] = useState(null); // null = loading (only relevant when clientKey)
  const [clientError, setClientError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    listMedia()
      .then(m => { if (live) setItems(m); })
      .catch(err => {
        if (!live) return;
        const msg = err.message || 'Could not load media library';
        setError(msg);
        showToast?.(msg, 'error');
      });
    return () => { live = false; };
  }, [reloadKey, showToast]);

  // Curated client library — only when the editor resolved a client slug. Videos are filtered
  // out (not insertable as an image); a fetch failure stays inline and non-blocking.
  useEffect(() => {
    if (!clientKey) return;
    let live = true;
    listClientMedia(clientKey)
      .then(m => { if (live) setClientItems(m.filter(x => x.type === 'image')); })
      .catch(err => {
        if (!live) return;
        setClientError(err.message || 'Could not load the client library');
        setClientItems([]);
      });
    return () => { live = false; };
  }, [clientKey, reloadKey]);

  const pick = (url) => { onSelect(url); onClose(); };

  const grid = (list) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {list.map(m => <Thumb key={m.key} item={m} onPick={() => pick(m.url)} />)}
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Media Library"
      onClick={onClose}
      className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"
      >
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Media Library</h2>
          <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto space-y-5">
          {/* Images already used on this client's posts — the most relevant reuse
              source (e.g. the imported calendar's hero photos). No re-upload. */}
          {clientImages.length > 0 && (
            <section aria-label="Images used on this client's posts">
              <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                <Images size={13} className="text-indigo-400" /> Used on {clientName ? `${clientName}’s` : 'these'} posts
              </h3>
              {grid(clientImages.map((url) => ({ key: url, url })))}
            </section>
          )}

          {/* Curated client library — its own labeled section when a client is resolved. */}
          {clientKey && (
            <section aria-label={`${clientName || clientKey}'s library`}>
              <h3 className="flex items-center gap-1.5 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                <FolderHeart size={13} className="text-indigo-400" /> {clientName || clientKey}&rsquo;s library
              </h3>
              {clientError ? (
                <p className="text-xs text-slate-400 flex items-center gap-1.5">
                  <AlertCircle size={13} className="text-rose-400" /> {clientError}
                </p>
              ) : clientItems === null ? (
                <div className="flex items-center text-slate-400 text-xs py-2">
                  <Loader2 className="animate-spin mr-2" size={14} /> Loading…
                </div>
              ) : clientItems.length === 0 ? (
                <p className="text-xs text-slate-400">No images in this client&rsquo;s library yet.</p>
              ) : (
                grid(clientItems)
              )}
            </section>
          )}

          {/* Generated AI-cache pool — the existing reuse library. */}
          <section aria-label="Generated images">
            {clientKey && (
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Generated images</h3>
            )}
            {error ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-sm">
                <AlertCircle size={28} className="mb-2 text-rose-400" />
                <p className="mb-3">{error}</p>
                <button onClick={() => { setItems(null); setError(null); setClientItems(null); setClientError(null); setReloadKey(k => k + 1); }} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700">
                  Retry
                </button>
              </div>
            ) : items === null ? (
              <div className="flex items-center justify-center h-40 text-slate-400">
                <Loader2 className="animate-spin mr-2" size={20} /> Loading…
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-slate-400 text-sm">
                <ImageOff size={28} className="mb-2" /> No images yet — generate one first.
              </div>
            ) : (
              grid(items)
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default MediaPicker;
