import React, { useState, useEffect, useRef } from 'react';
import { X, Trash2, UploadCloud, Loader2, Video, Plus, ImageOff, AlertCircle } from 'lucide-react';
import { listClientMedia, uploadMedia, addVideoUrl, deleteMedia } from '../utils/generationApi';
import { processImageFile } from '../utils/helpers';
import useEscapeKey from '../hooks/useEscapeKey';

const MEDIA_CAP = 50; // mirrors MEDIA_PER_CLIENT in wrangler.toml

/**
 * Standalone per-client media library: browse, upload (optimized), add video-URL
 * references, and delete. Opened from the sidebar.
 */
const MediaLibrary = ({ onClose, uniqueClients = [], initialClient = '', showToast }) => {
  useEscapeKey(onClose);
  const [client, setClient] = useState(initialClient || uniqueClients[0] || '');
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!client) return; // render shows the "select a client" state
    let live = true;
    listClientMedia(client)
      .then(m => { if (live) { setItems(m); setError(null); } })
      .catch(err => { if (live) { setError(err.message || 'Could not load media'); setItems([]); } });
    return () => { live = false; };
  }, [client, reloadKey]);

  const refresh = () => { setItems(null); setError(null); setReloadKey(k => k + 1); };
  const pickClient = (e) => { setItems(null); setError(null); setClient(e.target.value); };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !client || busy) return;
    setBusy(true);
    try {
      const optimized = await processImageFile(file, { maxWidth: 2048, quality: 0.82 });
      await uploadMedia(client, optimized);
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
      await addVideoUrl(client, v);
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
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-slate-400 text-sm"><ImageOff size={26} className="mb-2" /> No media yet — upload an image or add a video URL.</div>
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
                  <button onClick={() => handleDelete(m.key)} disabled={busy} title="Delete"
                    className="absolute top-1.5 right-1.5 p-1.5 bg-black/50 text-white rounded-full hover:bg-rose-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MediaLibrary;
