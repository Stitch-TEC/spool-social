import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FeedbackWidget from './FeedbackWidget';
import { MESSAGE_MAX } from '../lib/feedbackClient';

const mock = vi.hoisted(() => ({ submitFeedback: vi.fn() }));
vi.mock('../lib/feedbackClient', async original => ({
  ...await original(), submitFeedback: mock.submitFeedback,
}));
vi.mock('../lib/screenshot', () => ({
  imageFileToShot: vi.fn(), shotFromDataTransfer: vi.fn(),
  capturePageShot: vi.fn(), dataTransferHasImage: () => false,
}));

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
const enter = message => fireEvent.change(screen.getByRole('textbox', { name: 'Feedback message' }), {
  target: { value: message },
});
const send = () => screen.getByRole('button', { name: 'Send', exact: true });
const widget = () => render(<FeedbackWidget user={{ email: 'member@example.test' }} role="client" clientId="synthetic" />);

beforeEach(() => { mock.submitFeedback.mockReset(); mock.submitFeedback.mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('FeedbackWidget visible input limit', () => {
  it('names the input and describes the exact ingress-aligned count without a native silent cap', () => {
    widget(); open();
    const input = screen.getByRole('textbox', { name: 'Feedback message' });
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute('maxlength');
    expect(input).toHaveAccessibleDescription('0 / 1,000 characters');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true');
    expect(send()).toBeDisabled();
  });

  it.each([1, 999, 1000])('counts and sends all %i characters within the unchanged limit', async length => {
    widget(); open();
    const exact = 'x'.repeat(length);
    enter(exact);
    expect(screen.getByText(`${length.toLocaleString('en-US')} / 1,000 characters`)).toBeInTheDocument();
    expect(send()).toBeEnabled();
    if (length === MESSAGE_MAX) expect(screen.getByRole('status')).toHaveTextContent('1,000-character limit reached.');
    fireEvent.click(send());
    await waitFor(() => expect(mock.submitFeedback).toHaveBeenCalledTimes(1));
    expect(mock.submitFeedback.mock.calls[0][0].message).toBe(exact);
  });

  it.each([1001, 13000])('preserves all %i pasted characters and refuses even a forced form submit', length => {
    widget(); open();
    const exact = `Beginning ${'x'.repeat(length - 14)} END`;
    expect(exact).toHaveLength(length);
    enter(exact);
    const input = screen.getByRole('textbox', { name: 'Feedback message' });
    expect(input).toHaveValue(exact);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Over the 1,000-character limit. Shorten your message to send.');
    expect(send()).toBeDisabled();
    fireEvent.submit(input.closest('form'));
    expect(mock.submitFeedback).not.toHaveBeenCalled();
    expect(input).toHaveValue(exact);
  });

  it('counts code units consistently with the backend for emoji, rather than claiming grapheme limits', async () => {
    widget(); open(); enter('😀'.repeat(500));
    expect(screen.getByText('1,000 / 1,000 characters')).toBeInTheDocument();
    fireEvent.click(send());
    await waitFor(() => expect(mock.submitFeedback).toHaveBeenCalledTimes(1));
    expect(mock.submitFeedback.mock.calls[0][0].message).toBe('😀'.repeat(500));
  });

  it('does not silently trim excess whitespace before admitting an over-limit input', () => {
    widget(); open(); enter(`Valid${' '.repeat(1000)}`);
    expect(send()).toBeDisabled();
    fireEvent.submit(screen.getByRole('textbox').closest('form'));
    expect(mock.submitFeedback).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue(`Valid${' '.repeat(1000)}`);
  });

  it('clears the warning and enables Send immediately after a deliberate edit below the cap', async () => {
    widget(); open(); enter('x'.repeat(1001));
    enter('A shorter complete report');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid');
    expect(send()).toBeEnabled();
    fireEvent.click(send());
    await waitFor(() => expect(mock.submitFeedback).toHaveBeenCalledTimes(1));
    expect(mock.submitFeedback.mock.calls[0][0].message).toBe('A shorter complete report');
  });

  it.each(['Cancel', 'Close', 'Escape'])('preserves the complete unsent input after %s and reopen within the same widget', action => {
    widget(); open(); const exact = 'x'.repeat(1003); enter(exact);
    if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: action, exact: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    open(); expect(screen.getByRole('textbox')).toHaveValue(exact);
    expect(send()).toBeDisabled();
    expect(mock.submitFeedback).not.toHaveBeenCalled();
  });

  it('retains input on transport failure and allows a deliberate retry without changing its bytes', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.submitFeedback.mockRejectedValueOnce(new Error('synthetic failure'));
    widget(); open(); enter('A complete report'); fireEvent.click(send());
    await waitFor(() => expect(send()).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('A complete report');
    fireEvent.click(send());
    await waitFor(() => expect(mock.submitFeedback).toHaveBeenCalledTimes(2));
    expect(mock.submitFeedback.mock.calls.map(([payload]) => payload.message)).toEqual(['A complete report', 'A complete report']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('freezes the admitted input and refuses repeated submission or dismissal during dispatch', async () => {
    let finish;
    mock.submitFeedback.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    widget(); open(); enter('Exact submitted text'); fireEvent.click(send());
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unadmitted text' } });
    expect(screen.getByRole('textbox')).toHaveValue('Exact submitted text');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('textbox').closest('form'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mock.submitFeedback).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    open(); expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
