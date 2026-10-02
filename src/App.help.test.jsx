import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({ auth: {}, currentUser: null, revision: 1, posts: [] }));
vi.mock('./config/firebase', () => ({ db: {}, auth: { get currentUser() { return state.currentUser; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: false }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => ({ clients: [], loading: false }) }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), doc: vi.fn(), addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(), runTransaction: vi.fn() }));
vi.mock('./components/Sidebar', () => ({ default: ({ onFilterClient }) => <button onClick={() => onFilterClient('Alpha')}>Choose Alpha</button> }));
vi.mock('./components/PostGrid', () => ({ default: ({ posts }) => <section aria-label="Fixture threads">{posts.map(post => <p key={post.id}>{post.content}</p>)}</section> }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
vi.mock('./components/Editor', () => ({ default: function FixtureEditor({ onHelp }) {
  const [text, setText] = useState('');
  return <section><label>Unsaved draft<textarea value={text} onChange={event => setText(event.target.value)} /></label><button onClick={onHelp}>Editor help</button></section>;
} }));
import App from './App';
import * as firestore from 'firebase/firestore';

describe('actual App help wiring', () => {
  beforeEach(() => {
    localStorage.clear(); window.history.replaceState({}, '', '/'); vi.clearAllMocks();
    state.revision = 1; state.currentUser = { uid: 'synthetic', email: 'operator@example.test' };
    state.auth = { user: state.currentUser, authRevision: 1, getAuthRevision: () => state.revision, authLoading: false, role: 'super_admin', isReadOnly: false, isOperator: true, isClientMember: false };
    state.posts = ['Alpha', 'Beta'].map(client => ({ id: client, client, clientId: client.toLowerCase(), uid: 'synthetic', content: `${client} content`, platform: 'gmb', reviewStage: 'in_review', status: 'draft', tags: [], createdAt: new Date('2026-10-01'), _searchContent: `${client.toLowerCase()} content`, _searchClient: client.toLowerCase() }));
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No help network allowed'); }));
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled(); for (const fn of Object.values(firestore)) expect(fn).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  });
  it('preserves existing client filter and search through open, navigate and close', async () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Choose Alpha' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'content' } });
    const help = screen.getByRole('button', { name: 'Help & guides' }); help.focus(); fireEvent.click(help);
    await screen.findByRole('searchbox', { name: 'Find a guide' });
    fireEvent.click(screen.getByRole('button', { name: /Share a draft for review/ }));
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Share a draft for review' }), { key: 'Escape' });
    expect(help).toHaveFocus(); expect(screen.getByRole('textbox', { name: 'Search threads' })).toHaveValue('content');
    expect(screen.getByText('Alpha content')).toBeInTheDocument(); expect(screen.queryByText('Beta content')).toBeNull();
  });
  it('keeps the current editor instance and unsaved text while help opens and closes', async () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Create New Thread' }));
    const text = await screen.findByRole('textbox', { name: 'Unsaved draft' });
    fireEvent.change(text, { target: { value: 'Not yet saved' } });
    const trigger = screen.getByRole('button', { name: 'Editor help' }); trigger.focus(); fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Help & guides' });
    fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toBe(text); expect(text).toHaveValue('Not yet saved'); expect(trigger).toHaveFocus();
  });
  it('closes old help on a role/session change and never revives its search', async () => {
    const app = render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Help & guides' }));
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'private' } });
    const original = state.auth;
    state.revision = 2; state.auth = { ...state.auth, authRevision: 2, role: 'client', isOperator: false, isClientMember: true, clientId: 'alpha' };
    app.rerender(<App />); expect(screen.queryByRole('dialog')).toBeNull();
    state.revision = 1; state.auth = original; app.rerender(<App />); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Help & guides' }));
    expect(await screen.findByRole('searchbox')).toHaveValue('');
  });
  it('opens review-link-specific help without changing the share URL', async () => {
    window.history.replaceState({}, '', '/?s=synthetic-token');
    state.auth = { ...state.auth, isReadOnly: true, isOperator: false, role: null, sharedUid: 'synthetic', shareClientId: 'alpha', shareClient: 'Alpha' };
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Help & guides' }));
    await screen.findByRole('heading', { name: 'Review guides' });
    expect(screen.queryByRole('button', { name: /Share a draft for review/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Approve or request changes/ })).toBeInTheDocument();
    expect(window.location.search).toBe('?s=synthetic-token');
  });
  it('returns focus to the actual trigger when a pointer did not focus it first', () => {
    render(<App />); const search = screen.getByRole('textbox', { name: 'Search threads' }); search.focus();
    const trigger = screen.getByRole('button', { name: 'Help & guides' });
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(trigger).toHaveFocus();
  });
});
