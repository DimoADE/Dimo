import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppTitleBar } from './AppTitleBar';

const startDragging = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const toggleMaximize = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@/lib/desktopShell', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/desktopShell')>();
  return {
    ...actual,
    getDesktopShell: () => {
      const shell = actual.getDesktopShell();
      return {
        ...shell,
        window: {
          ...shell.window,
          startDragging,
          toggleMaximize,
        },
      };
    },
  };
});

describe('AppTitleBar', () => {
  it('is a drag region without embedding window controls', () => {
    render(<AppTitleBar left={<span>Settings</span>} />);

    const bar = screen.getByText('Settings').closest('.settings-titlebar');
    expect(bar).toHaveClass('window-chrome', 'h-9');
    expect(bar).toHaveAttribute('data-window-drag-region');
    expect(bar?.querySelector('[data-window-drag-region]')).not.toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Minimize' })
    ).not.toBeInTheDocument();
  });

  it('keeps the centered title inside a drag region without covering the bar', () => {
    render(<AppTitleBar center={<span>Settings</span>} />);

    const title = screen.getByText('Settings');
    const overlay = title.parentElement?.parentElement;
    expect(overlay).toHaveAttribute('data-window-drag-region');
    expect(overlay).toHaveClass('pointer-events-none');
    expect(overlay).not.toHaveClass('inset-0');
  });

  it('starts a window drag from empty titlebar chrome on Windows', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    render(<AppTitleBar center={<span>Settings</span>} />);

    const bar = screen.getByText('Settings').closest('.settings-titlebar');
    fireEvent.pointerDown(bar!, { button: 0 });
    await vi.waitFor(() => expect(startDragging).toHaveBeenCalled());
  });

  it('does not start a window drag from a titlebar button', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
    startDragging.mockClear();
    render(<AppTitleBar left={<button type="button">Logo</button>} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Logo' }), {
      button: 0,
    });
    expect(startDragging).not.toHaveBeenCalled();
  });
});
