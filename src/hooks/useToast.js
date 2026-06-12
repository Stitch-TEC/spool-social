import { useState, useCallback } from 'react';

/**
 * Toast state. Dismissal timing is owned by the <Toast> component itself
 * (re-armed per message) so consecutive toasts each get full display time.
 */
export default function useToast() {
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
  }, []);

  const hideToast = useCallback(() => setToast(null), []);

  return { toast, showToast, hideToast };
}
