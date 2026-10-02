import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { flushSync } from 'react-dom';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({
  auth: null, currentUser: null, revision: 1, posts: [], postsError: null, postsLoading: false,
  editor: null, documents: new Map(), writes: [], creates: [], reads: 0,
  host: vi.fn(), retry: null,
}));
vi.mock('./config/firebase', () => ({
  db: { app: { options: { projectId: 'demo-spool' } } },
  auth: { get currentUser() { return state.currentUser; } },
}));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: state.postsLoading, error: state.postsError }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [{ name: 'Acme', slug: 'acme' }], loading: false }) }));
vi.mock('./utils/generationApi', () => ({
  ensureHostedImage: (...args) => state.host(...args), pushToSender: vi.fn(), publishToSite: vi.fn(),
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db, path) => ({ path }),
  doc: (_db, _path, id) => ({ id }),
  addDoc: async (_ref, data) => { state.creates.push(data); return { id: 'created' }; },
  updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(),
  runTransaction: async (_db, callback) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const writes = [];
      await callback({
        get: async ref => {
          state.reads++;
          return { exists: () => state.documents.has(ref.id), data: () => ({ ...state.documents.get(ref.id) }) };
        },
        update: (ref, patch) => writes.push({ id: ref.id, patch }),
      });
      if (attempt === 0 && state.retry) { state.retry(); continue; }
      for (const write of writes) {
        state.documents.set(write.id, { ...state.documents.get(write.id), ...write.patch });
        state.writes.push(write);
      }
      return;
    }
  },
}));
vi.mock('./components/DashboardHeader', () => ({ default: ({ onNew }) => <button onClick={onNew}>New fixture thread</button> }));
vi.mock('./components/PostGrid', () => ({ default: ({ posts, onEdit }) => <section>{posts.map(post => <button key={post.id} onClick={() => onEdit(post)}>Open {post.id}</button>)}</section> }));
vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/DensityToggle', () => ({ default: () => null }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
vi.mock('./components/Editor', () => ({ default: props => {
  state.editor = props;
  return <section aria-label="Fixture editor">
    <p>{props.readOnlyReason}</p>
    {!props.isReadOnly && <button>Save fixture</button>}
  </section>;
} }));

const base = (id = 'one', fields = {}) => ({
  id, uid: OPERATOR_UID, clientId: 'acme', client: 'Acme', content: 'Original content',
  platform: 'linkedin', status: 'draft', reviewStage: 'in_review', approvalStatus: 'pending',
  scheduledDate: null, tags: [], isTemplate: false, imageUrl: '', title: '',
  altText: '', metaDescription: '', feedback: '', slug: '',
  createdAt: '2026-10-01T19:00:00.000Z', updatedAt: '2026-10-01T19:00:00.000Z',
  ...fields,
});
const populate = posts => {
  state.posts = posts;
  state.documents = new Map(posts.map(({ id, ...data }) => [id, data]));
};
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const open = async (id = 'one') => {
  fireEvent.click(screen.getByRole('button', { name: `Open ${id}` }));
  await screen.findByRole('region', { name: 'Fixture editor' });
  return state.editor;
};
const context = editor => ({
  isCurrentSession: editor.isSessionCurrent,
  baselineStatus: 'draft', baselineClientId: 'acme', baselineClient: 'Acme',
});
const dispatch = async (editor, form = {}, ctx = {}) => {
  let result;
  await act(async () => { result = await editor.onSave({ ...base(), content: 'Updated content', ...form }, { ...context(editor), ...ctx }); });
  return result;
};

beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/');
  state.revision = 1; state.currentUser = { uid: 'member-one', email: 'member@example.test', isAnonymous: false };
  state.auth = { user: state.currentUser, authRevision: 1, getAuthRevision: () => state.revision,
    authLoading: false, role: 'client', clientId: 'acme', isReadOnly: false, isOperator: false, isClientMember: true };
  populate([base()]); state.postsError = null; state.postsLoading = false; state.editor = null;
  state.writes = []; state.creates = []; state.reads = 0; state.retry = null;
  state.host.mockReset(); state.host.mockImplementation(async image => image);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network allowed'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('App current member edit admission', () => {
  it('wires a scoped draft to editable mode and passes session-bound media/default-platform props', async () => {
    render(<App />); const editor = await open();
    expect(editor.isReadOnly).toBe(false); expect(editor.readOnlyReason).toBe('');
    expect(editor.initialPlatform).toBe('linkedin');
    expect(editor.mediaSessionKey).toContain('member-one');
    expect(editor.isSessionCurrent()).toBe(true);
    const result = await dispatch(editor);
    expect(result).toMatchObject({ ok: true, post: { id: 'one', content: 'Updated content', clientId: 'acme' } });
    expect(state.writes).toHaveLength(1);
  });

  it.each([
    ['posted', { status: 'posted' }, /Posted threads are read-only/],
    ['legacy owner', { uid: 'legacy-owner' }, /Stitch TEC needs to check/],
    ['legacy enum', { approvalStatus: 'legacy' }, /Stitch TEC needs to check/],
  ])('opens %s in read-only mode and guards a directly invoked save before image hosting', async (_name, fields, message) => {
    populate([base('one', fields)]); render(<App />); const editor = await open();
    expect(editor.isReadOnly).toBe(true); expect(screen.queryByText('Save fixture')).toBeNull();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(editor.isSessionCurrent()).toBe(false);
    expect(await dispatch(editor)).toBe(false);
    expect(state.host).not.toHaveBeenCalled(); expect(state.writes).toHaveLength(0); expect(state.reads).toBe(0);
  });

  it('uses the current row for capability but retains the opened form baseline after it becomes posted', async () => {
    const app = render(<App />); const original = await open();
    state.posts = [base('one', { status: 'posted', content: 'New snapshot' })]; app.rerender(<App />);
    expect(state.editor.isReadOnly).toBe(true);
    expect(state.editor.post).toBe(original.post);
    expect(original.isSessionCurrent()).toBe(false);
    expect(await dispatch(original)).toBe(false);
    expect(state.host).not.toHaveBeenCalled();
  });

  it.each(['missing', 'failed'])('makes an existing editor read-only when its subscriber row is %s', async kind => {
    const app = render(<App />); const original = await open();
    if (kind === 'missing') state.posts = [];
    else state.postsError = new Error('synthetic read failure');
    app.rerender(<App />);
    expect(state.editor.isReadOnly).toBe(true);
    expect(screen.getByText(/Return to the client list/)).toBeInTheDocument();
    expect(original.isSessionCurrent()).toBe(false);
    expect(await dispatch(original)).toBe(false); expect(state.host).not.toHaveBeenCalled();
  });

  it('refuses an old callback as soon as the synchronous auth revision advances, before a render', async () => {
    render(<App />); const editor = await open(); state.revision++;
    expect(editor.isSessionCurrent()).toBe(false);
    expect(await dispatch(editor)).toBe(false); expect(state.host).not.toHaveBeenCalled();
  });

  it.each(['role', 'tenant', 'account'])('retires an old save callback on a rendered %s change', async kind => {
    const app = render(<App />); const editor = await open();
    if (kind === 'role') state.auth = { ...state.auth, role: 'super_admin', isOperator: true, isClientMember: false };
    else if (kind === 'tenant') state.auth = { ...state.auth, clientId: 'foreign' };
    else { state.currentUser = { uid: 'other', email: 'other@example.test' }; state.auth = { ...state.auth, user: state.currentUser }; }
    app.rerender(<App />);
    expect(editor.isSessionCurrent()).toBe(false);
    expect(await dispatch(editor)).toBe(false); expect(state.host).not.toHaveBeenCalled(); expect(state.writes).toHaveLength(0);
  });

  it.each([
    { tags: ['x'.repeat(21)] }, { tags: Array.from({ length: 11 }, (_, i) => `tag${i}`) },
    { tags: ['same', 'same'] }, { platform: 'unknown' }, { status: 'posted' },
  ])('rejects invalid member input before hosting or transaction: %j', async fields => {
    render(<App />); const editor = await open();
    expect(await dispatch(editor, fields)).toBe(false);
    expect(state.host).not.toHaveBeenCalled(); expect(state.reads).toBe(0); expect(state.writes).toHaveLength(0);
  });

  it('does not begin a transaction after account change during image preparation', async () => {
    const pending = deferred(); state.host.mockReturnValue(pending.promise);
    render(<App />); const editor = await open();
    let result; const saving = act(async () => { result = await editor.onSave({ ...base(), content: 'Changed' }, context(editor)); });
    await waitFor(() => expect(state.host).toHaveBeenCalledTimes(1));
    state.currentUser = { uid: 'different', email: 'different@example.test' };
    pending.resolve(''); await saving;
    expect(result).toBe(false); expect(state.reads).toBe(0); expect(state.writes).toHaveLength(0);
  });

  it('does not begin a transaction after the current row becomes posted during image preparation', async () => {
    const pending = deferred(); state.host.mockReturnValue(pending.promise);
    const app = render(<App />); const editor = await open();
    let result; const saving = act(async () => { result = await editor.onSave({ ...base(), content: 'Changed' }, context(editor)); });
    await waitFor(() => expect(state.host).toHaveBeenCalledTimes(1));
    state.posts = [base('one', { status: 'posted' })]; flushSync(() => app.rerender(<App />));
    pending.resolve(''); await saving;
    expect(result).toBe(false); expect(state.reads).toBe(0); expect(state.writes).toHaveLength(0);
  });

  it.each(['role', 'tenant', 'auth loading', 'post loading', 'post error', 'post eligibility'])('does not revive an in-flight save after a rendered %s A→B→A change', async kind => {
    const pending = deferred(); state.host.mockReturnValue(pending.promise);
    const app = render(<App />); const editor = await open();
    const originalAuth = state.auth; const originalPosts = state.posts;
    let result;
    // Omit the editor-supplied session callback to exercise App's independent
    // initiating-admission epoch, not just the Editor callback lifetime guard.
    const saving = act(async () => { result = await editor.onSave({ ...base(), content: 'Changed' }, {
      baselineStatus: 'draft', baselineClientId: 'acme', baselineClient: 'Acme',
    }); });
    await waitFor(() => expect(state.host).toHaveBeenCalledTimes(1));
    if (kind === 'role') state.auth = { ...state.auth, role: 'super_admin', isOperator: true, isClientMember: false };
    else if (kind === 'tenant') state.auth = { ...state.auth, clientId: 'foreign' };
    else if (kind === 'auth loading') state.auth = { ...state.auth, authLoading: true };
    else if (kind === 'post loading') state.postsLoading = true;
    else if (kind === 'post error') state.postsError = new Error('synthetic read failure');
    else state.posts = [base('one', { status: 'posted' })];
    flushSync(() => app.rerender(<App />));
    state.auth = originalAuth; state.posts = originalPosts; state.postsLoading = false; state.postsError = null;
    flushSync(() => app.rerender(<App />));
    pending.resolve(''); await saving;
    expect(result).toBe(false); expect(state.reads).toBe(0); expect(state.writes).toHaveLength(0);
  });

  it('does not retire an in-flight save for an ordinary same-eligibility approval snapshot', async () => {
    const pending = deferred(); state.host.mockReturnValue(pending.promise);
    const app = render(<App />); const editor = await open();
    let result; const saving = act(async () => { result = await editor.onSave({ ...base(), content: 'Changed' }, context(editor)); });
    await waitFor(() => expect(state.host).toHaveBeenCalledTimes(1));
    const newer = base('one', { approvalStatus: 'approved', updatedAt: '2026-10-02T19:00:00.000Z', feedback: 'Approved by reviewer' });
    state.posts = [newer];
    const { id: _id, ...document } = newer; state.documents.set('one', document);
    flushSync(() => app.rerender(<App />));
    expect(editor.isSessionCurrent()).toBe(true);
    pending.resolve(''); await saving;
    expect(result).toMatchObject({ ok: true, post: { content: 'Changed', approvalStatus: 'pending' } });
    expect(state.writes).toHaveLength(1);
  });

  it.each([
    { clientId: 'foreign' }, { uid: 'foreign-owner' }, { status: 'posted' }, { reviewStage: 'private' },
  ])('rechecks the actual transaction row even when the list is stale: %j', async fields => {
    render(<App />); const editor = await open();
    state.documents.set('one', { ...state.documents.get('one'), ...fields });
    expect(await dispatch(editor)).toBe(false);
    expect(state.reads).toBe(1); expect(state.writes).toHaveLength(0);
  });

  it.each(['row', 'actor'])('rechecks %s admission on a transaction retry without committing first-attempt writes', async kind => {
    render(<App />); const editor = await open();
    state.retry = () => {
      if (kind === 'row') state.documents.set('one', { ...state.documents.get('one'), status: 'posted' });
      else state.revision++;
    };
    expect(await dispatch(editor)).toBe(false); expect(state.writes).toHaveLength(0);
  });

  it('allows a newly acknowledged member identity before the listener sees it, but still verifies the transaction', async () => {
    populate([]); render(<App />); fireEvent.click(screen.getByRole('button', { name: 'New fixture thread' }));
    await screen.findByRole('region', { name: 'Fixture editor' });
    const editor = state.editor; const savedPost = base('fresh');
    const { id: _id, ...document } = savedPost; state.documents.set('fresh', document);
    const result = await dispatch(editor, { id: 'fresh' }, { savedPost });
    expect(result).toMatchObject({ ok: true, post: { id: 'fresh', content: 'Updated content' } });
    expect(state.reads).toBe(1); expect(state.writes).toHaveLength(1);
  });

  it('does not adopt a stale returned baseline when an existing editor row disappears', async () => {
    const app = render(<App />); const editor = await open();
    state.posts = []; app.rerender(<App />);
    expect(await dispatch(editor, {}, { savedPost: base() })).toBe(false);
    expect(state.host).not.toHaveBeenCalled(); expect(state.writes).toHaveLength(0);
  });

  it('preserves operator posted-thread editing while keeping the unchanged real transaction path', async () => {
    state.auth = { ...state.auth, role: 'super_admin', isOperator: true, isClientMember: false };
    populate([base('one', { status: 'posted' })]); render(<App />); const editor = await open();
    expect(editor.isReadOnly).toBe(false);
    expect(await dispatch(editor, { status: 'posted' }, { baselineStatus: 'posted' })).toMatchObject({ ok: true });
    expect(state.writes).toHaveLength(1);
  });
});
