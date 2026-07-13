import React from 'react';
import {
  Grid, Archive, Settings, Image as ImageIcon, Database, Users, Zap, Files
} from 'lucide-react';

const navButtonClass = (active) =>
  `w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50'
  }`;

const Sidebar = ({
  open,
  onClose,
  showArchived,
  onShowArchived,
  showTemplates,
  onShowTemplates,
  filterClient,
  onFilterClient,
  uniqueClients,
  onOpenClientSettings,
  onOpenMedia,
  onOpenData,          // opens the Import & Export modal (scoped inside for client members)
  isOperator = true,   // operator-only surfaces (media, client picker, branding, admin)
  onOpenAdmin,
  onOpenAutomations
}) => {
  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Mobile: fixed slide-in overlay. Desktop: sticky, full-viewport-height rail
          that stays pinned as the page scrolls (its nav scrolls internally). */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 transform transition-transform duration-200 lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'} lg:sticky lg:top-0 lg:self-start lg:h-screen`}>
        <div className="p-6 h-full flex flex-col">
          {/* Branding */}
          <div className="flex flex-col mb-8">
            <div className="flex items-center gap-2">
              <img src="/stitch-tec-logo.png" alt="Stitch TEC" width={32} height={32} className="shadow-sm" style={{ borderRadius: '50%', objectFit: 'cover' }} />
              <span className="font-black text-xl text-slate-900">Spool</span>
            </div>
            <a
              href="https://stitchtec.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-bold text-slate-400 tracking-widest uppercase hover:text-indigo-600 mt-2 ml-1"
            >
              by Stitch TEC
            </a>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="mb-6">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Views</h3>
              <div className="space-y-1">
                <button onClick={() => { onShowArchived(false); onClose(); }} className={navButtonClass(!showArchived && !showTemplates)}>
                  <div className="flex items-center gap-2"><Grid size={16} /> <span>Active Threads</span></div>
                </button>
                <button onClick={() => { onShowTemplates(true); onClose(); }} className={navButtonClass(showTemplates)}>
                  <div className="flex items-center gap-2"><Files size={16} /> <span>Templates</span></div>
                </button>
                <button onClick={() => { onShowArchived(true); onClose(); }} className={navButtonClass(showArchived)}>
                  <div className="flex items-center gap-2"><Archive size={16} /> <span>Archived</span></div>
                </button>
                {/* Media is not operator-only: client members manage their own client's
                    library (tenant-pinned server-side). */}
                {onOpenMedia && (
                  <button onClick={() => { onOpenMedia(); onClose(); }} className={navButtonClass(false)}>
                    <div className="flex items-center gap-2"><ImageIcon size={16} /> <span>Media Library</span></div>
                  </button>
                )}
              </div>
            </div>

            {isOperator && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3 w-full">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Clients</h3>
                  <button onClick={onOpenClientSettings} className="p-1 rounded-md text-slate-400 hover:bg-slate-100 hover:text-indigo-600 transition-colors" title="Brand Settings"><Settings size={14}/></button>
                </div>
                <div className="space-y-1">
                  <button onClick={() => { onFilterClient(null); onClose(); }} className={navButtonClass(!filterClient)}>
                    All Clients
                  </button>
                  {uniqueClients.map(client => (
                    <button key={client} onClick={() => { onFilterClient(client); onClose(); }} className={navButtonClass(filterClient === client)}>
                      {client}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {onOpenData && (
              <div className="mb-6">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Data</h3>
                <button onClick={() => { onOpenData(); onClose(); }} className={navButtonClass(false)}>
                  <div className="flex items-center gap-2"><Database size={16} /> <span>Import &amp; Export</span></div>
                </button>
              </div>
            )}

            {isOperator && onOpenAdmin && (
              <div className="mb-6">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Admin</h3>
                <button onClick={() => { onOpenAdmin(); onClose(); }} className={navButtonClass(false)}>
                  <div className="flex items-center gap-2"><Users size={16} /> <span>Manage Users</span></div>
                </button>
                {onOpenAutomations && (
                  <button onClick={() => { onOpenAutomations(); onClose(); }} className={navButtonClass(false)}>
                    <div className="flex items-center gap-2"><Zap size={16} /> <span>Automations</span></div>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
