import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('./HelpGuides', () => ({ default: () => { throw new Error('Synthetic unavailable guide chunk'); } }));
import HelpDialog from './HelpDialog';

it('contains a guide failure without replacing the draft or disabling Close', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const Fixture = () => {
    const [open, setOpen] = useState(false);
    return <><textarea aria-label="Draft" defaultValue="Still unsaved" /><button onClick={() => setOpen(true)}>Help</button>{open && <HelpDialog audience="operator" onClose={() => setOpen(false)} />}</>;
  };
  render(<Fixture />);
  const text = screen.getByRole('textbox'); const trigger = screen.getByRole('button', { name: 'Help' }); trigger.focus(); fireEvent.click(trigger);
  expect(await screen.findByRole('alert')).toHaveTextContent('Guides could not load');
  fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
  expect(screen.getByRole('textbox')).toBe(text); expect(text).toHaveValue('Still unsaved'); expect(trigger).toHaveFocus(); errors.mockRestore();
});
