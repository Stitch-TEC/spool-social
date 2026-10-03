import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BulkActionBar from './BulkActionBar';

const propsFor = () => ({ count: 2, totalFiltered: 4, uniqueClients: ['Synthetic'],
  ...Object.fromEntries(['onReassignClient', 'onAddTags', 'onRemoveTags', 'onSetStatus', 'onSendForReview', 'onHold', 'onArchive', 'onDelete', 'onExport', 'onSelectAll', 'onClear'].map(name => [name, vi.fn()])),
});
const open = (action = 'add') => fireEvent.click(screen.getByRole('button', { name: action === 'add' ? 'Add tags' : 'Remove tags' }));
const input = (action = 'add') => screen.getByRole('textbox', { name: action === 'add' ? 'Tags to add' : 'Tags to remove' });
const enter = (value, action = 'add') => fireEvent.change(input(action), { target: { value } });
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply', exact: true }));
const exactTags = () => Array.from({ length: 10 }, (_, index) => `${index}${'a'.repeat(19)}`);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

describe('BulkActionBar tag panels — actual component, synthetic handlers', () => {
  it('retains and submits all 209 characters at the exact tag limits', async () => {
    const props = propsFor(); render(<BulkActionBar {...props} />); open();
    const tags = exactTags(); const text = tags.join(','); enter(text);
    expect(input()).not.toHaveAttribute('maxlength');
    expect(input()).toHaveValue(text);
    expect(screen.getByText('10/10 tags · 20 characters each · commas or pipes')).toBeInTheDocument();
    apply();
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(props.onAddTags).toHaveBeenCalledExactlyOnceWith(tags);
    expect(props.onRemoveTags).not.toHaveBeenCalled();
  });
  it.each([
    ['a'.repeat(21), 'Each tag must contain 1–20 characters.'],
    [Array.from({ length: 11 }, (_, index) => `tag${index}`).join(','), 'Use no more than 10 tags.'],
    ['first, #first', 'Remove duplicate tags before saving.'],
    [' , | ', 'Enter at least one tag.'],
  ])('keeps invalid input %j in the open panel and calls no handler', (text, message) => {
    const props = propsFor(); render(<BulkActionBar {...props} />); open(); enter(text); apply();
    expect(input()).toHaveValue(text);
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByRole('alert'); expect(error).toHaveTextContent(message);
    expect(input().getAttribute('aria-describedby').split(' ')).toContain(error.id);
    expect(props.onAddTags).not.toHaveBeenCalled(); expect(props.onRemoveTags).not.toHaveBeenCalled();
  });
  it('keeps a long invalid tag intact instead of cutting it down to a valid value', () => {
    const props = propsFor(); render(<BulkActionBar {...props} />); open();
    const text = 'a'.repeat(250); enter(text); apply();
    expect(input()).toHaveValue(text); expect(props.onAddTags).not.toHaveBeenCalled();
  });
  it.each(['add', 'remove'])('normalizes entered separators and calls only the %s handler', async action => {
    const props = propsFor(); render(<BulkActionBar {...props} />); open(action); enter(' #first | second,, ', action); apply();
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    const handler = action === 'add' ? props.onAddTags : props.onRemoveTags;
    const other = action === 'add' ? props.onRemoveTags : props.onAddTags;
    expect(handler).toHaveBeenCalledExactlyOnceWith(['first', 'second']); expect(other).not.toHaveBeenCalled();
  });
  it.each([true, undefined])('closes after an awaited successful result %j', async result => {
    const pending = deferred(); const props = propsFor(); props.onAddTags.mockReturnValue(pending.promise);
    render(<BulkActionBar {...props} />); open(); enter('first'); apply();
    expect(input()).toHaveValue('first'); expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();
    await act(async () => pending.resolve(result));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('retains full input after an awaited false result and permits deliberate correction', async () => {
    const pending = deferred(); const props = propsFor(); props.onAddTags.mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    render(<BulkActionBar {...props} />); open(); enter('#first | second'); apply();
    await act(async () => pending.resolve(false));
    expect(input()).toHaveValue('#first | second'); expect(input()).not.toBeDisabled();
    enter('third'); apply(); await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(props.onAddTags).toHaveBeenNthCalledWith(2, ['third']);
  });
  it('restores focus only after the successful awaited action re-enables its opener', async () => {
    const pending = deferred(); const props = propsFor(); props.onAddTags.mockReturnValue(pending.promise);
    render(<BulkActionBar {...props} />); const trigger = screen.getByRole('button', { name: 'Add tags' }); trigger.focus(); open(); enter('first'); apply();
    expect(trigger).toBeDisabled();
    await act(async () => pending.resolve(true));
    expect(screen.queryByRole('textbox')).toBeNull(); expect(trigger).not.toBeDisabled(); expect(trigger).toHaveFocus();
  });
  it('returns focus to enabled Export when an operator closes a held panel', () => {
    const props = propsFor(); const view = render(<BulkActionBar {...props} />); open(); enter('first');
    view.rerender(<BulkActionBar {...props} disabled />); fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.getByRole('button', { name: 'Export' })).toHaveFocus(); expect(props.onAddTags).not.toHaveBeenCalled();
  });
  it('guards repeated clicks and form submission while awaiting a handler', async () => {
    const pending = deferred(); const props = propsFor(); props.onAddTags.mockReturnValue(pending.promise);
    render(<BulkActionBar {...props} />); open(); enter('first');
    const form = screen.getByRole('form', { name: 'Add tags' }); fireEvent.submit(form); fireEvent.submit(form);
    fireEvent.click(screen.getByRole('button', { name: 'Applying…' }));
    expect(props.onAddTags).toHaveBeenCalledTimes(1); expect(input()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Export/ })).not.toBeDisabled(); expect(screen.getByRole('button', { name: /Clear/ })).not.toBeDisabled();
    await act(async () => pending.resolve(false)); expect(input()).toHaveValue('first');
  });
  it('retains input with inline feedback when a handler rejects', async () => {
    const props = propsFor(); props.onRemoveTags.mockRejectedValue(new Error('The selection changed.'));
    render(<BulkActionBar {...props} />); open('remove'); enter('first', 'remove'); apply();
    expect(await screen.findByRole('alert')).toHaveTextContent('The selection changed.');
    expect(input('remove')).toHaveValue('first'); expect(input('remove')).not.toBeDisabled();
  });
  it('disables open-panel input and submit when the owner holds mutations', () => {
    const props = propsFor(); const view = render(<BulkActionBar {...props} />); open(); enter('first');
    view.rerender(<BulkActionBar {...props} disabled />);
    expect(input()).toBeDisabled(); expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'Add tags' })); expect(props.onAddTags).not.toHaveBeenCalled();
    expect(input()).toHaveValue('first');
  });
  it('holds mutation and selection controls while preserving Export and Clear', () => {
    const props = propsFor(); render(<BulkActionBar {...props} disabled />);
    for (const name of ['Client', 'Add tags', 'Remove tags', 'Status', 'Send for review', 'Staging', 'Archive', 'Delete', 'All 4']) {
      const button = screen.getByRole('button', { name, exact: true }); expect(button).toBeDisabled(); fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Export' })); fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onExport).toHaveBeenCalledTimes(1); expect(props.onClear).toHaveBeenCalledTimes(1);
    for (const name of ['onReassignClient', 'onAddTags', 'onRemoveTags', 'onSetStatus', 'onSendForReview', 'onHold', 'onArchive', 'onDelete', 'onSelectAll']) expect(props[name]).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('focuses the named field, exposes limits, and restores focus on keyboard close', () => {
    render(<BulkActionBar {...propsFor()} />); const trigger = screen.getByRole('button', { name: 'Remove tags' }); trigger.focus(); open('remove');
    expect(input('remove')).toHaveFocus();
    const limits = screen.getByText('0/10 tags · 20 characters each · commas or pipes');
    expect(input('remove')).toHaveAttribute('aria-describedby', limits.id);
    expect(input('remove')).toHaveClass('min-h-11', 'min-w-0');
    expect(screen.getByRole('form', { name: 'Remove tags' })).toHaveClass('flex-wrap', 'min-w-0');
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveClass('min-h-11', 'min-w-11');
    expect(trigger).toHaveClass('shrink-0');
    fireEvent.keyDown(input('remove'), { key: 'Escape' }); expect(screen.queryByRole('textbox')).toBeNull(); expect(trigger).toHaveFocus();
  });
  it('clears an input error after an explicit edit', () => {
    render(<BulkActionBar {...propsFor()} />); open(); enter('first,first'); apply(); enter('first');
    expect(screen.queryByRole('alert')).toBeNull(); expect(input()).toHaveAttribute('aria-invalid', 'false');
  });
  it('keeps the existing client-field cap and payload normalization', async () => {
    const props = propsFor(); render(<BulkActionBar {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Client' }));
    const field = screen.getByRole('combobox', { name: 'Client name' }); expect(field).toHaveAttribute('maxlength', '50');
    fireEvent.change(field, { target: { value: ' Synthetic/ Client ' } }); apply();
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Client name' })).toBeNull()); expect(props.onReassignClient).toHaveBeenCalledExactlyOnceWith('Synthetic Client');
  });
});
