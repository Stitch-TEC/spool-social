import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import RepurposeBlog from './RepurposeBlog';

const api = vi.hoisted(() => ({ pending: [] }));
vi.mock('../utils/generationApi', () => ({ generateText: () => new Promise(resolve => api.pending.push(resolve)) }));
afterEach(() => { cleanup(); api.pending = []; });

describe('repurpose generation cancellation boundary', () => {
  it.each(['cancel', 'client', 'platform', 'unmount'])('does not generate more or create drafts after %s', async change => {
    const props = { title: 'Synthetic', content: 'Synthetic blog', client: 'Alpha', clientId: 'alpha', onCreateDrafts: vi.fn(), showToast: vi.fn() };
    const view = render(<RepurposeBlog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Repurpose → social' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 drafts' }));
    expect(api.pending).toHaveLength(1);
    if (change === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    if (change === 'client') view.rerender(<RepurposeBlog {...props} client="Beta" clientId="beta" />);
    if (change === 'platform') {
      view.rerender(<RepurposeBlog {...props} platform="job" />);
      expect(screen.getByRole('button', { name: 'Create 2 drafts' })).toBeEnabled();
    }
    if (change === 'unmount') view.unmount();
    await act(async () => api.pending[0]('Alpha generated copy'));
    expect(api.pending).toHaveLength(1);
    expect(props.onCreateDrafts).not.toHaveBeenCalled();
    expect(props.showToast).not.toHaveBeenCalled();
  });
  it('still creates the requested draft set for an unchanged session', async () => {
    const onCreateDrafts = vi.fn(async drafts => drafts.length);
    render(<RepurposeBlog title="Synthetic" content="Synthetic blog" client="Alpha" clientId="alpha" onCreateDrafts={onCreateDrafts} showToast={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Repurpose → social' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 drafts' }));
    await act(async () => api.pending[0]('LinkedIn synthetic'));
    await act(async () => api.pending[1]('Twitter synthetic'));
    expect(onCreateDrafts).toHaveBeenCalledWith([
      { platform: 'linkedin', content: 'LinkedIn synthetic', client: 'Alpha' },
      { platform: 'twitter', content: 'Twitter synthetic', client: 'Alpha' },
    ]);
  });
});
