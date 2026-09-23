// Deterministic transaction model for component/unit fixtures. Browser QA must
// additionally exercise the native IndexedDB implementation; this is not a
// storage-engine conformance test.
export function intentIndexedDB(options = {}) {
  const rows = new Map();
  let tail = Promise.resolve();
  const database = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const requests = [];
      let aborted = false;
      let staged;
      const tx = {
        abort() { aborted = true; },
        objectStore: () => ({
          get(key) { const request = {}; requests.push(() => { request.result = structuredClone(staged.get(key)); request.onsuccess?.(); }); return request; },
          put(value) {
            const request = {};
            requests.push(() => {
              if (options.failPut) { aborted = true; request.onerror?.(); return; }
              staged.set(value.key, structuredClone(value));
              request.onsuccess?.();
              if (options.abortAfterPut) aborted = true;
            });
            return request;
          },
        }),
      };
      tail = tail.then(async () => {
        staged = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
        while (requests.length && !aborted) { requests.shift()(); await Promise.resolve(); }
        if (!aborted) await options.beforeComplete?.({ rows: staged });
        if (aborted) tx.onabort?.();
        else {
          rows.clear();
          for (const [key, value] of staged) rows.set(key, value);
          tx.oncomplete?.();
        }
      });
      return tx;
    },
  };
  return {
    rows,
    open() {
      const request = { result: database };
      queueMicrotask(() => {
        if (options.blocked) request.onblocked?.();
        else if (options.denyOpen) request.onerror?.();
        else request.onsuccess?.();
      });
      return request;
    },
  };
}
