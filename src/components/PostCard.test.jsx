import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PostCard from './PostCard';
import { DENSITY } from '../constants';

const basePost = {
  id: 'p1',
  client: 'Acme',
  platform: 'gmb',
  content: 'Draft content',
  status: 'draft',
  approvalStatus: 'pending',
};

describe('PostCard', () => {
  it('renders content + client and calls onEdit when the body is clicked', () => {
    const onEdit = vi.fn();
    render(<PostCard post={basePost} onEdit={onEdit} />);
    expect(screen.getByText('Draft content')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Draft content'));
    expect(onEdit).toHaveBeenCalledWith(basePost);
  });

  it('shows the approved badge when the post is approved', () => {
    render(<PostCard post={{ ...basePost, approvalStatus: 'approved' }} onEdit={() => {}} />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('hides owner-only actions in read-only (guest) mode', () => {
    render(<PostCard post={basePost} onEdit={() => {}} isReadOnly />);
    expect(screen.queryByLabelText('Delete Thread')).toBeNull();
    expect(screen.queryByLabelText('Set post status')).toBeNull();
  });

  it('passes the exact rendered post as the guest approval baseline', () => {
    const onStatusChange = vi.fn();
    render(<PostCard post={basePost} onEdit={() => {}} onStatusChange={onStatusChange} isReadOnly />);
    fireEvent.click(screen.getByText('Approve'));
    expect(onStatusChange).toHaveBeenCalledWith('p1', 'scheduled', basePost);
  });

  it('renders a template card with a badge and "Use as draft" instead of Mark Done', () => {
    const onUseTemplate = vi.fn();
    const tmpl = { ...basePost, isTemplate: true };
    render(<PostCard post={tmpl} onEdit={() => {}} onUseTemplate={onUseTemplate} />);
    expect(screen.getByText('Template')).toBeInTheDocument();
    expect(screen.queryByLabelText('Set post status')).toBeNull();
    fireEvent.click(screen.getByText('Use as draft'));
    expect(onUseTemplate).toHaveBeenCalledWith(tmpl);
  });

  it('shows a status selector for a non-template post and can set it to Scheduled', () => {
    const onStatusChange = vi.fn();
    render(<PostCard post={basePost} onEdit={() => {}} onStatusChange={onStatusChange} />);
    const sel = screen.getByLabelText('Set post status');
    expect(sel).toBeInTheDocument();
    expect(screen.queryByText('Use as draft')).toBeNull();
    fireEvent.change(sel, { target: { value: 'scheduled' } });
    expect(onStatusChange).toHaveBeenCalledWith('p1', 'scheduled');
  });

  it('limits member workflow controls to rule-permitted statuses', () => {
    render(
      <PostCard
        post={basePost}
        onEdit={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
        onStatusChange={() => {}}
        statusOptions={['draft', 'scheduled']}
      />
    );
    const values = [...screen.getByLabelText('Set post status').options].map(option => option.value);
    expect(values).toEqual(['draft', 'scheduled']);
    expect(screen.queryByLabelText('Archive Thread')).toBeNull();
    expect(screen.queryByLabelText('Blast: Clone to All Clients')).toBeNull();
  });

  it('offers "Back for review" (replacing the status selector) when changes are requested', () => {
    const onResubmit = vi.fn();
    const post = { ...basePost, approvalStatus: 'changes_requested', feedback: 'Tighten the CTA' };
    render(<PostCard post={post} onEdit={() => {}} onStatusChange={() => {}} onResubmit={onResubmit} />);
    expect(screen.queryByLabelText('Set post status')).toBeNull();
    fireEvent.click(screen.getByText('Back for review'));
    expect(onResubmit).toHaveBeenCalledWith(post);
  });

  it('badges an automation-sourced draft as "Auto" only when provenance is shown (operators)', () => {
    const auto = { ...basePost, source: 'automation' };
    // Operator view: the Auto badge distinguishes a machine draft from a hand-written one.
    const { rerender } = render(<PostCard post={auto} onEdit={() => {}} onStatusChange={() => {}} showProvenance />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
    // Client/guest view (no showProvenance): no machine-provenance labeling.
    rerender(<PostCard post={auto} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.queryByText('Auto')).toBeNull();
  });

  it('shows a generated date on a plain auto draft, and a linked source page on a grounded one (operators)', () => {
    // Plain cron auto draft (no site grounding): still self-explains with a generated date.
    const plain = { ...basePost, source: 'automation', createdAt: '2026-07-20T00:00:00Z' };
    const { rerender } = render(<PostCard post={plain} onEdit={() => {}} onStatusChange={() => {}} showProvenance />);
    expect(screen.getByText(/Generated/)).toBeInTheDocument();
    // Grounded auto draft: shows the client's own source page as a link (provenance the worker now
    // stamps on auto drafts too, not just suggestions).
    const grounded = { ...plain, suggestPageUrl: 'https://acme.com/news', suggestPageTitle: 'Latest news' };
    rerender(<PostCard post={grounded} onEdit={() => {}} onStatusChange={() => {}} showProvenance />);
    expect(screen.getByText('Latest news').closest('a')).toHaveAttribute('href', 'https://acme.com/news');
    // Clients/guests never see any of this provenance.
    rerender(<PostCard post={grounded} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.queryByText('Latest news')).toBeNull();
    expect(screen.queryByText(/Generated/)).toBeNull();
  });

  it('shows the "Suggested" badge and site provenance on a parked suggestion card', () => {
    const suggestion = {
      ...basePost,
      source: 'suggestion',
      suggestPageTitle: 'Our Services',
      suggestPageUrl: 'https://acme.com/services',
    };
    render(
      <PostCard
        post={suggestion}
        onEdit={() => {}}
        onPromoteSuggestion={() => {}}
        onDismissSuggestion={() => {}}
        showProvenance
      />
    );
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    // Provenance links to the source page so "Use this" is an informed click.
    const link = screen.getByText('Our Services').closest('a');
    expect(link).toHaveAttribute('href', 'https://acme.com/services');
    expect(screen.getByText('Use this')).toBeInTheDocument();
  });
});

describe('PostCard — the review pipeline', () => {
  it('badges a staged post "Not sent" and offers Send instead of a status dropdown', () => {
    // A staged draft's only meaningful next step is showing it to the client, so the
    // status dropdown (which changes nothing the client can see) gives way to it.
    const onSendForReview = vi.fn();
    const staged = { ...basePost, reviewStage: 'private' };
    render(<PostCard post={staged} onEdit={() => {}} onStatusChange={() => {}} onSendForReview={onSendForReview} />);
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    expect(screen.queryByLabelText('Set post status')).toBeNull();
    fireEvent.click(screen.getByText('Send for review'));
    expect(onSendForReview).toHaveBeenCalledWith(staged);
  });

  it('treats a post with NO reviewStage as already in review (legacy back-compat)', () => {
    render(<PostCard post={basePost} onEdit={() => {}} onStatusChange={() => {}} onSendForReview={() => {}} />);
    expect(screen.getByText('Awaiting')).toBeInTheDocument();
    expect(screen.queryByText('Send for review')).toBeNull();
    expect(screen.getByLabelText('Set post status')).toBeInTheDocument();
  });

  it('lets an approval outrank the stage — pulling an approved post back still reads Approved', () => {
    render(<PostCard post={{ ...basePost, reviewStage: 'private', approvalStatus: 'approved' }} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByText('Not sent')).toBeNull();
  });

  it('offers "Move to staging" only for a post that is actually with the client', () => {
    const onHoldFromReview = vi.fn();
    const { rerender } = render(<PostCard post={basePost} onEdit={() => {}} onStatusChange={() => {}} onHoldFromReview={onHoldFromReview} />);
    fireEvent.click(screen.getByLabelText('Move to staging'));
    expect(onHoldFromReview).toHaveBeenCalledWith(basePost);
    rerender(<PostCard post={{ ...basePost, reviewStage: 'private' }} onEdit={() => {}} onStatusChange={() => {}} onHoldFromReview={onHoldFromReview} />);
    expect(screen.queryByLabelText('Move to staging')).toBeNull();
  });

  it('keeps archived rows out of every review-action surface', () => {
    const props = {
      onEdit: () => {}, onStatusChange: () => {}, onResubmit: vi.fn(),
      onSendForReview: vi.fn(), onHoldFromReview: vi.fn(),
    };
    const { rerender } = render(<PostCard
      post={{ ...basePost, status: 'archived', approvalStatus: 'changes_requested', reviewStage: 'in_review' }}
      {...props}
    />);
    expect(screen.queryByText('Back for review')).toBeNull();
    expect(screen.queryByLabelText('Move to staging')).toBeNull();
    rerender(<PostCard post={{ ...basePost, status: 'archived', reviewStage: 'private' }} {...props} />);
    expect(screen.queryByText('Send for review')).toBeNull();
  });

  it('shows no review badge on a template or a parked suggestion (neither is in the loop)', () => {
    const { rerender } = render(<PostCard post={{ ...basePost, isTemplate: true }} onEdit={() => {}} onUseTemplate={() => {}} />);
    expect(screen.queryByText('Awaiting')).toBeNull();
    rerender(
      <PostCard post={{ ...basePost, source: 'suggestion' }} onEdit={() => {}} onPromoteSuggestion={() => {}} onDismissSuggestion={() => {}} />
    );
    expect(screen.queryByText('Awaiting')).toBeNull();
  });
});

describe('PostCard — readiness', () => {
  it('names what is missing, to the operator only', () => {
    const gap = { ...basePost, platform: 'instagram', imageUrl: '', scheduledDate: null };
    const { rerender } = render(<PostCard post={gap} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.getByText('Needs an image')).toBeInTheDocument();
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
    // A review guest sees the post, not our production checklist.
    rerender(<PostCard post={gap} onEdit={() => {}} onStatusChange={() => {}} isReadOnly />);
    expect(screen.queryByText('Needs an image')).toBeNull();
  });
});

describe('PostCard — feedback history', () => {
  const threaded = {
    ...basePost,
    approvalStatus: 'pending',
    feedback: '',
    feedbackThread: [
      { text: 'Too formal', by: 'client', at: '2026-08-01T00:00:00Z' },
      { text: 'Reworked the opener', by: 'you', at: '2026-08-02T00:00:00Z' },
      { text: 'Better — tighten the CTA', by: 'client', at: '2026-08-03T00:00:00Z' },
    ],
  };

  it('survives "Back for review" clearing the latest-note field', () => {
    // `feedback` is cleared on resubmit by design; before this the operator lost every
    // trace of what the client had asked for the moment they acted on it.
    render(<PostCard post={threaded} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.getByText('“Better — tighten the CTA”')).toBeInTheDocument();
  });

  it('collapses earlier rounds behind a disclosure', () => {
    render(<PostCard post={threaded} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.queryByText('“Too formal”')).toBeNull();
    fireEvent.click(screen.getByText('+2 earlier notes'));
    expect(screen.getByText('“Too formal”')).toBeInTheDocument();
    expect(screen.getByText('“Reworked the opener”')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Hide earlier notes'));
    expect(screen.queryByText('“Too formal”')).toBeNull();
  });

  it('falls back to the legacy single field for posts that predate threading', () => {
    render(<PostCard post={{ ...basePost, feedback: 'Wrong photo' }} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.getByText('“Wrong photo”')).toBeInTheDocument();
    expect(screen.queryByText(/earlier note/)).toBeNull();
  });
});

describe('PostCard — compact density', () => {
  // Compact keeps every verb the card has; what it gives up is vertical space, so
  // anything that can grow without bound (tags, readiness chips) gets a tighter cap
  // and an honest "+N" rather than being allowed to wrap.
  const blogGaps = { ...basePost, platform: 'blog', imageUrl: '', scheduledDate: null };

  it('keeps every card action, as icons without their labels', () => {
    render(<PostCard post={basePost} onEdit={() => {}} onStatusChange={() => {}} density={DENSITY.COMPACT} />);
    expect(screen.getByLabelText('Open platform app')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy content to clipboard')).toBeInTheDocument();
    expect(screen.getByLabelText('Set post status')).toBeInTheDocument();
    // The labels are what a 300px card cannot afford — they wrapped the footer.
    expect(screen.queryByText('Open App')).toBeNull();
  });

  it('caps the tag row and says how many it folded', () => {
    const tagged = { ...basePost, tags: ['pillar', 'series', 'cal-9931', 'import'] };
    const { rerender } = render(<PostCard post={tagged} onEdit={() => {}} onStatusChange={() => {}} density={DENSITY.COMPACT} />);
    expect(screen.getByText('pillar')).toBeInTheDocument();
    expect(screen.getByText('series')).toBeInTheDocument();
    expect(screen.queryByText('cal-9931')).toBeNull();
    expect(screen.getByTitle('cal-9931 · import')).toHaveTextContent('+2');

    // Cards has the room, so it shows them all.
    rerender(<PostCard post={tagged} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.getByText('cal-9931')).toBeInTheDocument();
    expect(screen.queryByText('+2')).toBeNull();
  });

  it('caps readiness chips at two, against three on a full card', () => {
    // A blog draft with no image, no date, no title and no meta description: four gaps.
    const { rerender } = render(<PostCard post={blogGaps} onEdit={() => {}} onStatusChange={() => {}} density={DENSITY.COMPACT} />);
    expect(screen.getByText('No image')).toBeInTheDocument();
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
    expect(screen.queryByText('No title')).toBeNull();
    expect(screen.getByTitle('No title · No meta description')).toHaveTextContent('+2');

    rerender(<PostCard post={blogGaps} onEdit={() => {}} onStatusChange={() => {}} />);
    expect(screen.getByText('No title')).toBeInTheDocument();
    expect(screen.getByTitle('No meta description')).toHaveTextContent('+1');
  });

  it('still renders the image, as a thumbnail beside the copy', () => {
    const withImage = { ...basePost, imageUrl: 'https://example.com/a.jpg', altText: 'Studio' };
    render(<PostCard post={withImage} onEdit={() => {}} onStatusChange={() => {}} density={DENSITY.COMPACT} />);
    expect(screen.getByAltText('Studio')).toHaveAttribute('src', 'https://example.com/a.jpg');
  });
});
