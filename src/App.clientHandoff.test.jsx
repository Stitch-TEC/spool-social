import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({ auth: {}, currentUser: null, revision: 1, posts: [], roster: {}, traces: [], editors: [] }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'synthetic-project' } } }, auth: { get currentUser() { return state.currentUser; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: false }) }));
// Roster transport/hook have their own tests. Keep the handoff hook and App's
// filters/entrypoint callbacks real; this boundary supplies an explicit read.
vi.mock('./hooks/useClients', () => ({ useClients: (_enabled, scopeKey) => ({ ...state.roster, scopeKey }) }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), doc: vi.fn(), addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(), runTransaction: vi.fn() }));
vi.mock('./components/Sidebar', () => ({ default: ({ onFilterClient, onShowTemplates }) => <nav><button onClick={() => onFilterClient('Beta Studio')}>Choose Beta</button><button onClick={() => onShowTemplates(true)}>Choose templates</button></nav> }));
vi.mock('./components/DashboardHeader', () => ({ default: ({ onNew }) => <button onClick={onNew}>Create fixture</button> }));
vi.mock('./components/PostGrid', () => ({ default: ({ posts, onEdit, onUseTemplate }) => {
  state.traces.push(posts.map(post => post.title));
  return <section aria-label="Synthetic grid">{posts.map(post => <div key={post.id}><p>{post.title}</p><button onClick={() => onEdit(post)}>Edit {post.title}</button>{onUseTemplate && <button onClick={() => onUseTemplate(post)}>Use {post.title}</button>}</div>)}</section>;
} }));
vi.mock('./components/Editor', () => ({ default: props => {
  state.editors.push(props.initialClient);
  return <section aria-label="Synthetic editor"><label>Unsaved fixture<input defaultValue="" /></label><button onClick={props.onCancel}>Cancel fixture</button></section>;
} }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
vi.mock('./components/BulkActionBar', () => ({ default: () => null }));
import App from './App';
import * as firestore from 'firebase/firestore';

const post = (id, client, clientId) => ({ id, title: id, client, clientId, approvalStatus: 'pending', platform: 'gmb', status: 'draft', reviewStage: 'in_review', content: `Synthetic ${id}`, imageUrl: '/synthetic.png', tags: [], _searchContent: id, _searchClient: client.toLowerCase(), scheduledDate: null, createdAt: new Date('2026-09-27'), updatedAt: '2026-09-27T00:00:00Z' });
const setActor = uid => {
  state.currentUser = { uid, email: `${uid}@example.test` }; state.revision++;
  state.auth = { ...state.auth, user: state.currentUser, authRevision: state.revision };
};

describe('actual App canonical client handoff — real lifetime hook and filters', () => {
  beforeEach(() => {
    localStorage.clear(); window.history.replaceState({}, '', '/?clientSlug=alpha-key'); vi.clearAllMocks();
    state.revision = 1; state.currentUser = { uid: 'operator-a', email: 'operator@example.test' };
    state.auth = { user: state.currentUser, authRevision: 1, getAuthRevision: () => state.revision, authLoading: false, isReadOnly: false, isOperator: true, isClientMember: false, role: 'super_admin' };
    state.roster = { clients: [{ slug: 'alpha-key', name: 'Alpha Studio', status: 'active' }, { slug: 'beta-key', name: 'Beta Studio', status: 'active' }], loading: false, error: null, confirmed: true, readVersion: 'read-1' };
    state.posts = [post('Alpha draft', 'Alpha Studio', 'alpha-key'), post('Beta draft', 'Beta Studio', 'beta-key')]; state.traces = []; state.editors = [];
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network permitted'); }));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); for (const fn of Object.values(firestore)) expect(fn).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
  it('never supplies all-client rows before a canonical match, including pending-to-ready', () => {
    state.roster.loading = true; state.roster.confirmed = false;
    const app = render(<App />); expect(state.traces).toEqual([]);
    state.roster = { ...state.roster, loading: false, confirmed: true, readVersion: 'read-2' }; app.rerender(<App />);
    expect(screen.getByText('Alpha draft')).toBeInTheDocument(); expect(screen.queryByText('Beta draft')).toBeNull();
    expect(state.traces.every(rows => rows.every(title => title === 'Alpha draft'))).toBe(true); expect(state.editors).toEqual([]);
  });
  it.each(['?clientSlug=alpha-key&clientSlug=alpha-key', '?clientSlug=alpha-key&client=Beta', '?clientSlug=%ZZ'])('does not turn invalid input into an ordinary/all-client view: %s', query => {
    window.history.replaceState({}, '', `/${query}`); render(<App />); expect(state.traces).toEqual([]); expect(state.editors).toEqual([]);
  });
  it('allows the first signed-out login but irreversibly retires a later account round-trip', () => {
    state.auth = { ...state.auth, user: null, isOperator: false }; state.currentUser = null;
    const app = render(<App />); expect(state.traces).toEqual([]);
    setActor('operator-a'); state.auth.isOperator = true; app.rerender(<App />); expect(screen.getByText('Alpha draft')).toBeInTheDocument();
    setActor('operator-b'); app.rerender(<App />); expect(screen.queryByLabelText('Synthetic grid')).toBeNull();
    setActor('operator-a'); app.rerender(<App />); expect(screen.queryByLabelText('Synthetic grid')).toBeNull();
  });
  it('manual filtering consumes the intent so roster updates cannot reapply it', () => {
    const app = render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Choose Beta' }));
    expect(screen.getByText('Beta draft')).toBeInTheDocument(); expect(screen.queryByText('Alpha draft')).toBeNull();
    state.roster = { ...state.roster, readVersion: 'read-2' }; app.rerender(<App />);
    expect(screen.getByText('Beta draft')).toBeInTheDocument(); expect(screen.queryByRole('region', { name: 'Client opened from a link' })).toBeNull();
  });
  it.each(['create', 'edit', 'new-template', 'use-template'])('explicit %s consumes the verified label and preserves ordinary unsaved editor work', async action => {
    if (action === 'use-template') state.posts[0].isTemplate = true;
    const app = render(<App />);
    if (action === 'create') fireEvent.click(screen.getByRole('button', { name: 'Create fixture' }));
    else if (action === 'edit') fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha draft' }));
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Choose templates' }));
      fireEvent.click(screen.getByRole('button', { name: action === 'new-template' ? 'New template' : 'Use Alpha draft' }));
    }
    await screen.findByLabelText('Synthetic editor'); expect(state.editors.at(-1)).toBe('Alpha Studio');
    fireEvent.change(screen.getByLabelText('Unsaved fixture'), { target: { value: 'Keep this unsaved text' } });
    state.roster = { ...state.roster, confirmed: false, error: 'unavailable', readVersion: 'read-2' }; app.rerender(<App />);
    expect(screen.getByLabelText('Unsaved fixture')).toHaveValue('Keep this unsaved text');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel fixture' }));
    expect(screen.queryByRole('region', { name: 'Client opened from a link' })).toBeNull();
  });
  it.each(['revision', 'sdk-user'])('rejects a captured create button after an unrendered %s change', kind => {
    render(<App />); const button = screen.getByRole('button', { name: 'Create fixture' });
    if (kind === 'revision') state.revision++; else state.currentUser = { uid: 'other' };
    fireEvent.click(button); expect(state.editors).toEqual([]);
  });
  it('restores keyboard-owned focus to the ready region after explicit recovery', async () => {
    state.roster = { ...state.roster, confirmed: false, error: 'unavailable' }; const app = render(<App />);
    state.roster = { ...state.roster, confirmed: true, error: null, readVersion: 'read-2' }; app.rerender(<App />);
    const button = screen.getByRole('button', { name: 'Open verified client' }); button.focus(); fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Client opened from a link' })).toHaveFocus());
  });
  it('does not steal intentionally external focus during recovery', async () => {
    state.roster = { ...state.roster, confirmed: false, error: 'unavailable' }; const app = render(<App />);
    state.roster = { ...state.roster, confirmed: true, error: null, readVersion: 'read-2' }; app.rerender(<App />);
    const external = document.createElement('button'); external.textContent = 'Outside app'; document.body.append(external); external.focus();
    try { await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open verified client' }))); expect(external).toHaveFocus(); }
    finally { external.remove(); }
  });
  it('restores focus owned by the pending notice when the first roster resolves', () => {
    state.roster = { ...state.roster, confirmed: false, loading: true }; const app = render(<App />);
    screen.getByRole('button', { name: 'Continue to Spool' }).focus();
    state.roster = { ...state.roster, confirmed: true, loading: false, readVersion: 'read-2' }; app.rerender(<App />);
    expect(screen.getByRole('region', { name: 'Client opened from a link' })).toHaveFocus();
  });
  it('does not steal external focus when the pending roster resolves', () => {
    state.roster = { ...state.roster, confirmed: false, loading: true }; const app = render(<App />);
    const external = document.createElement('button'); external.textContent = 'Outside app'; document.body.append(external); external.focus();
    try {
      state.roster = { ...state.roster, confirmed: true, loading: false, readVersion: 'read-2' }; app.rerender(<App />);
      expect(external).toHaveFocus();
    } finally { external.remove(); }
  });
});
