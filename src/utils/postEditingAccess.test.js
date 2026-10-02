import { describe, expect, it } from 'vitest';
import { OPERATOR_UID } from '../config/roles';
import { postEditingAccess } from './postEditingAccess';

const member = { isClientMember: true, clientId: 'synthetic-client' };
const post = {
  clientId: 'synthetic-client', client: 'Synthetic Client', uid: OPERATOR_UID,
  reviewStage: 'in_review', status: 'draft', approvalStatus: 'pending',
  platform: 'linkedin', isTemplate: false,
};

describe('conservative per-post editor affordance', () => {
  it.each(['draft', 'scheduled'])('admits a scoped %s member draft without claiming a permission check', status => {
    expect(postEditingAccess({ ...post, status }, member)).toEqual({ canEdit: true, reason: '' });
  });
  it.each(['pending', 'approved', 'changes_requested'])('allows valid %s review state', approvalStatus => {
    expect(postEditingAccess({ ...post, approvalStatus }, member).canEdit).toBe(true);
  });
  it('does not block correctable text/tag/schedule values at the affordance boundary', () => {
    expect(postEditingAccess({ ...post, content: '', tags: ['x'.repeat(21)], title: null, scheduledDate: 'bad' }, member).canEdit).toBe(true);
  });
  it('admits legacy absent isTemplate false-equivalent but not malformed truthy or null flags', () => {
    const { isTemplate: _ignored, ...legacy } = post;
    expect(postEditingAccess(legacy, member).canEdit).toBe(true);
    for (const isTemplate of [true, 'false', 0, null]) expect(postEditingAccess({ ...post, isTemplate }, member).canEdit).toBe(false);
  });
  it.each(['posted', 'archived'])('keeps %s read-only as explicit product policy', status => {
    const result = postEditingAccess({ ...post, status }, member);
    expect(result.canEdit).toBe(false);
    expect(result.reason).toContain('read-only');
  });
  it.each([
    ['clientId', 'foreign'], ['reviewStage', 'private'], ['reviewStage', undefined],
    ['uid', 'other-owner'], ['uid', undefined], ['client', ''], ['client', '   '],
    ['client', 'x'.repeat(51)], ['client', null], ['platform', 'unsupported'],
    ['platform', '__proto__'], ['status', undefined], ['status', 'unknown'],
    ['approvalStatus', undefined], ['approvalStatus', 'unknown'], ['source', 'suggestion'],
  ])('refuses incompatible %s=%s without inventing a live permission diagnosis', (key, value) => {
    const result = postEditingAccess({ ...post, [key]: value }, member);
    expect(result.canEdit).toBe(false);
    expect(result.reason).not.toMatch(/permission denied|insufficient permissions|February/i);
  });
  it.each([null, '', 'UPPERCASE', 'a_underscore', 'a'.repeat(65)])('refuses unknown or malformed member client %s', clientId => {
    expect(postEditingAccess(post, { ...member, clientId }).canEdit).toBe(false);
    expect(postEditingAccess(null, { ...member, clientId }).canEdit).toBe(false);
  });
  it('allows known scoped member creation, but no unknown-role creation', () => {
    expect(postEditingAccess(null, member).canEdit).toBe(true);
    expect(postEditingAccess(null).canEdit).toBe(false);
  });
  it('leaves operator capability unchanged while review-link affordances always remain read-only', () => {
    expect(postEditingAccess({ ...post, uid: null, clientId: 'foreign', status: 'posted' }, { isOperator: true }).canEdit).toBe(true);
    expect(postEditingAccess(post, { isReadOnly: true, isOperator: true }).canEdit).toBe(false);
    expect(postEditingAccess(post, { ...member, isReadOnly: true }).canEdit).toBe(false);
  });
});
