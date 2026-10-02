// Narrow client-access admission. No identity/role is inferred from an email domain,
// absent document, unknown role or malformed record. The internal-key route owns auth.
export class PeopleSyncError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.name = 'PeopleSyncError';
    this.code = code;
    this.status = status;
  }
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const EMAIL_RE = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export function parsePeopleSyncIntent(body) {
  if (!plain(body)) throw new PeopleSyncError('invalid_sync_request', 400);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const clientId = typeof body.clientId === 'string' ? body.clientId.trim().toLowerCase() : '';
  const hasControl = Array.from(email).some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
  if (hasControl || email.length > 254 || !EMAIL_RE.test(email)) throw new PeopleSyncError('valid_email_required', 400);
  if (body.action !== 'grant' && body.action !== 'revoke') throw new PeopleSyncError('invalid_sync_action', 400);
  // Revoke also needs a tenant: email alone never proves which workspace is intended.
  if (!SLUG_RE.test(clientId)) throw new PeopleSyncError('valid_clientId_required', 400);
  return Object.freeze({ email, clientId, action: body.action });
}

export function admitPeopleSyncRecord(intent, record) {
  if (record === null) return;
  if (!plain(record) || !Array.isArray(record.roles)) throw new PeopleSyncError('malformed_access_record');
  if (record.roles.includes('super_admin') || record.roles.includes('client_admin')) {
    throw new PeopleSyncError('privileged_account_hand_managed');
  }
  if (record.roles.length !== 1 || record.roles[0] !== 'client'
    || typeof record.clientId !== 'string' || !SLUG_RE.test(record.clientId)
    || (Object.hasOwn(record, 'email') && record.email !== intent.email)) {
    throw new PeopleSyncError('malformed_access_record');
  }
  if (record.clientId !== intent.clientId) throw new PeopleSyncError('client_mismatch');
}
