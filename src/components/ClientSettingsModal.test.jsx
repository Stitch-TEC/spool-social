import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import ClientSettingsModal from './ClientSettingsModal';
import { processImageFile } from '../utils/helpers';
import { setDoc } from 'firebase/firestore';

vi.mock('../config/firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: (...args) => args, setDoc: vi.fn() }));
vi.mock('../utils/helpers', () => ({ processImageFile: vi.fn() }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const props = {
  uniqueClients: ['Synthetic Alpha', 'Synthetic Beta'],
  clientMap: {
    'Synthetic Alpha': { clientId: 'synthetic-alpha', aiBrandVoice: 'Alpha voice' },
    'Synthetic Beta': { clientId: 'synthetic-beta', aiBrandVoice: 'Beta voice' },
  },
  uid: 'synthetic-operator',
  isReadOnly: false,
};
const upload = (name = 'alpha') => fireEvent.change(screen.getByLabelText('Choose brand logo'), {
  target: { files: [new File([name], `${name}.png`, { type: 'image/png' })] },
});
const drop = (container, name = 'alpha') => fireEvent.drop(container.querySelector('[class*="border-dashed"]'), {
  dataTransfer: { files: [new File([name], `${name}.png`, { type: 'image/png' })] },
});
const select = name => fireEvent.change(screen.getByLabelText('Select Client'), { target: { value: name } });
const saveButton = () => screen.getByRole('button', { name: 'Save Brand Info' });

describe('Client brand settings asynchronous ownership', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('saves the selected settings with the existing tenant/doc and merge contract', async () => {
    setDoc.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ClientSettingsModal {...props} onClose={onClose} />);
    select('Synthetic Beta');
    await act(async () => { fireEvent.click(saveButton()); });
    expect(setDoc).toHaveBeenCalledExactlyOnceWith(
      [{}, 'clients', 'synthetic-operator__Synthetic%20Beta'],
      { uid: 'synthetic-operator', name: 'Synthetic Beta', clientId: 'synthetic-beta', logoUrl: '', brandColor: '#4f46e5', aiBrandVoice: 'Beta voice', aiAudience: '', aiTone: 'professional', aiKeywords: '', aiAvoid: '' },
      { merge: true },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores an upload after changing clients and blocks saving while processing', async () => {
    const image = deferred();
    processImageFile.mockReturnValue(image.promise);
    setDoc.mockResolvedValue(undefined);
    render(<ClientSettingsModal {...props} onClose={vi.fn()} />);
    upload();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Processing logo');
    select('Synthetic Beta');
    expect(saveButton()).toBeEnabled();
    await act(async () => { image.resolve('data:image/png;base64,ALPHA'); });
    expect(screen.queryByAltText('Client Logo')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(saveButton()); });
    expect(setDoc.mock.calls[0][1]).toMatchObject({ name: 'Synthetic Beta', logoUrl: '', aiBrandVoice: 'Beta voice' });
  });

  it('ignores an old dropped image after A to B to A switches', async () => {
    const image = deferred();
    processImageFile.mockReturnValue(image.promise);
    const { container } = render(<ClientSettingsModal {...props} onClose={vi.fn()} />);
    drop(container);
    select('Synthetic Beta');
    select('Synthetic Alpha');
    await act(async () => { image.resolve('data:image/png;base64,OLD'); });
    expect(screen.queryByAltText('Client Logo')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('uses the newest upload/drop even when old processing resolves last', async () => {
    const first = deferred(), second = deferred();
    processImageFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { container } = render(<ClientSettingsModal {...props} onClose={vi.fn()} />);
    upload();
    drop(container, 'new');
    await act(async () => { second.resolve('data:image/png;base64,NEW'); });
    await act(async () => { first.resolve('data:image/png;base64,OLD'); });
    expect(screen.getByAltText('Client Logo')).toHaveAttribute('src', 'data:image/png;base64,NEW');
    expect(saveButton()).toBeEnabled();
  });

  it('does not let stale failure clear a newer processing state', async () => {
    const first = deferred(), second = deferred();
    processImageFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<ClientSettingsModal {...props} onClose={vi.fn()} />);
    upload();
    upload('new');
    await act(async () => { first.reject(new Error('old failure')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    await act(async () => { second.resolve('data:image/png;base64,NEW'); });
    expect(saveButton()).toBeEnabled();
  });

  it('does not undo Remove Logo when earlier dropped image finishes', async () => {
    const image = deferred();
    processImageFile.mockReturnValue(image.promise);
    const { container } = render(<ClientSettingsModal {...props} clientMap={{ ...props.clientMap, 'Synthetic Alpha': { logoUrl: 'data:image/png;base64,EXISTING' } }} onClose={vi.fn()} />);
    drop(container);
    fireEvent.click(screen.getByTitle('Remove Logo'));
    await act(async () => { image.resolve('data:image/png;base64,LATE'); });
    expect(screen.queryByAltText('Client Logo')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('shows an actionable current processing failure and allows same-file retry', async () => {
    processImageFile.mockRejectedValueOnce(new Error('bad image')).mockResolvedValueOnce('data:image/png;base64,RETRY');
    render(<ClientSettingsModal {...props} onClose={vi.fn()} />);
    await act(async () => { upload(); });
    expect(screen.getByRole('alert')).toHaveTextContent('Try another PNG or JPG image');
    expect(saveButton()).toBeEnabled();
    await act(async () => { upload(); });
    expect(processImageFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByAltText('Client Logo')).toHaveAttribute('src', 'data:image/png;base64,RETRY');
  });

  it.each(['resolve', 'reject'])('ignores late logo %s after closing', async outcome => {
    const image = deferred();
    processImageFile.mockReturnValue(image.promise);
    const onClose = vi.fn();
    render(<ClientSettingsModal {...props} onClose={onClose} />);
    upload();
    fireEvent.click(screen.getByRole('button', { name: 'Close brand settings' }));
    await act(async () => { image[outcome](outcome === 'resolve' ? 'data:image/png;base64,LATE' : new Error('late')); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByAltText('Client Logo')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pauses editing and merge actions during save but keeps Close available', async () => {
    const save = deferred();
    setDoc.mockReturnValue(save.promise);
    const { container } = render(<ClientSettingsModal {...props} onMergeClient={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Target client name…'), { target: { value: 'Synthetic Beta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Merge into "Synthetic Beta"' }));
    fireEvent.click(saveButton());
    expect(screen.getByLabelText('Select Client')).toBeDisabled();
    expect(container.querySelector('textarea')).toBeDisabled();
    expect(container.querySelector('input[type=color]')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('closing does not cancel the save');
    drop(container);
    expect(processImageFile).not.toHaveBeenCalled();
    expect(setDoc).toHaveBeenCalledTimes(1);
    await act(async () => { save.resolve(); });
  });

  it('keeps values after a current save failure and supports explicit retry', async () => {
    setDoc.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const { container } = render(<ClientSettingsModal {...props} onClose={onClose} />);
    fireEvent.change(container.querySelector('textarea'), { target: { value: 'Changed voice' } });
    await act(async () => { fireEvent.click(saveButton()); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('could not confirm');
    expect(container.querySelector('textarea')).toHaveValue('Changed voice');
    expect(container.querySelector('textarea')).toBeEnabled();
    await act(async () => { fireEvent.click(saveButton()); });
    expect(setDoc).toHaveBeenCalledTimes(2);
    expect(setDoc.mock.calls[1][1].aiBrandVoice).toBe('Changed voice');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'])('old save %s cannot close or change a newly opened settings window', async outcome => {
    const save = deferred();
    setDoc.mockReturnValue(save.promise);
    const Wrapper = () => {
      const [open, setOpen] = useState(true);
      return open ? <ClientSettingsModal {...props} onClose={() => setOpen(false)} /> : <button onClick={() => setOpen(true)}>Open settings</button>;
    };
    render(<Wrapper />);
    fireEvent.click(saveButton());
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    select('Synthetic Beta');
    await act(async () => { save[outcome](outcome === 'resolve' ? undefined : new Error('late offline')); });
    expect(screen.getByRole('dialog', { name: 'Client Brand Settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Select Client')).toHaveValue('Synthetic Beta');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('ignores late save after direct unmount without a close event', async () => {
    const save = deferred();
    setDoc.mockReturnValue(save.promise);
    const onClose = vi.fn();
    const { unmount } = render(<ClientSettingsModal {...props} onClose={onClose} />);
    fireEvent.click(saveButton());
    unmount();
    await act(async () => { save.resolve(); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('invalidates a pending logo when the manually entered client name changes', async () => {
    const image = deferred();
    processImageFile.mockReturnValue(image.promise);
    render(<ClientSettingsModal {...props} onClose={vi.fn()} />);
    select('NEW');
    fireEvent.change(screen.getByLabelText('Client Name'), { target: { value: 'New Alpha' } });
    upload();
    fireEvent.change(screen.getByLabelText('Client Name'), { target: { value: 'New Beta' } });
    expect(saveButton()).toBeEnabled();
    await act(async () => { image.resolve('data:image/png;base64,LATE'); });
    expect(screen.queryByAltText('Client Logo')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Client Name')).toHaveValue('New Beta');
  });

  it.each([{ uid: 'other-synthetic-operator' }, { isReadOnly: true }])('invalidates pending save and logo UI on ownership change %j', async changed => {
    const image = deferred(), save = deferred();
    processImageFile.mockReturnValue(image.promise);
    setDoc.mockReturnValue(save.promise);
    const onClose = vi.fn();
    const { rerender } = render(<ClientSettingsModal {...props} onClose={onClose} />);
    upload();
    rerender(<ClientSettingsModal {...props} {...changed} onClose={onClose} />);
    await act(async () => { image.resolve('data:image/png;base64,LATE'); });
    expect(screen.queryByAltText('Client Logo')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<ClientSettingsModal {...props} onClose={onClose} />);
    fireEvent.click(saveButton());
    rerender(<ClientSettingsModal {...props} {...changed} onClose={onClose} />);
    await act(async () => { save.reject(new Error('old save')); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    if (changed.isReadOnly) expect(saveButton()).toBeDisabled();
    else expect(saveButton()).toBeEnabled();
  });
});
