import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount React trees between tests (we run with globals disabled).
afterEach(() => {
  cleanup();
});
