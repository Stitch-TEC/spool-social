import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

const emulatorIsRunning = !!globalThis.process?.env?.FIRESTORE_EMULATOR_HOST;
const OWNER_UID = 'sLcLtGsm9SOKkR82a6cDoLCOOVO2';
const PROJECT_ID = 'spool-rules-test';
const POST_ID = 'review-post';
const TOKEN = 'review-token';
const NOW = '2026-08-24T20:00:00.000Z';

describe.skipIf(!emulatorIsRunning)('guest review Firestore rules', () => {
  let testEnv;
  let guestDb;
  let memberDb;

  const postRef = () => doc(guestDb, 'posts', POST_ID);

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
      },
    });
    guestDb = testEnv.authenticatedContext('guest-user', {
      share: true,
      shareOwner: OWNER_UID,
      shareClientId: 'acme',
      shareToken: TOKEN,
    }).firestore();
    memberDb = testEnv.authenticatedContext('member-user', {
      email: 'member@example.com',
    }).firestore();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'shares', TOKEN), {
        uid: OWNER_UID,
        clientId: 'acme',
        revoked: false,
      });
      await setDoc(doc(db, 'users', 'member@example.com'), {
        email: 'member@example.com',
        roles: ['client'],
        clientId: 'acme',
      });
      await setDoc(doc(db, 'posts', POST_ID), {
        uid: OWNER_UID,
        clientId: 'acme',
        client: 'Acme',
        content: 'Approved payload',
        platform: 'gmb',
        status: 'draft',
        approvalStatus: 'pending',
        feedback: '',
        feedbackThread: [],
        reviewStage: 'in_review',
        updatedAt: '2026-08-24T19:00:00.000Z',
      });
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('allows the app approval transition and draft-to-scheduled advance', async () => {
    await assertSucceeds(updateDoc(postRef(), {
      status: 'scheduled',
      approvalStatus: 'approved',
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it('allows one bounded, client-attributed feedback append', async () => {
    await assertSucceeds(updateDoc(postRef(), {
      approvalStatus: 'changes_requested',
      feedback: 'Please tighten the CTA.',
      feedbackThread: arrayUnion({
        text: 'Please tighten the CTA.',
        by: 'client',
        at: NOW,
      }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it('allows repeating the same feedback in a later round without rewriting history', async () => {
    const prior = { text: 'Please tighten the CTA.', by: 'client', at: '2026-08-24T18:00:00.000Z' };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'changes_requested',
        feedback: prior.text,
        feedbackThread: [prior],
      });
    });

    await assertSucceeds(updateDoc(postRef(), {
      approvalStatus: 'changes_requested',
      feedback: prior.text,
      feedbackThread: arrayUnion({ text: prior.text, by: 'client', at: NOW }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it('supports a legacy post with no feedbackThread field', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'posts', POST_ID), {
        uid: OWNER_UID,
        clientId: 'acme',
        client: 'Acme',
        content: 'Legacy payload',
        status: 'draft',
        approvalStatus: 'pending',
        feedback: '',
        reviewStage: 'in_review',
        updatedAt: '2026-08-24T19:00:00.000Z',
      });
    });

    await assertSucceeds(updateDoc(postRef(), {
      approvalStatus: 'changes_requested',
      feedback: 'Legacy note',
      feedbackThread: arrayUnion({ text: 'Legacy note', by: 'client', at: NOW }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it.each(['posted', 'archived'])('approves %s content without rewinding workflow status', async (status) => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        status,
        approvalStatus: 'pending',
        updatedAt: '2026-08-24T19:00:00.000Z',
      });
    });
    await assertSucceeds(updateDoc(postRef(), {
      approvalStatus: 'approved',
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it('rejects a token bound to the wrong owner/client and a revoked share', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { uid: 'different-owner' });
    });
    await assertFails(updateDoc(postRef(), { approvalStatus: 'approved', updatedAt: NOW }));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        uid: OWNER_UID,
        clientId: 'different-client',
      });
    });
    await assertFails(updateDoc(postRef(), { approvalStatus: 'approved', updatedAt: NOW }));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { clientId: 'acme' });
      await updateDoc(doc(context.firestore(), 'shares', TOKEN), { revoked: true });
    });
    await assertFails(updateDoc(postRef(), { approvalStatus: 'approved', updatedAt: NOW }));
  });

  it('makes private and legacy-missing stage unreadable and immutable to guests and members', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'posts', 'private-post'), {
        uid: OWNER_UID, clientId: 'acme', client: 'Acme', content: 'Operator staging',
        status: 'draft', approvalStatus: 'pending', feedback: '', feedbackThread: [],
        reviewStage: 'private', updatedAt: NOW,
      });
      await setDoc(doc(db, 'posts', 'legacy-post'), {
        uid: OWNER_UID, clientId: 'acme', client: 'Acme', content: 'Missing stage',
        status: 'draft', approvalStatus: 'pending', feedback: '', feedbackThread: [],
        updatedAt: NOW,
      });
    });

    for (const id of ['private-post', 'legacy-post']) {
      await assertFails(getDoc(doc(guestDb, 'posts', id)));
      await assertFails(getDoc(doc(memberDb, 'posts', id)));
      await assertFails(updateDoc(doc(guestDb, 'posts', id), { approvalStatus: 'approved', updatedAt: NOW }));
      await assertFails(updateDoc(doc(memberDb, 'posts', id), { content: 'Member edit' }));
      await assertFails(deleteDoc(doc(guestDb, 'posts', id)));
      await assertFails(deleteDoc(doc(memberDb, 'posts', id)));
    }
  });

  it('allows stage-constrained guest/member reads and excludes private/legacy rows', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'posts', 'private-post'), {
        uid: OWNER_UID, clientId: 'acme', client: 'Acme', reviewStage: 'private', content: 'Private',
      });
      await setDoc(doc(db, 'posts', 'legacy-post'), {
        uid: OWNER_UID, clientId: 'acme', client: 'Acme', content: 'Legacy',
      });
    });

    const guestQuery = query(
      collection(guestDb, 'posts'),
      where('clientId', '==', 'acme'),
      where('uid', '==', OWNER_UID),
      where('reviewStage', '==', 'in_review'),
    );
    const memberQuery = query(
      collection(memberDb, 'posts'),
      where('clientId', '==', 'acme'),
      where('reviewStage', '==', 'in_review'),
    );
    const guestRows = await assertSucceeds(getDocs(guestQuery));
    const memberRows = await assertSucceeds(getDocs(memberQuery));
    if (guestRows.size !== 1 || memberRows.size !== 1) throw new Error('stage query leaked or hid rows');

    await assertFails(getDocs(query(collection(guestDb, 'posts'), where('clientId', '==', 'acme'), where('uid', '==', OWNER_UID))));
    await assertFails(getDocs(query(collection(memberDb, 'posts'), where('clientId', '==', 'acme'))));
  });

  it('allows member CRUD only while a post remains in_review', async () => {
    await assertSucceeds(getDoc(doc(memberDb, 'posts', POST_ID)));
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      content: 'Member edit', updatedAt: NOW,
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), { reviewStage: 'private' }));
    await assertSucceeds(deleteDoc(doc(memberDb, 'posts', POST_ID)));
  });

  it('allows member creation only into the in-review boundary', async () => {
    const base = {
      uid: OWNER_UID,
      clientId: 'acme',
      client: 'Acme',
      content: 'Member-authored copy',
      platform: 'gmb',
      status: 'draft',
      approvalStatus: 'pending',
      feedback: '',
      feedbackThread: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    await assertSucceeds(setDoc(doc(memberDb, 'posts', 'member-visible'), {
      ...base,
      reviewStage: 'in_review',
    }));
    await assertFails(setDoc(doc(memberDb, 'posts', 'member-private'), {
      ...base,
      reviewStage: 'private',
    }));
  });

  it('rejects member-created posted/approved state', async () => {
    const base = {
      uid: OWNER_UID, clientId: 'acme', client: 'Acme', content: 'Fresh copy',
      platform: 'gmb', feedback: '', feedbackThread: [], reviewStage: 'in_review',
      createdAt: NOW, updatedAt: NOW,
    };
    await assertFails(setDoc(doc(memberDb, 'posts', 'forged-create'), {
      ...base, status: 'posted', approvalStatus: 'approved',
    }));
  });

  it('requires an approved payload edit to reset approval atomically', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { approvalStatus: 'approved' });
    });
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      content: 'Changed approved copy', updatedAt: NOW,
    }));
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      content: 'Changed approved copy', approvalStatus: 'pending', updatedAt: NOW,
    }));
  });

  it('treats platform as approved payload in member editorial rules', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { approvalStatus: 'approved' });
    });
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      platform: 'linkedin', updatedAt: NOW,
    }));
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      platform: 'linkedin', approvalStatus: 'pending', updatedAt: NOW,
    }));
  });

  it('keeps resubmit exclusive and forbids approval revocation on metadata-only edits', async () => {
    const prior = { text: 'Fix CTA', by: 'client', at: '2026-08-24T18:00:00.000Z' };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'changes_requested', feedback: prior.text, feedbackThread: [prior],
      });
    });
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: ['metadata-only'], approvalStatus: 'pending', updatedAt: NOW,
    }));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'approved', feedback: '', feedbackThread: [],
      });
    });
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: ['metadata-only'], approvalStatus: 'pending', updatedAt: NOW,
    }));
  });

  it('bounds every member-authored tag by type and length', async () => {
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: ['launch', 'q3'], updatedAt: NOW,
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: [{ forged: true }], updatedAt: NOW,
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: [''], updatedAt: NOW,
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: ['x'.repeat(21)], updatedAt: NOW,
    }));
  });

  it('rejects member-forged workflow, review history, and attribution', async () => {
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      status: 'posted', updatedAt: NOW,
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      approvalStatus: 'changes_requested', feedback: 'Forged',
      feedbackThread: arrayUnion({ text: 'Forged', by: 'you', at: NOW }),
      reviewedBy: 'you', reviewedAt: NOW, updatedAt: NOW,
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      feedbackThread: [{ text: 'Replacement', by: 'client', at: NOW }],
      reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW,
    }));
  });

  it('allows a member review only with client attribution and append-only history', async () => {
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      approvalStatus: 'changes_requested', feedback: 'Member note',
      feedbackThread: arrayUnion({ text: 'Member note', by: 'client', at: NOW }),
      reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW,
    }));
  });

  it('allows member resubmit to pending without clearing prior history', async () => {
    const prior = { text: 'Fix CTA', by: 'client', at: '2026-08-24T18:00:00.000Z' };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'changes_requested', feedback: prior.text, feedbackThread: [prior],
      });
    });
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      approvalStatus: 'pending', feedback: '', sentForReviewAt: NOW, updatedAt: NOW,
    }));
    const snapshot = await getDoc(doc(memberDb, 'posts', POST_ID));
    if (snapshot.data().feedbackThread.length !== 1) throw new Error('resubmit rewrote history');
  });

  it('rejects arbitrary approval/workflow values and content edits', async () => {
    await assertFails(updateDoc(postRef(), {
      approvalStatus: 'owner',
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
    await assertFails(updateDoc(postRef(), {
      status: 'posted',
      approvalStatus: 'approved',
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
    await assertFails(updateDoc(postRef(), {
      content: 'Guest-authored replacement',
      approvalStatus: 'approved',
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        status: 'draft',
        approvalStatus: 'approved',
      });
    });
    await assertFails(updateDoc(postRef(), {
      status: 'scheduled',
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it('rejects oversized feedback and replacement of prior history', async () => {
    const first = { text: 'First note', by: 'client', at: '2026-08-24T17:00:00.000Z' };
    const prior = { text: 'Original note', by: 'client', at: '2026-08-24T18:00:00.000Z' };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'changes_requested',
        feedback: prior.text,
        feedbackThread: [first, prior],
      });
    });

    const replacement = { text: 'Replacement', by: 'client', at: NOW };
    await assertFails(updateDoc(postRef(), {
      feedback: replacement.text,
      feedbackThread: [replacement],
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
    await assertFails(updateDoc(postRef(), {
      feedback: replacement.text,
      feedbackThread: [prior, first, replacement],
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
    await assertFails(updateDoc(postRef(), {
      feedback: 'x'.repeat(501),
      feedbackThread: arrayUnion({ text: 'x'.repeat(501), by: 'client', at: NOW }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
  });

  it('rejects a 201st history entry and malformed/divergent client timestamps', async () => {
    const fullThread = Array.from({ length: 200 }, (_, i) => ({
      text: `Note ${i}`,
      by: 'client',
      at: '2026-08-24T18:00:00.000Z',
    }));
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'changes_requested',
        feedback: 'Note 199',
        feedbackThread: fullThread,
      });
    });
    await assertFails(updateDoc(postRef(), {
      feedback: 'One too many',
      feedbackThread: arrayUnion({ text: 'One too many', by: 'client', at: NOW }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        approvalStatus: 'pending',
        feedback: '',
        feedbackThread: [],
      });
    });
    await assertFails(updateDoc(postRef(), {
      approvalStatus: 'changes_requested',
      feedback: 'Bad clock',
      feedbackThread: arrayUnion({ text: 'Bad clock', by: 'client', at: 'yesterday' }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
    await assertFails(updateDoc(postRef(), {
      approvalStatus: 'changes_requested',
      feedback: 'Divergent clock',
      feedbackThread: arrayUnion({
        text: 'Divergent clock',
        by: 'client',
        at: '2026-08-24T20:00:01.000Z',
      }),
      reviewedBy: 'client',
      reviewedAt: NOW,
      updatedAt: NOW,
    }));
    await assertFails(updateDoc(postRef(), {
      approvalStatus: 'approved',
      reviewedBy: 'client',
      reviewedAt: 'not-an-iso-time',
      updatedAt: 'not-an-iso-time',
    }));
  });
});
