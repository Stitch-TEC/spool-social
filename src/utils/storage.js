import { ref, uploadString, getDownloadURL } from 'firebase/storage';
import { storage } from '../config/firebase';

/**
 * Uploads a base64 data URL to Firebase Storage and returns its download URL.
 * Values that are already remote URLs (or empty) are returned unchanged, so this
 * is safe to call on every save — only freshly-added inline images get uploaded.
 *
 * NOTE: requires Firebase Storage to be enabled for the project and storage.rules
 * deployed. Posts/logos without a new inline image never touch Storage.
 *
 * @param {string} imageValue - a data: URL, an existing https URL, or empty
 * @param {{ uid: string, folder: string }} opts
 * @returns {Promise<string>} the stored download URL (or the unchanged input)
 */
export const uploadImageIfNeeded = async (imageValue, { uid, folder }) => {
  if (!imageValue || !imageValue.startsWith('data:')) return imageValue || '';
  const safeUid = uid || 'anon';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const storageRef = ref(storage, `${folder}/${safeUid}/${filename}`);
  await uploadString(storageRef, imageValue, 'data_url');
  return getDownloadURL(storageRef);
};
