import { assertLegacyReviewWriter } from './reviewDetails';

// Memory-only admission for a delayed confirmation/batch. It is not a server
// lock: deployed rules must also fence concurrent and unaware legacy writers.
export function assertLegacyReviewSelection(posts, ids) {
  const current = new Map(posts.map(post => [post.id, post]));
  for (const id of ids) {
    const post = current.get(id);
    if (!post) throw new Error('A selected thread is no longer available. Check the list before continuing.');
    assertLegacyReviewWriter(post);
  }
}
