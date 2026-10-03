import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import MediaPicker from './MediaPicker';

const { listMedia, listClientMedia, fetchContentIndex, importSiteImage } = vi.hoisted(() => ({
  listMedia: vi.fn(),
  listClientMedia: vi.fn(),
  fetchContentIndex: vi.fn(),
  importSiteImage: vi.fn(),
}));
vi.mock('../utils/generationApi', () => ({ listMedia, listClientMedia, fetchContentIndex, importSiteImage }));

const baseProps = { onClose: vi.fn(), onSelect: vi.fn(), showToast: vi.fn() };

// alt="" images have role "presentation", so query the DOM directly.
const imgsBySrc = (container, src) => container.querySelectorAll(`img[src="${src}"]`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const video = { key: 'library/o/acme/v1', type: 'video', url: 'https://youtu.be/abcdefghijk', provider: 'youtube' };

describe('MediaPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the durable index has no site images (old broker / empty index) — the section hides.
    fetchContentIndex.mockResolvedValue({ images: [] });
  });

  it('hints to pick a client when no client is resolved', async () => {
    listMedia.mockResolvedValue([]);
    render(<MediaPicker {...baseProps} />);
    expect(screen.getByText(/Pick a client in the editor/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No images yet/)).toBeInTheDocument());
    expect(listClientMedia).not.toHaveBeenCalled();
  });

  it('shows the same stored image only once across sections', async () => {
    // The same R2 object surfaces in all three sources: used on a post, in the
    // curated library, and in the generated pool — the picker must collapse it.
    const shared = 'https://spool.example/media/generated/u1/abc.jpg';
    const curatedOnly = 'https://spool.example/media/library/o/acme/1.jpg';
    listClientMedia.mockResolvedValue([
      { key: 'library/o/acme/1.jpg', type: 'image', url: curatedOnly },
      { key: 'library/o/acme/dupe.jpg', type: 'image', url: shared },
    ]);
    listMedia.mockResolvedValue([
      { key: 'generated/u1/abc.jpg', type: 'image', url: shared },
    ]);

    const { container } = render(
      <MediaPicker {...baseProps} clientKey="acme" clientName="Acme" clientImages={[shared]} />
    );

    await waitFor(() =>
      expect(screen.getByText('All generated images are shown above.')).toBeInTheDocument()
    );
    expect(imgsBySrc(container, shared)).toHaveLength(1);
    expect(imgsBySrc(container, curatedOnly)).toHaveLength(1);
    expect(screen.getByText(/Used on Acme’s posts/)).toBeInTheDocument();
  });

  it('imports a site-index image into the library on pick', async () => {
    const siteUrl = 'https://acme.example/img/team.jpg';
    listClientMedia.mockResolvedValue([]);
    listMedia.mockResolvedValue([]);
    fetchContentIndex.mockResolvedValue({
      images: [
        { url: siteUrl, pageUrl: 'https://acme.example/about', alt: 'Our team', kind: 'img', spoolUrl: '' },
        // Logo candidates are brand material, not post imagery — the section must skip them.
        { url: 'https://acme.example/logo.png', pageUrl: '', alt: '', kind: 'logo', spoolUrl: '' },
      ],
    });
    importSiteImage.mockResolvedValue('/media/library/o/acme/team.jpg');
    const onSelect = vi.fn();

    const { container } = render(
      <MediaPicker {...baseProps} onSelect={onSelect} clientKey="acme" clientName="Acme" />
    );

    await waitFor(() => expect(screen.getByText(/On Acme’s site/)).toBeInTheDocument());
    expect(imgsBySrc(container, 'https://acme.example/logo.png')).toHaveLength(0);
    fireEvent.click(imgsBySrc(container, siteUrl)[0].closest('button'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/media/library/o/acme/team.jpg'));
    expect(importSiteImage).toHaveBeenCalledWith('acme', siteUrl);
  });

  it('resolves an already-imported site image to its library copy without a re-import', async () => {
    const siteUrl = 'https://acme.example/img/shop.jpg';
    const hosted = '/media/library/o/acme/shop.jpg';
    listClientMedia.mockResolvedValue([]);
    listMedia.mockResolvedValue([]);
    fetchContentIndex.mockResolvedValue({
      images: [{ url: siteUrl, pageUrl: '', alt: '', kind: 'img', spoolUrl: hosted }],
    });
    const onSelect = vi.fn();

    const { container } = render(
      <MediaPicker {...baseProps} onSelect={onSelect} clientKey="acme" clientName="Acme" />
    );

    await waitFor(() => expect(imgsBySrc(container, siteUrl)).toHaveLength(1));
    fireEvent.click(imgsBySrc(container, siteUrl)[0].closest('button'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(hosted));
    expect(importSiteImage).not.toHaveBeenCalled();
  });

  it('keeps the curated section useful when it has unique images', async () => {
    listClientMedia.mockResolvedValue([
      { key: 'library/o/acme/only.jpg', type: 'image', url: '/media/library/o/acme/only.jpg' },
      { key: 'library/o/acme/vid', type: 'video', url: 'https://youtube.com/watch?v=x', provider: 'youtube' },
    ]);
    listMedia.mockResolvedValue([]);

    const { container } = render(<MediaPicker {...baseProps} clientKey="acme" clientName="Acme" />);

    await waitFor(() =>
      expect(imgsBySrc(container, '/media/library/o/acme/only.jpg')).toHaveLength(1)
    );
    // Video links are presented separately and never masquerade as cover images.
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Choose video link/ })).toBeDisabled();
  });

  it('selects an identifiable video via only the explicit separate callback', async () => {
    listClientMedia.mockResolvedValue([video]); listMedia.mockResolvedValue([]);
    const onSelectVideo = vi.fn();
    const { container } = render(<MediaPicker {...baseProps} clientKey="acme" onSelectVideo={onSelectVideo} />);
    const choose = await screen.findByRole('button', { name: 'Choose video link: YouTube · abcdefghijk' });
    fireEvent.click(choose); fireEvent.click(choose);
    expect(onSelectVideo).toHaveBeenCalledExactlyOnceWith({ url: video.url, label: 'YouTube · abcdefghijk', provider: 'YouTube' });
    expect(baseProps.onSelect).not.toHaveBeenCalled();
    expect(baseProps.onClose).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('img, iframe, video')).toHaveLength(0);
  });

  it('uses saved labels and searches video IDs without fetching thumbnails', async () => {
    listClientMedia.mockResolvedValue([{ ...video, title: 'CT inspection v2' }]); listMedia.mockResolvedValue([]);
    render(<MediaPicker {...baseProps} clientKey="acme" onSelectVideo={vi.fn()} />);
    await screen.findByRole('button', { name: 'Choose video link: CT inspection v2' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search media' }), { target: { value: 'missing' } });
    expect(screen.queryByRole('button', { name: /Choose video link/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No matching media/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ABCDEFGHIJK' } });
    expect(screen.getByRole('button', { name: 'Choose video link: CT inspection v2' })).toBeInTheDocument();
  });

  it('hides stale client rows immediately and ignores an old A→B→A response', async () => {
    const oldA = deferred(), freshA = deferred();
    listMedia.mockResolvedValue([]);
    listClientMedia.mockReturnValueOnce(oldA.promise).mockResolvedValueOnce([]).mockReturnValueOnce(freshA.promise);
    const { rerender } = render(<MediaPicker {...baseProps} clientKey="a" />);
    rerender(<MediaPicker {...baseProps} clientKey="b" />);
    rerender(<MediaPicker {...baseProps} clientKey="a" />);
    await act(async () => oldA.resolve([video]));
    expect(screen.queryByRole('button', { name: /Choose video link/ })).not.toBeInTheDocument();
    await act(async () => freshA.resolve([{ ...video, title: 'Fresh A' }]));
    expect(screen.getByRole('button', { name: 'Choose video link: Fresh A' })).toBeInTheDocument();
  });

  it('does not dispatch a selection after synchronous authority changes without rerendering', async () => {
    let current = true;
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([video]);
    const onSelectVideo = vi.fn();
    render(<MediaPicker {...baseProps} clientKey="acme" onSelectVideo={onSelectVideo} isSessionCurrent={() => current} />);
    const choose = await screen.findByRole('button', { name: /Choose video link/ });
    current = false; fireEvent.click(choose);
    expect(onSelectVideo).not.toHaveBeenCalled(); expect(baseProps.onClose).not.toHaveBeenCalled();
  });

  it('retires an import immediately on Close even before parent unmount', async () => {
    const imported = deferred();
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([]);
    fetchContentIndex.mockResolvedValue({ images: [{ url: 'https://acme.example/team.jpg', alt: 'Team' }] });
    importSiteImage.mockReturnValue(imported.promise);
    render(<MediaPicker {...baseProps} clientKey="acme" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use image: Team' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => imported.resolve('/media/team.jpg'));
    expect(baseProps.onSelect).not.toHaveBeenCalled(); expect(baseProps.onClose).toHaveBeenCalledOnce();
  });

  it('ignores an import and old read after the account changes', async () => {
    const imported = deferred();
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([]);
    fetchContentIndex.mockResolvedValue({ images: [{ url: 'https://acme.example/team.jpg', alt: 'Team' }] });
    importSiteImage.mockReturnValue(imported.promise);
    const { rerender } = render(<MediaPicker {...baseProps} clientKey="acme" sessionKey="one" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use image: Team' }));
    rerender(<MediaPicker {...baseProps} clientKey="acme" sessionKey="two" />);
    await act(async () => imported.resolve('/media/team.jpg'));
    expect(baseProps.onSelect).not.toHaveBeenCalled(); expect(baseProps.onClose).not.toHaveBeenCalled();
  });

  it('blocks other image/video picks while importing', async () => {
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([video, { key: 'image', type: 'image', url: '/media/cover.jpg' }]);
    fetchContentIndex.mockResolvedValue({ images: [{ url: 'https://acme.example/team.jpg', alt: 'Team' }] });
    importSiteImage.mockReturnValue(new Promise(() => {}));
    const onSelectVideo = vi.fn();
    render(<MediaPicker {...baseProps} clientKey="acme" onSelectVideo={onSelectVideo} />);
    await screen.findByRole('button', { name: /Choose video link/ });
    fireEvent.click(screen.getByRole('button', { name: 'Use image: Team' }));
    fireEvent.click(screen.getByRole('button', { name: /Choose video link/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this image' }));
    expect(onSelectVideo).not.toHaveBeenCalled(); expect(baseProps.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Choose video link/ })).toBeDisabled();
  });

  it('contains every Tab and captures Escape before the editor listener', async () => {
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([]);
    const parentEscape = vi.fn(); const parentKeys = event => { if (event.key === 'Escape') parentEscape(); }; window.addEventListener('keydown', parentKeys);
    const { unmount } = render(<MediaPicker {...baseProps} />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    const close = screen.getByRole('button', { name: 'Close' });
    const all = screen.getByRole('button', { name: 'All', exact: true });
    const images = screen.getByRole('button', { name: 'Images', exact: true });
    const videos = screen.getByRole('button', { name: 'Videos', exact: true });
    const search = screen.getByRole('searchbox');
    for (const next of [all, images, videos, search, close]) {
      fireEvent.keyDown(document, { key: 'Tab' }); expect(next).toHaveFocus();
    }
    for (const next of [search, videos, images, all, close]) {
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(next).toHaveFocus();
    }
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Escape' });
    expect(parentEscape).toHaveBeenCalledTimes(0); expect(baseProps.onClose).toHaveBeenCalledOnce();
    unmount(); window.removeEventListener('keydown', parentKeys);
  });

  it('keeps a failed client read distinct from an empty library and allows one deliberate retry', async () => {
    listMedia.mockResolvedValue([]); listClientMedia.mockRejectedValueOnce(new Error('secret raw provider error')).mockResolvedValueOnce([video]);
    render(<MediaPicker {...baseProps} clientKey="acme" onSelectVideo={vi.fn()} />);
    await screen.findByText('Client library could not load. Try again.');
    expect(screen.queryByText(/No media in this client/)).not.toBeInTheDocument();
    expect(screen.queryByText('secret raw provider error')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry client library' }));
    expect(await screen.findByRole('button', { name: /Choose video link/ })).toBeInTheDocument();
  });

  it('refuses malformed read results rather than showing unknown items as selectable', async () => {
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue({ media: [video] });
    render(<MediaPicker {...baseProps} clientKey="acme" onSelectVideo={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Client library could not load');
    expect(screen.queryByRole('button', { name: /Choose video link/ })).not.toBeInTheDocument();
  });
  it('combines media type and search across used, curated, generated and site images', async () => {
    const used = '/media/generated/o/used.jpg';
    const curated = '/media/library/o/acme/cover.jpg';
    const generated = '/media/generated/o/generated.jpg';
    const site = 'https://acme.example/site-team.jpg';
    listClientMedia.mockResolvedValue([{ ...video, title: 'Team video' }, { key: 'library/o/acme/cover.jpg', type: 'image', url: curated }]);
    listMedia.mockResolvedValue([{ key: 'generated/o/generated.jpg', type: 'image', url: generated }]);
    fetchContentIndex.mockResolvedValue({ images: [{ url: site, alt: 'Site team' }] });
    const { container } = render(<MediaPicker {...baseProps} clientKey="acme" clientImages={[used]} onSelectVideo={vi.fn()} />);
    await screen.findByRole('button', { name: 'Use image: Site team' });
    expect(container.querySelectorAll('img')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Choose video link: Team video' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Generated images' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'site team' } });
    expect(screen.queryByRole('button', { name: /Choose video link/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No matching media/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Images', exact: true }));
    expect(imgsBySrc(container, site)).toHaveLength(1);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'used.jpg' } });
    expect(imgsBySrc(container, used)).toHaveLength(1);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cover.jpg' } });
    expect(imgsBySrc(container, curated)).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'generated.jpg' } });
    expect(imgsBySrc(container, generated)).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'All', exact: true }));
    expect(imgsBySrc(container, site)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Choose video link: Team video' })).toBeInTheDocument();
    expect(listMedia).toHaveBeenCalledOnce(); expect(listClientMedia).toHaveBeenCalledOnce(); expect(fetchContentIndex).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('iframe, video')).toHaveLength(0);
  });
  it('waits for the pending site image inventory before claiming no match for All or Images', async () => {
    const site = deferred();
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([]); fetchContentIndex.mockReturnValue(site.promise);
    render(<MediaPicker {...baseProps} clientKey="acme" />);
    await screen.findByText(/No media in this client/);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'team' } });
    expect(screen.getByText('Loading site images…')).toBeInTheDocument();
    expect(screen.queryByText(/No matching media/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Images', exact: true }));
    expect(screen.queryByText(/No matching media/)).not.toBeInTheDocument();
    await act(async () => site.resolve({ images: [{ url: 'https://acme.example/team.jpg', alt: 'Team' }] }));
    expect(screen.getByRole('button', { name: 'Use image: Team' })).toBeInTheDocument();
    expect(screen.queryByText(/No matching media/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading site images…')).not.toBeInTheDocument();
  });
  it('can confirm no video matches without waiting for optional image inventory', async () => {
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([]); fetchContentIndex.mockReturnValue(new Promise(() => {}));
    render(<MediaPicker {...baseProps} clientKey="acme" />);
    await screen.findByText(/No media in this client/);
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    expect(screen.getByText(/No matching media/)).toBeInTheDocument();
    expect(screen.getByText('Loading site images…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All', exact: true }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.queryByText(/No matching media/)).not.toBeInTheDocument();
  });
  it('keeps optional site failures visible and prevents a false complete no-match claim until a deliberate retry succeeds', async () => {
    const retry = deferred();
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([]);
    fetchContentIndex.mockRejectedValueOnce(new Error('private provider response')).mockReturnValueOnce(retry.promise);
    render(<MediaPicker {...baseProps} clientKey="acme" />);
    await screen.findByText('Site images could not load. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Images', exact: true }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.queryByText(/No matching media/)).not.toBeInTheDocument();
    expect(screen.queryByText('private provider response')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    expect(screen.getByText('Site images could not load. Try again.')).toBeInTheDocument();
    expect(screen.getByText(/No matching media/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Images', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry site images' }));
    expect(screen.getByText('Loading site images…')).toBeInTheDocument();
    expect(screen.queryByText(/No matching media/)).not.toBeInTheDocument();
    await act(async () => retry.resolve({ images: [] }));
    expect(screen.getByText(/No matching media/)).toBeInTheDocument();
    expect(screen.queryByText('Site images could not load. Try again.')).not.toBeInTheDocument();
    expect(listMedia).toHaveBeenCalledOnce(); expect(listClientMedia).toHaveBeenCalledOnce(); expect(fetchContentIndex).toHaveBeenCalledTimes(2);
  });
  it('keeps client and generated loading, errors and retries visible under a video filter', async () => {
    const client = deferred(), pool = deferred();
    listClientMedia.mockReturnValue(client.promise); listMedia.mockReturnValue(pool.promise);
    render(<MediaPicker {...baseProps} clientKey="acme" />);
    fireEvent.click(screen.getByRole('button', { name: 'Videos', exact: true }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getAllByText('Loading…')).toHaveLength(2);
    expect(screen.queryByText(/No matching media|No media in this client|No generated images/)).not.toBeInTheDocument();
    await act(async () => { client.reject(new Error('offline')); pool.reject(new Error('offline')); });
    expect(screen.getByText('Client library could not load. Try again.')).toBeInTheDocument();
    expect(screen.getByText('Generated images could not load. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry client library' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry', exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/No matching media|No media in this client|No generated images/)).not.toBeInTheDocument();
  });
  it.each(['client', 'account'])('resets type and search for a new %s scope while ignoring late source results', async changed => {
    const oldSite = deferred();
    listMedia.mockResolvedValue([]); listClientMedia.mockResolvedValue([video]);
    fetchContentIndex.mockReturnValueOnce(oldSite.promise).mockResolvedValue({ images: [] });
    const { rerender } = render(<MediaPicker {...baseProps} clientKey="acme" sessionKey="one" onSelectVideo={vi.fn()} />);
    await screen.findByRole('button', { name: /Choose video link/ });
    fireEvent.click(screen.getByRole('button', { name: 'Images', exact: true }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old search' } });
    rerender(<MediaPicker {...baseProps} clientKey={changed === 'client' ? 'northwind' : 'acme'} sessionKey={changed === 'account' ? 'two' : 'one'} onSelectVideo={vi.fn()} />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => oldSite.resolve({ images: [{ url: 'https://acme.example/old.jpg', alt: 'Old account' }] }));
    expect(screen.queryByRole('button', { name: 'Use image: Old account' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Choose video link/ })).toBeInTheDocument();
    expect(screen.queryByText('Loading site images…')).not.toBeInTheDocument();
  });
});
