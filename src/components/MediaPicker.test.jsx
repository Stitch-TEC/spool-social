import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MediaPicker from './MediaPicker';

const { listMedia, listClientMedia } = vi.hoisted(() => ({
  listMedia: vi.fn(),
  listClientMedia: vi.fn(),
}));
vi.mock('../utils/generationApi', () => ({ listMedia, listClientMedia }));

const baseProps = { onClose: vi.fn(), onSelect: vi.fn(), showToast: vi.fn() };

// alt="" images have role "presentation", so query the DOM directly.
const imgsBySrc = (container, src) => container.querySelectorAll(`img[src="${src}"]`);

describe('MediaPicker', () => {
  beforeEach(() => vi.clearAllMocks());

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
