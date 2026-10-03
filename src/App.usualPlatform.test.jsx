import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { OPERATOR_UID } from './config/roles';

const state = vi.hoisted(() => ({ auth: {}, currentUser: null, revision: 1, posts: [], clientMap: {},
  loading: false, error: null, stalled: false, roster: {}, editor: null }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'demo-spool-usual' } } },
  auth: { get currentUser() { return state.currentUser; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: state.clientMap,
  isLoading: state.loading, error: state.error, isStalled: state.stalled }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => state.roster }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), doc: vi.fn(), addDoc: vi.fn(),
  updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(), runTransaction: vi.fn() }));
vi.mock('./components/Sidebar', () => ({ default: ({ onFilterClient }) => <button onClick={() => onFilterClient('Acme')}>Choose Acme fixture</button> }));
vi.mock('./components/DashboardHeader', () => ({ default: ({ onNew }) => <button onClick={onNew}>New usual fixture</button> }));
vi.mock('./components/PostGrid', () => ({ default: () => null }));
vi.mock('./components/FilterBar', () => ({ default: () => null, SUGGESTIONS_LANE: 'suggestions' }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
vi.mock('./components/Editor', () => ({ default: props => {
  state.editor = props;
  return <section aria-label="Usual fixture editor"><p>{props.getUsualPlatformForClient('Acme') || 'No usual fixture'}</p></section>;
} }));
import { addDoc, updateDoc, deleteDoc, setDoc, writeBatch, runTransaction } from 'firebase/firestore';

const fixture = (id, clientId = 'acme', platform = 'linkedin') => ({ id, uid: OPERATOR_UID,
  clientId, client: clientId === 'acme' ? 'Acme' : 'Other', platform, content: `Synthetic caption ${id}`,
  status: 'draft', reviewStage: 'in_review', approvalStatus: 'pending', tags: [], isTemplate: false,
  scheduledDate: null, imageUrl: '', title: '', altText: '', metaDescription: '', feedback: '' });
const open = async app => {
  fireEvent.click(screen.getByRole('button', { name: 'New usual fixture' }));
  await screen.findByRole('region', { name: 'Usual fixture editor' });
  return { app, editor: state.editor };
};
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); window.history.replaceState({}, '', '/');
  state.currentUser = { uid: OPERATOR_UID, email: 'owner@example.test', isAnonymous: false };
  state.revision = 1; state.auth = { user: state.currentUser, role: 'super_admin', isOperator: true,
    isClientMember: false, isReadOnly: false, authLoading: false, authRevision: 1,
    getAuthRevision: () => state.revision, clientId: null };
  state.posts = [fixture('one'), fixture('two'), fixture('foreign', 'other', 'gmb')]; state.clientMap = {};
  state.loading = false; state.error = null; state.stalled = false;
  state.roster = { clients: [{ name: 'Acme', slug: 'acme' }, { name: 'Other', slug: 'other' }], loading: false, error: null };
  state.editor = null;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in usual-platform tests'); }));
});
afterEach(() => {
  cleanup(); expect(fetch).not.toHaveBeenCalled();
  for (const writer of [addDoc, updateDoc, deleteDoc, setDoc, writeBatch, runTransaction]) expect(writer).not.toHaveBeenCalled();
  localStorage.clear(); vi.unstubAllGlobals();
});

describe('App usual-platform read-only wiring', () => {
  it('marks only the confirmed complete selected client and leaves All-clients initial default untouched', async () => {
    const { editor } = await open(render(<App />));
    expect(editor.initialClient).toBe(''); expect(editor.initialPlatform).toBe('gmb');
    expect(editor.getUsualPlatformForClient('Acme')).toBe('linkedin');
    expect(editor.getUsualPlatformForClient('  acme  ')).toBe('linkedin');
    expect(editor.getUsualPlatformForClient('Other')).toBe('gmb');
    expect(editor.getUsualPlatformForClient('Ac')).toBeNull();
    expect(editor.getUsualPlatformForClient('Unknown')).toBeNull();
    expect(screen.getByText('linkedin')).toBeInTheDocument();
  });
  it('preserves the existing mount default when the client is selected before New', async () => {
    const app = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Acme fixture' }));
    const { editor } = await open(app);
    expect(editor.initialClient).toBe('Acme'); expect(editor.initialPlatform).toBe('linkedin');
  });
  it.each(['loading', 'error', 'stalled'])('suppresses unconfirmed feed %s without inventing fallback evidence', async kind => {
    const { app, editor } = await open(render(<App />));
    if (kind === 'loading') state.loading = true;
    if (kind === 'error') state.error = new Error('Synthetic read failure');
    if (kind === 'stalled') state.stalled = true;
    app.rerender(<App />);
    expect(state.editor.getUsualPlatformForClient('Acme')).toBeNull();
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it.each(['loading', 'error'])('suppresses operator roster %s', async kind => {
    const { app } = await open(render(<App />));
    state.roster = { ...state.roster, [kind]: kind === 'loading' ? true : 'Unconfirmed roster' };
    app.rerender(<App />);
    expect(state.editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('refuses ambiguous canonical names even when the legacy stamped resolver would pick one', async () => {
    state.roster.clients.push({ name: ' acme ', slug: 'other' });
    const { editor } = await open(render(<App />));
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('refuses off-roster stamped posts rather than treating their label as confirmed canonical identity', async () => {
    state.roster.clients = [{ name: 'Other', slug: 'other' }];
    const { editor } = await open(render(<App />));
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('does not transfer preference from phantom stamped IDs into the real canonical tenant', async () => {
    state.roster.clients = [{ name: 'Acme', slug: 'real-acme' }];
    const { editor } = await open(render(<App />));
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('retires old source callbacks after a readable snapshot changes', async () => {
    const { app, editor } = await open(render(<App />));
    state.posts = [fixture('new', 'acme', 'facebook')]; app.rerender(<App />);
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
    expect(state.editor.getUsualPlatformForClient('Acme')).toBe('facebook');
  });
  it('retires old roster callbacks after a canonical reassignment', async () => {
    const { app, editor } = await open(render(<App />));
    state.roster = { ...state.roster, clients: [{ name: 'Acme', slug: 'other' }] }; app.rerender(<App />);
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
    expect(state.editor.getUsualPlatformForClient('Acme')).toBe('gmb');
  });
  it.each(['user-object', 'revision', 'signed-out'])('suppresses an actual auth transition before props refresh: %s', async kind => {
    const { editor } = await open(render(<App />));
    if (kind === 'user-object') state.currentUser = { ...state.currentUser };
    if (kind === 'revision') state.revision++;
    if (kind === 'signed-out') state.currentUser = null;
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('does not revive an old callback after a same-account auth revision round trip', async () => {
    const { app, editor } = await open(render(<App />));
    state.revision = 2; state.auth = { ...state.auth, authRevision: 2 }; app.rerender(<App />);
    state.revision = 3; state.auth = { ...state.auth, authRevision: 3 }; app.rerender(<App />);
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('does not treat an anonymous identity as a confirmed writer even with inconsistent fixture flags', async () => {
    state.currentUser.isAnonymous = true;
    const { editor } = await open(render(<App />));
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('retires the source after App unmount without keeping a readable tenant callback', async () => {
    const { app, editor } = await open(render(<App />));
    app.unmount(); expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
  });
  it('shows only a member’s pinned client, independent of the unavailable operator roster', async () => {
    state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    state.posts = [fixture('own')]; state.roster = { clients: [], loading: true, error: 'Operator-only' };
    const { editor } = await open(render(<App />));
    expect(editor.getUsualPlatformForClient('Acme')).toBe('linkedin');
    expect(editor.getUsualPlatformForClient('Other')).toBeNull();
    expect(editor.initialPlatform).toBe('linkedin');
  });
  it('does not revive an old member callback after a tenant reassignment', async () => {
    state.auth = { ...state.auth, role: 'client', isOperator: false, isClientMember: true, clientId: 'acme' };
    const { app, editor } = await open(render(<App />));
    state.auth = { ...state.auth, clientId: 'other' }; state.posts = [fixture('foreign', 'other', 'gmb')]; app.rerender(<App />);
    expect(editor.getUsualPlatformForClient('Acme')).toBeNull();
    expect(state.posts).toHaveLength(1);
  });
});
