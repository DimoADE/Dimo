import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDesktopShell,
  getDesktopShellKind,
  getDesktopWindowLabel,
  hasAnyDesktopRuntime,
  hasDesktopShell,
  openExternalUrl,
  type ElectronDesktopBridge,
} from './index';

function createMockElectronBridge(): ElectronDesktopBridge {
  return {
    platform: 'win32',
    backend: {
      baseUrl: 'http://127.0.0.1:43210',
      token: 'secret-token',
    },
    getAppVersion: vi.fn(async () => '2.0.0-electron'),
    getWindowLabel: vi.fn(() => 'host-lab'),
    window: {
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
      show: vi.fn(async () => undefined),
      hide: vi.fn(async () => undefined),
      setFocus: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
      startDragging: vi.fn(async () => undefined),
      onResized: vi.fn(async () => () => undefined),
      setZoom: vi.fn(async () => undefined),
      onDragDropEvent: vi.fn(async () => () => undefined),
    },
    dialog: {
      open: vi.fn(async () => 'C:/projects/demo'),
      save: vi.fn(async () => 'C:/projects/out.md'),
    },
    fs: {
      readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
      writeFile: vi.fn(async () => undefined),
      writeTextFile: vi.fn(async () => undefined),
    },
    path: {
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
    },
    assets: {
      convertFileSrc: vi.fn(
        (filePath: string) => `dimo-asset://localhost/${filePath}`
      ),
    },
    events: {
      listen: vi.fn(async () => () => undefined),
      emit: vi.fn(async () => undefined),
    },
    updater: {
      check: vi.fn(async () => null),
      relaunch: vi.fn(async () => undefined),
    },
    desktopToast: {
      setIgnoreMouseEvents: vi.fn(async () => undefined),
    },
    invoke: vi.fn(async () => ({ ok: true })) as ElectronDesktopBridge['invoke'],
  };
}

afterEach(() => {
  delete window.dimoDesktop;
  vi.restoreAllMocks();
});

describe('DesktopShellBridge', () => {
  it('detects web and electron runtimes accurately', () => {
    expect(getDesktopShellKind()).toBe('web');
    expect(hasDesktopShell()).toBe(false);
    expect(hasAnyDesktopRuntime()).toBe(false);
    expect(getDesktopWindowLabel()).toBe('main');

    window.dimoDesktop = createMockElectronBridge();
    expect(getDesktopShellKind()).toBe('electron');
    expect(hasDesktopShell()).toBe(true);
    expect(hasAnyDesktopRuntime()).toBe(true);
    expect(getDesktopWindowLabel()).toBe('host-lab');
  });

  it('delegates all shell operations to window.dimoDesktop when running in Electron', async () => {
    const mock = createMockElectronBridge();
    window.dimoDesktop = mock;

    const shell = getDesktopShell();
    expect(shell.kind).toBe('electron');
    expect(await shell.getAppVersion()).toBe('2.0.0-electron');
    expect(shell.getWindowLabel()).toBe('host-lab');
    expect(await shell.window.getLabel()).toBe('host-lab');
    expect(await shell.window.isMaximized()).toBe(true);
    await shell.window.setTitle('Settings');
    expect(mock.window.setTitle).toHaveBeenCalledWith('Settings');
    await shell.window.setZoom(1.1);
    expect(mock.window.setZoom).toHaveBeenCalledWith(1.1);
    expect(await shell.dialog.open({ directory: true })).toBe(
      'C:/projects/demo'
    );
    expect(await shell.path.join('/a', 'b.md')).toBe('/a/b.md');
    expect(shell.assets.convertFileSrc('/tmp/a.html')).toBe(
      'dimo-asset://localhost//tmp/a.html'
    );
    await shell.desktopToast?.setIgnoreMouseEvents?.(false);
    expect(mock.desktopToast?.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    await shell.invoke('reveal_main_window');
    expect(mock.invoke).toHaveBeenCalledWith('reveal_main_window');
  });

  it('falls back to window.open when shell.openExternal throws', async () => {
    const mock = createMockElectronBridge();
    vi.mocked(mock.shell.openExternal).mockRejectedValueOnce(
      new Error('shell unavailable')
    );
    window.dimoDesktop = mock;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openExternalUrl('https://example.com');
    expect(mock.shell.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('returns the web fallback bridge outside Electron', async () => {
    const shell = getDesktopShell();
    expect(shell.kind).toBe('web');
    expect(await shell.getAppVersion()).toBe('0.0.0');
    expect(shell.assets.convertFileSrc('/docs/index.html')).toBe(
      '/docs/index.html'
    );
  });
});
