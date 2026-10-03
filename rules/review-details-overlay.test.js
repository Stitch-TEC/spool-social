import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const baseline = read('./review-details-deployed-baseline.rules');
const overlay = read('./review-details-overlay.rules');
const marker = '    // --- Posts ---------------------------------------------------------------';
const start = '    // Compatibility-only global post fence.';
const replaceOne = (value, before, after) => {
  expect(value.split(before)).toHaveLength(2);
  return value.replace(before, after);
};

describe('isolated review-details rules preparation', () => {
  it('pins the exact read-only Aug25 deployed-source identity', () => {
    expect(Buffer.byteLength(baseline)).toBe(26767);
    expect(createHash('sha256').update(baseline).digest('hex'))
      .toBe('be60b8d68aca925c5f1f35baa6b045b3b44dbcb0a0dd02dc6241b21af8760b1d');
  });

  it('has exactly the five presence-bearing fields, including null/empty alias and stored ack', () => {
    const body = overlay.slice(overlay.indexOf(start), overlay.indexOf(marker));
    expect(body).toContain('return data.keys().hasAny([');
    expect([...body.matchAll(/'([^']+)'/g)].map(match => match[1]))
      .toEqual(['reviewDetailsVersion', 'reviewMedia', 'firstComment', 'reviewDetailsAck', 'reviewMediaLinks']);
    expect(body).not.toContain("data.get(");
    expect(body).not.toContain('== null');
  });

  it('changes only the helper and three globally fenced post authorization clauses', () => {
    let reversed = overlay.slice(0, overlay.indexOf(start)) + overlay.slice(overlay.indexOf(marker));
    reversed = replaceOne(reversed,
      `      // A full SDK/REST replacement also evaluates create. Refuse its existing
      // marked resource before entering the inherited guest/email create path.
      allow create: if (hasReviewDetailPresence(request.resource.data)
          || (resource != null ? hasReviewDetailPresence(resource.data) : false)) ? false
        : (isSuperAdmin()
          || isOwner(ownerUid())
          || (isEntityMember(request.resource.data.get('clientId', null))
              && request.resource.data.uid == ownerUid()
              && validMemberCreate()));`,
      `      allow create: if isSuperAdmin()
        || isOwner(ownerUid())
        || (isEntityMember(request.resource.data.get('clientId', null))
            && request.resource.data.uid == ownerUid()
            && validMemberCreate());`);
    reversed = replaceOne(reversed,
      `      allow update: if (hasReviewDetailPresence(resource.data)
          || hasReviewDetailPresence(request.resource.data)) ? false
        : (isGuestReviewUpdate()
          || isSuperAdmin()
          || isOwner(resource.data.uid)
          || isMemberEditorialUpdate()
          || isMemberReviewUpdate());`,
      `      allow update: if isGuestReviewUpdate()
        || isSuperAdmin()
        || isOwner(resource.data.uid)
        || isMemberEditorialUpdate()
        || isMemberReviewUpdate();`);
    reversed = replaceOne(reversed,
      `      allow delete: if hasReviewDetailPresence(resource.data) ? false
        : (isSuperAdmin()
          || isOwner(resource.data.uid)
          || (isReviewVisible(resource.data)
              && isEntityMember(resource.data.get('clientId', null))));`,
      `      allow delete: if isSuperAdmin()
        || isOwner(resource.data.uid)
        || (isReviewVisible(resource.data)
            && isEntityMember(resource.data.get('clientId', null)));`);
    expect(reversed).toBe(baseline);
  });

  it('does not connect the prepared overlay to the normal Firebase deployment configuration', () => {
    expect(JSON.parse(read('../firebase.json')).firestore.rules).toBe('firestore.rules');
    expect(read('../firestore.rules')).not.toBe(overlay);
    expect(read('../firestore.rules')).not.toBe(baseline);
  });
});
