import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({ auth: {}, firebaseUser: null, revision: 1, posts: [], loading: false,
  error: null, stalled: false, clients: [], modal: null, batches: [], commit: null, ids: 0 }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'demo-spool-import' } } },
  auth: { get currentUser() { return state.firebaseUser; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {},
  isLoading: state.loading, error: state.error, isStalled: state.stalled }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: state.clients, loading: false }) }));
vi.mock('firebase/firestore', () => ({
  collection: (_db, path) => ({ path }),
  doc: (target, _path, id) => target?.path === 'posts' ? { id: `import-${++state.ids}` } : { id: id || 'other' },
  addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), runTransaction: vi.fn(),
  writeBatch: () => {
    const writes = []; state.batches.push(writes);
    return { set: (ref, data) => writes.push({ ref, data }), commit: () => state.commit?.(state.batches.length) };
  },
}));
vi.mock('./components/Sidebar', () => ({ default: props => <button onClick={props.onOpenData}>Open import fixture</button> }));
vi.mock('./components/ImportExportModal', () => ({ default: props => { state.modal = props;
  return <section><button onClick={props.onClose}>Close import fixture</button>{props.importHold && <p>Fixture import held</p>}</section>; } }));
vi.mock('./components/DashboardHeader', () => ({ default: () => null }));
vi.mock('./components/PostGrid', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
const rows = count => Array.from({ length: count }, (_, index) => ({ client: 'Acme', content: `Synthetic draft ${index}`, platform: 'linkedin' }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const open = async () => { fireEvent.click(screen.getByRole('button', { name: 'Open import fixture' })); await screen.findByRole('button', { name: 'Close import fixture' }); return state.modal; };
const invoke = (modal, input = rows(1)) => modal.onImport(input, { admissionKey: modal.getAdmissionKey() });

beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/');
  state.firebaseUser = { uid: OPERATOR_UID, email: 'owner@example.test' }; state.revision = 1;
  state.auth = { user: state.firebaseUser, role: 'super_admin', isOperator: true, isClientMember: false,
    isReadOnly: false, authLoading: false, authRevision: 1, getAuthRevision: () => state.revision, clientId: null };
  state.posts = []; state.clients = [{ name: 'Acme', slug: 'acme' }]; state.loading = false; state.error = null; state.stalled = false;
  state.modal = null; state.batches = []; state.commit = null; state.ids = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network in import QA'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual App import admission and page-memory hold', () => {
  it('writes only new draft/pending private operator data with once-generated IDs', async () => {
    render(<App />); const modal = await open(); let result;
    await act(async () => { result = await invoke(modal, [{ ...rows(1)[0], id: 'old', uid: 'foreign', createdAt: 'old', source: 'old' }]); });
    expect(result).toBe(true); expect(state.ids).toBe(1); expect(state.batches).toHaveLength(1);
    expect(state.batches[0][0]).toMatchObject({ ref: { id: 'import-1' }, data: {
      uid: OPERATOR_UID, clientId: 'acme', client: 'Acme', status: 'draft', approvalStatus: 'pending', feedback: '',
      reviewStage: 'private', scheduledDate: null, source: 'import' } });
    expect(state.batches[0][0].data).not.toHaveProperty('id');
    expect(state.batches[0][0].data.createdAt).not.toBe('old');
  });
  it('pins member drafts to their current tenant and review lane', async () => {
    state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    render(<App />); const modal = await open(); await act(async () => { await invoke(modal, [{ ...rows(1)[0], client: 'Foreign' }]); });
    expect(state.batches[0][0].data).toMatchObject({ client: 'acme', clientId: 'acme', reviewStage: 'in_review', status: 'draft', approvalStatus: 'pending' });
  });
  it('rejects member template reinterpretation before generating IDs', async () => {
    state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    render(<App />); const modal = await open(); await act(async () => { expect(await invoke(modal, [{ ...rows(1)[0], isTemplate: true }])).toBe(false); });
    expect(state.ids).toBe(0); expect(state.batches).toHaveLength(0);
  });
  it.each(['reviewDetailsVersion', 'firstComment', 'reviewMedia', 'reviewDetailsAck', 'reviewMediaLinks'])('refuses whole inputs containing %s presence before IDs', async field => {
    render(<App />); const modal = await open(); await act(async () => { expect(await invoke(modal, [rows(1)[0], { ...rows(1)[0], [field]: null }])).toBe(false); });
    expect(state.ids).toBe(0); expect(state.batches).toHaveLength(0);
  });
  it.each([{ status: 'posted' }, { approvalStatus: 'approved' }, { feedback: 'Prior review' }, { tags: ['x'.repeat(21)] }])('rejects invalid/history input %# before IDs', async patch => {
    render(<App />); const modal = await open(); await act(async () => { expect(await invoke(modal, [{ ...rows(1)[0], ...patch }])).toBe(false); });
    expect(state.ids).toBe(0); expect(state.batches).toHaveLength(0);
  });
  it('refuses unknown operator clients rather than minting a tenant slug', async () => {
    render(<App />); const modal = await open(); await act(async () => { expect(await invoke(modal, [{ ...rows(1)[0], client: 'Unknown' }])).toBe(false); });
    expect(state.ids).toBe(0); expect(state.batches).toHaveLength(0);
  });
  it.each(['firebase-object', 'revision', 'role', 'loading', 'read-error', 'stalled'])('refuses stale preview %s before dispatch', async change => {
    const app = render(<App />); const modal = await open(), key = modal.getAdmissionKey();
    if (change === 'firebase-object') state.firebaseUser = { ...state.firebaseUser };
    if (change === 'revision') state.revision += 1;
    if (change === 'role') { state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' }; app.rerender(<App />); }
    if (change === 'loading') { state.loading = true; app.rerender(<App />); }
    if (change === 'read-error') { state.error = new Error('unconfirmed read'); app.rerender(<App />); }
    if (change === 'stalled') { state.stalled = true; app.rerender(<App />); }
    await act(async () => { expect(await modal.onImport(rows(1), { admissionKey: key })).toBe(false); });
    expect(state.ids).toBe(0); expect(state.batches).toHaveLength(0);
  });
  it('prevents overlapping invocations while the first commit is pending', async () => {
    const wait = deferred(); state.commit = () => wait.promise;
    render(<App />); const modal = await open(); let attempt;
    await act(async () => { attempt = invoke(modal, rows(2)); });
    await act(async () => { expect(await invoke(modal, rows(1))).toBe(false); });
    expect(state.ids).toBe(2); expect(state.batches).toHaveLength(1);
    await act(async () => { wait.resolve(); expect(await attempt).toBe(true); });
  });
  it.each(['firebase-object', 'revision', 'role', 'tenant', 'read-error', 'loading', 'mapping'])('stops after a pending commit when %s changes, retaining a hold', async change => {
    const wait = deferred(); state.commit = count => count === 1 ? wait.promise : undefined;
    const app = render(<App />); const modal = await open(); let attempt;
    await act(async () => { attempt = invoke(modal, rows(451)); });
    await waitFor(() => expect(state.batches[0]).toHaveLength(450));
    if (change === 'firebase-object') state.firebaseUser = { ...state.firebaseUser };
    if (change === 'revision') state.revision += 1;
    if (change === 'role') state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    if (change === 'tenant') state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'beta' };
    if (change === 'read-error') state.error = new Error('unconfirmed read');
    if (change === 'loading') state.loading = true;
    if (change === 'mapping') state.clients = [{ name: 'Acme', slug: 'different-tenant' }];
    app.rerender(<App />);
    await act(async () => { wait.resolve(); expect(await attempt).toBe(false); });
    expect(state.batches).toHaveLength(1); expect(state.ids).toBe(451);
    expect(state.modal.importHold).toMatchObject({ status: 'needs_checking', confirmed: 450, unconfirmedIds: [], notDispatchedIds: ['import-451'] });
    await act(async () => { expect(await invoke(state.modal, rows(1))).toBe(false); });
    expect(state.batches).toHaveLength(1);
    expect(screen.queryByText('Imported 451 threads')).toBeNull();
  });
  it('retains a first-batch unknown hold across closing and reopening the modal', async () => {
    state.commit = async () => { throw new Error('unknown delivery'); };
    render(<App />); const modal = await open(); await act(async () => { expect(await invoke(modal, rows(2))).toBe(false); });
    expect(state.modal.importHold).toMatchObject({ confirmed: 0, unconfirmedIds: ['import-1', 'import-2'] });
    fireEvent.click(screen.getByRole('button', { name: 'Close import fixture' })); const reopened = await open();
    await act(async () => { expect(await invoke(reopened, rows(2))).toBe(false); });
    expect(state.batches).toHaveLength(1); expect(state.ids).toBe(2);
    expect(reopened.getHoldDetails()).toMatchObject({ confirmed: 0, ids: ['import-1', 'import-2'] });
    expect(screen.queryByText(/Please try again|rest failed|zero imported/i)).toBeNull();
  });
  it('retains the fulfilled count and uncertain second-batch IDs without retrying', async () => {
    state.commit = async count => { if (count === 2) throw new Error('unknown'); };
    render(<App />); const modal = await open(); await act(async () => { expect(await invoke(modal, rows(451))).toBe(false); });
    expect(state.modal.importHold).toMatchObject({ confirmed: 450, unconfirmedIds: ['import-451'], notDispatchedIds: [] });
    expect(state.batches).toHaveLength(2);
  });
  it('keeps the generic hold but hides old counts and references after another sign-in', async () => {
    state.commit = async () => { throw new Error('unknown'); };
    const app = render(<App />); const modal = await open(); await act(async () => { await invoke(modal); });
    expect(state.modal.getHoldDetails()).not.toBeNull();
    state.firebaseUser = { uid: 'other-owner', email: 'other@example.test' }; state.revision = 2;
    state.auth = { ...state.auth, user: state.firebaseUser, authRevision: 2 }; app.rerender(<App />);
    expect(state.modal.importHold).not.toBeNull(); expect(state.modal.getHoldDetails()).toBeNull();
    await act(async () => { expect(await invoke(state.modal)).toBe(false); });
    expect(state.ids).toBe(1);
  });
  it('invalidates the captured read epoch even when a feed error clears before the commit finishes', async () => {
    const wait = deferred(); state.commit = () => wait.promise;
    const app = render(<App />); const modal = await open(); let attempt;
    await act(async () => { attempt = invoke(modal, rows(451)); });
    state.error = new Error('temporary read error'); app.rerender(<App />);
    state.error = null; app.rerender(<App />);
    await act(async () => { wait.resolve(); expect(await attempt).toBe(false); });
    expect(state.batches).toHaveLength(1); expect(state.modal.importHold.confirmed).toBe(450);
    expect(state.modal.getHoldDetails()).toBeNull();
  });
  it('does not continue an old import after the App unmounts', async () => {
    const wait = deferred(); state.commit = () => wait.promise;
    const app = render(<App />); const modal = await open(); let attempt;
    await act(async () => { attempt = invoke(modal, rows(451)); });
    app.unmount();
    await act(async () => { wait.resolve(); expect(await attempt).toBe(false); });
    expect(state.batches).toHaveLength(1); expect(modal.getAdmissionKey()).toBeNull();
    expect(modal.getHoldDetails()).toBeNull();
  });
  it('prevents a captured modal close from remounting imports during dispatch', async () => {
    const wait = deferred(); state.commit = () => wait.promise;
    render(<App />); const modal = await open(); let attempt;
    await act(async () => { attempt = invoke(modal); modal.onClose(); });
    expect(screen.getByRole('button', { name: 'Close import fixture' })).toBeInTheDocument();
    await act(async () => { wait.resolve(); expect(await attempt).toBe(true); });
  });
});
