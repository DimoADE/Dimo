import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    on: vi.fn(),
    off: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  Tray: vi.fn(),
  nativeImage: {
    createFromPath: vi.fn(),
    createFromBitmap: vi.fn(),
  },
  screen: {
    getDisplayMatching: vi.fn(),
    getPrimaryDisplay: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

import {
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
  DesktopToastQueue,
  computeToastWindowPosition,
} from './desktopToast';
import { isDevToolsShortcut } from './windows';

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

    // Session activation URL routes to desktop-toast-activated.
    manager.handleProcessArgs(
      ['Dimo.exe', 'dimo://open?project=p1&workspace=w2&session=s3'],
      { isStartup: false }
    );
    expect(broadcastEvent).toHaveBeenLastCalledWith(
      DESKTOP_TOAST_ACTIVATED_EVENT,
      { projectId: 'p1', workspaceId: 'w2', sessionId: 's3' }
    );

    // Second-instance --new-window opens a new local window.
    manager.handleProcessArgs(['Dimo.exe', '--new-window'], {
      isStartup: false,
    });
    expect(openAppWindow).toHaveBeenCalledTimes(1);
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
});
