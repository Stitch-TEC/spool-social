import { APPROVAL_STATUS, PLATFORMS, REVIEW_STAGE, STATUS } from '../constants';
import { OPERATOR_UID } from '../config/roles';
import { hasReviewDetailsFields } from './reviewDetails';

const CLIENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const blocked = reason => ({ canEdit: false, reason });
const allowed = () => ({ canEdit: true, reason: '' });

// This is a conservative editor affordance, not a permission probe. Actual
// authority remains in Firestore. Posted/archived read-only is a product policy;
// it is not proof of why a historical production write was denied.
export function postEditingAccess(post, { isReadOnly = false, isOperator = false, isClientMember = false, clientId } = {}) {
  if (isReadOnly) return blocked('Review links cannot edit threads. Ask Stitch TEC for changes.');
  if (hasReviewDetailsFields(post)) return blocked('Review details are read-only in this Spool version.');
  if (isOperator) return allowed();
  if (!isClientMember || typeof clientId !== 'string' || clientId.length > 64 || !CLIENT_ID.test(clientId)) {
    return blocked('Only Stitch TEC or this workspace’s editors can edit threads.');
  }
  if (!post) return allowed(); // A new member draft is still scoped at its write boundary.
  if (post.clientId !== clientId || post.reviewStage !== REVIEW_STAGE.IN_REVIEW) {
    return blocked('This thread is not editable in this workspace. Ask Stitch TEC to check it.');
  }
  if (post.status === STATUS.POSTED) {
    return blocked('Posted threads are read-only. Ask Stitch TEC to update this thread.');
  }
  if (post.status === STATUS.ARCHIVED) {
    return blocked('Archived threads are read-only. Ask Stitch TEC to restore this thread.');
  }
  // Unlike correctable text/tags, these values cannot be repaired by the member
  // editorial path. The application would stamp a different owner/name or an
  // invalid fixed enum, which its unchanged server contract refuses.
  if (post.uid !== OPERATOR_UID
    || typeof post.client !== 'string' || !post.client.trim() || post.client.length > 50
    || !Object.prototype.hasOwnProperty.call(PLATFORMS, post.platform)
    || ![STATUS.DRAFT, STATUS.SCHEDULED].includes(post.status)
    || !Object.values(APPROVAL_STATUS).includes(post.approvalStatus)
    || (post.isTemplate !== undefined && post.isTemplate !== false)
    || post.source === 'suggestion') {
    return blocked('Stitch TEC needs to check this thread before you can edit it.');
  }
  return allowed();
}
