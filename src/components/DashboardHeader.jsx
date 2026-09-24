import React, { useRef, useEffect } from 'react';
import {
  Menu, Search, X, Grid, Calendar as CalendarIcon,
  Share2, Plus, LogOut
} from 'lucide-react';
import ToolSwitcher from './ToolSwitcher';

const ROLE_LABELS = {
  super_admin: 'Operator',
  client_admin: 'Client admin',
  client: 'Client',
};

const DashboardHeader = ({
  isReadOnly,
  view,
  onViewChange,
  searchQuery,
  onSearchChange,
  onToggleSidebar,
  onShare,
  filterClient,
  onNew,
  onSignOut,
  userEmail = '',
  role = null
}) => {
  const initial = (userEmail.trim()[0] || '?').toUpperCase();
  const roleLabel = ROLE_LABELS[role] || '';
  const searchInputRef = useRef(null);

  // "/" focuses search (unless already typing in a field).
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    // The header grows with its controls/text, including enlarged desktop text.
    // In short viewports it scrolls too, so tall controls cannot cover the feed.
    // PostGrid headings scroll normally: there is no fixed header-height offset.
    <header className="bg-white border-b border-slate-200 sticky top-0 [@media(max-height:32rem)]:static z-40 px-4 sm:px-6 py-2 flex flex-wrap items-center gap-2 shadow-sm 2xl:gap-4">
      <div className="shrink-0 flex items-center gap-2">
        {!isReadOnly && <ToolSwitcher />}
        {!isReadOnly && (
          <button onClick={onToggleSidebar} title="Toggle Sidebar" aria-label="Toggle Sidebar" className="lg:hidden min-h-11 min-w-11 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            <Menu size={24} />
          </button>
        )}

        {/* Mobile/Client Branding (owners get branding in the sidebar; hide on
            narrow screens to leave room for the view/new/link actions) */}
        <a href="https://stitchtec.dev" target="_blank" rel="noopener noreferrer" aria-label="Stitch TEC website" className={`min-h-11 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${!isReadOnly ? 'hidden sm:flex lg:hidden' : 'flex'}`}>
          <img src="/stitch-tec-logo.png" alt="Stitch TEC" width={28} height={28} style={{ borderRadius: '50%', objectFit: 'cover' }} />
          <div className="flex flex-col leading-none">
            <h1 className="text-xl font-black text-slate-900">Spool</h1>
            <span className="text-[10px] font-bold text-slate-600 tracking-widest uppercase">by Stitch TEC</span>
          </div>
        </a>
      </div>

      <div className="flex-1 basis-40 min-w-[min(100%,10rem)] 2xl:max-w-md">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search..."
            aria-label="Search threads"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="min-h-11 min-w-0 w-full pl-9 pr-12 py-2 bg-slate-100 border-none rounded-xl text-sm text-slate-900 placeholder:text-slate-600 focus:ring-2 focus:ring-indigo-600 focus:bg-white transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => {
                onSearchChange('');
                searchInputRef.current?.focus();
              }}
              className="absolute right-0 top-1/2 -translate-y-1/2 min-h-11 min-w-11 flex items-center justify-center rounded-xl text-slate-600 hover:text-indigo-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              aria-label="Clear search"
              title="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="basis-full min-w-0 flex flex-wrap items-center gap-1 sm:gap-2 2xl:basis-auto">
        {!isReadOnly && (
          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button onClick={() => onViewChange('grid')} className={`min-h-11 min-w-11 flex items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${view === 'grid' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-600 hover:text-slate-900'}`} title="Grid View" aria-label="Grid View" aria-pressed={view === 'grid'}><Grid size={18}/></button>
            <button onClick={() => onViewChange('calendar')} className={`min-h-11 min-w-11 flex items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${view === 'calendar' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-600 hover:text-slate-900'}`} title="Calendar View" aria-label="Calendar View" aria-pressed={view === 'calendar'}><CalendarIcon size={18}/></button>
          </div>
        )}

        {!isReadOnly && (
          <button
            onClick={onShare}
            className="min-h-11 min-w-11 flex items-center justify-center gap-2 border px-3 py-2 rounded-xl font-bold text-sm transition-all bg-indigo-50 text-indigo-700 border-indigo-100 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            title={filterClient ? `Share ${filterClient} for client review` : 'Share for client review'}
            aria-label={filterClient ? `Share ${filterClient} for client review` : 'Share for client review'}
          >
            <Share2 size={16} className="shrink-0" />
            <span className="hidden sm:inline max-w-[112px] truncate">{filterClient ? `Share ${filterClient}` : 'Share'}</span>
          </button>
        )}

        {!isReadOnly && (
          <button
            onClick={onNew}
            className="min-h-11 min-w-11 flex items-center justify-center gap-2 bg-indigo-600 text-white px-3 sm:px-4 py-2 rounded-xl font-bold text-sm shadow-md hover:bg-indigo-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            aria-label="Create New Thread"
          >
            <Plus size={18} className="shrink-0" /> <span className="hidden md:inline">New</span>
          </button>
        )}

        {!isReadOnly && userEmail && (
          <div
            className="flex items-center gap-2 sm:pl-1 sm:pr-2.5 sm:py-1 sm:rounded-full sm:bg-slate-100 sm:border sm:border-slate-200"
            title={`Signed in as ${userEmail}${roleLabel ? ` · ${roleLabel}` : ''}`}
          >
            <div className="w-8 h-8 sm:w-7 sm:h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0" aria-hidden="true">
              {initial}
            </div>
            <div className="hidden sm:flex flex-col leading-tight min-w-0 max-w-[128px]">
              <span className="text-xs font-semibold text-slate-700 truncate">{userEmail}</span>
              {roleLabel && <span className="text-[10px] text-slate-600 -mt-0.5">{roleLabel}</span>}
            </div>
          </div>
        )}

        <button
          onClick={onSignOut}
          className="min-h-11 min-w-11 flex items-center justify-center rounded-lg text-slate-600 hover:text-rose-700 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          title={isReadOnly ? "Exit View" : `Log out ${userEmail}`.trim()}
          aria-label={isReadOnly ? "Exit View" : "Log Out"}
        >
          <LogOut size={20} />
        </button>
      </div>
    </header>
  );
};

export default DashboardHeader;
