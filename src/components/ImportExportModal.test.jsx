import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ImportExportModal from './ImportExportModal';

const posts = [
  { id: '1', client: 'Acme', platform: 'gmb', content: 'a1', status: 'draft' },
  { id: '2', client: 'Acme', platform: 'blog', content: 'a2', status: 'archived' },
  { id: '3', client: 'Beta', platform: 'gmb', content: 'b1', status: 'draft' },
];

const noop = () => {};
const importAdmission = { admissionKey: 'fixture-admission', getAdmissionKey: () => 'fixture-admission',
  resolveClientId: name => name ? name.toLowerCase().replace(/\s+/g, '-') : '' };

// downloadFile() needs URL.createObjectURL, which jsdom doesn't implement.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

const changeFile = (container, text, name = 'in.csv') => {
  const input = container.querySelector('input[type="file"]');
  const file = new File([text], name, { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
};

describe('ImportExportModal — export scope', () => {
  it.each([['reviewDetailsAck', null], ['reviewDetailsAck', {}], ['reviewMediaLinks', null],
    ['reviewMediaLinks', []], ['reviewMediaLinks', '']])('does not download lossy CSV for ack/alias-only %s records %#', (field, value) => {
    const showToast = vi.fn();
    render(<ImportExportModal posts={[{ ...posts[0], [field]: value }]} uniqueClients={['Acme']}
      isOperator onImport={noop} onClose={noop} showToast={showToast} />);
    fireEvent.click(screen.getByRole('button', { name: /^CSV/ }));
    fireEvent.click(screen.getByRole('button', { name: /Export 1 thread$/ }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('CSV cannot preserve review details'), 'error');
  });
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
      <ImportExportModal {...importAdmission} posts={[]} uniqueClients={['Acme']} isOperator onImport={onImport} onClose={onClose} showToast={noop} />
    );
    openImportTab();
    changeFile(container, 'client,content,platform\nAcme,Hello,gmb\nBeta,World,blog');

    expect(await screen.findByText(/threads in this preview/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Import 2$/ }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onImport.mock.calls[0][0]).toHaveLength(2);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('client member: re-pins every imported row to their own client (ignores the file column)', async () => {
    const onImport = vi.fn().mockResolvedValue(true);
    const { container } = render(
      <ImportExportModal {...importAdmission} posts={[]} uniqueClients={['MyClient']} isOperator={false} scopeClient="MyClient" onImport={onImport} onClose={noop} showToast={noop} />
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

  const renderImport = (props = {}) => {
    const result = render(<ImportExportModal {...importAdmission} posts={[]} uniqueClients={['Acme']}
      isOperator onImport={noop} onClose={noop} showToast={noop} {...props} />);
    openImportTab(); return result;
  };
  it('downloads findable CSV and JSON draft templates without importing', () => {
    const onImport = vi.fn(); renderImport({ onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV template' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download JSON template' }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2); expect(onImport).not.toHaveBeenCalled();
  });
  it('opens optional field Help without a write', () => {
    const onOpenHelp = vi.fn(), onImport = vi.fn(); renderImport({ onOpenHelp, onImport });
    fireEvent.click(screen.getByRole('button', { name: 'Import guides' }));
    expect(onOpenHelp).toHaveBeenCalledTimes(1); expect(onImport).not.toHaveBeenCalled();
  });
  it('keeps valid rows previewable but blocks the whole file on a row error', async () => {
    const onImport = vi.fn(); const { container } = renderImport({ onImport });
    changeFile(container, 'client,content,platform\nAcme,Valid,linkedin\nAcme,Invalid,unknown');
    expect(await screen.findByText(/Row 2 · platform/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import 1$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ })); expect(onImport).not.toHaveBeenCalled();
  });
  it.each(['reviewDetailsVersion', 'firstComment', 'reviewMedia', 'reviewDetailsAck', 'reviewMediaLinks'])('shows protected %s presence as a row error', async field => {
    const onImport = vi.fn(); const { container } = renderImport({ onImport });
    changeFile(container, JSON.stringify([{ client: 'Acme', content: 'Draft', platform: 'linkedin', [field]: null }]), 'in.json');
    expect(await screen.findByText(new RegExp(`Row 1 · ${field}`))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import\s*$/ })).toBeDisabled(); expect(onImport).not.toHaveBeenCalled();
  });
  it('reports unknown destination clients instead of previewing a newly minted tenant', async () => {
    const { container } = renderImport({ resolveClientId: () => '' });
    changeFile(container, 'client,content,platform\nUnknown,Draft,linkedin');
    expect(await screen.findByText(/Choose an existing client/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import 1$/ })).toBeDisabled();
  });
  it('rejects a member reusable-template flag instead of silently changing it', async () => {
    const { container } = renderImport({ isOperator: false, scopeClient: 'Acme' });
    changeFile(container, 'client,content,platform,isTemplate\nAcme,Draft,linkedin,true');
    expect(await screen.findByText(/Client imports cannot create reusable templates/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import 1$/ })).toBeDisabled();
  });
  it('submits the fresh admission token and explicit null scheduling', async () => {
    const onImport = vi.fn().mockResolvedValue(true); const { container } = renderImport({ onImport });
    changeFile(container, 'client,content,platform,scheduledDate\nAcme,Draft,linkedin,');
    await screen.findByText(/thread in this preview/); fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
    await waitFor(() => expect(onImport).toHaveBeenCalled());
    expect(onImport.mock.calls[0][0][0].scheduledDate).toBeNull();
    expect(onImport.mock.calls[0][1]).toEqual({ admissionKey: 'fixture-admission' });
  });
  it('refuses confirmation if Firebase admission changes before props catch up', async () => {
    let current = 'fixture-admission'; const onImport = vi.fn(), showToast = vi.fn();
    const { container } = renderImport({ getAdmissionKey: () => current, onImport, showToast });
    changeFile(container, 'client,content,platform\nAcme,Draft,linkedin'); await screen.findByText(/thread in this preview/);
    current = null; fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
    expect(onImport).not.toHaveBeenCalled(); expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Workspace changed'), 'error');
  });
  const fakeReaders = () => {
    const readers = [];
    vi.stubGlobal('FileReader', class {
      readyState = 0;
      abort = vi.fn(() => { this.readyState = 2; });
      constructor() { readers.push(this); }
      readAsText() { this.readyState = 1; }
    });
    return readers;
  };
  it('drops a delayed FileReader result after an admission change', async () => {
    const readers = fakeReaders(); let current = 'fixture-admission';
    const { container } = renderImport({ getAdmissionKey: () => current });
    changeFile(container, 'placeholder'); current = null;
    await act(async () => { readers[0].onload({ target: { result: 'client,content,platform\nAcme,Old,linkedin' } }); });
    expect(screen.queryByText(/in this preview/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Import 1$/ })).toBeNull();
  });
  it('aborts reading and ignores its callback after the pane unmounts', async () => {
    const readers = fakeReaders(); const { container } = renderImport(); changeFile(container, 'placeholder');
    fireEvent.click(screen.getByRole('tab', { name: 'Export' })); expect(readers[0].abort).toHaveBeenCalledTimes(1);
    await act(async () => { readers[0].onload({ target: { result: 'client,content,platform\nAcme,Old,linkedin' } }); });
    openImportTab(); expect(screen.queryByText(/in this preview/)).toBeNull();
  });
  it('rejects oversized files before constructing a reader', async () => {
    const readers = fakeReaders(); const { container } = renderImport();
    const file = new File(['tiny'], 'large.csv'); Object.defineProperty(file, 'size', { value: 10 * 1024 * 1024 + 1 });
    fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
    expect(await screen.findByText(/Use a file smaller than 10 MiB/)).toBeInTheDocument(); expect(readers).toHaveLength(0);
  });
  it('shows file read errors without retaining an older preview', async () => {
    const readers = fakeReaders(), showToast = vi.fn(); const { container } = renderImport({ showToast });
    changeFile(container, 'placeholder'); await act(async () => { readers[0].onerror(); });
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Could not read the file'), 'error');
    expect(screen.queryByText(/in this preview/)).toBeNull();
  });
  it('keeps uncertainty visible and blocks importing during the page-memory hold', async () => {
    const onImport = vi.fn(); const { container } = renderImport({ onImport,
      importHold: { confirmed: 450, status: 'needs_checking' } });
    expect(screen.getByText('Import needs checking')).toBeInTheDocument();
    expect(screen.getByText(/Reloading loses this hold/)).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeDisabled();
    changeFile(container, 'client,content,platform\nAcme,Draft,linkedin'); expect(onImport).not.toHaveBeenCalled();
  });
  it('displays the actual member review consequence before confirmation', async () => {
    const { container } = renderImport({ isOperator: false, scopeClient: 'Acme' });
    changeFile(container, 'client,content,platform\nAcme,Draft,linkedin'); await screen.findByText(/thread in this preview/);
    expect(screen.getByText(/Creates new drafts available for client review/)).toBeInTheDocument();
  });
  it('uses a keyboard-focusable Choose file button with a real input trigger', () => {
    const { container } = renderImport(); const click = vi.spyOn(container.querySelector('input[type="file"]'), 'click');
    const button = screen.getByRole('button', { name: 'Choose file' }); button.focus();
    expect(document.activeElement).toBe(button); fireEvent.click(button); expect(click).toHaveBeenCalledTimes(1);
  });
  it('disables scope, duplicate, close, tab and file actions throughout dispatch', async () => {
    let finish; const onImport = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { container } = renderImport({ posts: [{ client: 'Acme', content: 'Duplicate', platform: 'linkedin' }], onImport });
    changeFile(container, 'client,content,platform\nAcme,Duplicate,linkedin\nBeta,Fresh,linkedin'); await screen.findByText(/thread in this preview/);
    fireEvent.click(screen.getByRole('button', { name: /^Import 1$/ }));
    expect(screen.getByLabelText('All clients')).toBeDisabled(); expect(screen.getByLabelText(/Skip 1 duplicate/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose another' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => { finish(false); }); expect(onImport).toHaveBeenCalledTimes(1);
  });
  it('offers bounded private references only through current hold admission', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `synthetic-id-${i}`); let current = true;
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue() } });
    const getHoldDetails = () => current ? { confirmed: 2, ids, total: 51 } : null;
    const showToast = vi.fn(); const app = renderImport({ importHold: { confirmed: 2 }, getHoldDetails, showToast });
    expect(screen.getByText('2 rows were confirmed saved.')).toBeInTheDocument();
    expect(screen.queryByText('synthetic-id-50')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy references' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ids.join('\n')));
    expect(showToast).toHaveBeenCalledWith('Copied import references');
    current = false; app.rerender(<ImportExportModal {...importAdmission} posts={[]} isOperator onImport={noop} onClose={noop}
      showToast={showToast} importHold={{ confirmed: 2 }} getHoldDetails={getHoldDetails} />);
    expect(screen.getByText('Import needs checking')).toBeInTheDocument();
    expect(screen.queryByText('2 rows were confirmed saved.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy references' })).toBeNull();
  });
});
