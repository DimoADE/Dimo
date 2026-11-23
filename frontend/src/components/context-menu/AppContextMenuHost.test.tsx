import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElectronDesktopBridge } from '@/lib/desktopShell/types';
import { AppContextMenuHost, useAppContextMenu } from './AppContextMenuHost';

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: vi.fn(async () => true),
  readClipboardViaBridge: vi.fn(async () => 'pasted'),
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

function installMockDesktopBridge({
  isDev = false,
  developerMode = false,
}: {
  isDev?: boolean;
  developerMode?: boolean;
}) {
  let currentDeveloperMode = developerMode;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn(async () => undefined);
  const bridge = {
    isElectron: true as const,
    isDev,
    isDeveloperMode: () => currentDeveloperMode,
    platform: 'win32',
    version: '0.5.2',
    windowLabel: 'main',
    apiOrigin: 'http://127.0.0.1:18421',
    wsOrigin: 'ws://127.0.0.1:18421',
    invoke,
    events: {
      listen: async (event: string, listener: (payload: unknown) => void) => {
        let bucket = listeners.get(event);
        if (!bucket) {
          bucket = new Set();
          listeners.set(event, bucket);
        }
        bucket.add(listener);
        return () => {
          bucket?.delete(listener);
        };
      },
    },
  } as unknown as ElectronDesktopBridge;

  window.dimoDesktop = bridge;

  return {
    invoke,
    emitDeveloperMode(enabled: boolean) {
      currentDeveloperMode = enabled;
      for (const listener of listeners.get('developer-mode-changed') ?? []) {
        listener({ enabled });
      }
    },
  };
}

function SurfaceButton() {
  const { openSurfaceMenu } = useAppContextMenu();
  return (
    <button
      type="button"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'create-session',
            label: 'Do thing',
            onSelect: () => undefined,
          },
        ]);
      }}
    >
      surface
    </button>
  );
}

describe('AppContextMenuHost', () => {
  afterEach(() => {
    delete window.dimoDesktop;
  });

  it('prevents the native browser menu', () => {
    render(
      <AppContextMenuHost>
        <div>hello</div>
      </AppContextMenuHost>
    );
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows cut/copy/paste on an input', async () => {
    render(
      <AppContextMenuHost>
        <input aria-label="name" defaultValue="abc" />
      </AppContextMenuHost>
    );
    const input = screen.getByLabelText('name') as HTMLInputElement;
    input.setSelectionRange(0, 2);
    fireEvent.contextMenu(input);
    expect(await screen.findByRole('menuitem', { name: '复制' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '剪切' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '粘贴' })).toBeTruthy();
  });

  it('does not show a product menu on a forbidden terminal zone', () => {
    render(
      <AppContextMenuHost>
        <div data-context-menu-zone="forbidden">
          <span>term</span>
        </div>
      </AppContextMenuHost>
    );
    fireEvent.contextMenu(screen.getByText('term'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a surface menu from openSurfaceMenu', async () => {
    render(
      <AppContextMenuHost>
        <SurfaceButton />
      </AppContextMenuHost>
    );
    fireEvent.contextMenu(screen.getByText('surface'));
    const item = await screen.findByRole('menuitem', { name: 'Do thing' });
    expect(item.querySelector('svg')).toBeTruthy();
  });

  it('shows developer actions on right-click in Dev desktop and invokes desktop commands', async () => {
    const { invoke } = installMockDesktopBridge({ isDev: true });
    render(
      <AppContextMenuHost>
        <div>blank-area</div>
      </AppContextMenuHost>
    );

    const target = screen.getByText('blank-area');
    fireEvent.contextMenu(target, { clientX: 120.4, clientY: 240.6 });

    const reloadItem = await screen.findByRole('menuitem', { name: '刷新' });
    fireEvent.click(reloadItem);
    expect(invoke).toHaveBeenCalledWith('reload_window');

    fireEvent.contextMenu(target, { clientX: 120.4, clientY: 240.6 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '强制刷新' }));
    expect(invoke).toHaveBeenCalledWith('force_reload_window');

    fireEvent.contextMenu(target, { clientX: 120.4, clientY: 240.6 });
    fireEvent.click(await screen.findByRole('menuitem', { name: '检查元素' }));
    expect(invoke).toHaveBeenCalledWith('inspect_element', {
      x: 120,
      y: 241,
    });

    fireEvent.contextMenu(target, { clientX: 120.4, clientY: 240.6 });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: '打开开发者工具' })
    );
    expect(invoke).toHaveBeenCalledWith('open_developer_tools');
  });

  it('opens developer menu on Shift+Right-Click over a surface menu target', async () => {
    installMockDesktopBridge({ isDev: true });
    render(
      <AppContextMenuHost>
        <SurfaceButton />
      </AppContextMenuHost>
    );

    const surface = screen.getByText('surface');
    fireEvent.contextMenu(surface);
    expect(
      await screen.findByRole('menuitem', { name: 'Do thing' })
    ).toBeTruthy();

    fireEvent.contextMenu(surface, { shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: '刷新' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Do thing' })).toBeNull();
  });

  it('syncs developer menu visibility live when developer-mode-changed fires', async () => {
    const { emitDeveloperMode } = installMockDesktopBridge({
      isDev: false,
      developerMode: false,
    });
    render(
      <AppContextMenuHost>
        <div>workspace-bg</div>
      </AppContextMenuHost>
    );

    const target = screen.getByText('workspace-bg');
    fireEvent.contextMenu(target);
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => {
      emitDeveloperMode(true);
    });

    fireEvent.contextMenu(target);
    expect(await screen.findByRole('menuitem', { name: '刷新' })).toBeTruthy();

    act(() => {
      emitDeveloperMode(false);
    });

    fireEvent.contextMenu(target);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('handles Ctrl+R reload outside forbidden terminal zones in developer mode', () => {
    const { invoke } = installMockDesktopBridge({ isDev: true });
    render(
      <AppContextMenuHost>
        <div>normal-zone</div>
        <div data-context-menu-zone="forbidden">
          <span>terminal-zone</span>
        </div>
      </AppContextMenuHost>
    );

    fireEvent.keyDown(screen.getByText('terminal-zone'), {
      key: 'r',
      code: 'KeyR',
      ctrlKey: true,
    });
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByText('normal-zone'), {
      key: 'r',
      code: 'KeyR',
      ctrlKey: true,
    });
    expect(invoke).toHaveBeenCalledWith('reload_window');
  });
});
