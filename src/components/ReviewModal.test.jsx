import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ReviewModal from './ReviewModal';

const post = {
  id: 'p1',
  client: 'Acme',
  platform: 'gmb',
  title: 'Approved title',
  altText: 'A storefront at sunset',
  metaDescription: 'A concise search preview.',
  slug: '',
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

  it('shows every approval-bearing preview field and labels workflow-only metadata', () => {
    render(<ReviewModal
      post={{ ...post, platform: 'blog', slug: 'approved-publication-path', tags: ['internal'] }}
      onApprove={noop}
      onRequestChanges={noop}
      onClose={noop}
    />);
    expect(screen.getByText('Approved title')).toBeInTheDocument();
    expect(screen.getByText('A storefront at sunset')).toBeInTheDocument();
    expect(screen.getByText('A concise search preview.')).toBeInTheDocument();
    expect(screen.getByText('/approved-publication-path')).toBeInTheDocument();
    expect(screen.getByText(/Schedule \(workflow only\)/)).toBeInTheDocument();
    expect(screen.getByText(/Internal tags — not part of approval/)).toBeInTheDocument();
  });

  it('disables review actions for archived content', () => {
    const onApprove = vi.fn();
    render(<ReviewModal
      post={{ ...post, status: 'archived' }}
      onApprove={onApprove}
      onRequestChanges={noop}
      onClose={noop}
    />);
    expect(screen.getByText(/archived and can’t be approved/)).toBeInTheDocument();
    expect(screen.getByText('Approve Thread')).toBeDisabled();
    fireEvent.click(screen.getByText('Approve Thread'));
    expect(onApprove).not.toHaveBeenCalled();
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

  it('does not invent empty feedback and accepts an explicitly selected reason', () => {
    const onRequestChanges = vi.fn();
    render(<ReviewModal post={post} onApprove={noop} onRequestChanges={onRequestChanges} onClose={noop} />);
    fireEvent.click(screen.getByText('Request Changes'));
    const submit = screen.getByText('Submit Feedback');
    expect(submit).toBeDisabled();
    expect(screen.getByText('Enter feedback or select a reason.')).toHaveAttribute('role', 'status');
    fireEvent.click(submit);
    expect(onRequestChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Fix Text'));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onRequestChanges).toHaveBeenCalledWith('Fix Text');
  });

  it('retains raw overlength input, counts tag prefixes, announces overage, and disables submit', () => {
    const onRequestChanges = vi.fn();
    render(<ReviewModal post={post} onApprove={noop} onRequestChanges={onRequestChanges} onClose={noop} />);
    fireEvent.click(screen.getByText('Request Changes'));
    fireEvent.click(screen.getByText('Fix Text'));
    const textarea = screen.getByLabelText('Specific feedback');
    const raw = 'x'.repeat(490);
    fireEvent.change(textarea, { target: { value: raw } });
    expect(textarea).toHaveValue(raw);
    expect(textarea).not.toHaveAttribute('maxLength');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '501');
    expect(screen.getByRole('alert')).toHaveTextContent('1 character over the 500-character limit.');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Submit Feedback')).toBeDisabled();
    fireEvent.click(screen.getByText('Submit Feedback'));
    expect(onRequestChanges).not.toHaveBeenCalled();
  });

  it('preserves exact accepted whitespace and punctuation', () => {
    const onRequestChanges = vi.fn();
    render(<ReviewModal post={post} onApprove={noop} onRequestChanges={onRequestChanges} onClose={noop} />);
    fireEvent.click(screen.getByText('Request Changes'));
    fireEvent.change(screen.getByLabelText('Specific feedback'), { target: { value: '  Keep this!  ' } });
    fireEvent.click(screen.getByText('Submit Feedback'));
    expect(onRequestChanges).toHaveBeenCalledWith('  Keep this!  ');
  });
});
