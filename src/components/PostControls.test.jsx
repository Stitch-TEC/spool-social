import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import PostControls from './PostControls';
import { SORT_ORDERS } from '../utils/helpers';

const base = {
  sortBy: SORT_ORDERS.SCHEDULED_DESC,
  onSortChange: () => {},
  filterPlatform: null,
  onPlatformChange: () => {},
  platformCounts: { gmb: 8, linkedin: 5, instagram: 12, blog: 0 },
  showClientSort: true,
};

const optionText = (label) =>
  within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);

describe('PostControls', () => {
  it('offers only platforms that have posts, with counts, plus "All platforms"', () => {
    render(<PostControls {...base} />);
    const opts = optionText('Filter by platform');
    expect(opts[0]).toBe('All platforms');
    expect(opts).toContain('Google Business (8)');
    expect(opts).toContain('Instagram (12)');
    expect(opts).toContain('LinkedIn (5)');
    expect(opts.some((o) => o.startsWith('Blog'))).toBe(false); // count 0 → hidden
  });

  it('calls onPlatformChange with the id, and null for "All platforms"', () => {
    const onPlatformChange = vi.fn();
    render(<PostControls {...base} onPlatformChange={onPlatformChange} />);
    const sel = screen.getByLabelText('Filter by platform');
    fireEvent.change(sel, { target: { value: 'gmb' } });
    expect(onPlatformChange).toHaveBeenCalledWith('gmb');
    fireEvent.change(sel, { target: { value: '' } });
    expect(onPlatformChange).toHaveBeenLastCalledWith(null);
  });

  it('shows Client A–Z only when showClientSort is true', () => {
    const { rerender } = render(<PostControls {...base} showClientSort />);
    expect(optionText('Sort posts')).toContain('Client A–Z');
    rerender(<PostControls {...base} showClientSort={false} />);
    expect(optionText('Sort posts')).not.toContain('Client A–Z');
  });

  it('calls onSortChange with the chosen order', () => {
    const onSortChange = vi.fn();
    render(<PostControls {...base} onSortChange={onSortChange} />);
    fireEvent.change(screen.getByLabelText('Sort posts'), { target: { value: SORT_ORDERS.SCHEDULED_ASC } });
    expect(onSortChange).toHaveBeenCalledWith(SORT_ORDERS.SCHEDULED_ASC);
  });

  it('keeps the active platform selectable even if its count dropped to 0', () => {
    render(<PostControls {...base} filterPlatform="twitter" platformCounts={{ gmb: 3 }} />);
    const opts = optionText('Filter by platform');
    expect(opts).toContain('X / Twitter (0)'); // active filter preserved as an option
  });

  it('shows a tag filter with only shared (2+) tags, ranked by count', () => {
    render(<PostControls {...base} filterTag={null} onTagChange={() => {}} tagCounts={{ growth: 3, culture: 5, 'FB-01': 1 }} />);
    const opts = optionText('Filter by tag');
    expect(opts[0]).toBe('All tags');
    expect(opts[1]).toBe('#culture (5)'); // highest count first
    expect(opts[2]).toBe('#growth (3)');
    expect(opts.some((o) => o.includes('FB-01'))).toBe(false); // per-post tag hidden
  });

  it('hides the tag filter entirely when no tag is shared by 2+ posts', () => {
    render(<PostControls {...base} filterTag={null} onTagChange={() => {}} tagCounts={{ a: 1, b: 1 }} />);
    expect(screen.queryByLabelText('Filter by tag')).toBeNull();
  });

  it('calls onTagChange with the tag and null for "All tags"', () => {
    const onTagChange = vi.fn();
    render(<PostControls {...base} filterTag={null} onTagChange={onTagChange} tagCounts={{ growth: 2, culture: 4 }} />);
    const sel = screen.getByLabelText('Filter by tag');
    fireEvent.change(sel, { target: { value: 'growth' } });
    expect(onTagChange).toHaveBeenCalledWith('growth');
    fireEvent.change(sel, { target: { value: '' } });
    expect(onTagChange).toHaveBeenLastCalledWith(null);
  });
});
