import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({ user: null, auth: {}, revision: 1, posts: [], rows: new Map(), grid: null, bulk: null,
  loading: false, error: null, stalled: false, runs: 0, reads: [], writes: [], read: null, commit: null,
  serverReads: [], serverRead: null, header: null }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'demo-spool-tags' } } }, auth: { get currentUser() { return state.user; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: state.loading, error: state.error, isStalled: state.stalled }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [{ name: 'Acme', slug: 'acme' }], loading: false }) }));
vi.mock('firebase/firestore', () => ({
  collection: (_db, path) => ({ path }), doc: (_db, _path, id) => ({ id }),
  addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(),
  getDocFromServer: async ref => {
    state.serverReads.push(ref.id);
    return state.serverRead ? state.serverRead(ref) : { id: ref.id, exists: () => state.rows.has(ref.id), data: () => state.rows.get(ref.id) };
  },
  runTransaction: async (_db, callback) => {
    state.runs++; const prepared = [];
    const result = await callback({
      get: async ref => {
        state.reads.push(ref.id);
        return state.read ? state.read(ref) : { exists: () => state.rows.has(ref.id), data: () => state.rows.get(ref.id) };
      },
      update: (ref, patch) => { prepared.push({ ref, patch }); state.writes.push({ ref, patch }); },
    });
    if (state.commit) await state.commit();
    for (const { ref, patch } of prepared) state.rows.set(ref.id, { ...state.rows.get(ref.id), ...patch });
    return result;
  },
}));
vi.mock('./components/PostGrid', () => ({ default: props => { state.grid = props; return <div>Fixture threads</div>; } }));
vi.mock('./components/BulkActionBar', () => ({ default: props => { state.bulk = props; return <div>Fixture bulk</div>; } }));
vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/DashboardHeader', () => ({ default: props => { state.header = props; return null; } }));
vi.mock('./components/CalendarView', () => ({ default: () => <div>Fixture calendar</div> }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
const post = (id = 'a', patch = {}) => ({ id, uid: OPERATOR_UID, client: 'Acme', clientId: 'acme', content: 'Exact caption', platform: 'linkedin',
  status: 'draft', reviewStage: 'in_review', approvalStatus: 'approved', feedback: 'Keep feedback', feedbackThread: [], scheduledDate: null,
  tags: ['keep'], imageUrl: '', title: '', createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z', ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function select() {
  fireEvent.click(screen.getByRole('button', { name: 'Select', exact: true }));
  await act(async () => { state.posts.forEach(row => state.grid.onToggleSelect(row.id)); });
}
beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/');
  state.user = { uid: OPERATOR_UID, email: 'owner@example.test' }; state.revision = 1;
  state.auth = { user: state.user, authRevision: 1, getAuthRevision: () => state.revision, role: 'super_admin',
    isOperator: true, isClientMember: false, isReadOnly: false, authLoading: false, clientId: null };
  state.posts = [post(), post('b')]; state.rows = new Map(state.posts.map(row => [row.id, { ...row }]));
  state.loading = false; state.error = null; state.stalled = false; state.grid = null; state.bulk = null;
  state.runs = 0; state.reads = []; state.writes = []; state.read = null; state.commit = null;
  state.serverReads = []; state.serverRead = null; state.header = null;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live transport in tag QA'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual App bulk tag lifetime', () => {
  it('confirms atomic tags with unchanged content/date/approval and keeps selection', async () => {
    render(<App />); await select(); const before = structuredClone([...state.rows]);
    await act(async () => { expect(await state.bulk.onAddTags(['new'])).toBe(true); });
    expect(state.runs).toBe(1); expect(state.reads).toEqual(['a', 'b']); expect(state.bulk.count).toBe(2);
    for (const [id, prior] of before) expect(state.rows.get(id)).toEqual({ ...prior, ...state.writes.find(write => write.ref.id === id).patch });
    expect(screen.getByText('Updated tags on 2 threads')).toBeInTheDocument();
  });
  it('immediately refuses duplicate Apply while the first acknowledgement is pending', async () => {
    const wait = deferred(); state.commit = () => wait.promise; render(<App />); await select();
    const captured = state.bulk; let pending;
    await act(async () => { pending = captured.onAddTags(['new']); expect(await captured.onAddTags(['new'])).toBe(false); });
    expect(state.runs).toBe(1); expect(state.bulk.disabled).toBe(true);
    await act(async () => { wait.resolve(); expect(await pending).toBe(true); }); expect(state.bulk.disabled).toBe(false);
  });
  it.each(['user', 'revision', 'loading', 'error', 'stalled', 'role', 'selection'])('refuses captured stale %s admission before opening a transaction', async change => {
    const app = render(<App />); await select(); const captured = state.bulk;
    if (change === 'user') state.user = { ...state.user };
    if (change === 'revision') state.revision++;
    if (change === 'loading') state.loading = true;
    if (change === 'error') state.error = new Error('unconfirmed');
    if (change === 'stalled') state.stalled = true;
    if (change === 'role') state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    if (change === 'selection') await act(async () => { state.grid.onToggleSelect('b'); });
    app.rerender(<App />);
    await act(async () => { expect(await captured.onAddTags(['new'])).toBe(false); }); expect(state.runs).toBe(0);
  });
  it('refuses same-user logout/relogin ABA and recovered read errors', async () => {
    const app = render(<App />); await select(); const captured = state.bulk, user = state.user;
    state.user = null; state.auth = { ...state.auth, user: null, authRevision: ++state.revision }; app.rerender(<App />);
    state.user = user; state.auth = { ...state.auth, user, authRevision: ++state.revision }; app.rerender(<App />);
    await act(async () => { expect(await captured.onAddTags(['new'])).toBe(false); }); expect(state.runs).toBe(0);
    const after = state.bulk; state.error = new Error('unconfirmed'); app.rerender(<App />); state.error = null; app.rerender(<App />);
    await act(async () => { expect(await after.onAddTags(['new'])).toBe(false); }); expect(state.runs).toBe(0);
  });
  it('refuses stale, missing or protected rows for the whole selection', async () => {
    const app = render(<App />); await select(); state.rows.set('b', post('b', { reviewMedia: null }));
    await act(async () => { expect(await state.bulk.onAddTags(['new'])).toBe(false); });
    expect(state.writes).toEqual([]); expect(screen.getByText(/No tag changes submitted/)).toBeInTheDocument();
    state.posts = state.posts.filter(row => row.id !== 'b'); app.rerender(<App />);
    await act(async () => { expect(await state.bulk.onAddTags(['new'])).toBe(false); }); expect(state.runs).toBe(1);
  });
  it('retains an uncertainty hold through selection/panel/account changes, without replay', async () => {
    state.commit = async () => { throw new Error('unknown response'); };
    const app = render(<App />); await select(); const captured = state.bulk;
    await act(async () => { expect(await captured.onAddTags(['new'])).toBe(false); });
    expect(state.bulk.disabled).toBe(true); expect(screen.getByRole('alert')).toHaveTextContent('Tag update needs checking');
    await act(async () => { captured.onClear(); });
    // Clear empties the selection but deliberately keeps Select mode active.
    await act(async () => { state.posts.forEach(row => state.grid.onToggleSelect(row.id)); });
    state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' }; app.rerender(<App />);
    state.auth = { ...state.auth, role: 'super_admin', isOperator: true, isClientMember: false, clientId: null }; app.rerender(<App />);
    await act(async () => { expect(await captured.onAddTags(['new'])).toBe(false); expect(await state.bulk.onRemoveTags(['keep'])).toBe(false); });
    expect(state.runs).toBe(1); expect(screen.getByRole('alert')).not.toHaveTextContent(/Acme|owner@example|Caption/);
  });
  it('shows no prior-actor success after a confirmed save retires mid-acknowledgement', async () => {
    const wait = deferred(); state.commit = () => wait.promise;
    const app = render(<App />); await select(); let pending;
    await act(async () => { pending = state.bulk.onAddTags(['new']); });
    state.user = { uid: 'other', email: 'other@example.test' }; state.auth = { ...state.auth, user: state.user, authRevision: ++state.revision }; app.rerender(<App />);
    await act(async () => { wait.resolve(); expect(await pending).toBe(false); });
    expect(screen.queryByText('Updated tags on 2 threads')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Tag update needs checking');
    expect(screen.queryByRole('button', { name: 'Check saved tags' })).toBeNull();
  });
  it('checks the original saved IDs after Clear and view changes, without replay', async () => {
    state.commit = async () => { throw new Error('unknown response'); };
    render(<App />); await select();
    await act(async () => { expect(await state.bulk.onAddTags(['new'])).toBe(false); });
    for (const { ref, patch } of state.writes) state.rows.set(ref.id, { ...state.rows.get(ref.id), ...patch });
    await act(async () => { state.bulk.onClear(); state.header.onViewChange('calendar'); });
    expect(screen.getByText('Fixture calendar')).toBeInTheDocument();
    await act(async () => { state.header.onViewChange('grid'); });
    expect(state.grid.selectedIds.size).toBe(0);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check saved tags' })); });
    expect(state.serverReads).toEqual(['a', 'b']); expect(state.runs).toBe(1);
    expect(screen.queryByText(/Tag update needs checking/)).toBeNull();
    expect(screen.getByText('Saved tags match the original update on 2 threads.')).toBeInTheDocument();
  });
  it('keeps a nonmatching or failed-read hold and blocks duplicate check submissions', async () => {
    state.commit = async () => { throw new Error('unknown'); }; render(<App />); await select();
    await act(async () => { await state.bulk.onAddTags(['new']); });
    const wait = deferred(); state.serverRead = () => wait.promise;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check saved tags' })); });
    expect(screen.getByRole('button', { name: 'Checking saved tags…' })).toBeDisabled();
    expect(state.serverReads).toEqual(['a', 'b']);
    await act(async () => { wait.reject(new Error('offline')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm');
    state.serverRead = null;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check saved tags' })); });
    expect(state.bulk.disabled).toBe(true); expect(state.runs).toBe(1);
  });
  it('retires a check during a read error/account ABA without clearing hold or showing stale detail', async () => {
    state.commit = async () => { throw new Error('unknown'); }; const app = render(<App />); await select();
    await act(async () => { await state.bulk.onAddTags(['new']); });
    for (const { ref, patch } of state.writes) state.rows.set(ref.id, { ...state.rows.get(ref.id), ...patch });
    const wait = deferred(); state.serverRead = ref => wait.promise.then(() => ({ id: ref.id, exists: () => true, data: () => state.rows.get(ref.id) }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check saved tags' })); });
    state.error = new Error('read uncertain'); app.rerender(<App />); state.error = null; app.rerender(<App />);
    await act(async () => { wait.resolve(); });
    expect(screen.getByRole('alert')).toHaveTextContent('Tag update needs checking');
    expect(screen.queryByText(/Saved tags match/)).toBeNull();
    state.serverRead = null;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check saved tags' })); });
    expect(screen.queryByText(/Tag update needs checking/)).toBeNull();
  });
  it('lets a second operator inspect their own receipt while keeping canonical post ownership', async () => {
    state.user = { uid: 'second-super-admin', email: 'second@example.test' };
    state.auth = { ...state.auth, user: state.user };
    state.commit = async () => { throw new Error('unknown'); };
    render(<App />); await select(); await act(async () => { await state.bulk.onAddTags(['new']); });
    for (const { ref, patch } of state.writes) state.rows.set(ref.id, { ...state.rows.get(ref.id), ...patch });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check saved tags' })); });
    expect(state.serverReads).toEqual(['a', 'b']); expect(state.rows.get('a').uid).toBe(OPERATOR_UID);
    expect(screen.getByText(/Saved tags match the original update on 2 threads/)).toBeInTheDocument();
  });
});
