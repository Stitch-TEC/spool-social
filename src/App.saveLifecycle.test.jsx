import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { recoveryScope } from './utils/editorRecovery';
import { intentIndexedDB } from './test/intentIndexedDB';
const recoveryKey = slot => recoveryScope({ principalId: 'operator-test', clientId: 'acme', postId: slot === 'new' ? null : slot }).key;

// Keep the App → Editor → postSave boundary real. Only the navigation shell,
// subscriptions and Firebase transport are replaced; no save callback is faked.
const state = vi.hoisted(() => ({
  posts: [],
  clientMap: {},
  clients: [{ name: 'Acme', slug: 'acme' }],
  auth: {
    user: { uid: 'operator-test', email: 'operator@example.test' },
    authLoading: false,
    isReadOnly: false,
    isOperator: true,
    isClientMember: false,
    role: 'super_admin',
  },
  documents: new Map(),
  creates: [],
  updates: [],
  transactions: [],
  transactionCommit: null,
  idb: null,
  restReads: [],
  forbiddenRequests: [],
  readStatus: null,
  liveAuthRevision: 1,
}));

vi.mock('./config/firebase', () => ({
  db: { app: { options: { projectId: 'demo-spool' } } },
  auth: { get currentUser() { return state.auth.user; } },
}));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({
  default: () => ({ posts: state.posts, clientMap: state.clientMap, isLoading: false }),
}));
vi.mock('./hooks/useClients', () => ({
  useClients: () => ({ clients: state.clients, loading: false }),
}));
vi.mock('firebase/firestore', () => ({
  collection: (_db, path) => ({ path }),
  doc: (_db, path, id) => ({ path: `${path}/${id}`, id }),
  addDoc: async (_ref, data) => {
    const result = await new Promise((resolve, reject) => {
      state.creates.push({ data, resolve, reject, transport: 'sdk' });
    });
    state.documents.set(result.id, { ...data });
    return result;
  },
  runTransaction: async (_db, callback) => {
    const writes = [];
    await callback({
      get: async (ref) => ({
        exists: () => state.documents.has(ref.id),
        data: () => ({ ...state.documents.get(ref.id) }),
      }),
      update: (ref, patch) => writes.push({ id: ref.id, patch }),
    });
    state.transactions.push(writes);
    if (state.transactionCommit) await state.transactionCommit.promise;
    for (const write of writes) {
      state.documents.set(write.id, { ...state.documents.get(write.id), ...write.patch });
      state.updates.push(write);
    }
  },
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  writeBatch: vi.fn(),
}));
vi.mock('./components/DashboardHeader', () => ({
  default: ({ onNew }) => <button onClick={onNew}>New test thread</button>,
}));
vi.mock('./components/PostGrid', () => ({
  default: ({ posts, onEdit, onDuplicate }) => (
    <div aria-label="Thread grid">
      {posts.map((post) => (
        <div key={post.id}>
          <button onClick={() => onEdit(post)}>Edit {post.id}</button>
          <button onClick={() => onDuplicate(post)}>Duplicate {post.id}</button>
        </div>
      ))}
    </div>
  ),
}));
vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/DensityToggle', () => ({ default: () => null }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));

const post = (id, content) => ({
  id, content, client: 'Acme', clientId: 'acme', platform: 'gmb',
  status: 'draft', approvalStatus: 'pending', reviewStage: 'private',
  imageUrl: '', tags: [], feedback: '',
  createdAt: '2026-09-21T12:00:00.000Z', updatedAt: '2026-09-21T12:00:00.000Z',
  scheduledDate: '2026-09-23T12:00:00.000Z',
});

const editorContent = () => document.querySelector('textarea');
const changeContent = (value) => fireEvent.change(editorContent(), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
const recovery = () => Object.fromEntries(
  Object.keys(window.localStorage)
    .filter((key) => key.startsWith('spool:autosave:'))
    .map((key) => [key, window.localStorage.getItem(key)]),
);
const journalEntries = () => [...state.idb.rows.values()];
const journalRecord = (principal = 'operator-test', client = 'acme') => journalEntries()
  .find(record => record.scope.principalId === principal && record.scope.clientId === client);
const user = (uid = 'operator-test') => ({ uid, email: `${uid}@example.test`, isAnonymous: false, getIdToken: vi.fn().mockResolvedValue('synthetic-id-token') });
const deferred = () => {
  const value = {};
  value.promise = new Promise((resolve, reject) => Object.assign(value, { resolve, reject }));
  return value;
};
const encode = value => typeof value === 'string' ? { stringValue: value }
  : typeof value === 'boolean' ? { booleanValue: value }
    : { arrayValue: { values: value.map(encode) } };
const decode = value => 'stringValue' in value ? value.stringValue
  : 'booleanValue' in value ? value.booleanValue : (value.arrayValue.values || []).map(decode);
const restDocument = (id, data) => ({
  name: `projects/demo-spool/databases/(default)/documents/posts/${id}`,
  fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encode(value)])),
});
const waitForWork = async (content, principal, client) => waitFor(() => expect(journalRecord(principal, client)?.work.content).toBe(content));

function fakeFirestoreRequest(url, options = {}) {
  const base = 'https://firestore.googleapis.com/v1/projects/demo-spool/databases/(default)/documents/posts';
  const parsed = new URL(url, 'https://spool.example.test');
  if (parsed.origin === 'https://firestore.googleapis.com' && parsed.pathname === new URL(base).pathname && options.method === 'POST') {
    const id = parsed.searchParams.get('documentId');
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(options.headers.Authorization).toBe('Bearer synthetic-id-token');
    const data = Object.fromEntries(Object.entries(JSON.parse(options.body).fields).map(([key, value]) => [key, decode(value)]));
    // Dispatch is permitted only after the REAL journal transaction committed.
    expect(journalEntries().find(record => record.id === id)).toMatchObject({ state: 'submitted', payload: data });
    return new Promise((resolve, reject) => {
      const create = {
        id, data, transport: 'rest', reject,
        commit() {
          if (state.documents.has(id)) throw new Error('Fixture refuses destructive create overwrite');
          state.documents.set(id, structuredClone(data));
        },
        resolve() {
          create.commit();
          resolve({ ok: true, status: 200, json: async () => restDocument(id, state.documents.get(id)) });
        },
      };
      state.creates.push(create);
    });
  }
  if (url.startsWith(`${base}/`) && options.method === 'GET') {
    const id = decodeURIComponent(url.slice(base.length + 1));
    state.restReads.push(id);
    const data = state.documents.get(id);
    const status = state.readStatus || (data ? 200 : 404);
    return Promise.resolve({ ok: status === 200, status, json: async () => data ? restDocument(id, data) : {} });
  }
  state.forbiddenRequests.push({ url, method: options.method });
  return Promise.reject(new Error('Unexpected network request in synthetic save-lifecycle test'));
}

async function openNew(content = 'First submitted snapshot') {
  fireEvent.click(screen.getByRole('button', { name: 'New test thread' }));
  await screen.findByText('New Thread');
  const clientInput = screen.queryByPlaceholderText('Select or type a new client...');
  if (clientInput) fireEvent.change(clientInput, { target: { value: 'Acme' } });
  await waitFor(() => expect(screen.queryByText('Checking this device for previous work…')).not.toBeInTheDocument());
  if (content !== null) changeContent(content);
}

async function createPending() {
  save();
  await waitFor(() => expect(state.creates).toHaveLength(1));
  return state.creates[0];
}

async function acknowledge(create, id = 'created-one') {
  await act(async () => { create.resolve({ id }); });
}

async function closeEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
  const discard = screen.queryByRole('button', { name: 'Discard', exact: true });
  if (discard) fireEvent.click(discard);
  await screen.findByRole('button', { name: 'New test thread' });
}

async function restoreNew() {
  await openNew(null);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore previous work' }));
}

describe('App and Editor save lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    state.posts = [post('a', 'Original A'), post('b', 'Original B')];
    state.liveAuthRevision = 1;
    state.auth = { user: user(), authRevision: 1, getAuthRevision: () => state.liveAuthRevision, authLoading: false, isReadOnly: false, isOperator: true, isClientMember: false, role: 'super_admin' };
    state.clientMap = {};
    state.clients = [{ name: 'Acme', slug: 'acme' }];
    state.documents = new Map(state.posts.map(({ id, ...data }) => [id, data]));
    state.creates = [];
    state.updates = [];
    state.transactions = [];
    state.transactionCommit = null;
    state.restReads = [];
    state.forbiddenRequests = [];
    state.readStatus = null;
    state.idb = intentIndexedDB();
    vi.stubGlobal('indexedDB', state.idb);
    // Only invented Firestore documents are served. Optional AI/provider/API
    // calls remain forbidden; the real journal, transport and onSave all run.
    vi.stubGlobal('fetch', vi.fn(fakeFirestoreRequest));
  });

  afterEach(() => {
    cleanup();
    expect(state.forbiddenRequests).toEqual([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('closes the old editor on account change and never restores its recovery into a client member', async () => {
    const app = render(<App />);
    await openNew('Operator-only Acme work');
    expect(window.localStorage.getItem(recoveryKey('new'))).toBeNull();
    await waitForWork('Operator-only Acme work');
    // Cross-tab auth update while the editor is mounted; no navigation/reload.
    state.auth = { user: user('beta-member'), authLoading: false, isReadOnly: false, isOperator: false, isClientMember: true, role: 'client', clientId: 'beta' };
    state.posts = [];
    state.clientMap = { Beta: { name: 'Beta', clientId: 'beta' } };
    state.clients = [];
    app.rerender(<App />);
    expect(screen.queryByText('New Thread')).not.toBeInTheDocument();
    const saved = structuredClone(journalRecord());
    expect(saved.work.content).toBe('Operator-only Acme work');
    fireEvent.click(screen.getByRole('button', { name: 'New test thread' }));
    await screen.findByText('New Thread');
    expect(editorContent()).toHaveValue('');
    await waitFor(() => expect(screen.queryByText('Checking this device for previous work…')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Restore previous work' })).not.toBeInTheDocument();
    expect(journalRecord()).toEqual(saved);
    changeContent('Beta-owned draft');
    const create = await createPending();
    expect(create.data).toMatchObject({ client: 'Beta', clientId: 'beta', content: 'Beta-owned draft', reviewStage: 'in_review' });
    await acknowledge(create, 'beta-created');
    expect(create.transport).toBe('rest');
    expect(create.data).toMatchObject({ status: 'draft', approvalStatus: 'pending', isTemplate: false, feedback: '' });
    expect(create.data.source).toBeUndefined();
  });

  it('drops an existing editor when the same user changes tenant or role', async () => {
    const app = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit a' }));
    await screen.findByText('Edit Thread');
    changeContent('Private unsaved edit');
    state.auth = { ...state.auth, isOperator: false, isClientMember: true, role: 'client', clientId: 'beta' };
    state.posts = [];
    app.rerender(<App />);
    expect(screen.queryByText('Edit Thread')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Private unsaved edit')).not.toBeInTheDocument();
    expect(state.creates).toHaveLength(0);
  });

  it('keeps newer edits and updates the acknowledged create ID before any posts-listener refresh', async () => {
    render(<App />);
    await openNew();
    const create = await createPending();
    changeContent('Newer typing while the first save is pending');
    fireEvent.pageHide(window);
    await waitForWork('Newer typing while the first save is pending');

    await acknowledge(create);
    expect(editorContent()).toHaveValue('Newer typing while the first save is pending');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(window.localStorage.getItem(recoveryKey('new'))).toBeNull();
    expect(journalRecord().work.content).toBe('Newer typing while the first save is pending');
    expect(state.documents.get(create.id).content).toBe('First submitted snapshot');
    expect(state.posts.some((p) => p.id === create.id)).toBe(false);

    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].id).toBe(create.id);
    expect(state.documents.get(create.id)).toMatchObject({
      content: 'Newer typing while the first save is pending',
      clientId: 'acme', client: 'Acme', reviewStage: 'private', approvalStatus: 'pending',
    });
    expect(journalRecord().state).toBe('complete');
  });

  it('retains typing queued in the same React batch as the create acknowledgement', async () => {
    render(<App />);
    await openNew();
    const create = await createPending();
    await act(async () => {
      changeContent('Same-batch newer content');
      create.resolve({ id: 'created-batched' });
    });
    expect(editorContent()).toHaveValue('Same-batch newer content');
    expect(state.documents.get(create.id).content).toBe('First submitted snapshot');
    await waitForWork('Same-batch newer content');
    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.documents.get(create.id).content).toBe('Same-batch newer content');
  });

  it.each(['success', 'rejection'])('leaves a later editor and its recovery untouched after a closed create finishes with %s', async (outcome) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await openNew('Pending A');
    const create = await createPending();
    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit b' }));
    await screen.findByText('Edit Thread');
    changeContent('Unsaved B must survive');
    fireEvent.pageHide(window);
    const snapshotsBeforeASettles = recovery();
    expect(snapshotsBeforeASettles[recoveryKey('b')]).toContain('Unsaved B must survive');
    expect(journalRecord().work.content).toBe('Pending A');

    await act(async () => {
      if (outcome === 'success') create.resolve({ id: 'late-a' });
      else create.reject(new Error('Synthetic save rejection'));
    });
    expect(editorContent()).toHaveValue('Unsaved B must survive');
    expect(screen.getByText('Edit Thread')).toBeInTheDocument();
    expect(recovery()).toEqual(snapshotsBeforeASettles);
    expect(state.documents.get('b').content).toBe('Original B');
    // A response for a closed editor cannot establish UI success. Its durable
    // intent deliberately stays submitted for a later explicit exact-ID check.
    expect(journalRecord().state).toBe('submitted');
    expect(consoleError).toHaveBeenCalledWith('Save Error:', expect.any(Error));
  });

  it('does not close an editor when an earlier grid duplicate finishes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate a' }));
    await waitFor(() => expect(state.creates).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Edit b' }));
    await screen.findByText('Edit Thread');
    changeContent('B opened during grid duplication');
    fireEvent.pageHide(window);
    const before = recovery();

    await acknowledge(state.creates[0], 'duplicated-a');
    expect(editorContent()).toHaveValue('B opened during grid duplication');
    expect(recovery()).toEqual(before);
    expect(state.documents.get('duplicated-a')).toMatchObject({
      content: 'Original A', clientId: 'acme', reviewStage: 'private',
    });
    expect(state.updates).toHaveLength(0);
    expect(state.creates[0].transport).toBe('sdk');
    expect(journalEntries()).toEqual([]);
  });

  it.each(['success', 'rejection'])('ignores a closed existing editor transaction finishing with %s', async (outcome) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const commit = {};
    commit.promise = new Promise((resolve, reject) => Object.assign(commit, { resolve, reject }));
    state.transactionCommit = commit;
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit a' }));
    await screen.findByText('Edit Thread');
    changeContent('A submitted update');
    save();
    await waitFor(() => expect(state.transactions).toHaveLength(1));
    expect(state.documents.get('a').content).toBe('Original A');

    fireEvent.click(screen.getByRole('button', { name: 'Close Editor' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit b' }));
    await screen.findByText('Edit Thread');
    changeContent('B while A transaction is pending');
    fireEvent.pageHide(window);
    const before = recovery();
    await act(async () => {
      if (outcome === 'success') commit.resolve();
      else commit.reject(new Error('Synthetic commit rejection'));
    });

    expect(editorContent()).toHaveValue('B while A transaction is pending');
    expect(recovery()).toEqual(before);
    expect(state.documents.get('a').content).toBe(outcome === 'success' ? 'A submitted update' : 'Original A');
    expect(state.documents.get('b').content).toBe('Original B');
    expect(state.creates).toHaveLength(0);
    if (outcome === 'rejection') expect(consoleError).toHaveBeenCalledWith('Save Error:', expect.any(Error));
    else expect(consoleError).not.toHaveBeenCalled();
  });

  it('reopens a response-lost create, confirms only that ID, then updates newer work without a listener refresh', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = render(<App />);
    await openNew('First remote version');
    const create = await createPending();
    changeContent('Newer local version after dispatch');
    await waitForWork('Newer local version after dispatch');
    await act(async () => { create.commit(); create.reject(new TypeError('Synthetic lost response')); });
    expect(journalRecord()).toMatchObject({ id: create.id, state: 'submitted', payload: { content: 'First remote version' } });
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Discard unsent recovery' })).not.toBeInTheDocument();
    app.unmount();
    render(<App />);
    await restoreNew();
    expect(editorContent()).toHaveValue('Newer local version after dispatch');
    expect(state.creates).toHaveLength(1);
    expect(state.restReads).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Check previous save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
    expect(state.restReads).toEqual([create.id]);
    expect(editorContent()).toHaveValue('Newer local version after dispatch');
    expect(state.posts.some(row => row.id === create.id)).toBe(false);
    expect(state.documents.get(create.id).content).toBe('First remote version');
    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.updates.map(update => update.id)).toEqual([create.id]);
    expect(state.documents.get(create.id).content).toBe('Newer local version after dispatch');
    expect(journalRecord().state).toBe('complete');
  });

  it('links a late acknowledgement after Close to the reopened draft rather than a fresh create', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await openNew('Pending then closed');
    const create = await createPending();
    await closeEditor();
    await acknowledge(create);
    await restoreNew();
    expect(editorContent()).toHaveValue('Pending then closed');
    fireEvent.click(screen.getByRole('button', { name: 'Check previous save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
    changeContent('Follow-up to the same thread');
    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.updates.map(update => update.id)).toEqual([create.id]);
    expect(journalRecord().state).toBe('complete');
  });

  it('retains newer typing through delayed journal retirement, including after reopening the whole app', async () => {
    const retirement = deferred();
    let retiring = false;
    state.idb = intentIndexedDB({
      beforeComplete: ({ rows }) => {
        if (!retiring && [...rows.values()].some(record => record.state === 'complete')) {
          retiring = true;
          return retirement.promise;
        }
      },
    });
    vi.stubGlobal('indexedDB', state.idb);
    const app = render(<App />);
    await openNew('Already saved first version');
    const create = await createPending();
    await acknowledge(create);
    await waitFor(() => expect(retiring).toBe(true));
    expect(journalRecord().state).toBe('confirmed');
    expect(state.documents.get(create.id).content).toBe('Already saved first version');
    changeContent('Typed while final device transaction was pending');
    await act(async () => { retirement.resolve(); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
    expect(editorContent()).toHaveValue('Typed while final device transaction was pending');
    await waitFor(() => expect(journalRecord()).toMatchObject({
      id: create.id, state: 'confirmed', work: { content: 'Typed while final device transaction was pending' },
    }));
    // Checking only the editor would miss loss of durable recovery after the
    // old completion. Reopen against the same committed journal and no posts
    // listener refresh, then verify the final update still targets one ID.
    app.unmount();
    render(<App />);
    await restoreNew();
    expect(editorContent()).toHaveValue('Typed while final device transaction was pending');
    fireEvent.click(screen.getByRole('button', { name: 'Check previous save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.updates.map(update => update.id)).toEqual([create.id]);
    expect(state.documents.get(create.id).content).toBe('Typed while final device transaction was pending');
    expect(journalRecord().state).toBe('complete');
  });

  it.each([403, 404])('does not recreate a possibly committed target when exact-ID checking returns %i', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await openNew('Keep this uncertain copy');
    const create = await createPending();
    await act(async () => { create.commit(); create.reject(new TypeError('Synthetic lost response')); });
    // A deleted target and a moved/private target are indistinguishable from
    // failed creation to some principals. Neither result permits another POST.
    if (status === 404) state.documents.delete(create.id);
    state.readStatus = status;
    await closeEditor();
    await restoreNew();
    fireEvent.click(screen.getByRole('button', { name: 'Check previous save' }));
    await waitFor(() => expect(state.restReads).toEqual([create.id]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check previous save' })).toBeEnabled());
    expect(editorContent()).toHaveValue('Keep this uncertain copy');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(journalRecord()).toMatchObject({ id: create.id, state: 'submitted', work: { content: 'Keep this uncertain copy' } });
    expect(state.creates).toHaveLength(1);
    expect(state.updates).toHaveLength(0);
  });

  it.each(['different user', 'same UID and same user object'])('does not dispatch after a token wait spans %s session change', async (change) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = deferred();
    const originalUser = state.auth.user;
    originalUser.getIdToken.mockReturnValue(token.promise);
    const app = render(<App />);
    await openNew('Bound to original auth session');
    save();
    await waitFor(() => expect(originalUser.getIdToken).toHaveBeenCalledTimes(1));
    expect(state.creates).toHaveLength(0);
    // Auth's revision changes synchronously before React sees the final event.
    // The ABA case deliberately retains object identity as well as the UID.
    state.liveAuthRevision += 2;
    if (change === 'different user') state.auth = { ...state.auth, user: user('replacement') };
    await act(async () => { token.resolve('synthetic-id-token'); });
    expect(state.creates).toHaveLength(0);
    expect(journalRecord()).toMatchObject({ state: 'prepared', work: { content: 'Bound to original auth session' } });
    state.auth = { ...state.auth, authRevision: state.liveAuthRevision };
    app.rerender(<App />);
    expect(screen.queryByText('New Thread')).not.toBeInTheDocument();
    expect(state.updates).toHaveLength(0);
  });

  it('preserves legacy v2 work without offering it as a retry-safe new create', async () => {
    const scope = recoveryScope({ principalId: 'operator-test', clientId: 'acme' });
    const legacy = JSON.stringify({ scope, work: { content: 'Ambiguous older-build work' } });
    window.localStorage.setItem(scope.key, legacy);
    render(<App />);
    await openNew('Intentionally separate new work');
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore previous work' })).not.toBeInTheDocument();
    const create = await createPending();
    await acknowledge(create);
    await screen.findByRole('button', { name: 'New test thread' });
    expect(window.localStorage.getItem(scope.key)).toBe(legacy);
    expect(create.data.content).toBe('Intentionally separate new work');
    expect(journalRecord().state).toBe('complete');
  });

  it('refuses a new remote create when device recovery cannot commit, retaining the current text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.idb = intentIndexedDB({ abortAfterPut: true });
    vi.stubGlobal('indexedDB', state.idb);
    render(<App />);
    await openNew('Keep the only available copy');
    await screen.findByText(/Device recovery could not be committed/);
    save();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled());
    expect(editorContent()).toHaveValue('Keep the only available copy');
    expect(state.creates).toHaveLength(0);
    expect(journalEntries()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeEnabled();
  });

  it('lets an empty never-submitted recovery be explicitly discarded before starting a separate new draft', async () => {
    render(<App />);
    await openNew('An abandoned idea');
    await waitForWork('An abandoned idea');
    changeContent('');
    await waitForWork('');
    const abandonedId = journalRecord().id;
    expect(journalRecord()).toMatchObject({ state: 'draft', payload: null, submittedWork: null });
    await closeEditor();
    await openNew(null);
    expect(await screen.findByRole('button', { name: 'Restore previous work' })).toBeEnabled();
    expect(editorContent()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsent recovery' }));
    expect(screen.getByRole('dialog', { name: 'Discard unsent recovery?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(journalRecord()).toMatchObject({ id: abandonedId, state: 'draft' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsent recovery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsent copy' }));
    await screen.findByRole('button', { name: 'New test thread' });
    expect(journalRecord()).toMatchObject({ id: abandonedId, state: 'discarded' });
    expect(state.creates).toHaveLength(0);
    await openNew('A deliberately separate draft');
    expect(screen.queryByRole('button', { name: 'Restore previous work' })).not.toBeInTheDocument();
    const create = await createPending();
    expect(create.id).not.toBe(abandonedId);
    expect(create.data.content).toBe('A deliberately separate draft');
    await acknowledge(create);
    await screen.findByRole('button', { name: 'New test thread' });
    expect(journalRecord().state).toBe('complete');
    expect(state.creates).toHaveLength(1);
  });

  it('leaves suggestion edits on their existing private unassigned path without publication', async () => {
    state.posts = [{ ...post('suggestion', 'Parked idea'), source: 'suggestion', clientId: '', forClientId: 'acme', isTemplate: false }];
    state.documents = new Map(state.posts.map(({ id, ...data }) => [id, data]));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Review', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit suggestion' }));
    await screen.findByText('Edit Thread');
    changeContent('An edited parked idea, not a published draft');
    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.documents.get('suggestion')).toMatchObject({ source: 'suggestion', clientId: '', forClientId: 'acme', reviewStage: 'private', isTemplate: false, content: 'An edited parked idea, not a published draft' });
    expect(journalEntries()).toEqual([]);
    expect(state.restReads).toHaveLength(0);
    expect(state.creates).toHaveLength(0);
    expect(state.updates.map(update => update.id)).toEqual(['suggestion']);
  });
});
