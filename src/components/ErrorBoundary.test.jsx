import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

const BrokenDashboard = () => {
  throw new Error('snapshot render failed');
};

describe('ErrorBoundary', () => {
  it('catches a failure above the dashboard instead of leaving a white root', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <BrokenDashboard />
        </ErrorBoundary>
      );

      expect(screen.getByRole('heading', { name: 'Spool hit a display error' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reload App' })).toBeInTheDocument();
      expect(screen.getByText(/content is still safe/i)).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
