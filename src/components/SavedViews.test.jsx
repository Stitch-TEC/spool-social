import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SavedViews from './SavedViews';
import { parseSavedViews, savedViewsKey, serializeSavedViews } from '../utils/savedViews';

const key = savedViewsKey('synthetic-project', 'operator-a');
const filters = { clientSlug: 'lyf-fit', review: 'changes', status: null, platform: null, media: null, needs: null, sort: 'scheduled_asc' };
const view = { name: 'Lyf Fit — Changes', filters };
const base = () => ({ projectId: 'synthetic-project', uid: 'operator-a', isCurrent: () => true,
  roster: { clients: [{ slug: 'lyf-fit', name: 'Lyf Fit' }], loading: false, error: null },
  currentFilters: { clientName: 'Lyf Fit', review: 'changes', status: null, platform: null, media: null, needs: null, sort: 'scheduled_asc' },
  canSave: true, onApply: vi.fn() });
const open = () => { const details = screen.getByText('Saved views · this browser only').closest('details'); details.open = true; fireEvent(details, new Event('toggle')); };
const save = name => { fireEvent.change(screen.getByLabelText('New view name'), { target: { value: name } }); fireEvent.click(screen.getByRole('button', { name: 'Save current filters' })); };
const choose = (name = view.name) => fireEvent.change(screen.getByLabelText('Saved view'), { target: { value: name } });
const seed = (views = [view], scope = key) => localStorage.setItem(scope, serializeSavedViews(views));

describe('SavedViews — real component with synthetic browser storage', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('does not read storage or auto-apply until explicit disclosure/application', () => {
    seed(); const read = vi.spyOn(Storage.prototype, 'getItem'); const props = base();
    render(<SavedViews {...props} />); expect(read).not.toHaveBeenCalled(); expect(props.onApply).not.toHaveBeenCalled();
    open(); choose(); expect(props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply view' }));
    expect(props.onApply).toHaveBeenCalledWith({ ...filters, clientName: 'Lyf Fit' });
  });
  it('saves only bounded preferences and normalizes the name', () => {
    const props = base(); props.currentFilters.search = 'private content'; props.currentFilters.tag = 'private tag'; props.currentFilters.records = ['not allowed'];
    render(<SavedViews {...props} />); open(); save('  Lyf Fit — Changes  ');
    expect(parseSavedViews(localStorage.getItem(key))).toEqual([view]);
    expect(localStorage.getItem(key)).not.toContain('private');
    expect(screen.getByRole('status')).toHaveTextContent('View saved in this browser only.');
    expect(props.onApply).not.toHaveBeenCalled();
  });
  it('supports explicitly all-client approved blogs without needing a client roster', () => {
    const props = base(); props.currentFilters = { ...props.currentFilters, clientName: null, review: 'approved', platform: 'blog' }; props.roster = { loading: true };
    render(<SavedViews {...props} />); open(); save('Approved blogs');
    const saved = parseSavedViews(localStorage.getItem(key))[0];
    expect(saved.filters).toMatchObject({ clientSlug: null, review: 'approved', platform: 'blog' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply view' }));
    expect(props.onApply).toHaveBeenCalledWith({ ...saved.filters, clientName: null });
  });
  it.each(['missing', 'loading', 'error', 'ambiguous', 'duplicate-slug'])('refuses client-specific save/apply for %s roster without changing filters', scenario => {
    seed(); const props = base();
    if (scenario === 'missing') props.roster.clients = [];
    if (scenario === 'loading') props.roster.loading = true;
    if (scenario === 'error') props.roster.error = 'no access';
    if (scenario === 'ambiguous') props.roster.clients.push({ slug: 'other', name: 'LYF FIT' });
    if (scenario === 'duplicate-slug') props.roster.clients.push({ slug: 'lyf-fit', name: 'Other' });
    render(<SavedViews {...props} />); open(); choose();
    fireEvent.click(screen.getByRole('button', { name: 'Apply view' })); expect(props.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('filters have not changed');
    save('Another'); expect(parseSavedViews(localStorage.getItem(key))).toEqual([view]);
  });
  it('resolves a renamed client by stored slug, not the old view name', () => {
    seed(); const props = base(); props.roster.clients = [{ slug: 'lyf-fit', name: 'Lyf Studio' }];
    render(<SavedViews {...props} />); open(); choose(); fireEvent.click(screen.getByRole('button', { name: 'Apply view' }));
    expect(props.onApply).toHaveBeenCalledWith({ ...filters, clientName: 'Lyf Studio' });
  });
  it('refuses duplicate names and the thirteenth view without overwriting', () => {
    const views = Array.from({ length: 12 }, (_, i) => ({ ...view, name: `View ${i}` })); seed(views);
    render(<SavedViews {...base()} />); open(); save('view 0');
    expect(screen.getByRole('status')).toHaveTextContent('already used');
    save('Thirteenth'); expect(screen.getByRole('status')).toHaveTextContent('12 saved views');
    expect(parseSavedViews(localStorage.getItem(key))).toEqual(views);
  });
  it.each(['{', '{"version":2,"views":[]}'])('does not overwrite invalid storage during a save (%s)', raw => {
    localStorage.setItem(key, raw); render(<SavedViews {...base()} />); open(); save('New');
    expect(localStorage.getItem(key)).toBe(raw); expect(screen.getByRole('status')).toHaveTextContent('could not be read');
  });
  it('offers read-only retry after blocked storage and succeeds when storage returns', () => {
    seed(); const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<SavedViews {...base()} />); open();
    expect(screen.getByRole('status')).toHaveTextContent('could not be read');
    read.mockRestore(); fireEvent.click(screen.getByRole('button', { name: 'Retry reading saved views' }));
    expect(screen.getByRole('option', { name: view.name })).toBeInTheDocument();
  });
  it.each(['save', 'delete'])('never announces persisted success after %s storage failure', action => {
    seed(); render(<SavedViews {...base()} />); open(); choose();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    if (action === 'save') save('Another'); else fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    expect(screen.getByRole('status')).toHaveTextContent('Nothing was saved or deleted');
    expect(parseSavedViews(localStorage.getItem(key))).toEqual([view]);
  });
  it('freshly merges a save and delete with another tab’s earlier committed changes', () => {
    seed(); render(<SavedViews {...base()} />); open(); choose();
    const other = { ...view, name: 'Other tab' }; seed([view, other]);
    save('Third'); expect(parseSavedViews(localStorage.getItem(key))).toHaveLength(3);
    choose(); fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    expect(parseSavedViews(localStorage.getItem(key)).map(item => item.name)).toEqual(['Other tab', 'Third']);
    expect(screen.getByRole('status')).toHaveTextContent('No posts were changed');
  });
  it('cannot replay a selected view removed by another tab', () => {
    seed(); const props = base(); render(<SavedViews {...props} />); open(); choose(); seed([]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply view' }));
    expect(props.onApply).not.toHaveBeenCalled(); expect(screen.getByRole('status')).toHaveTextContent('no longer available');
  });
  it.each(['save', 'apply', 'delete'])('blocks %s when auth changes before React renders', action => {
    seed(); let current = true; const props = { ...base(), isCurrent: () => current };
    render(<SavedViews {...props} />); open(); choose(); current = false;
    if (action === 'save') save('Wrong session'); else fireEvent.click(screen.getByRole('button', { name: action === 'apply' ? 'Apply view' : 'Delete view' }));
    expect(props.onApply).not.toHaveBeenCalled(); expect(parseSavedViews(localStorage.getItem(key))).toEqual([view]);
  });
  it('keyed account/session transitions show no prior view/name/notice', () => {
    seed(); const props = base(); const app = render(<SavedViews key="a:1" {...props} />); open(); choose();
    fireEvent.change(screen.getByLabelText('New view name'), { target: { value: 'Private name' } });
    app.rerender(<SavedViews key="b:2" {...props} uid="operator-b" />); open();
    expect(screen.queryByRole('option', { name: view.name })).not.toBeInTheDocument(); expect(screen.getByLabelText('New view name')).toHaveValue('');
    expect(screen.queryByRole('status')).toBeNull(); expect(localStorage.getItem(key)).not.toBeNull();
  });
  it('disables save outside the active queue but leaves existing views available', () => {
    seed(); render(<SavedViews {...base()} canSave={false} />); open(); choose();
    expect(screen.getByRole('button', { name: 'Save current filters' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply view' })).not.toBeDisabled();
    expect(screen.getByText(/To save filters/)).toBeInTheDocument();
  });
});
