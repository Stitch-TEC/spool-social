import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
    // Videos are filtered out — not insertable as a post image.
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });
});
