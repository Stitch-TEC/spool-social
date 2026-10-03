import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({ auth: {}, user: null, revision: 1, posts: [], server: null,
  loading: false, error: null, stalled: false, grid: null, runs: 0, writes: [], read: null, commit: null, invalidRef: false }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'demo-spool-archive' } } },
  auth: { get currentUser() { return state.user; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {},
  isLoading: state.loading, error: state.error, isStalled: state.stalled }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [{ name: 'Acme', slug: 'acme' }], loading: false }) }));
vi.mock('firebase/firestore', () => ({
  collection: (_db, path) => ({ path }), doc: (_db, _path, id) => {
    if (state.invalidRef) throw new Error('Invalid synthetic document reference');
    return { id };
  }, addDoc: vi.fn(),
  updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(),
  runTransaction: async (_db, callback) => {
    state.runs += 1;
    const writes = [];
    await callback({ get: async () => state.read ? state.read() : ({ exists: () => state.server !== null, data: () => state.server }),
      update: (ref, patch) => { writes.push({ ref, patch }); state.writes.push({ ref, patch }); } });
    if (state.commit) await state.commit();
    for (const { patch } of writes) state.server = { ...state.server, ...patch };
  },
}));
vi.mock('./components/PostGrid', () => ({ default: props => { state.grid = props; return <div>Fixture threads</div>; } }));
vi.mock('./components/Sidebar', () => ({ default: props => <button onClick={() => props.onShowArchived(true)}>Archived fixture</button> }));
vi.mock('./components/DashboardHeader', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
const post = patch => ({ id: 'synthetic-thread', uid: OPERATOR_UID, clientId: 'acme', client: 'Acme',
  content: 'Exact synthetic caption', title: '', imageUrl: '/media/keep.png', platform: 'linkedin',
  status: 'draft', approvalStatus: 'approved', feedback: 'Keep feedback', feedbackThread: [{ text: 'Keep history', by: 'client' }],
  reviewStage: 'in_review', tags: ['keep'], scheduledDate: null,
  createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z', ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/');
  state.user = { uid: OPERATOR_UID, email: 'owner@example.test' }; state.revision = 1;
  state.auth = { user: state.user, authRevision: 1, getAuthRevision: () => state.revision, role: 'super_admin',
    isOperator: true, isClientMember: false, isReadOnly: false, authLoading: false, clientId: null };
  state.posts = [post()]; state.server = post(); state.loading = false; state.error = null; state.stalled = false;
  state.grid = null; state.runs = 0; state.writes = []; state.read = null; state.commit = null; state.invalidRef = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network in archive QA'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual App operator archive lifetime', () => {
  it.each(['draft', 'scheduled', 'posted'])('confirms a fresh ordinary %s archive with no content/date/review reset', async status => {
    state.posts = [post({ status })]; state.server = post({ status });
    const before = structuredClone(state.server); render(<App />);
    await act(async () => { expect(await state.grid.onArchive('synthetic-thread')).toBe(true); });
    expect(state.runs).toBe(1); expect(state.writes[0].patch.status).toBe('archived');
    expect(Object.keys(state.writes[0].patch).sort()).toEqual(['status', 'updatedAt']);
    expect(state.server).toEqual({ ...before, ...state.writes[0].patch });
    expect(screen.getByText('Thread archived')).toBeInTheDocument();
  });
  it('restores archived to Draft without forging new approval or clearing a schedule', async () => {
    state.posts = [post({ status: 'archived', scheduledDate: '2026-10-10T12:00:00.000Z' })]; state.server = { ...state.posts[0] };
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Archived fixture' }));
    await act(async () => { expect(await state.grid.onRestore('synthetic-thread')).toBe(true); });
    expect(state.server).toMatchObject({ status: 'draft', approvalStatus: 'approved', scheduledDate: '2026-10-10T12:00:00.000Z' });
    expect(screen.getByText('Thread restored to drafts')).toBeInTheDocument();
  });
  it.each(['client', 'client_admin'])('keeps %s controls absent and refuses a captured operator action', async role => {
    const app = render(<App />), captured = state.grid.onArchive;
    state.auth = { ...state.auth, role, isOperator: false, isClientMember: true, clientId: 'acme' }; app.rerender(<App />);
    expect(state.grid.onArchive).toBeUndefined(); expect(state.grid.onRestore).toBeUndefined();
    await act(async () => { expect(await captured('synthetic-thread')).toBe(false); }); expect(state.runs).toBe(0);
  });
  it.each(['actual-user', 'revision', 'read-loading', 'read-error', 'stalled', 'read-only'])('refuses stale %s before the transaction starts', async change => {
    const app = render(<App />), captured = state.grid.onArchive;
    if (change === 'actual-user') state.user = { ...state.user };
    if (change === 'revision') state.revision += 1;
    if (change === 'read-loading') state.loading = true;
    if (change === 'read-error') state.error = new Error('unconfirmed read');
    if (change === 'stalled') state.stalled = true;
    if (change === 'read-only') state.auth = { ...state.auth, isReadOnly: true };
    app.rerender(<App />);
    await act(async () => { expect(await captured('synthetic-thread')).toBe(false); }); expect(state.runs).toBe(0);
  });
  it('refuses logout/relogin ABA even if the same Firebase user object returns', async () => {
    const app = render(<App />), captured = state.grid.onArchive, sameUser = state.user;
    state.user = null; state.revision = 2; state.auth = { ...state.auth, user: null, authRevision: 2 }; app.rerender(<App />);
    state.user = sameUser; state.revision = 3; state.auth = { ...state.auth, user: sameUser, authRevision: 3 }; app.rerender(<App />);
    await act(async () => { expect(await captured('synthetic-thread')).toBe(false); }); expect(state.runs).toBe(0);
  });
  it('refuses a recovered read epoch even after its error disappears', async () => {
    const app = render(<App />), captured = state.grid.onArchive;
    state.error = new Error('temporary read failure'); app.rerender(<App />);
    state.error = null; app.rerender(<App />);
    await act(async () => { expect(await captured('synthetic-thread')).toBe(false); }); expect(state.runs).toBe(0);
  });
  it.each(['uid', 'clientId', 'client', 'status', 'updatedAt'])('refuses fresh server %s drift while keeping the same post ID', async field => {
    const values = { uid: 'other-owner', clientId: 'beta', client: 'Beta', status: 'posted', updatedAt: '2026-10-03T12:00:01.000Z' };
    render(<App />); state.server = post({ [field]: values[field] });
    await act(async () => { expect(await state.grid.onArchive('synthetic-thread')).toBe(false); });
    expect(state.writes).toHaveLength(0); expect(screen.getByText(/Thread changed.*No change sent/)).toBeInTheDocument();
  });
  it.each(['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'])('refuses freshly added %s null presence', async field => {
    render(<App />); state.server = post({ [field]: null });
    await act(async () => { expect(await state.grid.onArchive('synthetic-thread')).toBe(false); });
    expect(state.writes).toHaveLength(0); expect(screen.getByText(/Review details are read-only.*No change sent/)).toBeInTheDocument();
  });
  it('refuses malformed source revision before any transaction', async () => {
    state.posts = [post({ updatedAt: null })]; render(<App />);
    await act(async () => { expect(await state.grid.onArchive('synthetic-thread')).toBe(false); });
    expect(state.runs).toBe(0); expect(screen.getByText(/Thread details need checking.*No change sent/)).toBeInTheDocument();
  });
  it('refuses an invalid reference before single flight begins, without wedging later valid actions', async () => {
    render(<App />); state.invalidRef = true;
    await act(async () => { expect(await state.grid.onArchive('synthetic-thread')).toBe(false); });
    expect(state.runs).toBe(0); expect(screen.getByText(/Thread reference needs checking.*No change sent/)).toBeInTheDocument();
    expect(screen.queryByText('Updating archive…')).toBeNull();
    expect(state.grid.onArchive).toBeTypeOf('function');
    state.invalidRef = false;
    await act(async () => { expect(await state.grid.onArchive('synthetic-thread')).toBe(true); });
    expect(state.runs).toBe(1);
  });
  it('stops before preparing a write if the account changes while reading the server', async () => {
    const wait = deferred(); state.read = () => wait.promise;
    const app = render(<App />); let attempt;
    await act(async () => { attempt = state.grid.onArchive('synthetic-thread'); });
    state.user = { uid: 'new-owner', email: 'other@example.test' }; state.revision = 2;
    state.auth = { ...state.auth, user: state.user, authRevision: 2 }; app.rerender(<App />);
    await act(async () => { wait.resolve({ exists: () => true, data: () => post() }); expect(await attempt).toBe(false); });
    expect(state.writes).toHaveLength(0); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps immediate single flight while a first transaction awaits confirmation', async () => {
    const wait = deferred(); state.commit = () => wait.promise; render(<App />);
    const captured = state.grid; let attempt;
    await act(async () => { attempt = captured.onArchive('synthetic-thread'); expect(await captured.onArchive('synthetic-thread')).toBe(false); });
    expect(state.runs).toBe(1); expect(state.grid.onArchive).toBeUndefined(); expect(state.grid.onRestore).toBeUndefined();
    expect(screen.getByRole('status')).toHaveTextContent('Updating archive');
    await act(async () => { wait.resolve(); expect(await attempt).toBe(true); });
    expect(state.grid.onArchive).toBeTypeOf('function');
  });
  it('blocks more archive/restore actions after an unconfirmed response, without claiming failure or cancellation', async () => {
    state.commit = async () => { throw new Error('unknown transport result'); };
    render(<App />); const captured = state.grid;
    await act(async () => { expect(await captured.onArchive('synthetic-thread')).toBe(false); });
    expect(screen.getByRole('alert')).toHaveTextContent('Archive or restore needs checking');
    expect(state.grid.onArchive).toBeUndefined(); expect(state.grid.onRestore).toBeUndefined();
    await act(async () => { expect(await captured.onArchive('synthetic-thread')).toBe(false); });
    expect(state.runs).toBe(1); expect(screen.queryByText(/Archive failed|cancelled|try again|Thread archived/i)).toBeNull();
  });
  it.each(['actor', 'role', 'read-epoch'])('retains a generic hold when %s changes after a write was prepared', async change => {
    const wait = deferred(); state.commit = () => wait.promise;
    const app = render(<App />); let attempt;
    await act(async () => { attempt = state.grid.onArchive('synthetic-thread'); });
    if (change === 'actor') {
      state.user = { uid: 'new-owner', email: 'other@example.test' }; state.revision = 2;
      state.auth = { ...state.auth, user: state.user, authRevision: 2 };
    }
    if (change === 'role') state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    if (change === 'read-epoch') { state.error = new Error('temporary'); app.rerender(<App />); state.error = null; }
    app.rerender(<App />);
    await act(async () => { wait.resolve(); expect(await attempt).toBe(false); });
    expect(state.writes).toHaveLength(1); expect(screen.queryByText('Thread archived')).toBeNull();
    if (change === 'role') { state.auth = { ...state.auth, role: 'super_admin', isOperator: true, isClientMember: false, clientId: null }; app.rerender(<App />); }
    expect(screen.getByRole('alert')).toHaveTextContent('Archive or restore needs checking');
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Acme|synthetic-thread|owner@example/);
    expect(state.grid.onArchive).toBeUndefined();
  });
  it('does not announce a late transaction as success after the App unmounts', async () => {
    const wait = deferred(); state.commit = () => wait.promise;
    const app = render(<App />); let attempt;
    await act(async () => { attempt = state.grid.onArchive('synthetic-thread'); });
    app.unmount(); await act(async () => { wait.resolve(); expect(await attempt).toBe(false); });
    expect(state.runs).toBe(1); expect(state.writes).toHaveLength(1);
  });
});
