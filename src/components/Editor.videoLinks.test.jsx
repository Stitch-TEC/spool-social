import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Editor from './Editor';
import { recoveryScope } from '../utils/editorRecovery';

const video = 'https://drive.google.com/file/d/synthetic-video/view?usp=sharing';
const props = {
  post: { id: 'video-post', content: 'Keep my caption  ', client: 'Acme', clientId: 'acme', platform: 'gmb', status: 'draft', reviewStage: 'private', tags: ['keep'], imageUrl: '' },
  recoveryPrincipalId: 'video-test', recoveryClientIdFor: name => ({ Acme: 'acme', Beta: 'beta' })[name] || '',
  clientIdFor: name => ({ Acme: 'acme', Beta: 'beta' })[name] || '',
  onSave: vi.fn(), onCancel: vi.fn(), showToast: vi.fn(), clientMap: {}, uniqueClients: ['Acme', 'Beta'], isReadOnly: false,
};
const editorText = () => document.querySelector('textarea');
const open = () => fireEvent.click(screen.getByText('Add video link to draft text'));
const enter = value => fireEvent.change(screen.getByLabelText('Video sharing link'), { target: { value } });
const insert = () => fireEvent.click(screen.getByRole('button', { name: 'Insert link into draft text' }));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('Editor video-link text convenience', () => {
  it('preserves two consecutive distinct insertions in StrictMode without duplicating either URL', () => {
    const second = 'https://youtu.be/synthetic-second';
    render(<StrictMode><Editor {...props} /></StrictMode>);
    open(); enter(video); insert();
    enter(second); insert();
    expect(editorText()).toHaveValue(`Keep my caption  \n\n${video}\n\n${second}`);
    enter(video); insert();
    expect(editorText()).toHaveValue(`Keep my caption  \n\n${video}\n\n${second}`);
    expect(screen.getByRole('status')).toHaveTextContent('This link is already in the draft text.');
  });

  it('appends without trimming existing work, persists through ordinary recovery and does not save or fetch', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<Editor {...props} />);
    open(); enter(video); insert();
    expect(editorText()).toHaveValue(`Keep my caption  \n\n${video}`);
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(document.querySelector(`a[href="${video}"]`)).not.toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.pageHide(window);
    const key = recoveryScope({ principalId: 'video-test', clientId: 'acme', postId: 'video-post' }).key;
    expect(JSON.parse(localStorage.getItem(key)).work).toMatchObject({ content: `Keep my caption  \n\n${video}`, tags: ['keep'] });
  });

  it.each(['', 'Caption\n', 'Caption\n\n'])('preserves existing separation for %j', content => {
    render(<Editor {...props} post={{ ...props.post, content }} />);
    open(); enter(video); insert();
    expect(editorText()).toHaveValue(`${content ? 'Caption\n\n' : ''}${video}`);
  });

  it('uses current text, preserves other form fields and sends only the normal save payload', async () => {
    const onSave = vi.fn(async form => ({ ok: true, post: { ...form } }));
    render(<Editor {...props} onSave={onSave} />);
    open(); enter(video);
    fireEvent.change(editorText(), { target: { value: 'Newer caption' } });
    insert();
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved).toMatchObject({ id: 'video-post', client: 'Acme', clientId: 'acme', content: `Newer caption\n\n${video}`, tags: ['keep'], reviewStage: 'private' });
    expect(saved).not.toHaveProperty('videoUrl');
    expect(saved).not.toHaveProperty('attachments');
    expect(saved).not.toHaveProperty('media');
  });

  it('keeps normal Save disabled when inserted text exceeds the channel limit', () => {
    render(<Editor {...props} post={{ ...props.post, content: 'x'.repeat(1490) }} />);
    open(); enter(video); insert();
    expect(editorText()).toHaveValue(`${'x'.repeat(1490)}\n\n${video}`);
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('does not offer insertion in a read-only editor but still exposes saved links', () => {
    render(<Editor {...props} isReadOnly post={{ ...props.post, content: video }} />);
    expect(screen.queryByText('Add video link to draft text')).toBeNull();
    expect(document.querySelector(`a[href="${video}"]`)).not.toBeNull();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('drops an uninserted URL on a client change without copying it into either caption', () => {
    render(<Editor {...props} />);
    open(); enter(video);
    fireEvent.change(screen.getByPlaceholderText('Select or type a new client...'), { target: { value: 'Beta' } });
    open();
    expect(screen.getByLabelText('Video sharing link')).toHaveValue('');
    expect(editorText()).toHaveValue('Keep my caption  ');
  });

  it('prevents helper insertion while Save is pending', async () => {
    const onSave = vi.fn(() => new Promise(() => {}));
    render(<Editor {...props} onSave={onSave} />);
    open(); enter(video);
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Video sharing link')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Insert link into draft text' })).toBeDisabled();
    expect(editorText()).toHaveValue('Keep my caption  ');
  });
});
