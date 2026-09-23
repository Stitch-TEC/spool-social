import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AIGenerate from './AIGenerate';

const api = vi.hoisted(() => ({ pending: [], ideas: vi.fn(), index: vi.fn() }));
vi.mock('../utils/generationApi', () => ({
  generateText: () => new Promise(resolve => api.pending.push(resolve)),
  generateImage: vi.fn(),
  fetchIdeas: api.ideas, fetchContentIndex: api.index,
  fetchPage: vi.fn(), fetchIndexPage: vi.fn(),
}));
beforeEach(() => {
  api.pending = []; vi.useFakeTimers();
  api.ideas.mockReset().mockResolvedValue({ signals: { site: { pages: [{ title: 'Synthetic page', url: 'https://example.test/page', description: 'Synthetic description' }] } } });
  api.index.mockReset().mockResolvedValue({ pages: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('idea generation context reset', () => {
  it.each(['Post ideas ✨', 'Suggest ideas'])('re-enables %s on platform change without re-fetching client signals', async action => {
    const props = { kind: 'text', clientName: 'Alpha', clientId: action === 'Suggest ideas' ? 'alpha-deck' : 'alpha-angles', platform: 'gmb', onResult: vi.fn(), showToast: vi.fn() };
    const view = render(<AIGenerate {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI draft' }));
    await act(async () => vi.advanceTimersByTimeAsync(650));
    vi.useRealTimers();
    expect(api.ideas).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
    expect(api.pending).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Thinking…', exact: true })).toBeDisabled();
    view.rerender(<AIGenerate {...props} platform="twitter" />);
    expect(screen.getByRole('button', { name: action, exact: true })).toBeEnabled();
    await act(async () => api.pending[0]('Old discarded idea'));
    expect(screen.queryByText(/Old discarded idea/)).not.toBeInTheDocument();
    expect(api.ideas).toHaveBeenCalledTimes(1);
    expect(api.index).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
    expect(api.pending).toHaveLength(2);
    await act(async () => api.pending[1]('Fresh current idea'));
    expect(screen.getByRole('button', { name: /Fresh current idea/ })).toBeInTheDocument();
  });
});
