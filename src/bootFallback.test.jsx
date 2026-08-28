import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

const shell = readFileSync('index.html', 'utf8');
const installShell = () => {
  const parsed = new DOMParser().parseFromString(shell, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
};

describe('static boot fallback', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('provides an accessible action when app modules cannot start', () => {
    installShell();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Opening Spool');
    expect(status).toHaveTextContent(/close and reopen Spool/i);
  });

  it('is cleanly replaced by the React application', () => {
    installShell();
    const container = document.getElementById('root');
    const { unmount } = render(<main>Spool dashboard ready</main>, { container });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Spool dashboard ready');
    unmount();
  });
});
