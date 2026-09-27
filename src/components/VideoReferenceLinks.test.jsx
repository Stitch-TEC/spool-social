import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import VideoReferenceLinks from './VideoReferenceLinks';

describe('VideoReferenceLinks', () => {
  it('is absent when there are no supported safe references', () => {
    const { container } = render(<VideoReferenceLinks content="Plain text and javascript:alert(1)" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders actionable provider/host links with explicit new-tab and privacy boundaries', () => {
    render(<VideoReferenceLinks content="[Review clip](https://drive.google.com/file/d/id/view?usp=sharing)" />);
    expect(screen.getByRole('region', { name: 'Video links in this draft' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Open link 1 — Google Drive.*drive.google.com.*Opens in a new tab/ });
    expect(link).toHaveAttribute('href', 'https://drive.google.com/file/d/id/view?usp=sharing');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(link).toHaveClass('min-h-11');
    expect(screen.getByText(/source controls access/)).toBeInTheDocument();
    expect(screen.getByText(/not a fixed video version/)).toHaveTextContent('Spool does not store the videos');
  });

  it('never embeds, fetches or previews a referenced resource', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container } = render(<VideoReferenceLinks content="https://acme.sharepoint.com/video.mp4 https://youtu.be/abc" />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(container.querySelector('iframe,video,audio,img,object,embed')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses native keyboard-focusable links and updates without retaining previous client content', () => {
    const { rerender } = render(<VideoReferenceLinks content="https://1drv.ms/v/first" />);
    const link = screen.getByRole('link');
    link.focus();
    expect(link).toHaveFocus();
    expect(link.tabIndex).toBe(0);
    rerender(<VideoReferenceLinks content="https://vimeo.com/second" />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://vimeo.com/second');
    expect(screen.queryByText('1drv.ms')).not.toBeInTheDocument();
    rerender(<VideoReferenceLinks content="No video" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('explains bounded display without calling a truncated list complete', () => {
    render(<VideoReferenceLinks content={Array.from({ length: 11 }, (_, i) => `https://youtu.be/id${i}`).join('\n')} />);
    expect(screen.getAllByRole('link')).toHaveLength(10);
    expect(screen.getByText('Showing up to 10 supported links. Check the full draft for any others.')).toBeInTheDocument();
  });
});
