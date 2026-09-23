import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const state = vi.hoisted(() => ({ posts: [], auth: {}, error: null, isStalled: false, liveRevision: 1, documents: new Map(), transactions: [], pending: null }));
vi.mock('./config/firebase', () => ({ db: {}, auth: { get currentUser() { return state.auth.user; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: false, error: state.error, isStalled: state.isStalled }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [], loading: false }) }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(), doc: (_db, path, id) => ({ path, id }), addDoc: vi.fn(),
  runTransaction: async (_db, callback) => {
    const writes = [];
    state.transactions.push(writes);
    await callback({
      get: async ref => ({ exists: () => state.documents.has(ref.id), data: () => state.documents.get(ref.id) }),
      update: (ref, patch) => writes.push({ id: ref.id, patch }),
    });
    if (state.pending) await state.pending.promise;
    for (const { id, patch } of writes) state.documents.set(id, { ...state.documents.get(id), ...patch });
  },
  updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(),
}));
vi.mock('./components/DashboardHeader', () => ({ default: () => <div>Fixture header</div> }));
vi.mock('./components/PostGrid', () => ({ default: ({ posts, onEdit }) => <div aria-label="Synthetic grid">{posts.map(post => <button key={post.id} onClick={() => onEdit(post)}>Review {post.id}</button>)}</div> }));
vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
import App from './App';

const makePost = id => ({
  id, uid: 'owner', content: `Synthetic original ${id}`, client: 'Alpha', clientId: 'alpha',
  platform: 'gmb', status: 'draft', approvalStatus: 'pending', reviewStage: 'in_review', tags: [],
  createdAt: new Date('2026-09-23T12:00:00Z'), scheduledDate: null, updatedAt: '2026-09-23T12:00:00Z',
});
const dialog = () => screen.queryByRole('dialog', { name: 'Review Thread' });
const open = (id = 'a') => fireEvent.click(screen.getByRole('button', { name: `Review ${id}`, exact: true }));
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Close Review' }));
const approve = () => fireEvent.click(screen.getByRole('button', { name: 'Approve Thread' }));
const typeFeedback = (value = 'My typed feedback') => {
  fireEvent.click(screen.getByRole('button', { name: 'Request Changes', exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Specific feedback' }), { target: { value } });
};
const deferred = () => {
  const result = {};
  result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }));
  return result;
};

describe('actual App review selection, actual modal and transaction baseline', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    state.posts = [makePost('a'), makePost('b')];
    state.documents = new Map(state.posts.map(post => [post.id, { ...post }]));
    state.liveRevision = 1;
    state.auth = { user: { uid: 'guest-alpha' }, authRevision: 1, getAuthRevision: () => state.liveRevision,
      authLoading: false, isReadOnly: true, isOperator: false, isClientMember: false, role: null,
      sharedUid: 'owner', shareClient: 'Alpha', shareClientId: 'alpha', clientId: null };
    state.error = null; state.isStalled = false; state.pending = null; state.transactions = [];
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network in synthetic review fixture'); }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(['different-session', 'same-uid-new-session', 'share-scope', 'deleted-post', 'permission-denied', 'unauthenticated'])('retires captured review content after %s and never resurrects it', scenario => {
    const app = render(<App />);
    open(); typeFeedback();
    const originalAuth = state.auth, originalPosts = state.posts;
    if (scenario === 'different-session' || scenario === 'same-uid-new-session') {
      state.liveRevision = 3;
      state.auth = { ...state.auth, authRevision: 3,
        user: { uid: scenario === 'different-session' ? 'guest-beta' : 'guest-alpha' }, shareClientId: 'beta' };
    } else if (scenario === 'share-scope') state.auth = { ...state.auth, shareClientId: 'beta' };
    else if (scenario === 'deleted-post') state.posts = state.posts.filter(post => post.id !== 'a');
    else { state.error = { code: scenario }; state.isStalled = true; } // Deliberately retain rows.
    app.rerender(<App />);
    expect(dialog()).toBeNull();
    state.liveRevision = 1; state.auth = originalAuth; state.posts = originalPosts; state.error = null; state.isStalled = false;
    app.rerender(<App />);
    expect(dialog()).toBeNull();
    expect(state.transactions).toHaveLength(0);
    open(); typeFeedback('New opening');
    expect(screen.getByRole('textbox', { name: 'Specific feedback' })).toHaveValue('New opening');
  });

  it.each(['clientId', 'uid', 'reviewStage', 'source'])('retires an open review when same-ID %s no longer authorizes it', field => {
    const app = render(<App />); open();
    const replacement = { clientId: 'beta', uid: 'other-owner', reviewStage: 'private', source: 'suggestion' };
    state.posts = state.posts.map(post => post.id === 'a' ? { ...post, [field]: replacement[field] } : post);
    app.rerender(<App />);
    expect(dialog()).toBeNull();
  });

  it('preserves feedback and the captured original baseline through transient errors and same-ID updates', async () => {
    const app = render(<App />); open(); typeFeedback('  Exact reviewer words  ');
    const originalDialog = dialog();
    state.error = { code: 'unavailable' };
    app.rerender(<App />);
    expect(dialog()).toBe(originalDialog);
    expect(screen.getByRole('textbox', { name: 'Specific feedback' })).toHaveValue('  Exact reviewer words  ');
    state.error = null;
    state.posts = state.posts.map(post => post.id === 'a' ? { ...post, content: 'New unseen revision' } : post);
    state.documents.set('a', { ...state.documents.get('a'), content: 'New unseen revision' });
    app.rerender(<App />);
    expect(dialog()).toBe(originalDialog);
    expect(screen.getByRole('textbox', { name: 'Specific feedback' })).toHaveValue('  Exact reviewer words  ');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));
    await screen.findByText('This thread changed while you were reviewing it — refresh and try again');
    expect(state.transactions).toEqual([[]]);
    expect(state.documents.get('a').feedback).toBeUndefined();
    expect(dialog()).toBe(originalDialog);
  });

  it('does not silently approve a new unseen same-ID content revision', async () => {
    const app = render(<App />); open();
    state.posts = state.posts.map(post => post.id === 'a' ? { ...post, content: 'New unseen revision' } : post);
    state.documents.set('a', { ...state.documents.get('a'), content: 'New unseen revision' });
    app.rerender(<App />);
    expect(within(dialog()).queryByText('New unseen revision')).toBeNull();
    approve();
    await screen.findByText('This thread changed while you were reviewing it — refresh and try again');
    expect(state.transactions).toEqual([[]]);
    expect(state.documents.get('a').approvalStatus).toBe('pending');
    expect(dialog()).not.toBeNull();
  });

  it.each(['approve', 'feedback'])('blocks stale %s dispatch when the auth counter advances before render', action => {
    render(<App />); open();
    if (action === 'feedback') typeFeedback();
    state.liveRevision = 3;
    if (action === 'approve') approve();
    else fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));
    expect(state.transactions).toHaveLength(0);
    expect(screen.queryByText('Approved ✓')).toBeNull();
    expect(screen.queryByText('Feedback sent!')).toBeNull();
  });

  it.each([
    ['approve', 'same', 'success'], ['approve', 'other', 'success'], ['approve', 'same', 'failure'],
    ['feedback', 'same', 'success'], ['feedback', 'other', 'success'], ['feedback', 'same', 'failure'],
  ])('does not let old %s %s reopen completion (%s) close or toast into a later selection', async (action, next, outcome) => {
    render(<App />); open();
    const pending = deferred(); state.pending = pending;
    if (action === 'approve') approve();
    else { typeFeedback('  Exact old words  '); fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' })); }
    await waitFor(() => expect(state.transactions[0]).toHaveLength(1));
    await act(async () => {
      close();
      open(next === 'same' ? 'a' : 'b');
      if (outcome === 'success') pending.resolve(); else pending.reject(new Error('Synthetic late failure'));
    });
    expect(dialog()).not.toBeNull();
    expect(within(dialog()).getAllByText(`Synthetic original ${next === 'same' ? 'a' : 'b'}`).length).toBeGreaterThan(0);
    expect(screen.queryByText('Approved ✓')).toBeNull();
    expect(screen.queryByText('Feedback sent!')).toBeNull();
    expect(screen.queryByText('Update failed')).toBeNull();
    expect(screen.queryByText('Failed to send feedback')).toBeNull();
    // A dispatched transaction can still commit; this only owns its UI result.
    if (outcome === 'success') expect(state.documents.get('a').approvalStatus).toBe(action === 'approve' ? 'approved' : 'changes_requested');
  });

  it('keeps real feedback bytes, returns focus on ordinary close and succeeds for a current review', async () => {
    render(<App />);
    const opener = screen.getByRole('button', { name: 'Review a', exact: true });
    opener.focus(); open(); close();
    expect(document.activeElement).toBe(opener);
    open(); typeFeedback('  Exact reviewer words  ');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));
    await screen.findByText('Feedback sent!');
    expect(dialog()).toBeNull();
    expect(state.documents.get('a').feedback).toBe('  Exact reviewer words  ');
  });

  it('keeps an open archived thread visible and rejects its stale approval through CAS', async () => {
    const app = render(<App />); open();
    state.documents.set('a', { ...state.documents.get('a'), status: 'archived' });
    state.posts = state.posts.map(post => post.id === 'a' ? { ...post, status: 'archived' } : post);
    app.rerender(<App />);
    expect(dialog()).not.toBeNull();
    approve();
    await screen.findByText('This thread changed while you were reviewing it — refresh and try again');
    expect(state.transactions).toEqual([[]]);
  });
});
