// Shared by the browser and Worker. Optional metadata only, never a post title
// or proof of remote access. Invalid input is refused whole, not truncated.
export const VIDEO_TITLE_LIMIT = 120;
// eslint-disable-next-line no-control-regex
const UNSAFE_TITLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

export function normalizeVideoTitle(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > VIDEO_TITLE_LIMIT || UNSAFE_TITLE.test(value)) return null;
  return value.trim();
}
