import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ImportExportModal from './ImportExportModal';

const posts = [
  { id: '1', client: 'Acme', platform: 'gmb', content: 'a1', status: 'draft' },
  { id: '2', client: 'Acme', platform: 'blog', content: 'a2', status: 'archived' },
  { id: '3', client: 'Beta', platform: 'gmb', content: 'b1', status: 'draft' },
];

const noop = () => {};

// downloadFile() needs URL.createObjectURL, which jsdom doesn't implement.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

const changeFile = (container, text, name = 'in.csv') => {
  const input = container.querySelector('input[type="file"]');
  const file = new File([text], name, { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
};

describe('ImportExportModal — export scope', () => {
  it('operator: counts active threads across all clients by default', () => {
    render(<ImportExportModal posts={posts} uniqueClients={['Acme', 'Beta']} isOperator onImport={noop} onClose={noop} showToast={noop} />);
    expect(screen.getByText('All clients')).toBeInTheDocument();
    // 2 of 3 posts are non-archived.
    expect(screen.getByRole('button', { name: /Export 2 threads/ })).toBeInTheDocument();
  });

  it('operator: narrows the export to a single selected client', () => {
    render(<ImportExportModal posts={posts} uniqueClients={['Acme', 'Beta']} isOperator onImport={noop} onClose={noop} showToast={noop} />);
    fireEvent.click(screen.getByLabelText('All clients')); // reveal per-client list, nothing selected
    expect(screen.getByRole('button', { name: /Export 0 threads/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Beta')); // Beta has one active post
    expect(screen.getByRole('button', { name: /Export 1 thread$/ })).toBeInTheDocument();
  });

  it('operator: "Everything" scope includes archived', () => {
    render(<ImportExportModal posts={posts} uniqueClients={['Acme', 'Beta']} isOperator onImport={noop} onClose={noop} showToast={noop} />);
    fireEvent.click(screen.getByLabelText('Everything (active + archived)'));
    expect(screen.getByRole('button', { name: /Export 3 threads/ })).toBeInTheDocument();
  });

  it('client member: no client picker, exports only their own posts', () => {
    const mine = [
      { id: '1', client: 'MyClient', platform: 'gmb', content: 'x', status: 'draft' },
      { id: '2', client: 'MyClient', platform: 'blog', content: 'y', status: 'draft' },
    ];
    render(<ImportExportModal posts={mine} uniqueClients={['MyClient']} isOperator={false} scopeClient="MyClient" onImport={noop} onClose={noop} showToast={noop} />);
    expect(screen.queryByText('All clients')).toBeNull();
    expect(screen.getByRole('button', { name: /Export 2 threads/ })).toBeInTheDocument();
  });

  it('fires a download and toast on export', () => {
    const showToast = vi.fn();
    render(<ImportExportModal posts={posts} uniqueClients={['Acme', 'Beta']} isOperator onImport={noop} onClose={noop} showToast={showToast} />);
    fireEvent.click(screen.getByRole('button', { name: /Export 2 threads/ }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/Exported 2 threads/));
  });
});

describe('ImportExportModal — import', () => {
  const openImportTab = () => fireEvent.click(screen.getByRole('tab', { name: /Import/ }));

  it('operator: parses a file, previews the count, and commits on confirm', async () => {
    const onImport = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    const { container } = render(
      <ImportExportModal posts={[]} uniqueClients={['Acme']} isOperator onImport={onImport} onClose={onClose} showToast={noop} />
    );
    openImportTab();
    changeFile(container, 'client,content,platform\nAcme,Hello,gmb\nBeta,World,blog');

    expect(await screen.findByText(/threads will be created/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Import 2$/ }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toHaveLength(2);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('client member: re-pins every imported row to their own client (ignores the file column)', async () => {
    const onImport = vi.fn().mockResolvedValue(true);
    const { container } = render(
      <ImportExportModal posts={[]} uniqueClients={['MyClient']} isOperator={false} scopeClient="MyClient" onImport={onImport} onClose={noop} showToast={noop} />
    );
    openImportTab();
    changeFile(container, 'client,content,platform\nEvil Corp,Sneaky,gmb\nOther,Post,blog');

    expect(await screen.findByText(/Importing under/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Import 2$/ }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const rows = onImport.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.client === 'MyClient')).toBe(true);
  });

  it('member sees the lock note before choosing a file', () => {
    render(<ImportExportModal posts={[]} uniqueClients={['MyClient']} isOperator={false} scopeClient="MyClient" onImport={noop} onClose={noop} showToast={noop} />);
    fireEvent.click(screen.getByRole('tab', { name: /Import/ }));
    expect(screen.getByText(/added under/)).toBeInTheDocument();
  });
});
