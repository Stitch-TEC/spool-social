import React from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { STATUS } from '../constants';

const CalendarView = ({ posts, currentDate, onDateChange, onEdit }) => {
  const getDaysInMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const getFirstDayOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1).getDay();

  const days = Array.from({ length: getDaysInMonth(currentDate) }, (_, i) => i + 1);
  const padding = Array.from({ length: getFirstDayOfMonth(currentDate) }, (_, i) => i);
  const monthName = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  return (
    <div className="h-full flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-4 flex justify-between items-center border-b border-slate-100 bg-slate-50">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
           <span className="text-indigo-600">📅</span> {monthName}
        </h2>
        <div className="flex gap-1 bg-white rounded-lg border border-slate-200 p-1">
          <button onClick={() => onDateChange(new Date(currentDate.setMonth(currentDate.getMonth() - 1)))} className="p-1.5 hover:bg-slate-100 rounded-md text-slate-600"><ChevronLeft size={18}/></button>
          <button onClick={() => onDateChange(new Date())} className="px-3 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-md">Today</button>
          <button onClick={() => onDateChange(new Date(currentDate.setMonth(currentDate.getMonth() + 1)))} className="p-1.5 hover:bg-slate-100 rounded-md text-slate-600"><ChevronRight size={18}/></button>
        </div>
      </div>
      <div className="grid grid-cols-7 bg-slate-100 gap-px border-b border-slate-200 text-center py-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="text-xs font-bold text-slate-400 uppercase tracking-wider">{d}</div>)}
      </div>
      <div className="flex-1 grid grid-cols-7 bg-slate-200 gap-px overflow-y-auto">
        {padding.map(i => <div key={`pad-${i}`} className="bg-slate-50/50" />)}
        {days.map(day => {
           const dayPosts = posts.filter(p => {
              const d = new Date(p.scheduledDate);
              return d.getDate() === day && d.getMonth() === currentDate.getMonth() && d.getFullYear() === currentDate.getFullYear();
           }).sort((a,b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));

           return (
             <div key={day} className="bg-white min-h-[100px] p-2 hover:bg-slate-50 transition-colors group relative">
               <span className={`text-xs font-bold ${new Date().getDate() === day && new Date().getMonth() === currentDate.getMonth() ? 'bg-indigo-600 text-white w-6 h-6 flex items-center justify-center rounded-full' : 'text-slate-400'}`}>{day}</span>
               <div className="mt-2 space-y-1">
                 {dayPosts.map(p => (
                   <button key={p.id} onClick={() => onEdit(p)} className={`w-full text-left text-[10px] truncate px-1.5 py-1 rounded border-l-2 ${p.status === STATUS.POSTED ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-amber-400 bg-amber-50 text-amber-800'}`}>
                     {new Date(p.scheduledDate).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} {p.client ? `• ${p.client}` : ''}
                   </button>
                 ))}
               </div>
               <button onClick={() => onEdit({ scheduledDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), day, 9, 0).toISOString() })} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-indigo-600 transition-all"><Plus size={14}/></button>
             </div>
           );
        })}
      </div>
    </div>
  );
};

export default CalendarView;