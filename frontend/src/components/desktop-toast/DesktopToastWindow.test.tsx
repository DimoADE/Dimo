import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopToastWindow } from './DesktopToastWindow';

const mocks = vi.hoisted(() => ({
  setIgnoreMouseEvents: vi.fn(async (_ignore: boolean) => undefined),
  desktopShellCall: vi.fn(),
  backendListen: vi.fn(),
  hideWindow: vi.fn(async () => undefined),
}));

vi.mock('@/lib/desktopShell', () => ({
  desktopShellCall: (...args: unknown[]) => mocks.desktopShellCall(...args),
  getDesktopShell: () => ({
    kind: 'electron',
    window: {
      hide: mocks.hideWindow,
    },
    desktopToast: {
      setIgnoreMouseEvents: mocks.setIgnoreMouseEvents,
    },
  }),
}));

vi.mock('@/lib/backendTransport', () => ({
  backendListen: (...args: unknown[]) => mocks.backendListen(...args),
}));

vi.mock('@/components/Logo', () => ({
  Logo: () => <span data-testid="logo" />,
}));

vi.mock('@/lib/api', () => ({
  sessionsApi: { getById: vi.fn() },
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { submitInput: vi.fn() },
}));

describe('DesktopToastWindow mouse pass-through coordination', () => {
  beforeEach(() => {
    mocks.setIgnoreMouseEvents.mockClear();
    mocks.desktopShellCall.mockReset();
    mocks.backendListen.mockReset();
    mocks.hideWindow.mockClear();

    mocks.backendListen.mockResolvedValue(() => undefined);
    mocks.desktopShellCall.mockImplementation(async (command: string) => {
      if (command === 'desktop_toast_window_ready') {
        return [
          {
            projectId: 'p1',
            workspaceId: 'w1',
            sessionId: 's1',
            title: 'Build finished',
            description: 'All checks passed',
            kind: 'success',
            durationMs: 60_000,
          },
        ];
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to click-through, disables on card hover/input focus, and restores on leave/blur/unmount', async () => {
    const { unmount } = render(<DesktopToastWindow />);

    expect(mocks.setIgnoreMouseEvents).toHaveBeenCalledWith(true);

    const card = await screen.findByRole('status');
    mocks.setIgnoreMouseEvents.mockClear();

    // Pointer enters toast card -> interactive (ignore = false)
    fireEvent.pointerEnter(card);
    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);

    // Pointer leaves toast card without focus -> click-through (ignore = true)
    fireEvent.pointerLeave(card);
    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);

    // Expand Quick Reply and focus input
    fireEvent.pointerEnter(card);
    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    const replyButton = card.querySelector('.vu-desktop-toast-reply-action');
    expect(replyButton).not.toBeNull();
    fireEvent.click(replyButton!);

    const input = await waitFor(() => {
      const el = card.querySelector<HTMLInputElement>('.vu-desktop-toast-input');
      expect(el).not.toBeNull();
      return el!;
    });

    fireEvent.focus(input);
    mocks.setIgnoreMouseEvents.mockClear();

    // Leaving card while input is still focused must keep ignore = false
    fireEvent.pointerLeave(card);
    expect(mocks.setIgnoreMouseEvents).not.toHaveBeenCalledWith(true);

    // Blurring input while pointer is outside restores click-through (ignore = true)
    fireEvent.blur(input);
    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);

    // Re-hover then unmount -> must restore click-through on unmount
    fireEvent.pointerEnter(card);
    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    unmount();
    expect(mocks.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  });
});
