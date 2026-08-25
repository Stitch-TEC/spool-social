export function composeReviewFeedback(activeTags, rawFeedback) {
  const tags = Array.isArray(activeTags)
    ? activeTags.filter((tag) => typeof tag === 'string' && tag)
    : [];
  const note = typeof rawFeedback === 'string' ? rawFeedback : '';
  const prefix = tags.join(', ');
  return `${prefix}${prefix && note ? ' - ' : ''}${note}`;
}

export function reviewFeedbackState(activeTags, rawFeedback, max = 500) {
  const text = composeReviewFeedback(activeTags, rawFeedback);
  const length = text.length;
  const hasText = text.trim().length > 0;
  const overBy = Math.max(0, length - max);
  return {
    text,
    length,
    hasText,
    overBy,
    valid: hasText && length <= max,
  };
}
