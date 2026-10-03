import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Editor from './Editor';
import { editorWorkSignature } from '../utils/editorSaveState';

const props = { post: null, clientMap: {}, uniqueClients: ['Acme'], showToast: vi.fn(),
  onSave: vi.fn(), onCancel: vi.fn(), isReadOnly: false,
  recoveryPrincipalId: 'synthetic-editor', recoveryClientIdFor: name => name === 'Acme' ? 'acme' : '',
  getUsualPlatformForClient: name => name === 'Acme' ? 'linkedin' : null };

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const chooseClient = value => fireEvent.change(screen.getByPlaceholderText('Select or type a new client...'), { target: { value } });
const platform = name => screen.getByRole('button', { name, exact: true });

describe('display-only usual platform in the real editor', () => {
  it('marks the existing choice after explicit known-client input without automatically selecting it', () => {
    render(<Editor {...props} />);
    expect(screen.queryByText('Usual')).toBeNull();
    chooseClient('Ac'); expect(screen.queryByText('Usual')).toBeNull();
    chooseClient('Acme');
    expect(screen.getByText('Usual').closest('button')).toBe(platform('LinkedIn'));
    expect(platform('Google Business')).toHaveAttribute('aria-pressed', 'true');
    expect(platform('LinkedIn')).toHaveAttribute('aria-pressed', 'false');
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it('keeps a deliberate choice even when the suggestion or client changes', () => {
    const app = render(<Editor {...props} initialClient="Acme" />);
    fireEvent.click(platform('Google Business'));
    app.rerender(<Editor {...props} initialClient="Acme" getUsualPlatformForClient={() => 'facebook'} />);
    expect(platform('Google Business')).toHaveAttribute('aria-pressed', 'true');
    chooseClient('Unknown');
    expect(platform('Google Business')).toHaveAttribute('aria-pressed', 'true');
  });
  it('uses the existing explicit platform action when the marked button is chosen', () => {
    render(<Editor {...props} initialClient="Acme" />);
    fireEvent.click(platform('LinkedIn'));
    expect(platform('LinkedIn')).toHaveAttribute('aria-pressed', 'true');
    expect(platform('Google Business')).toHaveAttribute('aria-pressed', 'false');
  });
  it('does not alter an existing post’s caption, selected platform, date, tags, metadata or asset', () => {
    const post = { id: 'synthetic-existing', client: 'Acme', clientId: 'acme', platform: 'blog',
      content: 'Exact caption with  whitespace', title: 'Exact title', altText: 'Exact alt',
      metaDescription: 'Exact description', scheduledDate: null, tags: ['keep'], imageUrl: '/media/keep.png',
      status: 'draft', isTemplate: false, approvalStatus: 'approved', feedback: 'Keep history' };
    const before = editorWorkSignature(post);
    const app = render(<Editor {...props} post={post} />);
    app.rerender(<Editor {...props} post={post} getUsualPlatformForClient={() => 'facebook'} />);
    expect(platform('Blog')).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('textarea')).toHaveValue(post.content);
    expect(screen.getByDisplayValue(post.title)).toBeInTheDocument();
    expect(screen.getByLabelText('Schedule (optional)')).toHaveValue('');
    expect(screen.getByText('#keep')).toBeInTheDocument();
    expect(editorWorkSignature(post)).toBe(before);
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it.each([{ source: 'suggestion' }, { isTemplate: true }, { id: undefined, isTemplate: false, source: 'template-copy' }])('does not reinterpret pre-filled work %#', extra => {
    render(<Editor {...props} post={{ client: 'Acme', platform: 'linkedin', content: 'Authored copy', ...extra }} />);
    expect(platform('LinkedIn')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByDisplayValue('Authored copy')).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it('preserves typed and then cleared content and keeps a manually selected platform after rerender', () => {
    const app = render(<Editor {...props} initialClient="Acme" />);
    const input = document.querySelector('textarea');
    fireEvent.change(input, { target: { value: 'Typed work' } });
    fireEvent.click(platform('Instagram'));
    fireEvent.change(input, { target: { value: '' } });
    app.rerender(<Editor {...props} initialClient="Acme" getUsualPlatformForClient={() => 'facebook'} />);
    expect(platform('Instagram')).toHaveAttribute('aria-pressed', 'true');
    expect(input).toHaveValue('');
  });
  it.each([null, 'unknown', '__proto__', 'constructor'])('does not display unsupported suggestion %j', suggestion => {
    render(<Editor {...props} initialClient="Acme" getUsualPlatformForClient={() => suggestion} />);
    expect(screen.queryByText('Usual')).toBeNull();
  });
  it('suppresses the badge when the current session is retired or read-only', () => {
    const app = render(<Editor {...props} initialClient="Acme" isSessionCurrent={() => false} />);
    expect(screen.queryByText('Usual')).toBeNull();
    app.rerender(<Editor {...props} initialClient="Acme" isReadOnly />);
    expect(screen.queryByText('Usual')).toBeNull();
  });
  it('keeps the stable button name and describes the observed-only suggestion accessibly', () => {
    render(<Editor {...props} initialClient="Acme" />);
    expect(platform('LinkedIn')).toHaveAccessibleDescription('Most-used in this client’s loaded threads, not a publishing connection.');
    expect(platform('LinkedIn')).toHaveClass('min-h-11', 'flex-wrap');
    expect(screen.getByText('Usual')).toHaveAttribute('aria-hidden', 'true');
  });
});
