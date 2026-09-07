// Invented data only. Never replace with an exported live automation or owner UID.
export const OWNER_A = 'synthetic-owner-a';
export const OWNER_B = 'synthetic-owner-b';
export const NOW = '2026-09-07T12:00:00.000Z';
export const LATER = '2026-09-09T12:00:00.000Z';
export function fixture(number = 1, overrides = {}) {
  return {
    id: `SYN${String(number).padStart(17, '0')}`, ownerUid: OWNER_A,
    clientId: 'synthetic-client-a', client: 'Synthetic Client A', platform: 'gmb',
    contentType: 'text', tone: 'professional', length: 'medium', imageStyle: 'photo',
    grounding: 'site', mode: 'suggest', pageCursor: 3,
    promptSeed: 'Synthetic fixture only. No generation is performed.', intervalHours: 48,
    enabled: true, nextRunAt: NOW, lastRunAt: '', lastStatus: '', lastError: '', runCount: 0,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}
