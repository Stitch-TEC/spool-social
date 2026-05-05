import React, { useMemo, memo } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { STATUS } from '../constants';
import { DATE_FORMATTERS } from '../utils/helpers';

const getDaysInMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
const getFirstDayOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1).getDay();

const CalendarView = memo(({ posts, currentDate, onDateChange, onEdit }) => {
  const days = useMemo(() => Array.from({ length: getDaysInMonth(currentDate) }, (_, i) => i + 1), [currentDate]);
  const padding = useMemo(() => Array.from({ length: getFirstDayOfMonth(currentDate) }, (_, i) => i), [currentDate]);

  // ⚡ OPTIMIZATION: Use pre-compiled Intl.DateTimeFormat for faster formatting.
  const monthName = DATE_FORMATTERS.monthYear.format(currentDate);

  const currentMonth = currentDate.getMonth();
  const currentYear = currentDate.getFullYear();

  // ⚡ OPTIMIZATION: Pre-calculate today's components to avoid ~30 redundant new Date() allocations in the loop.
  const today = useMemo(() => {
    const d = new Date();
    return { day: d.getDate(), month: d.getMonth(), year: d.getFullYear() };
  }, []);

  // ⚡ OPTIMIZATION: Group posts by date in a single pass (O(N))
  const postsByDay = useMemo(() => {
    const map = {};
    posts.forEach(p => {
      // ⚡ OPTIMIZATION: Use existing Date object from props instead of re-parsing
      const d = p.scheduledDate;
      // 🛡️ SAFETY CHECK: Ensure d is a valid Date before calling methods.
      if (d instanceof Date && !isNaN(d.getTime()) && d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
        const day = d.getDate();
        if (!map[day]) map[day] = [];
        map[day].push(p);
      }
    });
    // Sort each day's posts by time
    Object.keys(map).forEach(day => {
      // ⚡ OPTIMIZATION: Simplify sort by using direct Date subtraction (no re-parsing needed)
      map[day].sort((a, b) => a.scheduledDate - b.scheduledDate);
    });
    return map;
  }, [posts, currentMonth, currentYear]);

  return (
    <div className="h-full flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-4 flex justify-between items-center border-b border-slate-100 bg-slate-50">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
           <span className="text-indigo-600">📅</span> {monthName}
        </h2>
        <div className="flex gap-1 bg-white rounded-lg border border-slate-200 p-1">
          <button onClick={() => onDateChange(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))} title="Previous Month" aria-label="Previous Month" className="p-1.5 hover:bg-slate-100 rounded-md text-slate-600"><ChevronLeft size={18}/></button>
          <button onClick={() => onDateChange(new Date())} title="Go to Today" className="px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-md">Today</button>
          <button onClick={() => onDateChange(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))} title="Next Month" aria-label="Next Month" className="p-1.5 hover:bg-slate-100 rounded-md text-slate-600"><ChevronRight size={18}/></button>
        </div>
      </div>
      <div className="grid grid-cols-7 bg-slate-100 gap-px border-b border-slate-200 text-center py-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-wider">
            <span className="hidden sm:inline">{d}</span>
            <span className="sm:hidden">{d[0]}</span>
          </div>
        ))}
      </div>
      <div className="flex-1 grid grid-cols-7 bg-slate-200 gap-px overflow-y-auto">
        {padding.map(i => <div key={`pad-${i}`} className="bg-slate-50/50" />)}
        {days.map(day => {
           const dayPosts = postsByDay[day] || [];
           const isToday = today.day === day && today.month === currentMonth && today.year === currentYear;

           return (
             <div key={day} className="bg-white min-h-[70px] sm:min-h-[100px] p-1 sm:p-2 hover:bg-slate-50 transition-colors group relative">
               <span className={`text-[10px] sm:text-xs font-bold ${isToday ? 'bg-indigo-600 text-white w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center rounded-full' : 'text-slate-400'}`}>{day}</span>
               <div className="mt-1 sm:mt-2 space-y-0.5 sm:space-y-1">
                 {dayPosts.map(p => (
                   <button key={p.id} onClick={() => onEdit(p)} className={`w-full text-left text-[8px] sm:text-[10px] truncate px-1 sm:px-1.5 py-0.5 sm:py-1 rounded border-l-2 ${p.status === STATUS.POSTED ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
                     {/* ⚡ OPTIMIZATION: Use pre-compiled Intl.DateTimeFormat for faster formatting. */}
                     {/* 🛡️ SAFETY CHECK: scheduledDate should already be a Date object, but we guard here too. */}
                     <span className="hidden sm:inline">{p.scheduledDate instanceof Date ? DATE_FORMATTERS.time.format(p.scheduledDate) : ''}</span>
                     <span className="sm:hidden">{p.scheduledDate instanceof Date ? `${p.scheduledDate.getHours()}:${p.scheduledDate.getMinutes().toString().padStart(2, '0')}` : ''}</span>
                     {p.client ? ` • ${p.client}` : ''}
                   </button>
                 ))}
               </div>
               <button onClick={() => onEdit({ scheduledDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), day, 9, 0).toISOString() })} title="Add Thread" aria-label="Add Thread" className="absolute top-1 right-1 sm:top-2 sm:right-2 p-1 text-slate-300 hover:text-indigo-600 transition-all [@media(pointer:fine)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"><Plus size={12}/></button>
             </div>
           );
        })}
      </div>
    </div>
  );
});

export default CalendarView;