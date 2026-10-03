import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({ user: null, auth: null, grid: null, bulk: null, subscriptions: [], server: new Map(), reads: [], writes: [] }));
vi.mock('./config/firebase', () => ({ db: {}, auth: { get currentUser() { return state.user; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [{ name: 'Acme', slug: 'acme' }], loading: false }) }));
// usePosts itself is real: only its Firebase snapshot/transaction transport is synthetic.
vi.mock('firebase/firestore', () => ({
  collection: (_db, name) => ({ name }), query: (base, ...constraints) => ({ base, constraints }), where: (...args) => args,
  doc: (_db, name, id) => ({ name, id }), addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(),
  onSnapshot: (query, next, error) => { state.subscriptions.push({ query, next, error }); return vi.fn(); },
  runTransaction: async (_db, callback) => {
    const pending = [];
    const result = await callback({ get: async ref => { state.reads.push(ref); return { exists: () => state.server.has(ref.id), data: () => state.server.get(ref.id) }; },
      update: (ref, patch) => pending.push({ ref, patch }) });
    for (const write of pending) { state.writes.push(write); state.server.set(write.ref.id, { ...state.server.get(write.ref.id), ...write.patch }); }
    return result;
  },
}));
vi.mock('./components/PostGrid', () => ({ default: props => { state.grid = props; return <div>Canonical fixture threads</div>; } }));
vi.mock('./components/BulkActionBar', () => ({ default: props => { state.bulk = props; return <div>Tag fixture controls</div>; } }));
vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/DashboardHeader', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
const data = (id, content) => ({ id, uid: OPERATOR_UID, clientId: 'acme', client: 'Acme',
  content, title: '', imageUrl: '', platform: 'linkedin', status: 'draft', approvalStatus: 'pending',
  feedback: '', feedbackThread: [], reviewStage: 'in_review', tags: [], scheduledDate: null,
  createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z' });
const emit = (rows, type = 'added') => act(() => {
  const posts = state.subscriptions.filter(subscription => subscription.query.base.name === 'posts').at(-1);
  posts.next({ docChanges: () => rows.map(([id, body]) => ({ type, doc: { id, data: () => body } })) });
});
beforeEach(() => {
  localStorage.clear(); window.history.replaceState({}, '', '/');
  state.user = { uid: OPERATOR_UID, email: 'owner@example.test' };
  state.auth = { user: state.user, authRevision: 1, getAuthRevision: () => 1, role: 'super_admin', isOperator: true,
    isClientMember: false, isReadOnly: false, authLoading: false, clientId: null };
  state.grid = null; state.bulk = null; state.subscriptions = []; state.server = new Map(); state.reads = []; state.writes = [];
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network in canonical identity QA'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual usePosts → App Archive canonical document identity', () => {
  it('changes only displayed A’s tags when its stored id points at B with matching metadata', async () => {
    const a = data('document-b', 'Caption A'), b = data('document-a', 'Caption B');
    state.server = new Map([['document-a', a], ['document-b', b]]);
    render(<App />); emit([['document-a', a], ['document-b', b]]);
    fireEvent.click(screen.getByRole('button', { name: 'Select', exact: true }));
    await act(async () => { state.grid.onToggleSelect('document-a'); });
    await act(async () => { expect(await state.bulk.onAddTags(['new'])).toBe(true); });
    expect(state.reads.map(ref => ref.id)).toEqual(['document-a']);
    expect(state.writes.map(write => write.ref.id)).toEqual(['document-a']);
    expect(state.server.get('document-a')).toEqual({ ...a, ...state.writes[0].patch });
    expect(state.server.get('document-a').id).toBe('document-b');
    expect(state.server.get('document-b')).toBe(b);
    expect(Object.keys(state.writes[0].patch).sort()).toEqual(['tags', 'updatedAt']);
  });
  it('refuses malformed raw tags even when usePosts presents a safe shortened array', async () => {
    const a = { ...data('stored-id', 'Caption A'), tags: Array.from({ length: 11 }, (_, index) => `tag${index}`) };
    state.server.set('document-a', a); render(<App />); emit([['document-a', a]]);
    expect(state.grid.posts[0].tags).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Select', exact: true }));
    await act(async () => { state.grid.onToggleSelect('document-a'); });
    await act(async () => { expect(await state.bulk.onRemoveTags(['tag0'])).toBe(false); });
    expect(state.writes).toEqual([]); expect(state.server.get('document-a')).toBe(a);
    expect(screen.getByText(/No tag changes submitted/)).toBeInTheDocument();
  });
  it('archives the displayed document A, not body id B, even when both share all archive baseline fields', async () => {
    const a = data('document-b', 'Caption A'), b = data('document-a', 'Caption B');
    state.server = new Map([['document-a', a], ['document-b', b]]);
    render(<App />); emit([['document-a', a], ['document-b', b]]);
    expect(state.grid.posts.map(post => post.id).sort()).toEqual(['document-a', 'document-b']);
    const aCard = state.grid.posts.find(post => post.content === 'Caption A');
    expect(aCard.id).toBe('document-a');
    await act(async () => { expect(await state.grid.onArchive(aCard.id)).toBe(true); });
    expect(state.reads).toEqual([{ name: 'posts', id: 'document-a' }]);
    expect(state.writes).toHaveLength(1); expect(state.writes[0].ref.id).toBe('document-a');
    expect(state.server.get('document-a')).toEqual({ ...a, ...state.writes[0].patch });
    expect(state.server.get('document-a').id).toBe('document-b'); // Stored legacy field is not rewritten.
    expect(state.server.get('document-b')).toBe(b);
    expect(screen.getByText('Thread archived')).toBeInTheDocument();
  });
  it('retains the canonical target after a modified snapshot changes the body id', async () => {
    const a = data('obsolete-body-id', 'Caption A'), b = data('document-a', 'Caption B');
    state.server = new Map([['document-a', a], ['document-b', b]]);
    render(<App />); emit([['document-a', a], ['document-b', b]]);
    const modified = { ...a, id: 'document-b', title: 'Metadata change', updatedAt: '2026-10-03T12:00:01.000Z' };
    state.server.set('document-a', modified); emit([['document-a', modified]], 'modified');
    const aCard = state.grid.posts.find(post => post.content === 'Caption A');
    expect(aCard).toMatchObject({ id: 'document-a', title: 'Metadata change' });
    await act(async () => { expect(await state.grid.onArchive(aCard.id)).toBe(true); });
    expect(state.reads.map(ref => ref.id)).toEqual(['document-a']);
    expect(state.server.get('document-a')).toMatchObject({ status: 'archived', id: 'document-b', title: 'Metadata change' });
    expect(state.server.get('document-b')).toBe(b);
  });
  it('does not target the body-id collision after the displayed document is removed', async () => {
    const a = data('document-b', 'Caption A'), b = data('document-a', 'Caption B');
    state.server = new Map([['document-a', a], ['document-b', b]]);
    render(<App />); emit([['document-a', a], ['document-b', b]]);
    const captured = state.grid.onArchive;
    state.server.delete('document-a'); emit([['document-a', a]], 'removed');
    expect(state.grid.posts.map(post => post.id)).toEqual(['document-b']);
    await act(async () => { expect(await captured('document-a')).toBe(false); });
    expect(state.reads).toEqual([]); expect(state.writes).toEqual([]); expect(state.server.get('document-b')).toBe(b);
    expect(screen.getByText('Thread no longer available. No change sent.')).toBeInTheDocument();
  });
});
