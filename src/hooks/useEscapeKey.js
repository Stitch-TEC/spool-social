import { useEffect } from 'react';

/** Calls `onEscape` when the Escape key is pressed (for dismissing modals). */
export default function useEscapeKey(onEscape) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onEscape?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onEscape]);
}
