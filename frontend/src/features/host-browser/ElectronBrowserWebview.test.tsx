import { StrictMode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@/lib/desktopShell', () => ({
  getDesktopShell: () => ({
    invoke: invokeMock,
  }),
  hasElectronDesktopRuntime: () => true,
}));

import { ElectronBrowserHost } from './ElectronBrowserHost';
import {
  ElectronBrowserWebview,
  electronPartitionForProfile,
} from './ElectronBrowserWebview';
import {
  MAX_WEBVIEW_CRASH_RECOVERIES,
  WEBVIEW_POINTER_DOWN_CHANNEL,
} from './HostedElectronBrowserWebview';
import { closeBrowserTabOnce } from './browserPanelLifetime';
import {
  resetElectronBrowserSurfaceStoreForTests,
  setBrowserOverlayDragging,
  setCanvasBrowserInteracting,
  unregisterElectronBrowserTab,
} from './electronBrowserSurfaceStore';

interface MockWebviewElement extends HTMLElement {
  getWebContentsId?: () => number;
  canGoBack?: () => boolean;
  getURL?: () => string;
}

const activeSpies: Array<{ mockRestore: () => void }> = [];

function mockRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number }
): void {
  const domRect = {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  } as DOMRect;
  activeSpies.push(
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(domRect)
  );
}

describe('ElectronBrowserWebview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true });
    resetElectronBrowserSurfaceStoreForTests();
  });

  afterEach(() => {
    cleanup();
    while (activeSpies.length > 0) {
      activeSpies.pop()?.mockRestore();
    }
    resetElectronBrowserSurfaceStoreForTests();
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

  it('attaches webContentsId on dom-ready and detaches on unmount (standalone fallback)', () => {
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

    const webview = screen.getByTestId(
      'electron-browser-webview'
    ) as MockWebviewElement;
    expect(webview.getAttribute('partition')).toBe(
      'persist:dimo-browser-default'
    );
    expect(webview.getAttribute('src')).toBe('https://example.com');
    expect(webview.style.display).toBe('flex');

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

  it('attaches eagerly on did-attach without duplicating attach on dom-ready', () => {
    render(
      <>
        <ElectronBrowserHost />
        <ElectronBrowserWebview
          tabId="tab-eager"
          url="https://eager.example.com"
          profileId="default"
          surfaceHost="dockview"
          panelVisible={true}
        />
      </>
    );

    const webview = screen.getByTestId(
      'electron-browser-webview'
    ) as MockWebviewElement;
    webview.getWebContentsId = () => 91;
    webview.getURL = () => 'https://eager.example.com';

    act(() => {
      webview.dispatchEvent(new Event('did-attach'));
      webview.dispatchEvent(new Event('dom-ready'));
    });

    const attachCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'electron_browser_attach'
    );
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0][1]).toMatchObject({
      tabId: 'tab-eager',
      webContentsId: 91,
      url: 'https://eager.example.com',
    });
  });

  it('preserves the exact root webview DOM node across Dockview slot remounts and unmounts on tab close', async () => {
    const dispatchMock = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      <>
        <ElectronBrowserHost />
        <div data-testid="dock-slot-a">
          <ElectronBrowserWebview
            tabId="tab-persist"
            url="https://persist.example.com"
            profileId="default"
            surfaceHost="dockview"
            panelVisible={true}
          />
        </div>
      </>
    );

    const initialWebview = screen.getByTestId(
      'electron-browser-webview'
    ) as MockWebviewElement;
    initialWebview.getWebContentsId = () => 55;
    act(() => {
      initialWebview.dispatchEvent(new Event('did-attach'));
    });

    // Simulate Dockview splitting/reparenting where the panel slot unmounts and remounts.
    rerender(
      <>
        <ElectronBrowserHost />
        <div data-testid="dock-slot-empty" />
      </>
    );

    const stillMounted = screen.getByTestId('electron-browser-webview');
    expect(stillMounted).toBe(initialWebview);
    const wrapperHidden = screen.getByTestId('electron-browser-host-wrapper');
    expect(wrapperHidden.getAttribute('data-visible')).toBe('false');
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === 'electron_browser_detach')
    ).toHaveLength(0);

    // Remount the slot in a different container; the same <webview> is reused without reload.
    rerender(
      <>
        <ElectronBrowserHost />
        <div data-testid="dock-slot-b">
          <ElectronBrowserWebview
            tabId="tab-persist"
            url="https://persist.example.com"
            profileId="default"
            surfaceHost="dockview"
            panelVisible={true}
          />
        </div>
      </>
    );

    expect(screen.getByTestId('electron-browser-webview')).toBe(initialWebview);

    // Closing the tab via closeBrowserTabOnce unregisters and detaches the root webview.
    act(() => {
      void closeBrowserTabOnce(dispatchMock, 'tab-persist');
    });

    expect(screen.queryByTestId('electron-browser-webview')).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith('tab.close', {
      tabId: 'tab-persist',
    });
    expect(invokeMock).toHaveBeenCalledWith('electron_browser_detach', {
      tabId: 'tab-persist',
      webContentsId: 55,
    });
  });

  it('recovers from render-process-gone crashes up to MAX_WEBVIEW_CRASH_RECOVERIES and ignores clean-exit', () => {
    render(
      <>
        <ElectronBrowserHost />
        <ElectronBrowserWebview
          tabId="tab-crash"
          url="https://initial.example.com"
          profileId="default"
          surfaceHost="dockview"
          panelVisible={true}
        />
      </>
    );

    const firstWebview = screen.getByTestId(
      'electron-browser-webview'
    ) as MockWebviewElement;
    firstWebview.getURL = () => 'https://after-nav.example.com';
    act(() => {
      firstWebview.dispatchEvent(new Event('did-navigate'));
    });

    // clean-exit should not trigger recovery
    act(() => {
      const cleanExit = new Event('render-process-gone') as Event & {
        reason?: string;
      };
      cleanExit.reason = 'clean-exit';
      firstWebview.dispatchEvent(cleanExit);
    });
    expect(
      screen
        .getByTestId('electron-browser-webview')
        .getAttribute('data-generation')
    ).toBe('0');

    // Crashes increment generation and remount at last navigated URL
    for (let i = 1; i <= MAX_WEBVIEW_CRASH_RECOVERIES; i += 1) {
      const current = screen.getByTestId('electron-browser-webview');
      act(() => {
        const crashed = new Event('render-process-gone') as Event & {
          reason?: string;
        };
        crashed.reason = 'crashed';
        current.dispatchEvent(crashed);
      });
      const recovered = screen.getByTestId('electron-browser-webview');
      expect(recovered.getAttribute('data-generation')).toBe(String(i));
      expect(recovered.getAttribute('src')).toBe(
        'https://after-nav.example.com'
      );
    }

    // Beyond MAX_WEBVIEW_CRASH_RECOVERIES, no further remount occurs
    const capped = screen.getByTestId('electron-browser-webview');
    act(() => {
      const crashed = new Event('render-process-gone') as Event & {
        reason?: string;
      };
      crashed.reason = 'crashed';
      capped.dispatchEvent(crashed);
    });
    expect(
      screen
        .getByTestId('electron-browser-webview')
        .getAttribute('data-generation')
    ).toBe(String(MAX_WEBVIEW_CRASH_RECOVERIES));
  });

  it('renders canvas browser webviews inline inside the node DOM instead of app-root overlay so HUD and cards stack natively', () => {
    render(
      <>
        <ElectronBrowserHost />
        <div data-testid="workspace-canvas-stage" className="react-flow">
          <div
            data-testid="browser-node"
            className="react-flow__node"
            style={{ zIndex: 1 }}
          >
            <ElectronBrowserWebview
              tabId="tab-canvas-inline"
              url="https://github.com/"
              profileId="default"
              surfaceHost="canvas"
              panelVisible={true}
              surfaceZIndex={1}
              backgroundColor="#14171f"
            />
          </div>
          <div data-viewport-position="bottom-right">
            <div className="pointer-events-auto" data-testid="canvas-minimap" />
          </div>
        </div>
      </>
    );

    const slot = screen.getByTestId('electron-browser-surface-slot');
    const webview = screen.getByTestId('electron-browser-webview');

    // Webview lives directly inside the canvas node slot (never duplicated in ElectronBrowserHost)
    expect(slot.contains(webview)).toBe(true);
    expect(screen.queryByTestId('electron-browser-host-wrapper')).toBeNull();
    expect(
      screen.queryByTestId('electron-browser-occlusion-snapshot')
    ).toBeNull();
    expect(webview.style.width).toBe('100%');
    expect(webview.style.height).toBe('100%');
    expect(webview.style.visibility).toBe('visible');
    expect(webview.style.pointerEvents).toBe('auto');

    // During canvas pan/drag or overlay drag, pointer-events disable cleanly and recover immediately
    act(() => {
      setCanvasBrowserInteracting(true);
    });
    expect(webview.style.pointerEvents).toBe('none');

    act(() => {
      setCanvasBrowserInteracting(false);
    });
    expect(webview.style.pointerEvents).toBe('auto');

    act(() => {
      setBrowserOverlayDragging(true);
    });
    expect(webview.style.pointerEvents).toBe('none');

    act(() => {
      setBrowserOverlayDragging(false);
    });
    expect(webview.style.pointerEvents).toBe('auto');

    act(() => {
      unregisterElectronBrowserTab('tab-canvas-inline');
    });
  });

  it('bubbles guest pointerdown ipc-message from an inline canvas webview to the node ancestor and notifies onSurfacePointerDown', () => {
    const onParentPointerDown = vi.fn();
    const onSurfacePointerDown = vi.fn();

    render(
      <>
        <ElectronBrowserHost />
        <div onPointerDownCapture={onParentPointerDown}>
          <ElectronBrowserWebview
            tabId="tab-pointer"
            url="https://pointer.example.com"
            profileId="default"
            surfaceHost="canvas"
            panelVisible={true}
            onSurfacePointerDown={onSurfacePointerDown}
          />
        </div>
      </>
    );

    const webview = screen.getByTestId('electron-browser-webview');
    act(() => {
      const ipcEvent = new Event('ipc-message') as Event & {
        channel?: string;
        args?: unknown[];
      };
      ipcEvent.channel = WEBVIEW_POINTER_DOWN_CHANNEL;
      ipcEvent.args = [{ button: 0 }];
      webview.dispatchEvent(ipcEvent);
    });

    expect(onParentPointerDown).toHaveBeenCalledTimes(1);
    expect(onSurfacePointerDown).toHaveBeenCalledTimes(1);
  });

  it('hibernates canvas cards only when truly offscreen outside the stage viewport and wakes on click', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'electron_browser_capture_thumbnail') {
        return { mime: 'image/jpeg', data: 'ZmFrZQ==' };
      }
      return { ok: true };
    });

    render(
      <>
        <ElectronBrowserHost />
        <div data-testid="workspace-canvas-stage" className="react-flow">
          <ElectronBrowserWebview
            tabId="tab-canvas"
            url="https://canvas.example.com"
            profileId="default"
            surfaceHost="canvas"
            panelVisible={true}
            canHibernate={true}
            hibernateDelayMs={500}
          />
        </div>
      </>
    );

    const stage = screen.getByTestId('workspace-canvas-stage');
    const slot = screen.getByTestId('electron-browser-surface-slot');
    mockRect(stage, { left: 0, top: 0, width: 1000, height: 800 });
    mockRect(slot, { left: 100, top: 100, width: 400, height: 300 });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    // While inside the viewport, advancing timers must NOT hibernate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByTestId('electron-browser-webview')).toBeTruthy();
    expect(screen.queryByTestId('electron-browser-hibernated')).toBeNull();

    // Pan card completely offscreen beyond the 120px hibernation margin.
    mockRect(slot, { left: 1600, top: 100, width: 400, height: 300 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const hibernated = screen.getByTestId('electron-browser-hibernated');
    expect(hibernated).toBeTruthy();
    expect(screen.queryByTestId('electron-browser-webview')).toBeNull();

    const img = hibernated.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,ZmFrZQ==');

    // Clicking the hibernated card wakes the webview back up at the saved URL.
    fireEvent.click(hibernated);
    const woken = screen.getByTestId('electron-browser-webview');
    expect(woken.getAttribute('src')).toBe('https://canvas.example.com');
  });

  it('does not hibernate dockview tabs when panelVisible is false', async () => {
    render(
      <>
        <ElectronBrowserHost />
        <ElectronBrowserWebview
          tabId="tab-dock"
          url="https://dock.example.com"
          profileId="default"
          surfaceHost="dockview"
          panelVisible={false}
          canHibernate={true}
          hibernateDelayMs={100}
        />
      </>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(screen.getByTestId('electron-browser-webview')).toBeTruthy();
    expect(screen.queryByTestId('electron-browser-hibernated')).toBeNull();
  });

  it('renders ElectronBrowserHost with display: contents for Dockview tabs', () => {
    render(
      <>
        <ElectronBrowserHost />
        <ElectronBrowserWebview
          tabId="tab-stacking"
          url="https://stacking.example.com"
          profileId="default"
          surfaceHost="dockview"
          panelVisible={true}
        />
      </>
    );

    const host = screen.getByTestId('electron-browser-host');
    expect(host.style.display).toBe('contents');
    expect(host.style.zIndex).toBe('');
    expect(
      screen.getByTestId('electron-browser-host-wrapper')
    ).toBeInTheDocument();
  });

  it('keeps unattached Dockview webview paintable offscreen on Windows until did-attach fires', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'platform'
    );
    const uaDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'userAgent'
    );
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    try {
      render(
        <>
          <ElectronBrowserHost />
          <ElectronBrowserWebview
            tabId="tab-win-hidden"
            url="https://github.com/"
            profileId="default"
            surfaceHost="dockview"
            panelVisible={false}
          />
        </>
      );

      const wrapper = screen.getByTestId('electron-browser-host-wrapper');
      const webview = screen.getByTestId(
        'electron-browser-webview'
      ) as MockWebviewElement;
      expect(wrapper.getAttribute('data-visible')).toBe('false');
      expect(wrapper.style.visibility).toBe('visible');

      webview.getWebContentsId = () => 303;
      webview.getURL = () => 'https://github.com/';

      await act(async () => {
        webview.dispatchEvent(new Event('did-attach'));
        await Promise.resolve();
      });

      expect(wrapper.style.visibility).toBe('hidden');
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(navigator, 'platform', platformDescriptor);
      }
      if (uaDescriptor) {
        Object.defineProperty(navigator, 'userAgent', uaDescriptor);
      }
    }
  });

  it('does not send an unscoped electron_browser_detach before did-attach under React.StrictMode', () => {
    render(
      <StrictMode>
        <ElectronBrowserHost />
        <ElectronBrowserWebview
          tabId="tab-strict-attach"
          url="https://github.com/"
          profileId="default"
          surfaceHost="canvas"
          panelVisible={true}
        />
      </StrictMode>
    );

    const webview = screen.getByTestId(
      'electron-browser-webview'
    ) as MockWebviewElement;
    webview.getWebContentsId = () => 404;
    webview.getURL = () => 'https://github.com/';

    act(() => {
      webview.dispatchEvent(new Event('did-attach'));
    });

    const detachCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'electron_browser_detach'
    );
    expect(detachCalls).toHaveLength(0);

    const attachCalls = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === 'electron_browser_attach'
    );
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0][1]).toMatchObject({
      tabId: 'tab-strict-attach',
      webContentsId: 404,
    });
  });
});
