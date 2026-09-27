import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import VideoLinkComposer from './VideoLinkComposer';

const drive = 'https://drive.google.com/file/d/synthetic-video/view?usp=sharing';
const open = () => fireEvent.click(screen.getByText('Add video link to draft text'));
const enter = value => fireEvent.change(screen.getByLabelText('Video sharing link'), { target: { value } });
const insert = () => fireEvent.click(screen.getByRole('button', { name: 'Insert link into draft text' }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('VideoLinkComposer', () => {
  it('explains the publication boundary and does not submit or fetch while typing', () => {
    const onInsert = vi.fn(), fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<VideoLinkComposer onInsert={onInsert} />);
    open(); enter(drive);
    expect(screen.getByText(/included when that text is copied, published/)).toHaveTextContent('It is not a private attachment.');
    expect(screen.getByText(/Spool does not upload or check/)).toBeInTheDocument();
    expect(onInsert).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('iframe, video, img, form')).toBeNull();
  });

  it('inserts a trimmed normalized URL only on explicit action and clears the input on success', () => {
    const onInsert = vi.fn(() => 'inserted');
    render(<VideoLinkComposer content="Keep my caption" onInsert={onInsert} />);
    open(); enter(`  ${drive}  `); insert();
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(drive);
    expect(screen.getByLabelText('Video sharing link')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Link added to draft text. Save to keep this change.');
  });

  it('supports an explicit Enter without requiring mouse use', () => {
    const onInsert = vi.fn(() => 'inserted');
    render(<VideoLinkComposer onInsert={onInsert} />);
    open(); enter(drive);
    fireEvent.keyDown(screen.getByLabelText('Video sharing link'), { key: 'Enter' });
    expect(onInsert).toHaveBeenCalledExactlyOnceWith(drive);
  });

  it('does not insert during IME composition', () => {
    const onInsert = vi.fn();
    render(<VideoLinkComposer onInsert={onInsert} />);
    open(); enter(drive);
    fireEvent.keyDown(screen.getByLabelText('Video sharing link'), { key: 'Enter', isComposing: true });
    expect(onInsert).not.toHaveBeenCalled();
  });

  it.each(['file:///Users/operator/Desktop/movie.mov', '/Users/operator/Desktop/movie.mov', 'javascript:alert(1)', 'https://example.test/a-page', 'http://drive.google.com/file/d/v/view'])('refuses %s without changing the content', value => {
    const onInsert = vi.fn();
    render(<VideoLinkComposer onInsert={onInsert} />);
    open(); enter(value); insert();
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Video sharing link')).toHaveValue(value);
    expect(screen.getByLabelText('Video sharing link')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Use a supported HTTPS sharing link');
  });

  it('reports normalized duplicates without calling the insert path', () => {
    const onInsert = vi.fn();
    render(<VideoLinkComposer content={`Caption\n\n${drive}`} onInsert={onInsert} />);
    open(); enter(drive); insert();
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('This link is already in the draft text. Nothing was added.');
    expect(screen.getByLabelText('Video sharing link')).toHaveValue(drive);
  });

  it('reports a duplicate caught by the current-content boundary', () => {
    const onInsert = vi.fn(() => 'duplicate');
    render(<VideoLinkComposer content="Older rendered caption" onInsert={onInsert} />);
    open(); enter(drive); insert();
    expect(screen.getByRole('status')).toHaveTextContent('This link is already');
    expect(screen.getByLabelText('Video sharing link')).toHaveValue(drive);
  });

  it.each([() => 'unavailable', () => { throw new Error('private backend detail'); }, () => undefined])('retains input when the editor does not acknowledge insertion', onInsert => {
    render(<VideoLinkComposer onInsert={onInsert} />);
    open(); enter(drive); insert();
    expect(screen.getByRole('alert')).toHaveTextContent('The link was not added.');
    expect(screen.getByLabelText('Video sharing link')).toHaveValue(drive);
    expect(screen.queryByText(/private backend detail/)).toBeNull();
  });

  it('refuses disabled or empty input and removes stale error feedback on edit', () => {
    const onInsert = vi.fn(() => 'inserted');
    const view = render(<VideoLinkComposer onInsert={onInsert} />);
    open();
    expect(screen.getByRole('button', { name: 'Insert link into draft text' })).toBeDisabled();
    enter('invalid'); insert();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    enter(drive);
    expect(screen.queryByRole('alert')).toBeNull();
    view.rerender(<VideoLinkComposer onInsert={onInsert} disabled />);
    expect(screen.getByLabelText('Video sharing link')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Insert link into draft text' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Video sharing link'), { key: 'Enter' });
    expect(onInsert).not.toHaveBeenCalled();
  });
});
