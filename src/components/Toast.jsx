import React, { useEffect } from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';

const Toast = ({ message, type = 'success', action, onClose }) => {
  // Re-arm the dismiss timer whenever the message changes, so a second toast
  // shown within the window isn't killed early by the first toast's timer.
  // Toasts with an action (e.g. Undo) stay up longer.
  useEffect(() => {
    const timer = setTimeout(onClose, action ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [message, type, action, onClose]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-6 right-6 px-6 py-3 rounded-lg shadow-lg text-white transform transition-all duration-300 flex items-center gap-3 z-[60] ${
        type === 'success' ? 'bg-indigo-900' : 'bg-rose-900'
      }`}
    >
      {type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
      <span className="font-medium">{message}</span>
      {action && (
        <button
          onClick={() => { action.onClick(); onClose(); }}
          className="ml-2 px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 font-bold text-sm transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
};

export default Toast;
