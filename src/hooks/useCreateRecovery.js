import { useEffect, useRef, useState } from 'react';
import { createJournal, sameValue, workCopy } from '../utils/createJournal';
import { intentRequest } from '../utils/createTransport';

// One editor owns one revision. Never adopt another tab's revision merely to
// make a write succeed; an actual conflict leaves both copies available.
export default function useCreateRecovery({ enabled, scope, getUser, getWork, isAlive }) {
  const journal = useRef(createJournal());
  const session = useRef({ key: null, record: null, loaded: false, restored: true, failed: false, queue: Promise.resolve() });
  const [view, setView] = useState({ loading: enabled, record: null, restored: true, error: '' });
  const mounted = useRef(false);
  const publish = (s, error = '') => {
    if (mounted.current && session.current === s) setView({ loading: !s.loaded, record: s.record, restored: s.restored, error });
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const s = { key: scope?.key, record: null, loaded: false, restored: true, failed: false, queue: Promise.resolve() };
    session.current = s;
    if (!enabled || !scope) { s.loaded = true; publish(s); return; }
    publish(s);
    journal.current.read(scope).then(record => {
      s.record = ['complete', 'discarded'].includes(record?.state) ? null : record;
      s.restored = !s.record;
      s.loaded = true;
      publish(s);
    }).catch(error => { s.loaded = true; s.failed = true; publish(s, error.message); });
    // Scope values are immutable and include the authenticated principal/project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scope?.key]);

  const enqueue = (s, action) => {
    const pending = s.queue.then(action);
    s.queue = pending.catch(() => {});
    return pending.catch(error => { s.failed = true; publish(s, error.message); throw error; });
  };
  const persist = (work) => {
    const s = session.current;
    if (!enabled || !scope || !s.loaded || !s.restored || s.failed || s.key !== scope.key) return Promise.resolve(false);
    const copy = workCopy(work);
    return enqueue(s, async () => {
      if (s.failed) return false;
      s.record = s.record
        ? await journal.current.writeWork(s.record, copy)
        : await journal.current.begin(scope, copy);
      publish(s);
      return true;
    });
  };
  const restore = () => {
    const s = session.current;
    if (!s.record || !s.loaded || s.failed || s.key !== scope?.key) return null;
    s.restored = true;
    publish(s);
    return s.record.work;
  };
  const ready = () => {
    const s = session.current;
    if (!enabled || !scope || s.key !== scope.key || !s.loaded || !s.restored || s.failed) throw new Error('Device recovery is not ready. Restore the previous work if offered, or copy your text before reopening. No new thread was sent.');
    return s;
  };
  const acknowledge = async post => {
    const s = ready();
    await enqueue(s, async () => {
      if (s.failed) throw new Error('The recovery copy changed in another tab. Keep your text for review.');
      s.record = await journal.current.acknowledge(s.record, post);
      publish(s);
    });
  };
  const submit = async (payload, submittedWork, initiatingUser) => {
    const s = ready();
    const maySend = () => isAlive() && session.current === s && getUser() === initiatingUser;
    if (!maySend()) throw new Error('The editor or sign-in changed. No new thread was sent.');
    if (payload.clientId !== scope.clientId || !!payload.isTemplate !== (scope.flow === 'template')) throw new Error('The original client or draft type changed. Reopen the original recovery copy before saving.');
    await enqueue(s, async () => {
      if (!s.record) s.record = await journal.current.begin(scope, submittedWork);
      if (s.record.state === 'draft') s.record = await journal.current.prepare(s.record, payload, submittedWork);
      if (s.record.state !== 'prepared') throw new Error('Spool has not confirmed this save. Use Check previous save; do not create another copy.');
      publish(s);
    });
    // Includes typing/AI/image completions while App was preparing the image.
    await persist(getWork());
    if (s.failed || !maySend()) throw new Error('Device recovery or your session changed. No new request was sent.');
    try {
      const post = await intentRequest({ record: s.record, getUser, maySend, create: true,
        beforeCreate: () => enqueue(s, async () => { s.record = await journal.current.claim(s.record); publish(s); }),
      });
      await acknowledge(post);
      return { post, submitted: s.record.submittedWork };
    } catch (error) { publish(s, error.message); throw error; }
  };
  const check = async () => {
    const s = ready();
    if (!s.record || !['submitted', 'confirmed'].includes(s.record.state)) throw new Error('This copy has not been sent. Use Save to submit its recorded version.');
    try {
      const submitted = s.record.state === 'confirmed' ? s.record.baselineWork : s.record.submittedWork;
      const post = await intentRequest({ record: s.record, getUser, maySend: () => isAlive() && session.current === s });
      await acknowledge(post);
      return { post, submitted };
    } catch (error) { publish(s, error.message); throw error; }
  };
  const complete = async () => {
    const s = ready();
    await enqueue(s, async () => {
      if (s.failed || !s.record) throw new Error('The recovery copy changed. Keep your text and reopen it before continuing.');
      s.record = await journal.current.complete(s.record);
      publish(s);
    });
  };
  const discard = async () => {
    const s = session.current;
    if (!s.loaded || s.failed || !s.record || s.key !== scope?.key) throw new Error('This recovery copy is not ready to discard. Keep your text and reopen it.');
    await enqueue(s, async () => {
      await journal.current.discard(s.record);
      s.record = null; s.restored = true;
      publish(s);
    });
  };
  const stored = (work) => view.record && view.restored && !view.error && sameValue(view.record.work, workCopy(work));
  return { ...view, persist, restore, submit, check, acknowledge, complete, discard, stored };
}
