import React, { useState } from 'react';
import {
  Layout, Grid, Archive, Settings, Upload, Download, ChevronDown, Image as ImageIcon, FileText, Database
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
  filterClient,
  onFilterClient,
  uniqueClients,
  onOpenClientSettings,
  onOpenMedia,
  onImport,
  onExport
}) => {
  // Inline accordion — a left-full flyout gets clipped by the sidebar's
  // overflow-y-auto scroll container (the old bug where Export "did nothing").
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  const runExport = (mode, format = 'csv') => {
    onExport(mode, format);
    setExportMenuOpen(false);
  };

  const exportRowClass = 'w-full flex items-center gap-2 text-left px-3 py-2 text-xs font-medium text-slate-600 hover:bg-indigo-50 hover:text-indigo-700 rounded-md transition-colors';

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          onClick={onClose}
        />
      )}

      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 transform transition-transform duration-200 lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'} lg:static`}>
        <div className="p-6 h-full flex flex-col">
          {/* Branding */}
          <div className="flex flex-col mb-8">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <Layout className="text-white" size={18} />
              </div>
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
                <button onClick={() => { onShowArchived(false); onClose(); }} className={navButtonClass(!showArchived)}>
                  <div className="flex items-center gap-2"><Grid size={16} /> <span>Active Threads</span></div>
                </button>
                <button onClick={() => { onShowArchived(true); onClose(); }} className={navButtonClass(showArchived)}>
                  <div className="flex items-center gap-2"><Archive size={16} /> <span>Archived</span></div>
                </button>
                <button onClick={() => { onOpenMedia(); onClose(); }} className={navButtonClass(false)}>
                  <div className="flex items-center gap-2"><ImageIcon size={16} /> <span>Media Library</span></div>
                </button>
              </div>
            </div>

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

            <div className="mb-6">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Data</h3>
              <div className="space-y-1">
                <label className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 cursor-pointer transition-colors">
                  <Upload size={16} />
                  <span>Import CSV / JSON</span>
                  <input type="file" accept=".csv,.json,text/csv,application/json" onChange={onImport} className="hidden" />
                </label>
                <button
                  onClick={() => setExportMenuOpen(o => !o)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  aria-haspopup="true"
                  aria-expanded={exportMenuOpen}
                >
                  <Download size={16} />
                  <span>Export</span>
                  <ChevronDown size={14} className={`ml-auto opacity-40 transition-transform ${exportMenuOpen ? 'rotate-180' : ''}`} />
                </button>
                {/* Inline (in-flow) so it can never be clipped by the scroll container. */}
                {exportMenuOpen && (
                  <div className="ml-3 pl-3 border-l border-slate-100 py-1 space-y-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
                    <p className="px-3 pt-1 pb-0.5 text-[10px] font-bold text-slate-300 uppercase tracking-wider">Spreadsheet (CSV)</p>
                    <button onClick={() => runExport('current', 'csv')} className={exportRowClass}><FileText size={13} /> Current view</button>
                    <button onClick={() => runExport('all', 'csv')} className={exportRowClass}><FileText size={13} /> All threads</button>
                    <button onClick={() => runExport('archived', 'csv')} className={exportRowClass}><FileText size={13} /> Archived only</button>
                    <p className="px-3 pt-2 pb-0.5 text-[10px] font-bold text-slate-300 uppercase tracking-wider">Backup</p>
                    <button onClick={() => runExport('all', 'json')} className={exportRowClass}><Database size={13} /> Full backup (JSON)</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
