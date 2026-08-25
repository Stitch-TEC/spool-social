import { describe, expect, it } from 'vitest';
import { composeReviewFeedback, reviewFeedbackState } from './reviewFeedback';

describe('review feedback composition', () => {
  it('preserves exact raw feedback and counts the selected-tag prefix', () => {
    expect(composeReviewFeedback(['Fix Text', 'Tone Issue'], '  Keep spacing!  '))
      .toBe('Fix Text, Tone Issue -   Keep spacing!  ');
    const state = reviewFeedbackState(['Fix Text'], 'x'.repeat(490));
    expect(state.text).toBe(`Fix Text - ${'x'.repeat(490)}`);
    expect(state.length).toBe(501);
    expect(state).toMatchObject({ overBy: 1, valid: false });
  });

  it('accepts exact non-whitespace totals only and never invents a default note', () => {
    expect(reviewFeedbackState([], '')).toMatchObject({ text: '', hasText: false, valid: false });
    expect(reviewFeedbackState([], ' \n\t ')).toMatchObject({ hasText: false, valid: false });
    expect(reviewFeedbackState(['Fix Text'], '')).toMatchObject({ text: 'Fix Text', valid: true });
    expect(reviewFeedbackState([], 'x'.repeat(500))).toMatchObject({ length: 500, valid: true });
    expect(reviewFeedbackState([], 'x'.repeat(501))).toMatchObject({ length: 501, overBy: 1, valid: false });
  });
});
