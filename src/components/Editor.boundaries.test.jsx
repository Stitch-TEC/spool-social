import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Editor from './Editor';
import { recoveryScope } from '../utils/editorRecovery';

const api = vi.hoisted(() => ({ text: [], images: [], alt: [] }));
vi.mock('../utils/generationApi', () => ({
  generateText: (prompt, options) => new Promise(resolve => api.text.push({ prompt, options, resolve })),
  generateImage: (prompt, options) => new Promise(resolve => api.images.push({ prompt, options, resolve })),
  describeImage: (image, options) => new Promise(resolve => api.alt.push({ image, options, resolve })),
  fetchIdeas: async () => ({}), fetchPage: async () => ({}),
  fetchContentIndex: async () => ({}), fetchIndexPage: async () => ({}),
  ensureHostedImage: async image => image,
}));
const propsFor = (user = 'owner') => ({
  post: null, initialClient: 'Alpha', recoveryPrincipalId: user,
  recoveryClientIdFor: name => ({ Alpha: 'alpha', Beta: 'beta' })[name] || '',
  clientIdFor: name => ({ Alpha: 'alpha', Beta: 'beta' })[name] || '',
  onSave: vi.fn(async form => ({ ok: true, post: { ...form, id: 'created', clientId: form.client.toLowerCase() } })),
  onCancel: vi.fn(), showToast: vi.fn(), clientMap: {}, uniqueClients: ['Alpha', 'Beta'], isReadOnly: false,
});
const client = () => screen.getByPlaceholderText('Select or type a new client...');
const text = () => document.querySelector('textarea');
const changeText = value => fireEvent.change(text(), { target: { value } });
const scope = (principalId = 'owner', clientId = 'alpha', postId) => recoveryScope({ principalId, clientId, postId });
const startText = () => {
  fireEvent.click(screen.getByRole('button', { name: 'AI draft' }));
  fireEvent.change(screen.getByPlaceholderText(/What should this post|Topic to generate/), { target: { value: 'Synthetic topic' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate', exact: true }));
};

describe('Editor account/client recovery and asynchronous generation boundaries', () => {
  beforeEach(() => { localStorage.clear(); api.text = []; api.images = []; api.alt = []; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

  it('offers recovery only to the same principal and immutable client, preserving foreign and legacy work', () => {
    localStorage.setItem('spool:autosave:new', JSON.stringify({ client: 'Alpha', content: 'Legacy private work' }));
    const alpha = render(<Editor {...propsFor()} />);
    changeText('Alpha private work');
    fireEvent.pageHide(window);
    alpha.unmount();
    const saved = localStorage.getItem(scope().key);
    expect(saved).toContain('Alpha private work');
    const beta = render(<Editor {...propsFor('beta-member')} initialClient="Beta" clientLocked />);
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    expect(text()).toHaveValue('');
    expect(localStorage.getItem(scope().key)).toBe(saved);
    expect(localStorage.getItem('spool:autosave:new')).toContain('Legacy private work');
    beta.unmount();
    const otherClient = render(<Editor {...propsFor()} initialClient="Beta" />);
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    otherClient.unmount();
    render(<Editor {...propsFor()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(text()).toHaveValue('Alpha private work');
  });

  it.each(['unknown principal', 'unknown client'])('fails recovery closed for %s without deleting any copy', reason => {
    const props = propsFor(reason === 'unknown principal' ? '' : 'owner');
    if (reason === 'unknown client') props.recoveryClientIdFor = () => '';
    localStorage.setItem(scope().key, JSON.stringify({ scope: scope(), work: { content: 'Scoped work' } }));
    render(<Editor {...props} />);
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    changeText('Unsaved unknown identity');
    fireEvent.pageHide(window);
    expect(Object.keys(localStorage).filter(k => k.startsWith('spool:autosave:'))).toEqual([scope().key]);
    expect(localStorage.getItem(scope().key)).toContain('Scoped work');
  });

  it('waits for a recognized client selection and does not restore an old banner after switching clients', () => {
    localStorage.setItem(scope().key, JSON.stringify({ scope: scope(), work: { content: 'Scoped Alpha', client: 'Old Alpha label' } }));
    render(<Editor {...propsFor()} initialClient="" />);
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    fireEvent.change(client(), { target: { value: 'Alpha' } });
    expect(screen.getByRole('button', { name: 'Restore', exact: true })).toBeInTheDocument();
    fireEvent.change(client(), { target: { value: 'Beta' } });
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
    fireEvent.change(client(), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(text()).toHaveValue('Scoped Alpha');
    expect(client()).toHaveValue('Alpha');
  });

  it('retires submitted new recovery and keeps newer reassigned edits at the acknowledged ID', async () => {
    let resolve;
    const props = propsFor();
    props.onSave = vi.fn(() => new Promise(done => { resolve = done; }));
    render(<Editor {...props} />);
    changeText('Submitted Alpha');
    fireEvent.pageHide(window);
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    const submitted = props.onSave.mock.calls[0][0];
    fireEvent.change(client(), { target: { value: 'Beta' } });
    changeText('Newer Beta');
    fireEvent.pageHide(window);
    await act(async () => resolve({ ok: true, post: { ...submitted, id: 'acknowledged', clientId: 'alpha' } }));
    expect(localStorage.getItem(scope().key)).toBeNull();
    expect(localStorage.getItem(scope('owner', 'beta').key)).toBeNull();
    expect(localStorage.getItem(scope('owner', 'beta', 'acknowledged').key)).toContain('Newer Beta');
    expect(text()).toHaveValue('Newer Beta');
    expect(screen.queryByRole('button', { name: 'Restore', exact: true })).not.toBeInTheDocument();
  });

  it.each(['client', 'platform', 'cancel', 'client round trip', 'unmount'])('ignores delayed generated text after %s', async change => {
    const props = propsFor();
    const editor = render(<Editor {...props} />);
    startText();
    expect(api.text[0].options.clientId).toBe('alpha');
    if (change.startsWith('client')) {
      fireEvent.change(client(), { target: { value: 'Beta' } });
      if (change === 'client round trip') fireEvent.change(client(), { target: { value: 'Alpha' } });
    } else if (change === 'platform') fireEvent.click(screen.getByRole('button', { name: 'Blog', exact: true }));
    else if (change === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    if (change === 'unmount') editor.unmount();
    else changeText('Keep current manual text');
    await act(async () => api.text[0].resolve('Old Alpha generated text'));
    if (change !== 'unmount') expect(text()).toHaveValue('Keep current manual text');
    expect(props.showToast).not.toHaveBeenCalledWith('Draft generated');
  });

  it.each(['Improve', 'Add hashtags'])('ignores delayed %s output after the client changes', async action => {
    render(<Editor {...propsFor()} />);
    changeText('Alpha source');
    fireEvent.click(screen.getByRole('button', { name: 'AI draft' }));
    fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
    fireEvent.change(client(), { target: { value: 'Beta' } });
    changeText('Beta current text');
    await act(async () => api.text[0].resolve('#Alpha old output'));
    expect(text()).toHaveValue('Beta current text');
  });

  it('ignores old images while allowing a fresh request after cancellation', async () => {
    const props = propsFor();
    render(<Editor {...props} />);
    changeText('Draft');
    const start = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
      fireEvent.change(screen.getByPlaceholderText('Describe the image you want…'), { target: { value: 'Synthetic image' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate', exact: true }));
    };
    start();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    fireEvent.change(client(), { target: { value: 'Beta' } });
    start();
    await act(async () => api.images[0].resolve('https://example.test/alpha.png'));
    expect(screen.getByRole('button', { name: 'Working…', exact: true })).toBeDisabled();
    await act(async () => api.images[1].resolve('https://example.test/beta.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ client: 'Beta', imageUrl: 'https://example.test/beta.png' }), expect.any(Object)));
  });

  it.each(['metadata', 'alt text'])('keeps current %s when the originating client changes', async kind => {
    render(<Editor {...propsFor()} post={{ id: 'alpha-post', client: 'Alpha', clientId: 'alpha', platform: 'blog', title: 'Title', content: 'Alpha content', imageUrl: 'https://example.test/image.png' }} />);
    const label = screen.getByText(kind === 'metadata' ? 'Meta description (SEO)' : 'Alt text', { exact: true });
    fireEvent.click(within(label.parentElement).getByRole('button', { name: 'Generate' }));
    const pending = kind === 'metadata' ? api.text : api.alt;
    expect(pending).toHaveLength(1);
    fireEvent.change(client(), { target: { value: 'Beta' } });
    const field = screen.getByPlaceholderText(kind === 'metadata' ? 'One-sentence summary for search results…' : 'Describe the image for accessibility / SEO…');
    fireEvent.change(field, { target: { value: 'Beta manual metadata' } });
    await act(async () => pending[0].resolve('Old Alpha metadata'));
    expect(field).toHaveValue('Beta manual metadata');
  });
});
