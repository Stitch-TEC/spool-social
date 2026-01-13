import React from 'react';
import { AlertTriangle, Layers } from 'lucide-react';

const ConfirmModal = ({ title, message, onConfirm, onCancel, type = 'action' }) => (
  <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 animate-in fade-in zoom-in duration-200">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 mx-auto ${type === 'danger' ? 'bg-rose-100 text-rose-600' : 'bg-indigo-100 text-indigo-600'}`}>
         {type === 'danger' ? <AlertTriangle size={24} /> : <Layers size={24} />}
      </div>
      <h3 className="text-lg font-bold text-slate-800 mb-2 text-center">{title}</h3>
      <p className="text-slate-600 text-sm mb-6 text-center">{message}</p>
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 py-2.5 bg-slate-100 text-slate-700 font-medium rounded-xl hover:bg-slate-200 transition-colors">Cancel</button>
        <button onClick={onConfirm} className={`flex-1 py-2.5 text-white font-medium rounded-xl transition-colors ${type === 'danger' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
          {type === 'danger' ? 'Delete' : 'Confirm'}
        </button>
      </div>
    </div>
  </div>
);

export default ConfirmModal;