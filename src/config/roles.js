// RBAC role constants + the single operator (owner) identity.
//
// OPERATOR_UID MUST match firestore.rules `ownerUid()` and wrangler.toml
// `OWNER_UID`. It is not a secret (it's a Firebase uid). Overridable at build
// time via VITE_OPERATOR_UID; the literal is the safe default so the app works
// out of the box. The operator is recognized as super_admin via this uid even
// before their users/{email} doc exists, so the owner can never be locked out.
export const OPERATOR_UID =
  import.meta.env.VITE_OPERATOR_UID || 'sLcLtGsm9SOKkR82a6cDoLCOOVO2';

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  CLIENT_ADMIN: 'client_admin',
  CLIENT: 'client',
};

// Derive a stable clientId slug from a display name. MUST match the algorithm in
// scripts/admin.mjs (the backfill) so app-created clients line up with the
// backfilled ones (e.g. "OMNI NDE" → "omni-nde", "The BDR" → "the-bdr").
export const slugifyClientId = (name) =>
  String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
