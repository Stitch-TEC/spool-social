// Page-memory accounting only. A dispatched Firestore commit cannot be cancelled
// or safely retried just because its response (or the initiating account) changed.
export async function runImportAttempt({ entries, isCurrent, createBatch, maxOps = 450, maxBytes = 8 * 1024 * 1024 }) {
  let confirmed = 0;
  let dispatched = false;
  let pending = [];
  const stop = (reason) => ({
    status: dispatched ? 'needs_checking' : 'stopped', reason,
    total: entries.length, confirmed,
    unconfirmedIds: pending.map(entry => entry.ref.id),
    notDispatchedIds: entries.slice(confirmed + pending.length).map(entry => entry.ref.id),
    ids: entries.map(entry => entry.ref.id),
  });
  try {
    while (confirmed < entries.length) {
      if (!isCurrent()) return stop('admission_changed');
      const chunk = [];
      let bytes = 0;
      for (let index = confirmed; index < entries.length && chunk.length < maxOps; index += 1) {
        const entry = entries[index];
        if (chunk.length && bytes + entry.size > maxBytes) break;
        chunk.push(entry);
        bytes += entry.size;
      }
      const batch = createBatch();
      chunk.forEach(entry => batch.set(entry.ref, entry.data));
      if (!isCurrent()) return stop('admission_changed');
      // Mark before calling commit: even a synchronous transport exception is
      // not evidence that this submitted batch could not reach the server.
      pending = chunk;
      dispatched = true;
      await batch.commit();
      confirmed += chunk.length;
      pending = [];
      if (!isCurrent()) return stop('admission_changed');
    }
    return { status: 'complete', total: entries.length, confirmed, ids: entries.map(entry => entry.ref.id) };
  } catch (error) {
    return { ...stop(pending.length ? 'unconfirmed_commit' : 'local_failure'), error };
  }
}
