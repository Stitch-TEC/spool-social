import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { savedViewsKey, serializeSavedViews } from './utils/savedViews';
const state = vi.hoisted(() => ({ auth: {}, currentUser: null, revision: 1, posts: [], roster: {} }));
vi.mock('./config/firebase', () => ({ db: { app: { options: { projectId: 'synthetic-project' } } }, auth: { get currentUser() { return state.currentUser; } } }));
vi.mock('./hooks/useAuth', () => ({ default: () => state.auth }));
vi.mock('./hooks/usePosts', () => ({ default: () => ({ posts: state.posts, clientMap: {}, isLoading: false }) }));
vi.mock('./hooks/useClients', () => ({ useClients: () => state.roster }));
vi.mock('firebase/firestore', () => ({ collection: vi.fn(), doc: vi.fn(), addDoc: vi.fn(), updateDoc: vi.fn(), deleteDoc: vi.fn(), setDoc: vi.fn(), writeBatch: vi.fn(), runTransaction: vi.fn() }));
vi.mock('./components/Sidebar', () => ({ default: ({ onFilterClient, onShowArchived, onShowTemplates }) => <nav><button onClick={() => onFilterClient('Lyf Fit')}>Scope Lyf Fit</button><button onClick={() => onShowArchived(true)}>Archives fixture</button><button onClick={() => onShowTemplates(true)}>Templates fixture</button></nav> }));
vi.mock('./components/DashboardHeader', () => ({ default: ({ searchQuery, onSearchChange }) => <label>Search fixture<input value={searchQuery} onChange={event => onSearchChange(event.target.value)} /></label> }));
vi.mock('./components/PostGrid', () => ({ default: ({ posts, selectedIds, selectable, onToggleSelect }) => <div aria-label="Synthetic grid" data-selected={[...selectedIds].join(',')} data-selectable={String(selectable)}>{posts.map(post => <button key={post.id} onClick={() => onToggleSelect(post.id)}>{post.title}</button>)}</div> }));
vi.mock('./components/BrandFooter', () => ({ default: () => null }));
vi.mock('./components/FeedbackWidget', () => ({ default: () => null }));
vi.mock('./components/BulkActionBar', () => ({ default: () => null }));
import App from './App';
import * as firestore from 'firebase/firestore';

const prefs = { clientSlug: 'lyf-fit', review: 'changes', status: null, platform: null, media: null, needs: null, sort: 'scheduled_asc' };
const views = [{ name: 'Lyf Fit — Changes', filters: prefs }, { name: 'Approved blogs', filters: { ...prefs, clientSlug: null, review: 'approved', platform: 'blog' } }];
const makePost = (id, client, clientId, approvalStatus, platform = 'gmb') => ({ id, title: id, client, clientId, approvalStatus, platform, status: 'draft', reviewStage: 'in_review', content: `Synthetic ${id}`, imageUrl: '/synthetic.png', tags: ['private-tag'], _searchContent: id.toLowerCase(), _searchClient: client.toLowerCase(), scheduledDate: null, createdAt: new Date('2026-09-23'), updatedAt: '2026-09-23T00:00:00Z' });
const open = () => { const el = screen.getByText('Saved views · this browser only').closest('details'); el.open = true; fireEvent(el, new Event('toggle')); };
const apply = name => { fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: name } }); fireEvent.click(screen.getByRole('button', { name: 'Apply view' })); };
const grid = () => screen.getByLabelText('Synthetic grid');
const titles = () => within(grid()).queryAllByRole('button').map(button => button.textContent);

describe('actual App saved-view integration, real filters and storage; synthetic transport', () => {
  beforeEach(() => {
    localStorage.clear(); window.history.replaceState({}, '', '/'); vi.clearAllMocks();
    state.revision = 1; state.currentUser = { uid: 'operator-a', email: 'operator@example.test', isAnonymous: false };
    state.auth = { user: state.currentUser, authRevision: 1, getAuthRevision: () => state.revision, authLoading: false, isReadOnly: false, isOperator: true, isClientMember: false, role: 'super_admin' };
    state.roster = { clients: [{ slug: 'lyf-fit', name: 'Lyf Fit' }, { slug: 'alpha', name: 'Alpha' }], loading: false, error: null };
    state.posts = [makePost('Lyf changes', 'Lyf Fit', 'lyf-fit', 'changes_requested'), makePost('Lyf approved blog', 'Lyf Fit', 'lyf-fit', 'approved', 'blog'), makePost('Alpha changes', 'Alpha', 'alpha', 'changes_requested'), makePost('Alpha approved blog', 'Alpha', 'alpha', 'approved', 'blog')];
    localStorage.setItem(savedViewsKey('synthetic-project', 'operator-a'), serializeSavedViews(views));
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network permitted'); }));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); for (const fn of Object.values(firestore)) expect(fn).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
  it('applies Lyf Fit→Changes, clearing a previous selection/search/tag, with no write', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Select', exact: true })); fireEvent.click(within(grid()).getByRole('button', { name: 'Alpha changes', exact: true }));
    expect(grid().dataset.selected).not.toBe('');
    fireEvent.change(screen.getByLabelText('Filter by tag'), { target: { value: 'private-tag' } });
    fireEvent.change(screen.getByLabelText('Search fixture'), { target: { value: 'Alpha' } });
    open(); apply('Lyf Fit — Changes');
    expect(titles()).toEqual(['Lyf changes']); expect(grid().dataset.selected).toBe(''); expect(grid().dataset.selectable).toBe('false');
    expect(screen.getByLabelText('Search fixture')).toHaveValue(''); expect(screen.getByLabelText('Filter by tag')).toHaveValue('');
    expect(screen.getByRole('heading', { name: /Lyf Fit Threads/ })).toBeInTheDocument();
  });
  it('explicit all-client Approved blogs returns from an existing client scope', () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: 'Scope Lyf Fit' })); open(); apply('Approved blogs');
    expect(titles()).toEqual(['Lyf approved blog', 'Alpha approved blog']);
    expect(screen.getByLabelText('Filter by platform')).toHaveValue('blog');
    expect(screen.getByRole('heading', { name: /All Threads/ })).toBeInTheDocument();
  });
  it.each(['Archives fixture', 'Templates fixture'])('Apply exits %s while save stays unavailable there', label => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: label })); open();
    expect(screen.getByRole('button', { name: 'Save current filters' })).toBeDisabled(); apply('Approved blogs');
    expect(titles()).toEqual(['Lyf approved blog', 'Alpha approved blog']); expect(screen.getByRole('button', { name: 'Save current filters' })).not.toBeDisabled();
  });
  it('refuses a missing client and leaves the existing scope and search unchanged', () => {
    state.roster.clients = [{ slug: 'alpha', name: 'Alpha' }]; render(<App />);
    fireEvent.change(screen.getByLabelText('Search fixture'), { target: { value: 'Alpha' } }); const before = titles();
    open(); apply('Lyf Fit — Changes');
    expect(titles()).toEqual(before); expect(screen.getByLabelText('Search fixture')).toHaveValue('Alpha');
  });
  it('follows a confirmed roster rename to the current feed label', () => {
    state.roster.clients[0] = { slug: 'lyf-fit', name: 'Lyf Studio' };
    state.posts = state.posts.map(post => post.clientId === 'lyf-fit' ? { ...post, client: 'Lyf Studio' } : post);
    render(<App />); open(); apply('Lyf Fit — Changes'); expect(titles()).toEqual(['Lyf changes']);
    expect(screen.getByRole('heading', { name: /Lyf Studio Threads/ })).toBeInTheDocument();
  });
  it.each(['member', 'guest', 'loading'])('does not expose saved views to %s', kind => {
    if (kind === 'loading') state.auth.authLoading = true;
    else { state.auth.isOperator = false; state.auth.isClientMember = kind === 'member'; state.auth.isReadOnly = kind === 'guest'; }
    render(<App />); expect(screen.queryByText('Saved views · this browser only')).toBeNull();
  });
  it.each(['revision', 'actual-user'])('blocks stale Apply before the %s auth change renders', kind => {
    render(<App />); open(); fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: views[0].name } });
    if (kind === 'revision') state.revision = 2; else state.currentUser = { uid: 'operator-b' };
    fireEvent.click(screen.getByRole('button', { name: 'Apply view' })); expect(titles()).toHaveLength(4);
  });
  it('remounts account-local names and typed input across exact UID/revision changes', () => {
    const app = render(<App />); open(); fireEvent.change(screen.getByLabelText('New view name'), { target: { value: 'A-only name' } });
    state.currentUser = { uid: 'operator-b' }; state.revision = 2; state.auth = { ...state.auth, user: state.currentUser, authRevision: 2 }; app.rerender(<App />); open();
    expect(screen.queryByRole('option', { name: views[0].name })).toBeNull(); expect(screen.getByLabelText('New view name')).toHaveValue('');
  });

  it('wraps the suggestions notice but retains its read-only lane navigation and selection reset', () => {
    state.posts.push({ ...makePost('Parked option', 'Lyf Fit', '', 'pending'), source: 'suggestion', forClientId: 'lyf-fit', reviewStage: 'private' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Select', exact: true }));
    fireEvent.click(within(grid()).getByRole('button', { name: 'Alpha changes', exact: true }));
    const review = screen.getByRole('button', { name: 'Review', exact: true });
    expect(review.parentElement).toHaveClass('flex-wrap');
    expect(review).toHaveClass('min-h-[44px]', 'focus-visible:outline-2');
    fireEvent.click(review);
    expect(titles()).toEqual(['Parked option']);
    expect(grid().dataset.selected).toBe('');
    expect(grid().dataset.selectable).toBe('false');
    expect(screen.queryByLabelText('Dismiss suggestions notice')).toBeNull();
  });

  it('dismisses only the notice without changing the current feed or writing data', () => {
    state.posts.push({ ...makePost('Parked option', 'Lyf Fit', '', 'pending'), source: 'suggestion', forClientId: 'lyf-fit', reviewStage: 'private' });
    render(<App />);
    const before = titles();
    const dismiss = screen.getByLabelText('Dismiss suggestions notice');
    expect(dismiss).toHaveClass('min-h-[44px]', 'min-w-[44px]', 'focus-visible:outline-2');
    fireEvent.click(dismiss);
    expect(screen.queryByLabelText('Dismiss suggestions notice')).toBeNull();
    expect(titles()).toEqual(before);
  });

  it.each(['member', 'guest'])('keeps the suggestions notice hidden from %s', kind => {
    state.posts.push({ ...makePost('Parked option', 'Lyf Fit', '', 'pending'), source: 'suggestion', forClientId: 'lyf-fit', reviewStage: 'private' });
    state.auth.isOperator = false;
    state.auth.isClientMember = kind === 'member';
    state.auth.isReadOnly = kind === 'guest';
    render(<App />);
    expect(screen.queryByLabelText('Dismiss suggestions notice')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review', exact: true })).toBeNull();
  });

  it.each(['Archives fixture', 'Templates fixture'])('keeps the suggestions notice hidden on %s', label => {
    state.posts.push({ ...makePost('Parked option', 'Lyf Fit', '', 'pending'), source: 'suggestion', forClientId: 'lyf-fit', reviewStage: 'private' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.queryByLabelText('Dismiss suggestions notice')).toBeNull();
  });
});
