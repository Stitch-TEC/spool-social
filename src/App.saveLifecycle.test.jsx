import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { recoveryScope } from './utils/editorRecovery';
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
}));

vi.mock('./config/firebase', () => ({ db: {}, auth: { currentUser: null } }));
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
      state.creates.push({ data, resolve, reject });
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

async function openNew(content = 'First submitted snapshot') {
  fireEvent.click(screen.getByRole('button', { name: 'New test thread' }));
  await screen.findByText('New Thread');
  fireEvent.change(screen.getByPlaceholderText('Select or type a new client...'), { target: { value: 'Acme' } });
  changeContent(content);
}

async function createPending() {
  save();
  await waitFor(() => expect(state.creates).toHaveLength(1));
  return state.creates[0];
}

async function acknowledge(create, id = 'created-one') {
  await act(async () => { create.resolve({ id }); });
}

describe('App and Editor save lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    state.posts = [post('a', 'Original A'), post('b', 'Original B')];
    state.auth = { user: { uid: 'operator-test', email: 'operator@example.test' }, authLoading: false, isReadOnly: false, isOperator: true, isClientMember: false, role: 'super_admin' };
    state.clientMap = {};
    state.clients = [{ name: 'Acme', slug: 'acme' }];
    state.documents = new Map(state.posts.map(({ id, ...data }) => [id, data]));
    state.creates = [];
    state.updates = [];
    state.transactions = [];
    state.transactionCommit = null;
    // Network is forbidden in this integration fixture, including optional AI.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network disabled in save-lifecycle test')));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('closes the old editor on account change and never restores its recovery into a client member', async () => {
    const app = render(<App />);
    await openNew('Operator-only Acme work');
    fireEvent.pageHide(window);
    const saved = window.localStorage.getItem(recoveryKey('new'));
    expect(saved).toContain('Operator-only Acme work');
    // Cross-tab auth update while the editor is mounted; no navigation/reload.
    state.auth = { user: { uid: 'beta-member', email: 'beta@example.test' }, authLoading: false, isReadOnly: false, isOperator: false, isClientMember: true, role: 'client', clientId: 'beta' };
    state.posts = [];
    state.clientMap = { Beta: { name: 'Beta', clientId: 'beta' } };
    state.clients = [];
    app.rerender(<App />);
    expect(screen.queryByText('New Thread')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New test thread' }));
    await screen.findByText('New Thread');
    expect(editorContent()).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(recoveryKey('new'))).toBe(saved);
    changeContent('Beta-owned draft');
    const create = await createPending();
    expect(create.data).toMatchObject({ client: 'Beta', clientId: 'beta', content: 'Beta-owned draft', reviewStage: 'in_review' });
    await acknowledge(create, 'beta-created');
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
    expect(window.localStorage.getItem(recoveryKey('new'))).toContain('Newer typing');

    await acknowledge(create);
    expect(editorContent()).toHaveValue('Newer typing while the first save is pending');
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    expect(window.localStorage.getItem(recoveryKey('new'))).toBeNull();
    expect(window.localStorage.getItem(recoveryKey('created-one'))).toContain('Newer typing');
    expect(state.documents.get('created-one').content).toBe('First submitted snapshot');
    expect(state.posts.some((p) => p.id === 'created-one')).toBe(false);

    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].id).toBe('created-one');
    expect(state.documents.get('created-one')).toMatchObject({
      content: 'Newer typing while the first save is pending',
      clientId: 'acme', client: 'Acme', reviewStage: 'private', approvalStatus: 'pending',
    });
    expect(window.localStorage.getItem(recoveryKey('created-one'))).toBeNull();
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
    expect(state.documents.get('created-batched').content).toBe('First submitted snapshot');
    expect(window.localStorage.getItem(recoveryKey('created-batched'))).toContain('Same-batch newer content');
    save();
    await screen.findByRole('button', { name: 'New test thread' });
    expect(state.creates).toHaveLength(1);
    expect(state.documents.get('created-batched').content).toBe('Same-batch newer content');
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
    expect(snapshotsBeforeASettles[recoveryKey('new')]).toContain('Pending A');

    await act(async () => {
      if (outcome === 'success') create.resolve({ id: 'late-a' });
      else create.reject(new Error('Synthetic save rejection'));
    });
    expect(editorContent()).toHaveValue('Unsaved B must survive');
    expect(screen.getByText('Edit Thread')).toBeInTheDocument();
    expect(recovery()).toEqual(snapshotsBeforeASettles);
    expect(state.documents.get('b').content).toBe('Original B');
    if (outcome === 'rejection') expect(consoleError).toHaveBeenCalledWith('Save Error:', expect.any(Error));
    else expect(consoleError).not.toHaveBeenCalled();
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
});
