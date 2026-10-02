import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({ auth: {}, posts: [], batches: [], grid: null, bulk: null, commit: null }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'demo-spool' } } }, auth: { get currentUser() { return state.auth.user; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: false, error: null }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [{ name: 'Acme', slug: 'acme' }, { name: 'Beta', slug: 'beta' }], loading: false }) }));
vi.mock('firebase/firestore', () => ({
  collection: (_db, path) => ({ path }), doc: (_db, _path, id) => ({ id: id || 'new-copy' }),
  addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), runTransaction: vi.fn(),
  writeBatch: () => {
    const writes = []; state.batches.push(writes);
    return { set: (ref, value) => writes.push({ kind: 'set', id: ref.id, value }),
      delete: ref => writes.push({ kind: 'delete', id: ref.id }), update: vi.fn(),
      commit: async () => state.commit?.(state.batches.length, writes) };
  },
}));
vi.mock('./components/DashboardHeader', () => ({ default: () => null }));
vi.mock('./components/PostGrid', () => ({ default: props => {
  state.grid = props;
  return <section><button onClick={() => props.onCloneToAll(props.posts.find(post => post.id === 'a'))}>Clone fixture a</button></section>;
} }));
vi.mock('./components/BulkActionBar', () => ({ default: props => {
  state.bulk = props;
  return <button onClick={props.onDelete}>Delete fixture selection</button>;
} }));
vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));

const base = (id = 'a', patch = {}) => ({ id, uid: OPERATOR_UID, client: 'Acme', clientId: 'acme',
  content: 'Exact caption', platform: 'linkedin', status: 'draft', reviewStage: 'in_review', approvalStatus: 'pending',
  scheduledDate: null, tags: [], imageUrl: '', title: '', altText: '', metaDescription: '', slug: '',
  createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z', ...patch });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const beginDelete = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Select', exact: true }));
  await act(async () => { state.posts.forEach(post => state.grid.onToggleSelect(post.id)); });
  fireEvent.click(screen.getByRole('button', { name: 'Delete fixture selection' }));
  await screen.findByRole('dialog', { name: /^Delete \d+ threads?\?/ });
};

beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/');
  const user = { uid: OPERATOR_UID, email: 'owner@example.test' };
  state.auth = { user, role: 'super_admin', isOperator: true, isClientMember: false, isReadOnly: false,
    authLoading: false, authRevision: 1, getAuthRevision: () => 1, clientId: null };
  state.posts = [base(), base('b', { client: 'Beta', clientId: 'beta' })];
  state.batches = []; state.grid = null; state.bulk = null; state.commit = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network in compatibility QA'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual App delayed confirmation review-details admission', () => {
  it.each(['details', 'missing'])('does not clone a %s source after the confirmation was opened', async kind => {
    const app = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Clone fixture a' }));
    await screen.findByRole('dialog', { name: 'Blast: Clone to All Clients?' });
    state.posts = kind === 'missing' ? state.posts.filter(post => post.id !== 'a')
      : state.posts.map(post => post.id === 'a' ? { ...post, reviewDetailsVersion: 1, firstComment: 'New comment' } : post);
    app.rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.batches).toHaveLength(0);
    expect(screen.getByText(kind === 'details' ? /Nothing cloned.*now has review details/ : /Cloning failed.*source thread/)).toBeInTheDocument();
  });

  it('still clones an unchanged legacy source into unapproved private drafts', async () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Clone fixture a' }));
    await screen.findByRole('dialog', { name: 'Blast: Clone to All Clients?' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
    await waitFor(() => expect(state.batches).toHaveLength(1));
    expect(state.batches[0]).toHaveLength(1);
    expect(state.batches[0][0].value).toMatchObject({ clientId: 'beta', reviewStage: 'private', approvalStatus: 'pending', content: 'Exact caption' });
    expect(state.batches[0][0].value).not.toHaveProperty('firstComment');
  });

  it.each(['reviewDetailsVersion', 'firstComment', 'reviewMedia'])('does not delete after %s appears during confirmation', async field => {
    const app = render(<App />); await beginDelete();
    state.posts = state.posts.map(post => post.id === 'b' ? { ...post, [field]: field === 'reviewDetailsVersion' ? 99 : field === 'reviewMedia' ? [] : '' } : post);
    app.rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await screen.findByText(/Deletion stopped before starting.*now has review details/);
    expect(state.batches).toHaveLength(0);
  });

  it('rechecks remaining IDs after a delayed chunk and reports confirmed partial progress', async () => {
    state.posts = Array.from({ length: 451 }, (_, index) => base(String(index)));
    const pending = deferred(); state.commit = count => count === 1 ? pending.promise : undefined;
    const app = render(<App />); await beginDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(state.batches[0]).toHaveLength(450));
    state.posts = state.posts.map(post => post.id === '450' ? { ...post, firstComment: 'New remaining metadata' } : post);
    app.rerender(<App />);
    await act(async () => { pending.resolve(); });
    await screen.findByText(/Deletion stopped after deleting 450 threads.*now has review details/);
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0].some(write => write.id === '450')).toBe(false);
    expect(screen.queryByText('Deleted 451 threads')).toBeNull();
  });

  it('does not call an unconfirmed failed commit a successful deletion', async () => {
    state.commit = async () => { throw new Error('Unknown transport outcome'); };
    render(<App />); await beginDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await screen.findByText(/Deletion needs checking.*may have been deleted/);
    expect(state.batches).toHaveLength(1);
    expect(screen.queryByText('Deleted 2 threads')).toBeNull();
  });
});
