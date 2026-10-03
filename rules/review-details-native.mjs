import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, query,
  setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { rulesEvaluationFailures } from '../scripts/rulesTestEvidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = path.resolve(root, path.basename(path.dirname(root)) === '.worktrees' ? '../..' : '..');
if (path.basename(suite) !== 'Stitch TEC') throw new Error('Native evidence must remain inside the Stitch TEC suite');
const evidence = path.join(suite, '_archive-2026-10/spool-review-writer-fences-20261002/rules');
const projectId = 'demo-spool-review-fence';
const host = process.env.FIRESTORE_EMULATOR_HOST;
const runDir = process.env.SPOOL_REVIEW_FENCE_RUN_DIR;
if (process.argv.length !== 2 || process.env.SPOOL_REVIEW_FENCE_REQUIRED !== '1'
  || process.env.SPOOL_REVIEW_FENCE_PROJECT !== projectId || !/^127\.0\.0\.1:[0-9]+$/.test(host || '')
  || Number(host.split(':')[1]) < 1024 || Number(host.split(':')[1]) > 65535
  || typeof runDir !== 'string' || path.resolve(runDir) !== runDir
  || path.dirname(runDir) !== evidence || !/^native-run-[A-Za-z0-9]{6}$/.test(path.basename(runDir))) {
  throw new Error('Native fence comparison requires the owned loopback demo emulator');
}

const OWNER = 'sLcLtGsm9SOKkR82a6cDoLCOOVO2';
const NOW = '2026-10-02T21:00:00.000Z';
const EARLIER = '2026-10-02T20:00:00.000Z';
const fields = ['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks'];
const actors = {
  owner: { uid: OWNER, claims: { email: 'owner@example.test' } },
  super: { uid: 'super', claims: { email: 'super@example.test' }, profile: { roles: ['super_admin'] } },
  member: { uid: 'member', claims: { email: 'member@example.test' }, profile: { roles: ['client'], clientId: 'acme' } },
  clientAdmin: { uid: 'client-admin', claims: { email: 'client-admin@example.test' }, profile: { roles: ['client_admin'], clientId: 'acme' } },
  foreign: { uid: 'foreign', claims: { email: 'foreign@example.test' }, profile: { roles: ['client'], clientId: 'other' } },
  guest: { uid: 'guest', claims: { share: true, shareOwner: OWNER, shareClientId: 'acme', shareToken: 'live' } },
  revoked: { uid: 'revoked', claims: { share: true, shareOwner: OWNER, shareClientId: 'acme', shareToken: 'revoked' } },
  absentShare: { uid: 'absent-share', claims: { share: true, shareOwner: OWNER, shareClientId: 'acme', shareToken: 'absent' } },
  anonymous: null,
};
const legacy = (extra = {}) => ({ uid: OWNER, clientId: 'acme', client: 'Acme', content: 'Invented native comparison post',
  platform: 'gmb', status: 'draft', approvalStatus: 'pending', feedback: '', feedbackThread: [],
  reviewStage: 'in_review', createdAt: EARLIER, updatedAt: EARLIER, ...extra });
const reviewPatch = { status: 'scheduled', approvalStatus: 'approved', reviewedBy: 'client', reviewedAt: NOW, updatedAt: NOW };
const presentValues = field => field === 'reviewDetailsVersion' ? [null, 1]
  : field === 'firstComment' ? [null, '']
    : field === 'reviewDetailsAck' ? [null, { version: 1, firstComment: '', reviewMedia: [], at: EARLIER }]
      : [null, []];
const cases = [];
const add = (name, actor, op, seed, patch, fence = false, transport = 'sdk') => {
  const id = `case-${String(cases.length).padStart(4, '0')}`;
  cases.push({ id, name, actor, op, seed, patch, fence, transport });
};
for (const actor of Object.keys(actors)) {
  add(`legacy/${actor}/create`, actor, 'create', null, legacy());
  add(`legacy/${actor}/read`, actor, 'read', legacy());
  add(`legacy/${actor}/edit`, actor, 'patch', legacy(), { content: 'Edited legacy content', updatedAt: NOW });
  add(`legacy/${actor}/cached-review`, actor, 'patch', legacy(), reviewPatch);
  add(`legacy/${actor}/resubmit`, actor, 'patch', legacy({ approvalStatus: 'changes_requested', feedback: 'Please change' }),
    { approvalStatus: 'pending', feedback: '', sentForReviewAt: NOW, updatedAt: NOW });
  add(`legacy/${actor}/delete`, actor, 'delete', legacy());
  add(`legacy/${actor}/foreign-read`, actor, 'read', legacy({ clientId: 'other' }));
  add(`legacy/${actor}/private-read`, actor, 'read', legacy({ reviewStage: 'private' }));
  for (const op of ['query-scoped', 'query-private', 'query-unscoped']) add(`legacy/${actor}/${op}`, actor, op, null);
}
for (const field of fields) for (const [index, value] of presentValues(field).entries()) {
  for (const actor of ['owner', 'super', 'member', 'clientAdmin', 'guest']) {
    const extended = legacy({ [field]: value });
    const label = `presence/${field}/${index}/${actor}`;
    add(`${label}/create`, actor, 'create', null, extended, true);
    add(`${label}/introduce`, actor, 'patch', legacy(), { [field]: value, updatedAt: NOW }, true);
    add(`${label}/read`, actor, 'read', extended);
    add(`${label}/edit`, actor, 'patch', extended, { content: 'Old editor content', updatedAt: NOW }, true);
    add(`${label}/cached-review`, actor, 'patch', extended, reviewPatch, true);
    add(`${label}/replace-with-legacy`, actor, 'replace', extended, legacy({ updatedAt: NOW }), true);
    add(`${label}/remove-field`, actor, 'remove', extended, { field, updatedAt: NOW }, true);
    add(`${label}/delete`, actor, 'delete', extended, null, true);
  }
  for (const actor of ['owner', 'super', 'member', 'guest']) {
    add(`rest/${field}/${index}/${actor}/create`, actor, 'create', null, legacy({ [field]: value }), true, 'rest');
    add(`rest/${field}/${index}/${actor}/review`, actor, 'patch', legacy({ [field]: value }), reviewPatch, true, 'rest');
    add(`rest/${field}/${index}/${actor}/replace`, actor, 'replace', legacy({ [field]: value }), legacy({ updatedAt: NOW }), true, 'rest');
    add(`rest/${field}/${index}/${actor}/delete`, actor, 'delete', legacy({ [field]: value }), null, true, 'rest');
  }
}
for (const actor of ['owner', 'super', 'member', 'guest']) {
  add(`sticky/${actor}/empty-fields-remain`, actor, 'patch', legacy({ reviewDetailsVersion: 1, reviewMedia: [], firstComment: '' }),
    { updatedAt: NOW }, true);
  add(`sticky/${actor}/strip-all`, actor, 'replace', legacy({ reviewDetailsVersion: 1, reviewMedia: [], firstComment: '', reviewDetailsAck: null, reviewMediaLinks: [] }),
    legacy({ updatedAt: NOW }), true);
  for (const op of ['create', 'patch', 'delete']) {
    const payload = legacy({ uid: 'foreign-owner', clientId: 'other', firstComment: '' });
    add(`foreign/${actor}/${op}`, actor, op, op === 'create' ? null : payload, payload, true);
  }
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = actor => {
  if (!actor) return null;
  const seconds = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iss: `https://securetoken.google.com/${projectId}`, aud: projectId,
    sub: actor.uid, user_id: actor.uid, iat: seconds, exp: seconds + 3600, auth_time: seconds,
    firebase: { sign_in_provider: 'custom', identities: {} }, ...actor.claims })}.`;
};
const firestoreValue = value => value === null ? { nullValue: null }
  : typeof value === 'string' ? { stringValue: value }
    : typeof value === 'boolean' ? { booleanValue: value }
      : typeof value === 'number' ? { integerValue: String(value) }
        : Array.isArray(value) ? { arrayValue: { values: value.map(firestoreValue) } }
          : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, firestoreValue(item)])) } };
const firestoreBody = value => JSON.stringify({ fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, firestoreValue(item)])) });
const baseUrl = `http://${host}/v1/projects/${projectId}/databases/(default)/documents`;
async function restOperation(test, actor) {
  const uri = test.op === 'create' ? `${baseUrl}/posts?documentId=${test.id}` : `${baseUrl}/posts/${test.id}`;
  const method = test.op === 'create' ? 'POST' : test.op === 'delete' ? 'DELETE' : 'PATCH';
  const token = jwt(actor);
  const proposed = test.op === 'patch' ? { ...test.seed, ...test.patch } : test.patch;
  const response = await fetch(uri, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === 'DELETE' ? {} : { body: firestoreBody(proposed) }) });
  const text = await response.text();
  if (!response.ok) {
    const message = JSON.parse(text)?.error?.message;
    const error = new Error(typeof message === 'string' ? message : text);
    error.code = response.status === 403 ? 'permission-denied' : `rest-${response.status}`;
    throw error;
  }
  return method === 'DELETE' ? null : JSON.parse(text);
}
async function sdkOperation(test, db) {
  const ref = doc(db, 'posts', test.id);
  if (test.op === 'create' || test.op === 'replace') return setDoc(ref, test.patch);
  if (test.op === 'patch') return updateDoc(ref, test.patch);
  if (test.op === 'remove') return updateDoc(ref, { [test.patch.field]: deleteField(), updatedAt: test.patch.updatedAt });
  if (test.op === 'delete') return deleteDoc(ref);
  if (test.op === 'read') return (await getDoc(ref)).data();
  const posts = collection(db, 'posts');
  const q = test.op === 'query-unscoped' ? posts
    : test.op === 'query-private' ? query(posts, where('clientId', '==', 'acme'), where('reviewStage', '==', 'private'))
      : test.actor === 'guest' || test.actor === 'revoked' || test.actor === 'absentShare'
        ? query(posts, where('uid', '==', OWNER), where('clientId', '==', 'acme'), where('reviewStage', '==', 'in_review'))
        : query(posts, where('clientId', '==', 'acme'), where('reviewStage', '==', 'in_review'));
  return (await getDocs(q)).docs.map(item => item.id).sort();
}

const baseline = await readFile(path.join(root, 'rules/review-details-deployed-baseline.rules'), 'utf8');
const overlay = await readFile(path.join(root, 'rules/review-details-overlay.rules'), 'utf8');
const sha = source => createHash('sha256').update(source).digest('hex');
assert.equal(sha(baseline), 'be60b8d68aca925c5f1f35baa6b045b3b44dbcb0a0dd02dc6241b21af8760b1d');
const results = [];
for (const [variant, source] of [['baseline', baseline], ['overlay', overlay]]) {
  const env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: Number(host.split(':')[1]), rules: source } });
  try {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      const seeds = Object.values(actors).filter(actor => actor?.profile)
        .map(actor => ['users', actor.claims.email, { email: actor.claims.email, ...actor.profile }]);
      seeds.push(['shares', 'live', { uid: OWNER, clientId: 'acme', revoked: false }],
        ['shares', 'revoked', { uid: OWNER, clientId: 'acme', revoked: true }]);
      for (const test of cases) if (test.seed) seeds.push(['posts', test.id, test.seed]);
      for (let start = 0; start < seeds.length; start += 400) {
        const batch = writeBatch(db);
        for (const [table, id, value] of seeds.slice(start, start + 400)) batch.set(doc(db, table, id), value);
        await batch.commit();
      }
    });
    const dbs = Object.fromEntries(Object.entries(actors).map(([name, actor]) => [name,
      actor ? env.authenticatedContext(actor.uid, actor.claims).firestore() : env.unauthenticatedContext().firestore()]));
    for (const test of cases) {
      let outcome;
      try {
        const value = test.transport === 'rest' ? await restOperation(test, actors[test.actor]) : await sdkOperation(test, dbs[test.actor]);
        outcome = { allowed: true, code: null, error: null, evaluationFailures: [],
          ...(test.op.startsWith('query-') ? { queryIds: value } : {}) };
      } catch (error) {
        outcome = { allowed: false, code: error.code || null, error: String(error), evaluationFailures: rulesEvaluationFailures(String(error)) };
      }
      results.push({ variant, id: test.id, name: test.name, actor: test.actor, op: test.op, fence: test.fence, transport: test.transport, ...outcome });
    }
  } finally {
    await env.cleanup();
  }
}

const before = results.filter(result => result.variant === 'baseline');
const after = results.filter(result => result.variant === 'overlay');
const failures = [];
for (let index = 0; index < cases.length; index++) {
  const test = cases[index], a = before[index], b = after[index];
  if (!a || !b || a.id !== test.id || b.id !== test.id) failures.push(`Missing result: ${test.name}`);
  else if (test.fence) {
    if (b.allowed || b.code !== 'permission-denied' || b.evaluationFailures.length) failures.push(`Unclean fence denial: ${test.name}`);
  } else if (a.allowed !== b.allowed || a.code !== b.code) failures.push(`Legacy/read admission changed: ${test.name}`);
  // Query fixture mutation by earlier comparison writes can legitimately differ:
  // fence tests start AFTER legacy query controls and both runs use equal rows.
  if (!test.fence && test.op.startsWith('query-') && a.allowed && b.allowed
    && JSON.stringify(a.queryIds) !== JSON.stringify(b.queryIds)) failures.push(`Legacy query results changed: ${test.name}`);
}
const cleanRequired = ['legacy/owner/create', 'legacy/owner/read', 'legacy/owner/edit', 'legacy/owner/delete',
  'legacy/super/create', 'legacy/super/read', 'legacy/super/edit', 'legacy/super/delete',
  'legacy/member/create', 'legacy/member/read', 'legacy/member/delete',
  'legacy/clientAdmin/create', 'legacy/clientAdmin/read', 'legacy/clientAdmin/delete', 'legacy/guest/read'];
for (const name of cleanRequired) for (const variant of ['baseline', 'overlay']) {
  if (!results.some(result => result.variant === variant && result.name === name && result.allowed)) failures.push(`Positive control failed: ${variant}/${name}`);
}
const inheritedEvaluationFailures = results.filter(result => !result.fence && result.evaluationFailures.length);
const report = { status: failures.length ? 'failed' : inheritedEvaluationFailures.length ? 'comparison_passed_inherited_evaluation_faults_block_activation' : 'comparison_passed_pending_runner_log_check',
  authoringEnabled: false, deployed: false, projectId, host, baselineSha256: sha(baseline), overlaySha256: sha(overlay),
  plannedCases: cases.length, completedRequests: results.length, legacyAndReadComparisons: cases.filter(test => !test.fence).length,
  targetedFenceComparisons: cases.filter(test => test.fence).length, sdkRequests: results.filter(result => result.transport === 'sdk').length,
  restRequests: results.filter(result => result.transport === 'rest').length, failures, inheritedEvaluationFailures, results };
await writeFile(path.join(runDir, 'native-comparison.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: report.status, plannedCases: report.plannedCases, completedRequests: report.completedRequests,
  sdkRequests: report.sdkRequests, restRequests: report.restRequests, failures, inheritedEvaluationFaults: inheritedEvaluationFailures.length }));
process.exitCode = failures.length ? 1 : 0;
