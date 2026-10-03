import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MediaLibrary from './MediaLibrary';

const api = vi.hoisted(() => ({ listClientMedia: vi.fn(), uploadMedia: vi.fn(), addVideoUrl: vi.fn(), deleteMedia: vi.fn() }));
const processImageFile = vi.hoisted(() => vi.fn());
vi.mock('../utils/generationApi', () => api);
vi.mock('../utils/helpers', async importOriginal => ({ ...await importOriginal(), processImageFile }));
const video = { key: 'library/o/northwind/video', type: 'video', url: 'https://youtu.be/abcdefghijk', provider: 'youtube' };
const image = { key: 'library/o/northwind/cover.jpg', type: 'image', url: '/media/library/o/northwind/cover.jpg' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const defaults = { onClose: vi.fn(), showToast: vi.fn(), uniqueClients: ['Northwind', 'Acme'], initialClient: 'Northwind', clientIdFor: name => name.toLowerCase() };

describe('MediaLibrary first-stage video usability and local admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listClientMedia.mockResolvedValue([video, image]);
    api.addVideoUrl.mockResolvedValue({ ...video });
    api.uploadMedia.mockResolvedValue(image);
    api.deleteMedia.mockResolvedValue({ deleted: video.key });
    processImageFile.mockResolvedValue('data:image/png;base64,c2FmZQ==');
  });
  it('identifies library video links without requesting video metadata or posters', async () => {
    const { container } = render(<MediaLibrary {...defaults} />);
    const link = await screen.findByRole('link', { name: 'Open video link: YouTube · abcdefghijk' });
    expect(link).toHaveAttribute('href', video.url); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelectorAll('iframe, video')).toHaveLength(0);
    expect(screen.getByText('2 / 50')).toBeInTheDocument();
  });
  it('uses a saved label and filters loaded library rows by ID or filename', async () => {
    api.listClientMedia.mockResolvedValue([{ ...video, label: 'P01 short CT demo' }, image]);
    render(<MediaLibrary {...defaults} />);
    await screen.findByRole('link', { name: /P01 short CT demo/ });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cover.jpg' } });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'abcdefghi' } });
    expect(screen.getByRole('link', { name: /P01 short CT demo/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'not present' } });
    expect(screen.getByText('No matching library items.')).toBeInTheDocument();
  });
  it('does not create an external action for an unsafe saved URL', async () => {
    api.listClientMedia.mockResolvedValue([{ ...video, url: 'javascript:alert(1)' }]);
    render(<MediaLibrary {...defaults} />);
    await screen.findByText('Unsupported video link');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('keeps failed/malformed lists distinct from empty and disables writes before confirmed reading', async () => {
    const first = deferred(); api.listClientMedia.mockReturnValueOnce(first.promise);
    render(<MediaLibrary {...defaults} />);
    expect(screen.getByRole('button', { name: 'Upload image' })).toBeDisabled();
    expect(screen.getByText('Count not checked')).toBeInTheDocument();
    await act(async () => first.resolve({ items: [video] }));
    expect(await screen.findByText('Library could not load. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/No media in the library/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload image' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('link'); expect(screen.getByRole('button', { name: 'Upload image' })).toBeEnabled();
  });
  it('refuses unsupported URL text before dispatch without a recovery hold', async () => {
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: 'https://drive.google.com/file/d/id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(api.addVideoUrl).not.toHaveBeenCalled();
    expect(defaults.showToast).toHaveBeenCalledWith('Use a YouTube, Vimeo or direct HTTPS video-file link.', 'error');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('prevents same-tick duplicate video add, preserves source URL, then refreshes', async () => {
    const added = deferred(); api.addVideoUrl.mockReturnValue(added.promise);
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    const button = screen.getByRole('button', { name: 'Add link' });
    fireEvent.click(button); fireEvent.click(button);
    expect(api.addVideoUrl).toHaveBeenCalledExactlyOnceWith('northwind', video.url, { title: '', isCurrent: expect.any(Function) });
    await act(async () => added.resolve(video));
    await waitFor(() => expect(api.listClientMedia).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: 'Video library URL' })).toHaveValue('');
  });
  it('does not send Enter while an IME composition is active', async () => {
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    const field = screen.getByRole('textbox', { name: 'Video library URL' });
    fireEvent.change(field, { target: { value: video.url } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(api.addVideoUrl).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' }); expect(api.addVideoUrl).toHaveBeenCalledOnce();
  });
  it('labels the optional title, counts characters and clears the trimmed title only after confirmed success', async () => {
    const added = deferred(); api.addVideoUrl.mockReturnValue(added.promise);
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    const title = screen.getByRole('textbox', { name: 'Video title (optional)' });
    // The title limit is validated whole; the browser must not clip pasted text.
    expect(title).not.toHaveAttribute('maxLength');
    expect(title).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByText('0 / 120')).toBeInTheDocument();
    fireEvent.change(title, { target: { value: '  CT demo  ' } });
    expect(screen.getByText('11 / 120')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true });
    expect(api.addVideoUrl).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(api.addVideoUrl).toHaveBeenCalledExactlyOnceWith('northwind', video.url, { title: 'CT demo', isCurrent: expect.any(Function) });
    expect(title).toHaveValue('  CT demo  ');
    expect(title).toBeDisabled();
    expect(api.addVideoUrl.mock.calls[0][2].isCurrent()).toBe(true);
    await act(async () => added.resolve({ ...video, title: 'CT demo' }));
    expect(title).toHaveValue('');
    expect(screen.getByText('0 / 120')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Video library URL' })).toHaveValue('');
    expect(defaults.showToast).toHaveBeenCalledWith('Video added');
  });
  it.each(['', '   ', 'T'.repeat(120)])('admits blank or exactly bounded title %j', async raw => {
    const title = raw.trim(); api.addVideoUrl.mockResolvedValue({ ...video, ...(title ? { title } : {}) });
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video title (optional)' }), { target: { value: raw } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(api.addVideoUrl).toHaveBeenCalledExactlyOnceWith('northwind', video.url, { title, isCurrent: expect.any(Function) });
    await waitFor(() => expect(defaults.showToast).toHaveBeenCalledWith('Video added'));
  });
  it.each(['T'.repeat(121), 'CT\u0007demo', 'CT\u0085demo', 'CT\u202edemo', 'CT\u200bdemo', 'CT\u2028demo', 'CT\u2029demo'])('keeps invalid raw title %j whole, shows an alert and refuses dispatch', async raw => {
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    const field = screen.getByRole('textbox', { name: 'Video title (optional)' });
    fireEvent.change(field, { target: { value: raw } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    expect(field).toHaveValue(raw); expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(`${raw.length} / 120`)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Use a single-line title of 120 characters or fewer');
    expect(screen.getByRole('button', { name: 'Add link' })).toBeDisabled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(api.addVideoUrl).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'Corrected title' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add link' })).toBeEnabled();
  });
  it.each([undefined, null, 7, {}, 'Other title', ' CT demo ', 'CT\u0007demo', 'CT\u202edemo'])('holds a missing, malformed or nonexact title acknowledgement %j without clearing entered work', async title => {
    api.addVideoUrl.mockResolvedValue({ ...video, ...(title === undefined ? {} : { title }) });
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video title (optional)' }), { target: { value: 'CT demo' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Result not confirmed');
    expect(screen.getByRole('textbox', { name: 'Video title (optional)' })).toHaveValue('CT demo');
    expect(screen.getByRole('textbox', { name: 'Video library URL' })).toHaveValue(video.url);
    expect(defaults.showToast).not.toHaveBeenCalledWith('Video added');
    expect(api.listClientMedia).toHaveBeenCalledOnce();
  });
  it.each([' ', '\u0007', '\u202e', 7, null])('does not accept malformed raw title %j as an empty-title acknowledgement', async title => {
    api.addVideoUrl.mockResolvedValue({ ...video, title });
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Result not confirmed');
    expect(defaults.showToast).not.toHaveBeenCalledWith('Video added');
    expect(screen.getByRole('textbox', { name: 'Video library URL' })).toHaveValue(video.url);
  });
  it('combines type and search for curated and Used-on-posts images without changing the confirmed count', async () => {
    const used = '/media/generated/o/team.jpg';
    const { container } = render(<MediaLibrary {...defaults} postImagesByClient={{ Northwind: [used] }} />);
    await screen.findByRole('link');
    expect(container.querySelectorAll('img')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Images used on posts' })).not.toBeInTheDocument();
    expect(screen.getByText('2 / 50')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'team.jpg' } });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Images', exact: true }));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')).toHaveAttribute('src', used);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cover.jpg' } });
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')).toHaveAttribute('src', image.url);
    expect(screen.queryByRole('region', { name: 'Images used on posts' })).not.toBeInTheDocument();
  });
  it('keeps loading and read failures visible under type and search filters without empty claims or counts', async () => {
    const first = deferred(); api.listClientMedia.mockReturnValueOnce(first.promise);
    render(<MediaLibrary {...defaults} />);
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Count not checked')).toBeInTheDocument();
    expect(screen.queryByText('No matching library items.')).not.toBeInTheDocument();
    await act(async () => first.reject(new Error('offline')));
    expect(screen.getByText('Library could not load. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/No media in the library|No matching library/)).not.toBeInTheDocument();
    expect(screen.getByText('Count not checked')).toBeInTheDocument();
  });
  it('resets title, URL, search and type when the selected client changes', async () => {
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video title (optional)' }), { target: { value: 'Old title' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Old query' } });
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Acme' } });
    await waitFor(() => expect(api.listClientMedia).toHaveBeenCalledWith('acme'));
    expect(screen.getByRole('textbox', { name: 'Video title (optional)' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Video library URL' })).toHaveValue('');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
  it('retires the captured add callback on account change and keeps fresh input when the old acknowledgement arrives', async () => {
    const added = deferred(); api.addVideoUrl.mockReturnValue(added.promise);
    const { rerender } = render(<MediaLibrary {...defaults} sessionKey="one" />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video title (optional)' }), { target: { value: 'Old title' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'abcdefghijk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    const isCurrent = api.addVideoUrl.mock.calls[0][2].isCurrent;
    rerender(<MediaLibrary {...defaults} sessionKey="two" />);
    await waitFor(() => expect(api.listClientMedia).toHaveBeenCalledTimes(2));
    expect(isCurrent()).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Video title (optional)' })).toHaveValue('');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video title (optional)' }), { target: { value: 'Fresh title' } });
    await act(async () => added.resolve({ ...video, title: 'Old title' }));
    expect(screen.getByRole('textbox', { name: 'Video title (optional)' })).toHaveValue('Fresh title');
    expect(defaults.showToast).not.toHaveBeenCalled();
    expect(api.listClientMedia).toHaveBeenCalledTimes(2);
  });
  it('holds uncertain mutations until a fresh read and explicit inspection without automatic replay', async () => {
    api.addVideoUrl.mockRejectedValue(new Error('lost response'));
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Add link' })).toBeDisabled();
    expect(api.listClientMedia).toHaveBeenCalledOnce(); expect(api.addVideoUrl).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Check library' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I’ve checked — continue' }));
    expect(screen.getByRole('button', { name: 'Add link' })).toBeEnabled();
    expect(api.addVideoUrl).toHaveBeenCalledOnce();
  });
  it('does not release an uncertain hold when the inspection read fails', async () => {
    api.addVideoUrl.mockRejectedValue(new Error('lost response'));
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' })); await screen.findByRole('alert');
    api.listClientMedia.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Check library' }));
    await screen.findByText('Library could not load. Try again.');
    expect(screen.queryByRole('button', { name: 'I’ve checked — continue' })).not.toBeInTheDocument();
  });
  it.each([null, {}, { ...video, key: 'library/o/foreign/video' }, { ...video, url: 'https://youtu.be/other' }])('holds a malformed or mismatching successful video acknowledgement', async result => {
    api.addVideoUrl.mockResolvedValue(result);
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Result not confirmed');
    expect(defaults.showToast).not.toHaveBeenCalledWith('Video added');
    expect(api.listClientMedia).toHaveBeenCalledOnce();
  });
  it('holds a mismatching delete acknowledgement instead of refreshing into false success', async () => {
    api.deleteMedia.mockResolvedValue({ deleted: image.key });
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.click(screen.getByRole('button', { name: 'Delete library item: YouTube · abcdefghijk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete permanently' }));
    await screen.findByRole('alert'); expect(api.listClientMedia).toHaveBeenCalledOnce();
  });
  it('shows destructive consequences and requires two deliberate delete taps', async () => {
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.click(screen.getByRole('button', { name: 'Delete library item: YouTube · abcdefghijk' }));
    expect(api.deleteMedia).not.toHaveBeenCalled();
    expect(screen.getByText('Remove this library link permanently. The source video stays.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete permanently' }));
    expect(api.deleteMedia).toHaveBeenCalledExactlyOnceWith(video.key);
  });
  it('does not carry armed deletion to a different client', async () => {
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.click(screen.getByRole('button', { name: 'Delete library item: YouTube · abcdefghijk' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Library client' }), { target: { value: 'Acme' } });
    await waitFor(() => expect(api.listClientMedia).toHaveBeenCalledWith('acme'));
    expect(screen.queryByRole('button', { name: 'Tap again to delete permanently' })).not.toBeInTheDocument();
    expect(api.deleteMedia).not.toHaveBeenCalled();
  });
  it('ignores late account results and resets its displayed client, search and URL', async () => {
    const old = deferred(); api.listClientMedia.mockReturnValueOnce(old.promise).mockResolvedValueOnce([image]);
    const { rerender } = render(<MediaLibrary {...defaults} sessionKey="one" />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old query' } });
    rerender(<MediaLibrary {...defaults} sessionKey="two" initialClient="Acme" />);
    await act(async () => old.resolve([video]));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('Acme'); expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(api.listClientMedia).toHaveBeenCalledWith('acme');
  });
  it('cannot dispatch a mutation after a synchronous authority change', async () => {
    let current = true;
    render(<MediaLibrary {...defaults} isSessionCurrent={() => current} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    current = false; fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(api.addVideoUrl).not.toHaveBeenCalled();
  });
  it('does not upload after image preparation completes for a retired actor', async () => {
    const prepared = deferred(); processImageFile.mockReturnValue(prepared.promise);
    const { container, rerender } = render(<MediaLibrary {...defaults} sessionKey="one" />); await screen.findByRole('link');
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [new File(['x'], 'cover.png', { type: 'image/png' })] } });
    rerender(<MediaLibrary {...defaults} sessionKey="two" />);
    await act(async () => prepared.resolve('data:image/png;base64,c2FmZQ=='));
    expect(api.uploadMedia).not.toHaveBeenCalled(); expect(defaults.showToast).not.toHaveBeenCalled();
  });
  it('ignores a dispatched add result after Close without pretending to cancel the server write', async () => {
    const added = deferred(); api.addVideoUrl.mockReturnValue(added.promise);
    render(<MediaLibrary {...defaults} />); await screen.findByRole('link');
    fireEvent.change(screen.getByRole('textbox', { name: 'Video library URL' }), { target: { value: video.url } });
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => added.resolve(video));
    expect(api.addVideoUrl).toHaveBeenCalledOnce(); expect(defaults.showToast).not.toHaveBeenCalled();
    expect(api.listClientMedia).toHaveBeenCalledOnce(); expect(defaults.onClose).toHaveBeenCalledOnce();
  });
  it('keeps Close and the client selector reachable by keyboard with 44px target classes', async () => {
    const { container } = render(<MediaLibrary {...defaults} />); const link = await screen.findByRole('link');
    const close = screen.getByRole('button', { name: 'Close' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(screen.getByRole('combobox')).toHaveFocus();
    close.focus();
    const controls = [
      screen.getByRole('button', { name: 'Upload image' }),
      screen.getByRole('textbox', { name: 'Video library URL' }),
      // Add link is disabled until a URL is entered, so it is skipped initially.
      screen.getByRole('textbox', { name: 'Video title (optional)' }),
      screen.getByRole('button', { name: 'All', exact: true }),
      screen.getByRole('button', { name: 'Images', exact: true }),
      screen.getByRole('button', { name: 'Videos', exact: true }),
      screen.getByRole('searchbox'), link,
      screen.getByRole('button', { name: 'Delete library item: YouTube · abcdefghijk' }),
      screen.getByRole('button', { name: `Delete library item: ${image.key}` }),
      screen.getByRole('combobox'), close,
    ];
    for (const next of controls) {
      fireEvent.keyDown(document, { key: 'Tab' }); expect(next).toHaveFocus();
      expect(container.querySelector('input[type="file"]')).not.toHaveFocus();
    }
    const url = screen.getByRole('textbox', { name: 'Video library URL' });
    fireEvent.change(url, { target: { value: video.url } });
    url.focus(); fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Add link' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('textbox', { name: 'Video title (optional)' })).toHaveFocus();
    expect(close).toHaveClass('min-h-11', 'min-w-11');
    expect(screen.getByRole('button', { name: 'Add link' })).toHaveClass('min-h-11', 'min-w-11');
    expect(screen.getByRole('combobox')).toHaveClass('h-11', 'py-0');
  });
});
