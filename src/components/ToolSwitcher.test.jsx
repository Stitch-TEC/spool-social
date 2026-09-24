import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolSwitcher from './ToolSwitcher';
import { STITCH_APPS, CURRENT_APP_ID } from '../stitch-apps';

describe('ToolSwitcher header disclosure', () => {
  it('reports its disclosure state and retains every canonical app destination', () => {
    render(<ToolSwitcher />);
    const trigger = screen.getByRole('button', { name: 'Switch Stitch Suite app' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(trigger.getAttribute('aria-controls'));
    expect(panel).toBeInTheDocument();
    for (const app of STITCH_APPS.filter(app => app.status !== 'soon')) {
      const link = screen.getByRole('link', { name: `${app.name} · ${app.tagline}` });
      expect(link).toHaveAttribute('href', app.url);
      expect(link).toHaveAttribute('target', app.id === CURRENT_APP_ID ? '_self' : '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveClass('min-h-11');
      if (app.id === CURRENT_APP_ID) expect(link).toHaveAttribute('aria-current', 'page');
      else expect(link).not.toHaveAttribute('aria-current');
    }
    expect(panel).toHaveClass('overflow-y-auto', 'max-h-[calc(100dvh-5rem)]', 'max-w-[calc(100vw-2rem)]');
    fireEvent.click(trigger);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('Escape closes and returns keyboard focus from a destination to the trigger', () => {
    render(<ToolSwitcher />);
    const trigger = screen.getByRole('button', { name: 'Switch Stitch Suite app' });
    fireEvent.click(trigger);
    screen.getAllByRole('link')[1].focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('does not steal outside focus when Escape closes an open disclosure', () => {
    render(<><ToolSwitcher /><button>Outside control</button></>);
    const trigger = screen.getByRole('button', { name: 'Switch Stitch Suite app' });
    fireEvent.click(trigger);
    const outside = screen.getByRole('button', { name: 'Outside control' });
    outside.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(outside).toHaveFocus();
  });

  it('retains outside-pointer dismissal and gives each mounted disclosure a distinct id', () => {
    render(<><ToolSwitcher /><ToolSwitcher /><button>Outside control</button></>);
    const triggers = screen.getAllByRole('button', { name: 'Switch Stitch Suite app' });
    for (const trigger of triggers) fireEvent.click(trigger);
    expect(triggers[0].getAttribute('aria-controls')).not.toBe(triggers[1].getAttribute('aria-controls'));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside control' }));
    for (const trigger of triggers) expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
