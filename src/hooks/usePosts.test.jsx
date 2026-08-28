import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => ({ subscriptions: [] }));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, name) => ({ name })),
  query: vi.fn((base, ...constraints) => ({ base, constraints })),
  where: vi.fn((...args) => args),
  onSnapshot: vi.fn((_query, next, error) => {
    firestore.subscriptions.push({ next, error });
    return vi.fn();
  }),
}));

vi.mock('../config/firebase', () => ({ db: {} }));

import usePosts from './usePosts';

const added = (id, scheduledDate, tags = []) => ({
  type: 'added',
  doc: {
    id,
    data: () => ({
      uid: 'owner',
      client: 'Example',
      content: 'Draft',
      createdAt: '2026-08-27T12:00:00.000Z',
      scheduledDate,
      tags,
    }),
  },
});

describe('usePosts scheduled-date read compatibility', () => {
  beforeEach(() => {
    firestore.subscriptions.length = 0;
  });

  it('loads legacy local-minute and malformed rows without taking down the signed-in snapshot', async () => {
    const { result } = renderHook(() => usePosts(
      { uid: 'owner' }, null, null, null, true,
    ));

    await waitFor(() => expect(firestore.subscriptions).toHaveLength(2));
    act(() => {
      firestore.subscriptions[0].next({
        docChanges: () => [
          added('legacy-local', '2026-09-01T12:34'),
          added('malformed', 'not-a-date', ['valid', { malformed: true }, 42]),
        ],
      });
    });

    await waitFor(() => expect(result.current.posts).toHaveLength(2));
    const legacy = result.current.posts.find((post) => post.id === 'legacy-local');
    const malformed = result.current.posts.find((post) => post.id === 'malformed');

    expect(legacy.scheduledDate).toBeInstanceOf(Date);
    expect(legacy.scheduledDate.getFullYear()).toBe(2026);
    expect(legacy.scheduledDate.getMonth()).toBe(8);
    expect(legacy.scheduledDate.getDate()).toBe(1);
    expect(legacy.scheduledDate.getHours()).toBe(12);
    expect(legacy.scheduledDate.getMinutes()).toBe(34);
    expect(malformed.scheduledDate).toBeNull();
    expect(malformed.tags).toEqual(['valid']);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
