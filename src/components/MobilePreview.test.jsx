import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MobilePreview from './MobilePreview';

describe('MobilePreview', () => {
  it('renders the GMB layout with the default business name', () => {
    render(<MobilePreview post={{ platform: 'gmb', content: 'Hello world' }} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.getByText('Your Business')).toBeInTheDocument();
  });

  it('renders the Twitter layout', () => {
    render(<MobilePreview post={{ platform: 'twitter', content: 'Tweet body' }} />);
    expect(screen.getByText('Tweet body')).toBeInTheDocument();
    expect(screen.getByText(/@handle/)).toBeInTheDocument();
  });

  it('renders client branding (logo + name) from the clientMap', () => {
    render(
      <MobilePreview
        post={{ platform: 'gmb', content: 'x', client: 'Acme' }}
        clientMap={{ Acme: { logoUrl: 'data:image/png;base64,AAA', brandColor: '#ff0000' } }}
      />
    );
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByAltText('Client Logo')).toBeInTheDocument();
  });
});
