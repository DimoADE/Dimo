import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/desktopShell', () => ({
  getDesktopShell: () => ({
    invoke: invokeMock,
  }),
  hasElectronDesktopRuntime: () => true,
}));

import {
  ElectronBrowserWebview,
  electronPartitionForProfile,
} from './ElectronBrowserWebview';

describe('ElectronBrowserWebview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps persistent and ephemeral profiles to isolated webview partitions', () => {
    expect(electronPartitionForProfile('default', 'tab-1')).toBe(
      'persist:dimo-browser-default'
    );
    expect(electronPartitionForProfile('Work Account', 'tab-1')).toBe(
      'persist:dimo-browser-work-account'
    );
    expect(electronPartitionForProfile('ephemeral', 'tab-9')).toBe(
      'dimo-browser-ephemeral-tab-9'
    );
  });

  it('attaches webContentsId on dom-ready and detaches on unmount', () => {
    const onHistory = vi.fn();
    const { unmount } = render(
      <ElectronBrowserWebview
        tabId="tab-1"
        url="https://example.com"
        profileId="default"
        surfaceHost="dockview"
        panelVisible={true}
        onHistoryAvailabilityChange={onHistory}
      />
    );

    const webview = screen.getByTestId('electron-browser-webview') as HTMLElement & {
      getWebContentsId?: () => number;
      canGoBack?: () => boolean;
      getURL?: () => string;
    };
    expect(webview.getAttribute('partition')).toBe('persist:dimo-browser-default');
    expect(webview.getAttribute('src')).toBe('https://example.com');

    webview.getWebContentsId = () => 77;
    webview.canGoBack = () => true;
    webview.getURL = () => 'https://example.com/loaded';

    act(() => {
      webview.dispatchEvent(new Event('dom-ready'));
    });

    expect(invokeMock).toHaveBeenCalledWith('electron_browser_attach', {
      tabId: 'tab-1',
      webContentsId: 77,
      profileId: 'default',
      url: 'https://example.com/loaded',
    });
    expect(onHistory).toHaveBeenCalledWith(true);

    unmount();

    expect(invokeMock).toHaveBeenCalledWith('electron_browser_detach', {
      tabId: 'tab-1',
      webContentsId: 77,
    });
  });

  it('hibernates offscreen canvas cards to a snapshot and wakes on click', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'electron_browser_capture_thumbnail') {
        return { mime: 'image/jpeg', data: 'ZmFrZQ==' };
      }
      return { ok: true };
    });

    render(
      <ElectronBrowserWebview
        tabId="tab-canvas"
        url="https://canvas.example.com"
        profileId="default"
        surfaceHost="canvas"
        panelVisible={false}
        canHibernate={true}
        hibernateDelayMs={500}
      />
    );

    expect(screen.getByTestId('electron-browser-webview')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const hibernated = screen.getByTestId('electron-browser-hibernated');
    expect(hibernated).toBeTruthy();
    expect(screen.queryByTestId('electron-browser-webview')).toBeNull();

    const img = hibernated.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,ZmFrZQ==');

    // Click wakes the webview back up at the saved URL
    fireEvent.click(hibernated);
    const woken = screen.getByTestId('electron-browser-webview');
    expect(woken.getAttribute('src')).toBe('https://canvas.example.com');
  });

  it('does not hibernate dockview tabs when panelVisible is false', async () => {
    render(
      <ElectronBrowserWebview
        tabId="tab-dock"
        url="https://dock.example.com"
        profileId="default"
        surfaceHost="dockview"
        panelVisible={false}
        canHibernate={true}
        hibernateDelayMs={100}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByTestId('electron-browser-webview')).toBeTruthy();
    expect(screen.queryByTestId('electron-browser-hibernated')).toBeNull();
  });
});
