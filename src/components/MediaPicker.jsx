import React, { useState, useEffect } from 'react';
import { X, ImageOff, Loader2, AlertCircle } from 'lucide-react';
import { listMedia } from '../utils/generationApi';
import useEscapeKey from '../hooks/useEscapeKey';

/**
 * Modal that lists the user's previously generated images (the R2 pool) so they
 * can reuse one instead of regenerating. onSelect receives the image URL.
 */
const MediaPicker = ({ onClose, onSelect, showToast }) => {
  useEscapeKey(onClose);
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
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
        <div className="p-4 overflow-y-auto">
          {error ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-500 text-sm">
              <AlertCircle size={28} className="mb-2 text-rose-400" />
              <p className="mb-3">{error}</p>
              <button onClick={() => { setItems(null); setError(null); setReloadKey(k => k + 1); }} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700">
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
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {items.map(m => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => { onSelect(m.url); onClose(); }}
                  title="Use this image"
                  className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 hover:border-indigo-500 hover:ring-2 hover:ring-indigo-500/30 transition-all"
                >
                  <img src={m.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MediaPicker;
