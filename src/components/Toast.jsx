import React, { useEffect } from 'react';
import { CheckCircle, AlertCircle } from 'lucide-react';

const Toast = ({ message, type = 'success', onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed bottom-6 right-6 px-6 py-3 rounded-lg shadow-lg text-white transform transition-all duration-300 flex items-center gap-2 z-[60] ${
      type === 'success' ? 'bg-indigo-900' : 'bg-rose-900'
    }`}>
      {type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
      <span className="font-medium">{message}</span>
    </div>
  );
};

export default Toast;