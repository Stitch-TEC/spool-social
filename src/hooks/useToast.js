import { useState, useCallback } from 'react';

/**
 * Toast state. Dismissal timing is owned by the <Toast> component itself
 * (re-armed per message) so consecutive toasts each get full display time.
 */
export default function useToast() {
  const [toast, setToast] = useState(null);

  // `action` is optional: { label, onClick } — e.g. an Undo button.
  const showToast = useCallback((message, type = 'success', action = null) => {
    setToast({ message, type, action });
  }, []);

  const hideToast = useCallback(() => setToast(null), []);

  return { toast, showToast, hideToast };
}
