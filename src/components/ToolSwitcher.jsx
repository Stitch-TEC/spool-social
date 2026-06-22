import React, { useState, useRef, useEffect } from 'react';
import { LayoutGrid, Check } from 'lucide-react';
import { STITCH_APPS, CURRENT_APP_ID } from '../stitch-apps';

// Cross-app launcher for the Stitch Suite. Reads the canonical STITCH_APPS
// registry (SUITE-SHARED-COMPONENTS-PLAN.md §2) so the app list stays in sync
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
        <div className="absolute left-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-1 z-50">
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Stitch Suite</div>
          {STITCH_APPS.map(app => {
            const current = app.id === CURRENT_APP_ID;
            return app.status === 'soon' ? (
              <div key={app.id} className="flex items-center justify-between px-3 py-2 rounded-lg text-sm text-slate-400 cursor-default">
                <span className="font-semibold">{app.name} <span className="font-normal">· {app.tagline}</span></span>
                <span className="text-[10px] font-bold uppercase tracking-wide">Soon</span>
              </div>
            ) : (
              <a
                key={app.id}
                href={app.url}
                target={current ? '_self' : '_blank'}
                rel="noopener noreferrer"
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm hover:bg-slate-50 ${current ? 'text-indigo-700 font-bold' : 'text-slate-700 font-medium'}`}
              >
                <span>{app.name} <span className="font-normal text-slate-400">· {app.tagline}</span></span>
                {current && <Check size={14} className="text-indigo-600" />}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ToolSwitcher;
