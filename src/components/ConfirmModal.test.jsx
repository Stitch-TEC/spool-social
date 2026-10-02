import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';
import { useMediaDialog } from '../hooks/useMediaSession';

function LowerDialog({ onCancel }) {
  const [confirm, setConfirm] = useState(false);
  const dialog = useRef(null), close = useRef(null);
  useMediaDialog(dialog, close, onCancel);
  return <div ref={dialog} role="dialog" aria-modal="true" aria-label="Lower library">
    <button ref={close} onClick={onCancel}>Close library</button>
    <button onClick={() => setConfirm(true)}>Open upper confirmation</button>
    {confirm && <ConfirmModal title="Upper confirmation" message="Keep the underlying library open."
      onConfirm={() => setConfirm(false)} onCancel={() => setConfirm(false)} />}
  </div>;
}

function Fixture({ onCancel = () => {}, onConfirm = () => {}, type = 'danger', confirmLabel = 'Discard' }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open confirmation</button>
    {open && <ConfirmModal title="Discard unsaved changes?" message="Your changes are not saved. Cancel to keep your work."
      type={type} confirmLabel={confirmLabel}
      onCancel={() => { onCancel(); setOpen(false); }}
      onConfirm={() => { onConfirm(); setOpen(false); }} />}
  </>;
}

describe('ConfirmModal', () => {
  it('focuses the safe action, cycles both directions and restores owned trigger focus', () => {
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Open confirmation' });
    trigger.focus(); fireEvent.click(trigger);
    const cancel = screen.getByRole('button', { name: 'Cancel', exact: true });
    const discard = screen.getByRole('button', { name: 'Discard', exact: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' }); expect(discard).toHaveFocus();
    fireEvent.keyDown(discard, { key: 'Tab' }); expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true }); expect(discard).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('Escape cancels only the confirmation, not a surrounding editor listener', () => {
    const outerEscape = vi.fn();
    const onCancel = vi.fn(), onConfirm = vi.fn();
    window.addEventListener('keydown', outerEscape);
    try {
      render(<Fixture onCancel={onCancel} onConfirm={onConfirm} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel', exact: true }), { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledOnce();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(outerEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', outerEscape); }
  });

  it('requires explicit confirmation and retains the destructive label/consequence', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<Fixture onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }));
    expect(screen.getByText('Your changes are not saved. Cancel to keep your work.')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard', exact: true }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('uses a viewport-scrolling shell and nonshrinking card for enlarged text', () => {
    render(<ConfirmModal title="Long confirmation" message={'A long preserved consequence. '.repeat(60)} onCancel={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Long confirmation' });
    expect(dialog).toHaveClass('overflow-y-auto', 'flex-col');
    expect(dialog.firstElementChild).toHaveClass('shrink-0', 'my-auto');
    for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('min-h-11');
  });

  it('routes Escape and Tab only to the top confirmation over another captured dialog', () => {
    const closeLibrary = vi.fn();
    render(<LowerDialog onCancel={closeLibrary} />);
    const openUpper = screen.getByRole('button', { name: 'Open upper confirmation' });
    openUpper.focus(); fireEvent.click(openUpper);
    const cancel = screen.getByRole('button', { name: 'Cancel', exact: true });
    const confirm = screen.getByRole('button', { name: 'Confirm', exact: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' }); expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' }); expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(closeLibrary).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Upper confirmation' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Lower library' })).toBeInTheDocument();
    expect(openUpper).toHaveFocus();
    fireEvent.keyDown(openUpper, { key: 'Escape' });
    expect(closeLibrary).toHaveBeenCalledOnce();
  });
});
