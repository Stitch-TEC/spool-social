import { useLayoutEffect, useMemo, useRef } from 'react';

// A request remains valid only in its original mounted editor/context, even
// after A -> B -> A switches. Cancellation invalidates results, not provider
// billing, and cannot undo a write already submitted to the server.
export default function useAsyncRequest(context) {
  const state = useRef({ context, epoch: 0, mounted: true, active: new Map() });
  useLayoutEffect(() => {
    const s = state.current;
    s.context = context;
    s.mounted = true;
    return () => {
      s.mounted = false;
      s.epoch += 1;
      s.active.clear();
    };
  }, [context]);
  return useMemo(() => ({
    begin(kind = 'generation') {
      const s = state.current;
      if (!s.mounted || s.active.has(kind)) return null;
      const token = { epoch: s.epoch, context: s.context, kind };
      s.active.set(kind, token);
      return token;
    },
    current(token) {
      const s = state.current;
      return !!token && s.mounted && token.epoch === s.epoch
        && token.context === s.context && s.active.get(token.kind) === token;
    },
    finish(token) {
      if (state.current.active.get(token?.kind) === token) state.current.active.delete(token.kind);
    },
    cancel() {
      state.current.epoch += 1;
      state.current.active.clear();
    },
  }), []);
}
