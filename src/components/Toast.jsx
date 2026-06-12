import React, { useEffect } from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';

const Toast = ({ message, type = 'success', onClose }) => {
  // Re-arm the dismiss timer whenever the message changes, so a second toast
  // shown within 3s isn't killed early by the first toast's timer.
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [message, type, onClose]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-6 right-6 px-6 py-3 rounded-lg shadow-lg text-white transform transition-all duration-300 flex items-center gap-2 z-[60] ${
        type === 'success' ? 'bg-indigo-900' : 'bg-rose-900'
      }`}
    >
      {type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
      <span className="font-medium">{message}</span>
    </div>
  );
};

export default Toast;