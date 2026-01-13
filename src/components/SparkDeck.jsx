import React from 'react';
import { X, Sparkles, Copy } from 'lucide-react';
import { SPARK_PROMPTS } from '../constants';

const SparkDeck = ({ onClose, onSelect }) => (
  <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[80] flex items-end sm:items-center justify-center p-4">
    <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-10 duration-200">
      <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-indigo-600 rounded-t-2xl text-white">
        <div className="flex items-center gap-2">
          <Sparkles size={20} className="text-yellow-300" />
          <h3 className="font-bold text-lg">Spark Deck</h3>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-white/20 rounded-full transition-colors"><X size={20} /></button>
      </div>
      <div className="p-2 overflow-y-auto bg-slate-50 rounded-b-2xl">
        <div className="grid gap-2 p-2">
          {SPARK_PROMPTS.map((prompt, i) => (
            <button key={i} onClick={() => onSelect(prompt)} className="group text-left p-4 bg-white border border-slate-200 rounded-xl hover:border-indigo-300 hover:shadow-md hover:translate-x-1 transition-all flex justify-between items-center">
              <span className="text-slate-700 text-sm font-medium pr-4">{prompt}</span>
              <Copy size={14} className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </div>
    </div>
  </div>
);

export default SparkDeck;