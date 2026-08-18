import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ReviewModal from './ReviewModal';

const post = {
  id: 'p1',
  client: 'Acme',
  platform: 'gmb',
  content: 'Draft content',
  status: 'draft',
  approvalStatus: 'changes_requested',
  feedbackThread: [
    { text: 'Too formal', by: 'client', at: '2026-08-01T00:00:00Z' },
    { text: 'Reworked the opener', by: 'you', at: '2026-08-02T00:00:00Z' },
  ],
};

const noop = () => {};

const labelsFor = (viewerIsClient) => {
  render(
    <ReviewModal post={post} onApprove={noop} onRequestChanges={noop} onClose={noop} viewerIsClient={viewerIsClient} />
  );
  const history = screen.getByText('Feedback history').parentElement;
  return within(history).getAllByText(/^(You|Client|Your team)$/).map((el) => el.textContent);
};

describe('ReviewModal — feedback attribution', () => {
  it('resolves "by" against the VIEWER, not the author', () => {
    // `by` is stored from the author's point of view ('you' = the agency). Rendered
    // literally, the CLIENT saw our internal notes labelled "You" — i.e. attributed
    // to themselves — and their own notes labelled "Client".
    expect(labelsFor(true)).toEqual(['You', 'Your team']);
  });

  it('reads the other way round for the operator', () => {
    expect(labelsFor(false)).toEqual(['Client', 'You']);
  });
});

describe('ReviewModal — review actions', () => {
  it('approves from the default view', () => {
    const onApprove = vi.fn();
    render(<ReviewModal post={post} onApprove={onApprove} onRequestChanges={noop} onClose={noop} />);
    fireEvent.click(screen.getByText('Approve Thread'));
    expect(onApprove).toHaveBeenCalled();
  });

  it('sends tagged feedback, and never an empty note', () => {
    const onRequestChanges = vi.fn();
    render(<ReviewModal post={post} onApprove={noop} onRequestChanges={onRequestChanges} onClose={noop} />);
    fireEvent.click(screen.getByText('Request Changes'));
    fireEvent.click(screen.getByText('Change Image'));
    fireEvent.change(screen.getByPlaceholderText('Add specific notes...'), { target: { value: 'use the storefront shot' } });
    fireEvent.click(screen.getByText('Submit Feedback'));
    expect(onRequestChanges).toHaveBeenCalledWith('Change Image - use the storefront shot');
  });
});
