import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  assertFails as sdkAssertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { approvalSafeStoragePatch } from './src/utils/review';
import { createScope, workCopy } from './src/utils/createJournal';
import { intentRequest } from './src/utils/createTransport';
import { rulesEvaluationFailures } from './scripts/rulesTestEvidence.mjs';

async function assertFails(operation) {
  const error = await sdkAssertFails(operation);
  expect(rulesEvaluationFailures(String(error))).toEqual([]);
  return error;
}

const emulatorIsRunning = !!globalThis.process?.env?.FIRESTORE_EMULATOR_HOST;
const OWNER_UID = 'sLcLtGsm9SOKkR82a6cDoLCOOVO2';
const PROJECT_ID = 'demo-spool-rules';
const POST_ID = 'review-post';
const TOKEN = 'review-token';
const NOW = '2026-08-24T20:00:00.000Z';

if (globalThis.process?.env?.SPOOL_RULES_REQUIRED === '1'
  && (!emulatorIsRunning || globalThis.process.env.SPOOL_RULES_PROJECT !== PROJECT_ID
    || !/^(localhost|127\.0\.0\.1):\d+$/.test(globalThis.process.env.FIRESTORE_EMULATOR_HOST))) {
  throw new Error('Rules acceptance requires the owned loopback demo emulator');
}

describe.skipIf(!emulatorIsRunning)('guest review Firestore rules', () => {
  let testEnv;
  let guestDb;
  let memberDb;

  const postRef = () => doc(guestDb, 'posts', POST_ID);

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(new NodeURL('./firestore.rules', import.meta.url), 'utf8'),
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

  const restFixture = (principalId = 'member-user', clientId = 'acme', stage = 'in_review') => {
    const scope = createScope({ principalId, clientId, projectId: PROJECT_ID });
    const work = workCopy({ client: 'Acme', content: 'Invented interrupted draft', platform: 'gmb', status: 'draft' });
    const payload = { ...work, slug: '', uid: OWNER_UID, clientId, approvalStatus: 'pending', feedback: '', reviewStage: stage, createdAt: NOW, updatedAt: NOW };
    const record = { scope, id: '0123456789abcdef0123456789abcdef', revision: 1, state: 'prepared', work, submittedWork: work, payload };
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = { iss: `https://securetoken.google.com/${PROJECT_ID}`, aud: PROJECT_ID, sub: principalId, user_id: principalId, email: principalId === 'member-user' ? 'member@example.com' : 'owner@example.test', iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'password', identities: {} } };
    const user = { uid: principalId, getIdToken: async () => `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.` };
    const methods = [];
    const fetcher = (url, init) => {
      const host = globalThis.process.env.FIRESTORE_EMULATOR_HOST;
      expect(host).toMatch(/^(localhost|127\.0\.0\.1):\d+$/);
      expect(url).toMatch(new RegExp(`^https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/`));
      methods.push(init.method);
      return fetch(url.replace('https://firestore.googleapis.com', `http://${host}`), init);
    };
    return { record, user, methods, fetcher, getUser: () => user, beforeCreate: async () => {} };
  };

  it.each([['member-user', 'in_review'], [OWNER_UID, 'private']])('creates and reconciles one explicit ID under unchanged rules for %s', async (uid, stage) => {
    const f = restFixture(uid, 'acme', stage);
    const saved = await intentRequest({ ...f, create: true });
    expect(saved).toMatchObject({ id: f.record.id, reviewStage: stage, clientId: 'acme' });
    expect(await intentRequest({ ...f, record: { ...f.record, state: 'submitted' } })).toEqual(saved);
    await expect(intentRequest({ ...f, create: true })).rejects.toThrow('not confirmed');
    expect(f.methods).toEqual(['POST', 'GET', 'POST']);
  });

  it('denies foreign-client and private member creates with the real REST adapter', async () => {
    for (const fixture of [restFixture('member-user', 'foreign'), restFixture('member-user', 'acme', 'private'), restFixture('unknown-user')]) await expect(intentRequest({ ...fixture, create: true })).rejects.toThrow('not confirmed');
  });

  it('keeps changed, deleted and unreadable outcomes unresolved; checks never recreate a document', async () => {
    const f = restFixture();
    await intentRequest({ ...f, create: true });
    const record = { ...f.record, state: 'submitted' };
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posts', record.id), { content: 'Newer approved work', approvalStatus: 'approved' }));
    await expect(intentRequest({ ...f, record })).rejects.toThrow('differs');
    expect((await getDoc(doc(memberDb, 'posts', record.id))).data().content).toBe('Newer approved work');
    await testEnv.withSecurityRulesDisabled(context => deleteDoc(doc(context.firestore(), 'posts', record.id)));
    await expect(intentRequest({ ...f, record })).rejects.toThrow('not confirmed');
    expect(f.methods).toEqual(['POST', 'GET', 'GET']);
    await assertFails(getDoc(doc(memberDb, 'posts', record.id)));
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

  it('allows approval after resubmit when reviewedBy already has the client value', async () => {
    const priorReviewAt = '2026-08-24T18:00:00.000Z';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        // The operator resubmit transition resets the result but deliberately
        // preserves the attribution from the preceding client review round.
        approvalStatus: 'pending',
        reviewedBy: 'client',
        reviewedAt: priorReviewAt,
        sentForReviewAt: '2026-08-24T19:00:00.000Z',
      });
    });

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

  it('rejects whitespace-only feedback without normalizing accepted text', async () => {
    await assertFails(updateDoc(postRef(), {
      approvalStatus: 'changes_requested',
      feedback: ' \n\t ',
      feedbackThread: arrayUnion({ text: ' \n\t ', by: 'client', at: NOW }),
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

  it('approves posted content without rewinding workflow status', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        status: 'posted',
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

  it('makes archived in-review rows non-actionable', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        status: 'archived',
        approvalStatus: 'pending',
        updatedAt: '2026-08-24T19:00:00.000Z',
      });
    });
    const review = {
      approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW,
    };
    await assertFails(updateDoc(postRef(), review));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), review));
  });

  it('rejects a token bound to the wrong owner/client and a revoked share', async () => {
    const review = { approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { uid: 'different-owner' });
    });
    await assertFails(updateDoc(postRef(), review));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        uid: OWNER_UID,
        clientId: 'different-client',
      });
    });
    await assertFails(updateDoc(postRef(), review));

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { clientId: 'acme' });
      await updateDoc(doc(context.firestore(), 'shares', TOKEN), { revoked: true });
    });
    await assertFails(updateDoc(postRef(), review));
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

  it.each([
    ['altText', 'New alt text'],
    ['metaDescription', 'New SEO description'],
    ['slug', 'new-publication-path'],
  ])('treats %s as approved payload in member editorial rules', async (field, value) => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { approvalStatus: 'approved' });
    });
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      [field]: value, updatedAt: NOW,
    }));
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      [field]: value, approvalStatus: 'pending', updatedAt: NOW,
    }));
  });

  it('treats missing and explicit-empty optional preview fields as the same approved payload', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { approvalStatus: 'approved' });
    });
    const safePatch = approvalSafeStoragePatch({
      platform: 'gmb', content: 'Approved payload',
    }, {
      title: '', imageUrl: '', altText: '', metaDescription: '', slug: '',
      tags: ['metadata-only'], updatedAt: NOW,
    });
    if (['title', 'imageUrl', 'altText', 'metaDescription', 'slug'].some((field) => field in safePatch)) {
      throw new Error('approval-safe write retained a missing-to-empty representation change');
    }
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), safePatch));
  });

  it('omits equivalent v1→v2 media and effective-slug storage writes before strict member rules', async () => {
    const legacy = {
      platform: 'blog', title: 'Approved title',
      content: '![inline](/media/generated/o/inline.png)',
      imageUrl: '/media/generated/o/cover.png',
    };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), {
        ...legacy,
        approvalStatus: 'approved',
      });
    });

    const safePatch = approvalSafeStoragePatch(legacy, {
      content: '![inline](https://spool.stitchtec.dev/media/v2/generated/o/inline.png)',
      imageUrl: 'https://spool.stitchtec.dev/media/v2/generated/o/cover.png',
      slug: 'approved-title',
      scheduledDate: '2026-09-01T12:00:00.000Z',
      updatedAt: NOW,
    });
    if ('content' in safePatch || 'imageUrl' in safePatch || 'slug' in safePatch) {
      throw new Error('approval-safe write retained a representation-only payload change');
    }
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), safePatch));
    const stored = (await getDoc(doc(memberDb, 'posts', POST_ID))).data();
    if (stored.content !== legacy.content || stored.imageUrl !== legacy.imageUrl || stored.slug !== undefined) {
      throw new Error('member save rewrote approval-equivalent stored payload fields');
    }

    // Direct callers do not get a semantic bypass: a different object/copy/path
    // remains a strict payload change and must reset approval atomically.
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      imageUrl: '/media/v2/generated/o/different.png', updatedAt: '2026-08-24T20:00:00.001Z',
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      content: 'Genuinely changed copy', updatedAt: '2026-08-24T20:00:00.001Z',
    }));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), {
      slug: 'different-path', updatedAt: '2026-08-24T20:00:00.001Z',
    }));
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      imageUrl: '/media/v2/generated/o/different.png', approvalStatus: 'pending',
      updatedAt: '2026-08-24T20:00:00.001Z',
    }));
  });

  it('keeps tags and schedule outside approval-reset semantics', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'posts', POST_ID), { approvalStatus: 'approved' });
    });
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), {
      tags: ['internal'], scheduledDate: '2026-09-01T12:00:00.000Z', updatedAt: NOW,
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

  it.each(['guest', 'member'])('accepts maximum feedback and 200th entry, rejects one-over without changing history: %s', async actor => {
    const db = actor === 'guest' ? guestDb : memberDb;
    const ref = doc(db, 'posts', POST_ID);
    const prior = Array.from({ length: 199 }, (_, index) => ({ text: `Prior ${index}`, by: 'client', at: '2026-08-24T18:00:00.000Z' }));
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posts', POST_ID), {
      approvalStatus: 'changes_requested', feedback: 'Prior 198', feedbackThread: prior,
    }));
    const patch = (text, at = NOW) => ({ approvalStatus: 'changes_requested', feedback: text,
      feedbackThread: arrayUnion({ text, by: 'client', at }), reviewedBy: 'client', reviewedAt: at, updatedAt: at });
    await assertFails(updateDoc(ref, patch('x'.repeat(501))));
    expect((await getDoc(ref)).data().feedbackThread).toEqual(prior);
    await assertSucceeds(updateDoc(ref, patch('x'.repeat(500))));
    const accepted = (await getDoc(ref)).data();
    expect(accepted.feedbackThread).toEqual([...prior, { text: 'x'.repeat(500), by: 'client', at: NOW }]);
    await assertFails(updateDoc(ref, patch('One more', '2026-08-24T20:00:01.000Z')));
    expect((await getDoc(ref)).data()).toEqual(accepted);
  });

  it('preserves all maximum member editorial bounds and denies individual one-over values', async () => {
    const ref = doc(memberDb, 'posts', POST_ID);
    const maximum = { content: 'x'.repeat(100000), title: 'x'.repeat(200), altText: 'x'.repeat(300),
      metaDescription: 'x'.repeat(200), slug: 'x'.repeat(80), imageUrl: 'x'.repeat(500000),
      tags: Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(20, 'x')), scheduledDate: 'x'.repeat(40), updatedAt: NOW };
    await assertSucceeds(updateDoc(ref, maximum));
    const saved = (await getDoc(ref)).data();
    for (const field of ['content', 'title', 'altText', 'metaDescription', 'slug', 'imageUrl', 'scheduledDate']) {
      await assertFails(updateDoc(ref, { [field]: maximum[field] + 'x', updatedAt: '2026-08-24T20:00:01.000Z' }));
    }
    await assertFails(updateDoc(ref, { tags: [...maximum.tags, 'extra'], updatedAt: '2026-08-24T20:00:01.000Z' }));
    await assertFails(updateDoc(ref, { tags: ['x'.repeat(21)], updatedAt: '2026-08-24T20:00:01.000Z' }));
    expect((await getDoc(ref)).data()).toEqual(saved);
  });

  it.each(['guest', 'member'])('rejects malformed review fields through explicit false, not evaluator errors: %s', async actor => {
    const ref = doc(actor === 'guest' ? guestDb : memberDb, 'posts', POST_ID);
    const saved = (await getDoc(ref)).data();
    const review = { approvalStatus: 'changes_requested', feedback: 'Review', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW };
    for (const feedbackThread of [null, {}, [], [null], ['bad'], [{}], [{ text: 'Review', by: 'client' }]]) {
      await assertFails(updateDoc(ref, { ...review, feedbackThread }));
    }
    for (const malformed of [{ approvalStatus: deleteField() }, { reviewedBy: deleteField() },
      { reviewedAt: deleteField() }, { feedback: null }, { updatedAt: deleteField() }]) {
      await assertFails(updateDoc(ref, { ...review, feedbackThread: [{ text: 'Review', by: 'client', at: NOW }], ...malformed }));
    }
    expect((await getDoc(ref)).data()).toEqual(saved);
  });

  it.each([null, 'client', { client: true }, { super_admin: true }, [], ['unknown'], 1].map(roles => [roles]))('rejects malformed/ungranted role containers without errors: %j', async roles => {
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'users', 'member@example.com'), { roles }));
    await assertFails(getDoc(doc(memberDb, 'posts', POST_ID)));
    await assertFails(updateDoc(doc(memberDb, 'posts', POST_ID), { content: 'Not allowed', updatedAt: NOW }));
  });

  it('keeps the union of valid member and guest grants when either other branch denies', async () => {
    const mixed = testEnv.authenticatedContext('member-user', { email: 'member@example.com',
      share: true, shareOwner: OWNER_UID, shareClientId: 'foreign', shareToken: 'absent' }).firestore();
    await assertSucceeds(updateDoc(doc(mixed, 'posts', POST_ID), { content: 'Member-owned editorial path', updatedAt: NOW }));
    const guestWithUnknownEmail = testEnv.authenticatedContext('guest-other', { email: 'unknown@example.test',
      share: true, shareOwner: OWNER_UID, shareClientId: 'acme', shareToken: TOKEN }).firestore();
    await assertSucceeds(updateDoc(doc(guestWithUnknownEmail, 'posts', POST_ID), {
      approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: '2026-08-24T20:00:01.000Z', updatedAt: '2026-08-24T20:00:01.000Z',
    }));
  });

  it.each([{}, { email: null }, { email: 7 }, { share: true }, { share: true, shareOwner: OWNER_UID, shareClientId: 'acme', shareToken: [] }])('denies incomplete identity claims without evaluator errors: %j', async claims => {
    const db = testEnv.authenticatedContext('unknown-user', claims).firestore();
    await assertFails(getDoc(doc(db, 'posts', POST_ID)));
    await assertFails(updateDoc(doc(db, 'posts', POST_ID), { content: 'Denied', updatedAt: NOW }));
  });

  it.each(['owner', 'super_admin'])('keeps operator private CRUD and protected grant rules: %s', async kind => {
    const email = `${kind}@example.test`, uid = kind === 'owner' ? OWNER_UID : 'different-super-admin';
    if (kind === 'super_admin') await testEnv.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'users', email), { roles: ['super_admin'] }));
    const db = testEnv.authenticatedContext(uid, { email }).firestore();
    const ref = doc(db, 'posts', `operator-${kind}`);
    await assertSucceeds(setDoc(ref, { uid: OWNER_UID, clientId: 'acme', reviewStage: 'private', content: 'Operator private' }));
    await assertSucceeds(getDoc(ref));
    await assertSucceeds(updateDoc(ref, { content: 'Changed privately' }));
    await assertSucceeds(getDocs(collection(db, 'users')));
    await assertSucceeds(setDoc(doc(db, 'users', 'other@example.test'), { roles: ['client'], clientId: 'acme' }));
    await assertFails(setDoc(doc(db, 'users', email), { roles: ['client'], clientId: 'acme' }));
    await assertSucceeds(deleteDoc(ref));
  });

  it('denies member self-grants and foreign grants', async () => {
    await assertSucceeds(getDoc(doc(memberDb, 'users', 'member@example.com')));
    await assertFails(setDoc(doc(memberDb, 'users', 'member@example.com'), { roles: ['super_admin'] }));
    await assertFails(setDoc(doc(memberDb, 'users', 'other@example.test'), { roles: ['client'], clientId: 'acme' }));
  });

  it('denies member unconstrained users listing without an evaluator fault', async () => {
    await assertFails(getDocs(collection(memberDb, 'users')));
  });

  it.each(['shares', 'automations'])('denies member access to protected %s independently', async name => {
    await assertFails(getDoc(doc(memberDb, name, 'anything')));
    await assertFails(setDoc(doc(memberDb, name, 'anything'), { clientId: 'acme' }));
  });

  it.each(['member', 'client_admin', 'unregistered', 'owner', 'super_admin', 'email_less', 'anonymous'])('preserves exact own-user document/query access without granting a directory: %s', async actor => {
    const email = actor === 'unregistered' ? 'unknown@example.test' : 'member@example.com';
    const operator = actor === 'owner' || actor === 'super_admin';
    const ownReader = operator || ['member', 'client_admin', 'unregistered'].includes(actor);
    await testEnv.withSecurityRulesDisabled(async context => {
      // The field intentionally disagrees with the ID: authorization must use
      // the document path, never user-authored profile metadata.
      await setDoc(doc(context.firestore(), 'users', 'foreign@example.test'), { roles: ['client'], clientId: 'foreign', email });
      if (actor === 'client_admin' || actor === 'super_admin') {
        await updateDoc(doc(context.firestore(), 'users', email), { roles: [actor] });
      }
    });
    const context = actor === 'anonymous' ? testEnv.unauthenticatedContext()
      : testEnv.authenticatedContext(actor === 'owner' ? OWNER_UID : `user-${actor}`,
        actor === 'email_less' || actor === 'owner' ? {} : { email: email.toUpperCase() });
    const db = context.firestore(), users = collection(db, 'users');
    const ownChecks = [
      () => getDoc(doc(db, 'users', email)),
      () => getDocs(query(users, where(documentId(), '==', email))),
      () => getDocs(query(users, where(documentId(), 'in', [email]))),
    ];
    for (const check of ownChecks) await (ownReader ? assertSucceeds(check()) : assertFails(check()));
    const directoryChecks = [
      () => getDoc(doc(db, 'users', 'foreign@example.test')),
      () => getDocs(users),
      () => getDocs(query(users, where(documentId(), '==', 'foreign@example.test'))),
      () => getDocs(query(users, where(documentId(), 'in', [email, 'foreign@example.test']))),
      () => getDocs(query(users, where('email', '==', email))),
    ];
    for (const check of directoryChecks) await (operator ? assertSucceeds(check()) : assertFails(check()));
  });

  it.each(['guest', 'member'])('allows legacy missing-feedback approval without introducing a new requirement: %s', async actor => {
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posts', POST_ID), { feedback: deleteField() }));
    await assertSucceeds(updateDoc(doc(actor === 'guest' ? guestDb : memberDb, 'posts', POST_ID), {
      approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW,
    }));
  });

  it('keeps an email-less legacy owner unable to write user grants', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID, {}).firestore();
    await assertSucceeds(getDoc(doc(db, 'posts', POST_ID)));
    await assertFails(setDoc(doc(db, 'users', 'target@example.test'), { roles: ['client'], clientId: 'acme' }));
  });

  it('keeps member action selectors exclusive without excluding valid review, editorial or resubmit', async () => {
    const ref = doc(memberDb, 'posts', POST_ID);
    const saved = (await getDoc(ref)).data();
    const review = { approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW };
    await assertFails(updateDoc(ref, { ...review, sentForReviewAt: NOW }));
    await assertFails(updateDoc(ref, { ...review, content: 'Mixed editorial/review' }));
    expect((await getDoc(ref)).data()).toEqual(saved);
    await assertSucceeds(updateDoc(ref, review));
    await assertSucceeds(updateDoc(ref, { content: 'New editorial revision', approvalStatus: 'pending', updatedAt: '2026-08-24T20:00:01.000Z' }));
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'posts', POST_ID), { approvalStatus: 'changes_requested', feedback: 'Revise' }));
    const beforeResubmit = (await getDoc(ref)).data();
    const resubmit = { approvalStatus: 'pending', feedback: '', sentForReviewAt: '2026-08-24T20:00:02.000Z', updatedAt: '2026-08-24T20:00:02.000Z' };
    await assertFails(updateDoc(ref, { ...resubmit, reviewedAt: '2026-08-24T20:00:02.000Z' }));
    await assertFails(updateDoc(ref, { ...resubmit, content: 'Mixed editorial/resubmit' }));
    expect((await getDoc(ref)).data()).toEqual(beforeResubmit);
    await assertSucceeds(updateDoc(ref, resubmit));
  });

  it('retains valid cross-tenant guest authority alongside a different member grant', async () => {
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'users', 'member@example.com'), { clientId: 'different-member-client' }));
    const db = testEnv.authenticatedContext('member-user', { email: 'member@example.com',
      share: true, shareOwner: OWNER_UID, shareClientId: 'acme', shareToken: TOKEN }).firestore();
    await assertSucceeds(getDoc(doc(db, 'posts', POST_ID)));
    await assertSucceeds(updateDoc(doc(db, 'posts', POST_ID), {
      approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW,
    }));
  });

  it('retains member authority with malformed guest claims', async () => {
    const db = testEnv.authenticatedContext('member-user', { email: 'member@example.com',
      share: true, shareOwner: OWNER_UID, shareClientId: 'acme', shareToken: [] }).firestore();
    await assertSucceeds(updateDoc(doc(db, 'posts', POST_ID), { content: 'Valid member edit', updatedAt: NOW }));
  });

  it('denies foreign-member access to an existing row with otherwise valid payloads', async () => {
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'users', 'member@example.com'), { clientId: 'foreign' }));
    const ref = doc(memberDb, 'posts', POST_ID);
    await assertFails(getDoc(ref));
    await assertFails(updateDoc(ref, { content: 'Foreign edit', updatedAt: NOW }));
    await assertFails(updateDoc(ref, { approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW }));
    await assertFails(deleteDoc(ref));
    await testEnv.withSecurityRulesDisabled(async context => {
      expect((await getDoc(doc(context.firestore(), 'posts', POST_ID))).data().content).toBe('Approved payload');
    });
  });

  it.each([['client_admin'], ['unknown', 'client'], ['unknown', 'client_admin']].map(roles => [roles]))('retains valid member roles in lists: %j', async roles => {
    await testEnv.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), 'users', 'member@example.com'), { roles }));
    await assertSucceeds(updateDoc(doc(memberDb, 'posts', POST_ID), { content: 'Valid role list', updatedAt: NOW }));
  });
});
