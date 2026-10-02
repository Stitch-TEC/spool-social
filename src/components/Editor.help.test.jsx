import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import Editor from './Editor';
import HelpDialog from './HelpDialog';

it('actual Editor Help neither saves nor replaces unsaved text', async () => {
  const onSave = vi.fn(), onCancel = vi.fn();
  const post = { id: 'help-existing', content: 'Original text', client: 'Synthetic', clientId: 'synthetic', platform: 'gmb', status: 'draft', tags: [], imageUrl: '' };
  const Fixture = () => {
    const [help, setHelp] = useState(false);
    return <><Editor post={post} onSave={onSave} onCancel={onCancel} onHelp={() => setHelp(true)} clientMap={{}} uniqueClients={['Synthetic']} isReadOnly={false} />{help && <HelpDialog audience="member" onClose={() => setHelp(false)} />}</>;
  };
  render(<Fixture />);
  const text = document.querySelector('textarea'); fireEvent.change(text, { target: { value: 'Keep this newer work' } });
  const help = screen.getByRole('button', { name: 'Help & guides' }); expect(help).toHaveClass('min-h-11', 'min-w-11'); help.focus(); fireEvent.click(help);
  await screen.findByRole('heading', { name: 'Client workspace guides' });
  fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
  expect(document.querySelector('textarea')).toBe(text); expect(text).toHaveValue('Keep this newer work'); expect(help).toHaveFocus();
  expect(onSave).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
});
