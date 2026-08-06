import React, { useState, useRef, useEffect } from 'react';
import { LayoutGrid, Check } from 'lucide-react';
import { STITCH_APPS, CURRENT_APP_ID } from '../stitch-apps';
import { STITCH_MARK_TILE, STITCH_MARK_INK } from '../app-marks';
import { AppMark } from './AppMark';

// Cross-app launcher for the Stitch Suite. Reads the canonical STITCH_APPS
// registry (SUITE-ARCHITECTURE.md §2) so the app list stays in sync
// across every app. Each row's "current" is derived from CURRENT_APP_ID.
const ToolSwitcher = () => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch app"
        aria-label="Switch Stitch Suite app"
        className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"
      >
        <LayoutGrid size={20} />
      </button>
      {open && (
        <div className="absolute left-0 mt-2 w-64 bg-white border border-slate-200 rounded-xl shadow-lg p-1 z-50">
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Stitch Suite</div>
          {STITCH_APPS.map(app => {
            const current = app.id === CURRENT_APP_ID;
            const tile = (
              <span
                className="flex-shrink-0 w-7 h-7 rounded-md overflow-hidden"
                style={{ background: STITCH_MARK_TILE[app.id], color: STITCH_MARK_INK[app.id] }}
              >
                {app.id === 'site' ? (
                  // The company entry uses the real Stitch TEC logo raster — the
                  // drawn crescent mark is app-tile geometry, not the brand logo.
                  <img src="/stitch-tec-logo.png" alt="" className="w-7 h-7 object-cover" />
                ) : (
                  <AppMark id={app.id} className="w-7 h-7" />
                )}
              </span>
            );
            return app.status === 'soon' ? (
              <div key={app.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-400 cursor-default">
                <span className="opacity-50">{tile}</span>
                <span className="flex-1 min-w-0 font-semibold truncate">{app.name} <span className="font-normal">· {app.tagline}</span></span>
                <span className="text-[10px] font-bold uppercase tracking-wide">Soon</span>
              </div>
            ) : (
              <a
                key={app.id}
                href={app.url}
                target={current ? '_self' : '_blank'}
                rel="noopener noreferrer"
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm hover:bg-slate-50 ${current ? 'text-indigo-700 font-bold' : 'text-slate-700 font-medium'}`}
              >
                {tile}
                <span className="flex-1 min-w-0 truncate">{app.name} <span className="font-normal text-slate-400">· {app.tagline}</span></span>
                {current && <Check size={14} className="text-indigo-600 flex-shrink-0" />}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ToolSwitcher;
