import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const menuPopupMock = vi.fn();
const createdWindows: Array<{
  options: Record<string, unknown>;
  emitter: EventEmitter;
  webContentsEmitter: EventEmitter;
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  reloadIgnoringCache: ReturnType<typeof vi.fn>;
  inspectElement: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('electron', () => {
  const BrowserWindowMock = vi.fn((options: Record<string, unknown>) => {
    const emitter = new EventEmitter();
    const webContentsEmitter = new EventEmitter();
    let destroyed = false;
    let visible = false;
    const setZoomFactor = vi.fn();
    const reload = vi.fn();
    const reloadIgnoringCache = vi.fn();
    const inspectElement = vi.fn();
    const openDevTools = vi.fn();
    const destroy = vi.fn(() => {
      if (!destroyed) {
        destroyed = true;
        emitter.emit('closed');
      }
    });
    const hide = vi.fn(() => {
      visible = false;
    });
    const show = vi.fn(() => {
      visible = true;
      emitter.emit('show');
    });
    const showInactive = vi.fn(() => {
      visible = true;
      emitter.emit('show');
    });
    const focus = vi.fn();
    const setBounds = vi.fn();
    const setIgnoreMouseEvents = vi.fn();
    const record = {
      options,
      emitter,
      webContentsEmitter,
      destroy,
      hide,
      show,
      showInactive,
      focus,
      setBounds,
      setIgnoreMouseEvents,
      setZoomFactor,
      reload,
      reloadIgnoringCache,
      inspectElement,
      openDevTools,
    };
    createdWindows.push(record);
    return {
      on: (ev: string, cb: (...args: unknown[]) => void) => emitter.on(ev, cb),
      once: (ev: string, cb: (...args: unknown[]) => void) => emitter.once(ev, cb),
      emit: (ev: string, ...args: unknown[]) => emitter.emit(ev, ...args),
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => false,
      isFocused: () => false,
      restore: vi.fn(),
      show,
      showInactive,
      hide,
      focus,
      destroy,
      setTitle: vi.fn(),
      getTitle: () => String(options.title ?? ''),
      setBounds,
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      setIgnoreMouseEvents,
      setVisibleOnAllWorkspaces: vi.fn(),
      setAppDetails: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      webContents: {
        id: createdWindows.length,
        on: (ev: string, cb: (...args: unknown[]) => void) =>
          webContentsEmitter.on(ev, cb),
        once: (ev: string, cb: (...args: unknown[]) => void) =>
          webContentsEmitter.once(ev, cb),
        send: vi.fn(),
        setZoomFactor,
        setWindowOpenHandler: vi.fn(),
        isDevToolsOpened: () => false,
        closeDevTools: vi.fn(),
        openDevTools,
        reload,
        reloadIgnoringCache,
        inspectElement,
        executeJavaScript: vi.fn().mockResolvedValue(undefined),
      },
    };
  });
  (BrowserWindowMock as unknown as Record<string, unknown>).getFocusedWindow =
    vi.fn(() => null);
  (BrowserWindowMock as unknown as Record<string, unknown>).fromWebContents =
    vi.fn(() => null);

  return {
    app: {
      isPackaged: false,
      name: 'Dimo',
      on: vi.fn(),
      off: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(),
    },
    BrowserWindow: BrowserWindowMock,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => ({
        template,
        popup: menuPopupMock,
      })),
      setApplicationMenu: vi.fn(),
    },
    Tray: vi.fn(),
    nativeImage: {
      createFromPath: vi.fn(() => ({ isEmpty: () => true })),
      createFromBitmap: vi.fn(),
    },
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    session: {
      fromPartition: vi.fn(() => ({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      })),
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

import {
  DEFAULT_APP_USER_MODEL_ID,
  DESKTOP_APP_ORIGIN,
  hostAppWindowLabel,
  hostSettingsWindowForApp,
  hostSettingsWindowLabel,
  hostWindowLabel,
  hostWindowTitle,
  isHostSettingsWindowLabel,
  isHostWindowLabel,
  isLocalDesktopWindowLabel,
  settingsWindowLabelForCaller,
} from '../shared/ipcContract';
import {
  DesktopChromeManager,
  buildMacOsMenuTemplate,
  createBadgeOverlayRgba,
  encodeSinglePngIco,
  resolveAppIconAssetPath,
} from './chrome';
import {
  isValidCrashReportFilename,
  writeFallbackCrashReport,
} from './crashReporter';
import {
  DeepLinkManager,
  MODEL_ROUTER_IMPORT_EVENT,
  extractDimoUrlsFromArgs,
  extractLaunchActionFromArgs,
  isDimoScheme,
  parseModelRouterImport,
  parseSessionActivation,
} from './deeplink';
import {
  DESKTOP_TOAST_ACTIVATED_EVENT,
  DesktopToastManager,
  DesktopToastQueue,
  computeToastWindowPosition,
} from './desktopToast';
import {
  DesktopUpdaterManager,
  type AutoUpdaterLike,
} from './updater';
import {
  WindowManager,
  evaluatePermissionRequest,
  isDevToolsShortcut,
  matchReloadShortcut,
} from './windows';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('host window label & title helpers', () => {
  it('mirrors Rust host_windows naming and isolation rules', () => {
    expect(hostWindowLabel('550e8400-e29b-41d4-a716-446655440000')).toBe(
      'host-550e8400-e29b-41d4-a716-446655440000'
    );
    expect(hostWindowLabel('a/b c')).toBe('host-a-b-c');
    expect(hostSettingsWindowLabel('abc')).toBe('settings-host-abc');
    expect(isHostWindowLabel('host-abc')).toBe(true);
    expect(isHostWindowLabel('host-')).toBe(false);
    expect(isHostWindowLabel('main')).toBe(false);
    expect(isHostSettingsWindowLabel('settings-host-abc')).toBe(true);
    expect(isHostSettingsWindowLabel('settings')).toBe(false);

    expect(hostAppWindowLabel('host-abc')).toBe('host-abc');
    expect(hostAppWindowLabel('settings-host-abc')).toBe('host-abc');
    expect(hostAppWindowLabel('main')).toBeNull();
    expect(hostSettingsWindowForApp('host-abc')).toBe('settings-host-abc');
    expect(hostSettingsWindowForApp('main')).toBeNull();

    expect(settingsWindowLabelForCaller('main')).toBe('settings');
    expect(settingsWindowLabelForCaller('host-abc')).toBe('settings-host-abc');
    expect(settingsWindowLabelForCaller('settings-host-abc')).toBe(
      'settings-host-abc'
    );

    expect(isLocalDesktopWindowLabel('main')).toBe(true);
    expect(isLocalDesktopWindowLabel('settings')).toBe(true);
    expect(isLocalDesktopWindowLabel('app-1')).toBe(true);
    expect(isLocalDesktopWindowLabel('desktop-toast')).toBe(false);
    expect(isLocalDesktopWindowLabel('host-abc')).toBe(false);
    expect(isLocalDesktopWindowLabel('settings-host-abc')).toBe(false);

    expect(hostWindowTitle('root@lab')).toBe('Dimo — root@lab');
    expect(hostWindowTitle('   ')).toBe('Dimo');
  });
});

describe('dimo:// deep links and launch args', () => {
  it('validates dimo schemes and parses model router import URLs', () => {
    expect(isDimoScheme('dimo:')).toBe(true);
    expect(isDimoScheme('dimo-dev')).toBe(true);
    expect(isDimoScheme('dimo-dev-feature:')).toBe(true);
    expect(isDimoScheme('https:')).toBe(false);

    expect(
      parseModelRouterImport(
        'dimo://modelrouter/import?ticket=tkt_123&agent=claude_code'
      )
    ).toEqual({ ticket: 'tkt_123', agentId: 'claude_code' });

    expect(
      parseModelRouterImport('dimo-dev://modelrouter?ticket=tkt_456')
    ).toEqual({ ticket: 'tkt_456', agentId: null });

    expect(
      parseModelRouterImport('dimo://import-modelrouter?ticket=tkt_789&agentId=codex')
    ).toEqual({ ticket: 'tkt_789', agentId: 'codex' });

    expect(
      parseModelRouterImport('dimo://modelrouter/import?agent=claude_code')
    ).toBeNull();
  });

  it('parses session activation URLs and extracts deep links / launch flags from argv', () => {
    expect(
      parseSessionActivation('dimo://open?project=p1&workspace=w1&session=s1')
    ).toEqual({ projectId: 'p1', workspaceId: 'w1', sessionId: 's1' });
    expect(
      parseSessionActivation('dimo://open?project=p1&workspace=w1')
    ).toBeNull();

    expect(
      extractDimoUrlsFromArgs([
        'Dimo.exe',
        '--flag',
        'dimo://open?project=p1&workspace=w1&session=s1',
        'https://example.com',
      ])
    ).toEqual(['dimo://open?project=p1&workspace=w1&session=s1']);

    expect(extractLaunchActionFromArgs(['Dimo.exe', '--new-window'])).toBe(
      'new-window'
    );
    expect(extractLaunchActionFromArgs(['Dimo.exe', '--open-settings'])).toBe(
      'open-settings'
    );
    expect(extractLaunchActionFromArgs(['Dimo.exe'])).toBeNull();
  });

  it('queues cold-start URLs, drains single-take model router imports, and routes session links', () => {
    const manager = new DeepLinkManager();
    const showMainWindow = vi.fn();
    const openSettingsWindow = vi.fn();
    const openAppWindow = vi.fn();
    const broadcastEvent = vi.fn();

    // Arrives before handlers are attached (macOS cold-start open-url).
    manager.handleUrl(
      'dimo://modelrouter/import?ticket=tkt_cold&agent=claude_code'
    );
    expect(manager.takePendingModelRouterImport()).toBeNull();

    manager.attachHandlers({
      showMainWindow,
      openSettingsWindow,
      openAppWindow,
      broadcastEvent,
    });

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(openSettingsWindow).toHaveBeenCalledWith('/settings/agents');
    expect(broadcastEvent).toHaveBeenCalledWith(MODEL_ROUTER_IMPORT_EVENT, {
      id: 1,
      ticket: 'tkt_cold',
      agentId: 'claude_code',
    });

    const taken = manager.takePendingModelRouterImport();
    expect(taken).toEqual({
      id: 1,
      ticket: 'tkt_cold',
      agentId: 'claude_code',
    });
    expect(manager.takePendingModelRouterImport()).toBeNull();

    // Session activation URL arriving before main window finishes loading is queued,
    // not broadcast into an unmounted renderer, and replays once markMainWindowReady() fires.
    manager.handleProcessArgs(
      ['Dimo.exe', 'dimo://open?project=p1&workspace=w2&session=s3'],
      { isStartup: false }
    );
    expect(broadcastEvent).not.toHaveBeenCalledWith(
      DESKTOP_TOAST_ACTIVATED_EVENT,
      expect.anything()
    );

    manager.markMainWindowReady();
    expect(broadcastEvent).toHaveBeenLastCalledWith(
      DESKTOP_TOAST_ACTIVATED_EVENT,
      { projectId: 'p1', workspaceId: 'w2', sessionId: 's3' }
    );

    // Subsequent warm-start session activation broadcasts immediately.
    manager.handleProcessArgs(
      ['Dimo.exe', 'dimo://open?project=p2&workspace=w3&session=s4'],
      { isStartup: false }
    );
    expect(broadcastEvent).toHaveBeenLastCalledWith(
      DESKTOP_TOAST_ACTIVATED_EVENT,
      { projectId: 'p2', workspaceId: 'w3', sessionId: 's4' }
    );

    // Second-instance --new-window opens a new local window.
    manager.handleProcessArgs(['Dimo.exe', '--new-window'], {
      isStartup: false,
    });
    expect(openAppWindow).toHaveBeenCalledTimes(1);
  });

  it('queues early second-instance launch actions before attachHandlers and supports single-take session activation', () => {
    const manager = new DeepLinkManager();
    const showMainWindow = vi.fn();
    const openSettingsWindow = vi.fn();
    const openAppWindow = vi.fn();
    const broadcastEvent = vi.fn();

    // Actions and session deep links arriving before handlers attach
    manager.handleProcessArgs(['Dimo.exe', '--open-settings'], { isStartup: false });
    manager.handleProcessArgs(['Dimo.exe', '--new-window'], { isStartup: false });
    manager.handleProcessArgs(['Dimo.exe'], { isStartup: false });
    manager.handleUrl('dimo://open?project=p9&workspace=w9&session=s9');

    manager.attachHandlers({
      showMainWindow,
      openSettingsWindow,
      openAppWindow,
      broadcastEvent,
    });

    expect(openSettingsWindow).toHaveBeenCalledTimes(1);
    expect(openAppWindow).toHaveBeenCalledTimes(1);
    expect(showMainWindow).toHaveBeenCalledTimes(2); // once for focus, once for URL

    // Renderer can explicitly consume pending session activation before did-finish-load
    expect(manager.takePendingSessionActivation()).toEqual({
      projectId: 'p9',
      workspaceId: 'w9',
      sessionId: 's9',
    });
    expect(manager.takePendingSessionActivation()).toBeNull();

    // markMainWindowReady() does not double-broadcast already-consumed activation
    manager.markMainWindowReady();
    expect(broadcastEvent).not.toHaveBeenCalledWith(
      DESKTOP_TOAST_ACTIVATED_EVENT,
      expect.anything()
    );
  });
});

describe('floating desktop toast layout & queue', () => {
  it('anchors toast bottom-right with margin on primary and offset displays', () => {
    expect(
      computeToastWindowPosition({ x: 0, y: 0, width: 1920, height: 1080 })
    ).toEqual({ x: 1448, y: 544 });

    expect(
      computeToastWindowPosition({ x: 1920, y: 40, width: 1512, height: 942 })
    ).toEqual({ x: 2960, y: 446 });
  });

  it('queues payloads until desktop_toast_window_ready drains them', () => {
    const queue = new DesktopToastQueue();
    const payload = {
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
      title: 'Done',
      description: 'Task completed',
      kind: 'success',
      durationMs: 5000,
    };

    expect(queue.enqueueOrDeliver(payload)).toBe(false);
    expect(queue.pendingCount()).toBe(1);

    const drained = queue.markReady();
    expect(drained).toEqual([payload]);
    expect(queue.isReady()).toBe(true);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.enqueueOrDeliver(payload)).toBe(true);
  });

  it('creates focusable toast window with forwarded mouse pass-through and IPC toggle', () => {
    createdWindows.length = 0;
    const windows = new WindowManager({ preloadPath: '/preload.js' });
    const toast = new DesktopToastManager({
      preloadPath: '/preload.js',
      windows,
      platform: 'win32',
    });

    toast.show({
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
      title: 'Alert',
      description: 'Reply inline',
      kind: 'success',
      durationMs: 4000,
    });

    expect(createdWindows).toHaveLength(1);
    const toastRecord = createdWindows[0];
    expect(toastRecord.options.focusable).toBe(true);
    expect(toastRecord.showInactive).toHaveBeenCalledTimes(1);
    expect(toastRecord.setIgnoreMouseEvents).toHaveBeenCalledWith(true, {
      forward: true,
    });

    toast.setIgnoreMouseEvents(false);
    expect(toastRecord.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, {
      forward: true,
    });

    toast.hide();
    expect(toastRecord.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
      forward: true,
    });
    expect(toastRecord.hide).toHaveBeenCalledTimes(1);
    toast.destroy();
  });

  it('keeps mouse events enabled and resizes toast overlay height on Linux', () => {
    createdWindows.length = 0;
    const windows = new WindowManager({ preloadPath: '/preload.js' });
    const toast = new DesktopToastManager({
      preloadPath: '/preload.js',
      windows,
      platform: 'linux',
    });

    toast.show({
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
      title: 'Alert',
      description: 'Linux overlay',
      kind: 'info',
      durationMs: 4000,
    });

    expect(createdWindows).toHaveLength(1);
    const toastRecord = createdWindows[0];
    expect(toastRecord.setIgnoreMouseEvents).not.toHaveBeenCalled();

    toast.setIgnoreMouseEvents(false);
    expect(toastRecord.setIgnoreMouseEvents).not.toHaveBeenCalled();

    toast.setContentHeight(220);
    expect(toastRecord.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 220 })
    );

    toast.hide();
    expect(toastRecord.setIgnoreMouseEvents).not.toHaveBeenCalled();
    expect(toastRecord.hide).toHaveBeenCalledTimes(1);
    toast.destroy();
  });
});

describe('developer mode shortcut matcher', () => {
  it('matches F12 and platform inspect chords while ignoring repeats and keyUp', () => {
    const base = {
      type: 'keyDown',
      key: 'F12',
      code: 'F12',
      control: false,
      shift: false,
      alt: false,
      meta: false,
      isAutoRepeat: false,
    };

    expect(isDevToolsShortcut(base, 'win32')).toBe(true);
    expect(isDevToolsShortcut({ ...base, isAutoRepeat: true }, 'win32')).toBe(
      false
    );
    expect(isDevToolsShortcut({ ...base, type: 'keyUp' }, 'win32')).toBe(false);

    expect(
      isDevToolsShortcut(
        { ...base, key: 'I', code: 'KeyI', control: true, shift: true },
        'win32'
      )
    ).toBe(true);
    expect(
      isDevToolsShortcut(
        { ...base, key: 'I', code: 'KeyI', meta: true, alt: true },
        'darwin'
      )
    ).toBe(true);
    expect(
      isDevToolsShortcut(
        { ...base, key: 'I', code: 'KeyI', control: true, shift: true },
        'darwin'
      )
    ).toBe(false);
  });
});

describe('desktop chrome assets, badge bitmap, and crash fallback', () => {
  it('resolves all 4 app icon PNG assets from the repository', () => {
    for (const style of ['default', 'lite']) {
      for (const theme of ['light', 'dark']) {
        const assetPath = resolveAppIconAssetPath({
          style,
          theme,
          repoRoot: REPO_ROOT,
        });
        expect(assetPath).toBeTruthy();
        expect(fs.existsSync(assetPath!)).toBe(true);
      }
    }
  });

  it('generates a non-empty 16x16 RGBA badge overlay bitmap', () => {
    const buf = createBadgeOverlayRgba(5, 16);
    expect(buf.length).toBe(16 * 16 * 4);
    // Center region should contain visible white/red pixels.
    let opaquePixels = 0;
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] === 255) {
        opaquePixels += 1;
      }
    }
    expect(opaquePixels).toBeGreaterThan(100);
  });

  it('writes fallback shell crash reports and prunes to the newest 20 files', () => {
    const dataDir = makeTempDir('dimo-crash-test-');
    expect(isValidCrashReportFilename('crash-1751900000000.txt')).toBe(true);
    expect(isValidCrashReportFilename('notes.txt')).toBe(false);

    for (let i = 0; i < 23; i += 1) {
      writeFallbackCrashReport({
        dataDir,
        source: 'electron-main:test',
        message: `crash #${i}`,
        stack: 'at stack:1',
        appVersion: '0.5.2-test',
        nowMs: 1_751_900_000_000 + i,
      });
    }

    const files = fs
      .readdirSync(path.join(dataDir, 'crashes'))
      .filter(isValidCrashReportFilename)
      .sort();
    expect(files.length).toBe(20);
    expect(files[0]).toBe('crash-1751900000003.txt');
    expect(files[files.length - 1]).toBe('crash-1751900000022.txt');
  });

  it('encodes a single-PNG Windows ICO container with a valid 22-byte header', () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ico = encodeSinglePngIco(fakePng);
    expect(ico.length).toBe(22 + fakePng.length);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type = ICO
    expect(ico.readUInt16LE(4)).toBe(1); // count = 1
    expect(ico.readUInt8(6)).toBe(0); // width = 256
    expect(ico.readUInt8(7)).toBe(0); // height = 256
    expect(ico.readUInt16LE(10)).toBe(1); // color planes
    expect(ico.readUInt16LE(12)).toBe(32); // bpp
    expect(ico.readUInt32LE(14)).toBe(fakePng.length); // bytes in res
    expect(ico.readUInt32LE(18)).toBe(22); // offset
    expect(ico.subarray(22).equals(fakePng)).toBe(true);
  });

  it('builds complete macOS menus without duplicate Close and clears app menu on non-macOS', async () => {
    const onOpenSettings = vi.fn();
    const template = buildMacOsMenuTemplate({
      appName: 'Dimo',
      onNewWindow: vi.fn(),
      onOpenSettings,
      onExitRequested: vi.fn(),
    });

    const appSubmenu = template[0].submenu as Array<Record<string, unknown>>;
    const settingsItem = appSubmenu.find((item) => item.accelerator === 'CmdOrCtrl+,');
    expect(settingsItem).toBeDefined();
    (settingsItem!.click as () => void)();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    const editSubmenu = template[2].submenu as Array<Record<string, unknown>>;
    expect(editSubmenu.some((item) => item.role === 'pasteAndMatchStyle')).toBe(true);
    expect(editSubmenu.some((item) => item.role === 'delete')).toBe(true);

    const windowSubmenu = template[4].submenu as Array<Record<string, unknown>>;
    expect(windowSubmenu.some((item) => item.role === 'front')).toBe(true);
    expect(windowSubmenu.some((item) => item.role === 'close')).toBe(false);

    if (process.platform !== 'darwin') {
      const { Menu } = await import('electron');
      vi.mocked(Menu.setApplicationMenu).mockClear();
      const windows = new WindowManager({ preloadPath: '/preload.js' });
      const chrome = new DesktopChromeManager({
        windows,
        onExitRequested: async () => undefined,
      });
      chrome.install();
      expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    }
  });
});

describe('WindowManager remediation behaviors (hidden settings exit, zoom sync, spellcheck, permissions)', () => {
  it('destroys hidden local settings window when main closes without tray and syncs zoom across windows', () => {
    createdWindows.length = 0;
    const onMainWindowLoaded = vi.fn();
    const onMainWindowClosed = vi.fn();
    const onMainWindowClosedWithoutTray = vi.fn();
    const manager = new WindowManager({
      preloadPath: '/preload.js',
      appUserModelId: DEFAULT_APP_USER_MODEL_ID,
      onMainWindowLoaded,
      onMainWindowClosed,
      onMainWindowClosedWithoutTray,
    });
    manager.setTrayEnabled(false);

    const mainWin = manager.createMainWindow();
    const mainRecord = createdWindows[0];
    expect(
      (mainRecord.options.webPreferences as Record<string, unknown>).spellcheck
    ).toBe(true);

    mainRecord.webContentsEmitter.emit('did-finish-load');
    expect(onMainWindowLoaded).toHaveBeenCalledTimes(1);

    // Open settings and hide it via close event (hideOnClose: 'always')
    manager.openSettingsWindow('main');
    const settingsRecord = createdWindows[1];
    const closeEv = { preventDefault: vi.fn() };
    settingsRecord.emitter.emit('close', closeEv);
    expect(closeEv.preventDefault).toHaveBeenCalledTimes(1);
    expect(settingsRecord.hide).toHaveBeenCalledTimes(1);

    // Sync zoom across all open windows and apply to newly opened windows
    manager.setZoomFactor(1.25);
    expect(mainRecord.setZoomFactor).toHaveBeenCalledWith(1.25);
    expect(settingsRecord.setZoomFactor).toHaveBeenCalledWith(1.25);

    manager.openAppWindow();
    const appRecord = createdWindows[2];
    expect(appRecord.setZoomFactor).toHaveBeenCalledWith(1.25);

    // Closing main when tray is disabled destroys hidden settings and triggers callback
    mainWin.destroy();
    expect(onMainWindowClosed).toHaveBeenCalledTimes(1);
    expect(settingsRecord.destroy).toHaveBeenCalledTimes(1);
    expect(onMainWindowClosedWithoutTray).toHaveBeenCalledTimes(1);
  });

  it('restricts session permission requests to safe app-origin permissions and denies webviews', () => {
    expect(
      evaluatePermissionRequest({
        origin: `${DESKTOP_APP_ORIGIN}/settings`,
        allowedAppOrigin: DESKTOP_APP_ORIGIN,
        permission: 'clipboard-read',
      })
    ).toBe(true);
    expect(
      evaluatePermissionRequest({
        origin: `${DESKTOP_APP_ORIGIN}/settings`,
        allowedAppOrigin: DESKTOP_APP_ORIGIN,
        permission: 'geolocation',
      })
    ).toBe(false);
    expect(
      evaluatePermissionRequest({
        origin: 'https://evil.example/phish',
        allowedAppOrigin: DESKTOP_APP_ORIGIN,
        permission: 'notifications',
      })
    ).toBe(false);
    expect(
      evaluatePermissionRequest({
        origin: `${DESKTOP_APP_ORIGIN}/page`,
        allowedAppOrigin: DESKTOP_APP_ORIGIN,
        permission: 'media',
        isWebview: true,
      })
    ).toBe(false);
  });

  it('prewarms local settings window silently and promotes it immediately once painted', () => {
    createdWindows.length = 0;
    const manager = new WindowManager({ preloadPath: '/preload.js' });
    manager.setTrayEnabled(false);

    // Prewarm is a no-op before main window exists
    expect(manager.prewarmSettingsWindow()).toBeUndefined();
    expect(createdWindows).toHaveLength(0);

    const mainWin = manager.createMainWindow();
    const prewarmed = manager.prewarmSettingsWindow();
    expect(prewarmed).toBeDefined();
    expect(createdWindows).toHaveLength(2);
    const settingsRecord = createdWindows[1];

    // Renderer calls showWindow / focusWindow during silent boot -> suppressed
    manager.showWindow(prewarmed!);
    manager.focusWindow(prewarmed!);
    expect(settingsRecord.show).not.toHaveBeenCalled();
    expect(settingsRecord.focus).not.toHaveBeenCalled();

    // User opens Settings -> reused, navigated, shown, and focused immediately without creating a new window
    const opened = manager.openSettingsWindow('main', { path: '/settings/agents' });
    expect(opened).toBe(prewarmed);
    expect(createdWindows).toHaveLength(2);
    expect(settingsRecord.show).toHaveBeenCalledTimes(1);
    expect(settingsRecord.focus).toHaveBeenCalledTimes(1);

    // Closing main without tray still cleans up settings window
    mainWin.destroy();
    expect(settingsRecord.destroy).toHaveBeenCalledTimes(1);
  });

  it('defers showing an in-flight prewarmed settings window until renderer paint signals showWindow', () => {
    createdWindows.length = 0;
    const manager = new WindowManager({ preloadPath: '/preload.js' });
    manager.createMainWindow();

    const prewarmed = manager.prewarmSettingsWindow();
    const settingsRecord = createdWindows[1];
    expect(prewarmed).toBeDefined();

    // User opens Settings before renderer finishes initial paint
    const opened = manager.openSettingsWindow('main', { path: '/settings/mcp' });
    expect(opened).toBe(prewarmed);
    expect(settingsRecord.show).not.toHaveBeenCalled();

    // Once renderer finishes load and triggers showWindow/focusWindow, it shows normally
    settingsRecord.webContentsEmitter.emit('did-finish-load');
    manager.showWindow(prewarmed!);
    manager.focusWindow(prewarmed!);
    expect(settingsRecord.show).toHaveBeenCalledTimes(1);
    expect(settingsRecord.focus).toHaveBeenCalledTimes(1);
  });

  it('matches reload and force-reload shortcuts without hijacking plain Ctrl+R on Windows/Linux', () => {
    const base = {
      type: 'keyDown' as const,
      control: false,
      shift: false,
      alt: false,
      meta: false,
      isAutoRepeat: false,
    };

    expect(matchReloadShortcut({ ...base, key: 'F5', code: 'F5' }, 'win32')).toBe(
      'reload'
    );
    expect(
      matchReloadShortcut({ ...base, key: 'F5', code: 'F5', control: true }, 'win32')
    ).toBe('force-reload');
    expect(
      matchReloadShortcut({ ...base, key: 'F5', code: 'F5', shift: true }, 'linux')
    ).toBe('force-reload');
    expect(
      matchReloadShortcut(
        { ...base, key: 'R', code: 'KeyR', control: true, shift: true },
        'win32'
      )
    ).toBe('force-reload');
    expect(
      matchReloadShortcut({ ...base, key: 'r', code: 'KeyR', control: true }, 'win32')
    ).toBeNull();
    expect(
      matchReloadShortcut({ ...base, key: 'r', code: 'KeyR', meta: true }, 'darwin')
    ).toBe('reload');
    expect(
      matchReloadShortcut(
        { ...base, key: 'R', code: 'KeyR', meta: true, shift: true },
        'darwin'
      )
    ).toBe('force-reload');
  });

  it('enables reload shortcuts, DevTools, and fallback context menu in Dev desktop sessions', async () => {
    createdWindows.length = 0;
    menuPopupMock.mockClear();
    const { Menu } = await import('electron');
    vi.mocked(Menu.buildFromTemplate).mockClear();

    const manager = new WindowManager({
      preloadPath: '/preload.js',
      devUrl: 'http://127.0.0.1:5173',
      platform: 'win32',
    });
    expect(manager.isDevSession()).toBe(true);
    expect(manager.isDeveloperContextEnabled()).toBe(true);

    manager.createMainWindow();
    const mainRecord = createdWindows[0];

    const f5Event = { preventDefault: vi.fn() };
    mainRecord.webContentsEmitter.emit('before-input-event', f5Event, {
      type: 'keyDown',
      key: 'F5',
      code: 'F5',
      control: false,
      shift: false,
      alt: false,
      meta: false,
      isAutoRepeat: false,
    });
    expect(f5Event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainRecord.reload).toHaveBeenCalledTimes(1);

    const forceReloadEvent = { preventDefault: vi.fn() };
    mainRecord.webContentsEmitter.emit('before-input-event', forceReloadEvent, {
      type: 'keyDown',
      key: 'R',
      code: 'KeyR',
      control: true,
      shift: true,
      alt: false,
      meta: false,
      isAutoRepeat: false,
    });
    expect(forceReloadEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainRecord.reloadIgnoringCache).toHaveBeenCalledTimes(1);

    const devToolsEvent = { preventDefault: vi.fn() };
    mainRecord.webContentsEmitter.emit('before-input-event', devToolsEvent, {
      type: 'keyDown',
      key: 'F12',
      code: 'F12',
      control: false,
      shift: false,
      alt: false,
      meta: false,
      isAutoRepeat: false,
    });
    expect(devToolsEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainRecord.openDevTools).toHaveBeenCalledTimes(1);

    mainRecord.webContentsEmitter.emit('context-menu', {}, { x: 42, y: 84 });
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menuPopupMock).toHaveBeenCalledTimes(1);
  });

  it('keeps reload shortcuts and fallback context menu disabled in production when developer mode is off', async () => {
    createdWindows.length = 0;
    menuPopupMock.mockClear();
    const { Menu } = await import('electron');
    vi.mocked(Menu.buildFromTemplate).mockClear();

    const manager = new WindowManager({
      preloadPath: '/preload.js',
      platform: 'win32',
    });
    expect(manager.isDevSession()).toBe(false);
    expect(manager.isDeveloperContextEnabled()).toBe(false);

    manager.createMainWindow();
    const mainRecord = createdWindows[0];

    const f5Event = { preventDefault: vi.fn() };
    mainRecord.webContentsEmitter.emit('before-input-event', f5Event, {
      type: 'keyDown',
      key: 'F5',
      code: 'F5',
      control: false,
      shift: false,
      alt: false,
      meta: false,
      isAutoRepeat: false,
    });
    expect(f5Event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainRecord.reload).not.toHaveBeenCalled();

    mainRecord.webContentsEmitter.emit('context-menu', {}, { x: 10, y: 20 });
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(menuPopupMock).not.toHaveBeenCalled();

    manager.applyDeveloperMode(true);
    expect(manager.isDeveloperContextEnabled()).toBe(true);
    mainRecord.webContentsEmitter.emit('context-menu', {}, { x: 10, y: 20 });
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menuPopupMock).toHaveBeenCalledTimes(1);
  });
});

describe('DesktopUpdaterManager P0-8 safeguards', () => {
  function createFakeAutoUpdater(): AutoUpdaterLike & EventEmitter {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: false,
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    });
  }

  it('attaches an error listener, swallows late timeout rejections, pre-feeds Squirrel on darwin, and defers install', async () => {
    const fake = createFakeAutoUpdater();
    let rejectLateCheck: ((err: Error) => void) | undefined;
    vi.mocked(fake.checkForUpdates).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLateCheck = reject;
        })
    );

    const callOrder: string[] = [];
    const manager = new DesktopUpdaterManager({
      currentVersion: '0.5.2',
      isPackaged: () => true,
      platform: 'darwin',
      deferInstall: true,
      loadAutoUpdater: () => fake,
      beforeQuitForUpdate: async () => {
        callOrder.push('beforeQuit');
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    // Timeout rejects cleanly and a subsequent late rejection from checkForUpdates does not crash
    await expect(manager.check({ timeout: 20 })).rejects.toThrow(/timed out/i);
    rejectLateCheck?.(new Error('late network error'));
    await new Promise((r) => setTimeout(r, 15));

    // Emitting 'error' on autoUpdater does not throw unhandled EventEmitter error
    expect(() => fake.emit('error', new Error('Squirrel feed error'))).not.toThrow();

    // Check + download on darwin enables autoInstallOnAppQuit for Squirrel.Mac pre-feed
    vi.mocked(fake.checkForUpdates).mockResolvedValueOnce({
      updateInfo: { version: '0.6.0' },
    });
    vi.mocked(fake.downloadUpdate).mockImplementationOnce(async () => {
      fake.emit('update-downloaded', { version: '0.6.0' });
      return ['/tmp/update.zip'];
    });
    vi.mocked(fake.quitAndInstall).mockImplementationOnce(() => {
      callOrder.push('quitAndInstall');
    });

    const checkRes = await manager.check();
    expect(checkRes?.version).toBe('0.6.0');
    await manager.download(checkRes!.token, () => undefined);
    expect(fake.autoInstallOnAppQuit).toBe(true);

    // Deferred install resolves IPC before running beforeQuitForUpdate + quitAndInstall
    await manager.install(checkRes!.token);
    expect(manager.isInstalling()).toBe(true);
    expect(callOrder).toEqual([]);

    await new Promise((r) => setTimeout(r, 20));
    expect(callOrder).toEqual(['beforeQuit', 'quitAndInstall']);
  });
});
