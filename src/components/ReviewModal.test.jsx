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

describe('ReviewModal — mobile dialog keyboard lifecycle', () => {
  it('starts on Close, contains outside focus, and restores the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ReviewModal post={post} onApprove={noop} onRequestChanges={noop} onClose={noop} />);
    expect(screen.getByRole('button', { name: 'Close Review' })).toHaveFocus();
    opener.focus();
    expect(screen.getByRole('button', { name: 'Close Review' })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('wraps Tab and Shift+Tab without visiting the background', () => {
    // jsdom has no layout; actual visibility/scrolling is covered in WebKit and Chromium.
    const visible = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}]);
    try {
      render(<ReviewModal post={post} onApprove={noop} onRequestChanges={noop} onClose={noop} />);
      const close = screen.getByRole('button', { name: 'Close Review' });
      const approve = screen.getByRole('button', { name: 'Approve Thread' });
      close.focus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(approve).toHaveFocus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(close).toHaveFocus();
    } finally { visible.mockRestore(); }
  });

  it('moves focus to the feedback heading, not the keyboard-opening textarea, and back on Cancel', () => {
    render(<ReviewModal post={post} onApprove={noop} onRequestChanges={noop} onClose={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request Changes' }));
    expect(screen.getByRole('heading', { name: 'Request Changes' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Specific feedback' })).not.toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Close Review' })).toHaveFocus();
  });

  it('preserves feedback through Cancel and does not submit merely by changing focus or pressing Escape', () => {
    const onApprove = vi.fn(), onRequestChanges = vi.fn(), onClose = vi.fn();
    render(<ReviewModal post={post} onApprove={onApprove} onRequestChanges={onRequestChanges} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request Changes' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request Changes' }));
    expect(screen.getByRole('textbox')).toHaveValue('Keep my note');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    expect(onRequestChanges).not.toHaveBeenCalled();
  });

  it('keeps the full preview and image before approval in document order', () => {
    render(<ReviewModal post={{ ...post, imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' }} onApprove={noop} onRequestChanges={noop} onClose={noop} />);
    const approve = screen.getByRole('button', { name: 'Approve Thread' });
    const preview = screen.getByRole('button', { name: 'Learn More' });
    const image = screen.getByRole('img', { name: post.altText });
    expect(preview.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(image.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Posted on Google')).toBeInTheDocument();
    expect(screen.getAllByText(post.content)).toHaveLength(2);
  });
});
