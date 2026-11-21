import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    })),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

import {
  DIMO_PICK_CONSOLE_PREFIX,
  buildInjectedScriptWithPickerShim,
  deviceMetricsForPreset,
  serializeEvalResult,
} from './cdp';
import {
  BrowserRpcError,
  ElectronBrowserController,
  isAllowedBrowserUrl,
  isAllowedWebviewPartition,
  normalizeConsoleLevel,
  partitionForProfile,
  resolveUniqueDownloadPath,
} from './controller';

describe('Electron browser M4 helpers', () => {
  it('maps profiles to isolated persistent and ephemeral webview partitions', () => {
    expect(partitionForProfile('default')).toBe('persist:dimo-browser-default');
    expect(partitionForProfile('Work Profile #1')).toBe(
      'persist:dimo-browser-work-profile-1'
    );
    expect(partitionForProfile('ephemeral', 'tab-abc')).toBe(
      'dimo-browser-ephemeral-tab-abc'
    );
  });

  it('strictly validates webview partitions and browser URLs', () => {
    expect(isAllowedWebviewPartition('persist:dimo-browser-default')).toBe(true);
    expect(isAllowedWebviewPartition('dimo-browser-ephemeral-tab-1')).toBe(true);
    expect(isAllowedWebviewPartition('persist:host-remote-1')).toBe(false);
    expect(isAllowedWebviewPartition('persist:dimo-browser-')).toBe(false);
    expect(isAllowedWebviewPartition('')).toBe(false);

    expect(isAllowedBrowserUrl('https://example.com/path?a=1')).toBe(true);
    expect(isAllowedBrowserUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedBrowserUrl('about:blank')).toBe(true);
    expect(isAllowedBrowserUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedBrowserUrl('dimo-app://localhost/')).toBe(false);
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false);
  });

  it('maps device presets and normalizes console levels', () => {
    expect(deviceMetricsForPreset('desktop')).toBeNull();
    expect(deviceMetricsForPreset('phone')).toMatchObject({
      width: 390,
      height: 844,
      mobile: true,
    });
    expect(deviceMetricsForPreset('tablet')).toMatchObject({
      width: 820,
      height: 1180,
      mobile: true,
    });

    expect(normalizeConsoleLevel(0)).toBe('debug');
    expect(normalizeConsoleLevel(1)).toBe('info');
    expect(normalizeConsoleLevel(2)).toBe('warn');
    expect(normalizeConsoleLevel(3)).toBe('error');
    expect(normalizeConsoleLevel('warning')).toBe('warn');
    expect(normalizeConsoleLevel('error')).toBe('error');
  });

  it('serializes eval results cleanly and builds picker shim', () => {
    expect(serializeEvalResult('{"ok":true}')).toBe('{"ok":true}');
    expect(serializeEvalResult('absent')).toBe('absent');
    expect(serializeEvalResult(undefined)).toBe('null');
    expect(serializeEvalResult(['a', 'b'])).toBe('["a","b"]');
    expect(serializeEvalResult(42)).toBe('42');

    const injected = buildInjectedScriptWithPickerShim('window.__test = 1;');
    expect(injected).toContain('__dimoPickQueue');
    expect(injected).toContain('__codegSend');
    expect(injected).toContain(DIMO_PICK_CONSOLE_PREFIX);
    expect(injected).toContain('window.__test = 1;');
  });

  it('enforces will-attach-webview security policy', () => {
    const controller = new ElectronBrowserController({ onEvent: () => {} });
    let webContentsCreatedHandler:
      | ((event: unknown, contents: unknown) => void)
      | undefined;

    const fakeApp = {
      on: vi.fn((event: string, cb: (ev: unknown, c: unknown) => void) => {
        if (event === 'web-contents-created') {
          webContentsCreatedHandler = cb;
        }
      }),
    };
    controller.installWebviewSecurity(fakeApp as unknown as Electron.App);
    expect(webContentsCreatedHandler).toBeDefined();

    let willAttachHandler:
      | ((
          ev: { preventDefault: () => void },
          prefs: Record<string, unknown>,
          params: Record<string, unknown>
        ) => void)
      | undefined;
    webContentsCreatedHandler!(
      {},
      {
        on: (ev: string, cb: typeof willAttachHandler) => {
          if (ev === 'will-attach-webview') willAttachHandler = cb;
        },
      }
    );
    expect(willAttachHandler).toBeDefined();

    // Allowed partition & URL: strips preload and enforces sandbox
    const allowedEvent = { preventDefault: vi.fn() };
    const prefs: Record<string, unknown> = {
      preload: '/evil.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    };
    willAttachHandler!(allowedEvent, prefs, {
      partition: 'persist:dimo-browser-default',
      src: 'https://example.com',
    });
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
    expect(prefs.preload).toBeUndefined();
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);

    // Disallowed partition: prevented
    const badPartitionEvent = { preventDefault: vi.fn() };
    willAttachHandler!(
      badPartitionEvent,
      {},
      { partition: 'persist:host-123', src: 'https://example.com' }
    );
    expect(badPartitionEvent.preventDefault).toHaveBeenCalledOnce();

    // Disallowed URL: prevented
    const badUrlEvent = { preventDefault: vi.fn() };
    willAttachHandler!(
      badUrlEvent,
      {},
      { partition: 'persist:dimo-browser-default', src: 'file:///C:/secret.txt' }
    );
    expect(badUrlEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('manages tab lifecycle RPCs and rejects invalid URLs or missing tabs', async () => {
    const controller = new ElectronBrowserController({ onEvent: () => {} });

    await expect(
      controller.handleRpc('open', {
        tabId: 'tab-1',
        url: 'file:///etc/passwd',
        profileId: 'default',
      })
    ).rejects.toMatchObject({ code: 'browser_bad_address' });

    await controller.handleRpc('open', {
      tabId: 'tab-1',
      url: 'https://example.com',
      profileId: 'default',
    });

    expect(
      await controller.handleRpc('current_url', { tabId: 'tab-1' })
    ).toBe('https://example.com');

    await controller.handleRpc('set_bounds', {
      tabId: 'tab-1',
      bounds: { width: 1024, height: 768 },
    });

    await controller.handleRpc('close', { tabId: 'tab-1' });

    await expect(
      controller.handleRpc('current_url', { tabId: 'tab-1' })
    ).rejects.toBeInstanceOf(BrowserRpcError);
  });

  it('blocks disallowed schemes in will-navigate and will-redirect on attached webviews', async () => {
    const events: Array<Record<string, unknown>> = [];
    const controller = new ElectronBrowserController({
      onEvent: (ev) => events.push(ev),
    });

    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fakeWc = {
      id: 99,
      isDestroyed: () => false,
      getURL: () => 'https://example.com',
      getTitle: () => 'Example',
      isLoading: () => false,
      session: { on: vi.fn() },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners.set(event, cb);
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };

    const { webContents } = await import('electron');
    vi.mocked(webContents.fromId).mockReturnValueOnce(
      fakeWc as unknown as Electron.WebContents
    );

    await controller.handleRpc('open', {
      tabId: 'tab-nav-guard',
      url: 'https://example.com',
      profileId: 'default',
    });
    expect(
      controller.attachWebContents({
        tabId: 'tab-nav-guard',
        webContentsId: 99,
      })
    ).toEqual({ ok: true });

    // Initial state sync emitted immediately on attach
    expect(events.some((e) => e.kind === 'tab.state')).toBe(true);

    const willNavigate = listeners.get('will-navigate');
    const willRedirect = listeners.get('will-redirect');
    expect(willNavigate).toBeDefined();
    expect(willRedirect).toBeDefined();

    // Allowed URL passes through
    const allowedEv = { preventDefault: vi.fn() };
    willNavigate!(allowedEv, 'https://example.com/next');
    expect(allowedEv.preventDefault).not.toHaveBeenCalled();

    // Disallowed file:// URL is blocked in will-navigate
    const blockedEv = { preventDefault: vi.fn() };
    willNavigate!(blockedEv, 'file:///etc/passwd');
    expect(blockedEv.preventDefault).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      kind: 'navigation.blocked',
      tabId: 'tab-nav-guard',
      url: 'file:///etc/passwd',
    });

    // Disallowed scheme in will-redirect is also blocked
    const redirectEv = { preventDefault: vi.fn() };
    willRedirect!(redirectEv, 'dimo-app://localhost/secret');
    expect(redirectEv.preventDefault).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      kind: 'navigation.blocked',
      tabId: 'tab-nav-guard',
      url: 'dimo-app://localhost/secret',
    });
  });

  it('preserves POST navigations and intercepts redirects via session.webRequest.onBeforeRequest', async () => {
    const events: Array<Record<string, unknown>> = [];
    const checkNavigation = vi.fn(async (url: string) => {
      if (url.includes('blocked.test')) {
        return { allowed: false, preferSystem: false };
      }
      if (url.includes('system.test')) {
        return { allowed: true, preferSystem: true };
      }
      return { allowed: true, preferSystem: false };
    });

    const controller = new ElectronBrowserController({
      onEvent: (ev) => events.push(ev),
      checkNavigation,
    });

    let beforeRequestHandler:
      | ((
          details: { url: string; webContentsId?: number },
          cb: (response: { cancel?: boolean }) => void
        ) => void)
      | undefined;
    let permissionRequestHandler:
      | ((wc: unknown, permission: string, cb: (allowed: boolean) => void) => void)
      | undefined;
    let permissionCheckHandler: (() => boolean) | undefined;

    const listeners = new Map<string, (...args: unknown[]) => void>();
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const fakeSession = {
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn((fn) => {
        permissionRequestHandler = fn;
      }),
      setPermissionCheckHandler: vi.fn((fn) => {
        permissionCheckHandler = fn;
      }),
      webRequest: {
        onBeforeRequest: vi.fn((_filter, handler) => {
          beforeRequestHandler = handler;
        }),
      },
    };
    const fakeWc = {
      id: 101,
      isDestroyed: () => false,
      getURL: () => 'https://example.com',
      getTitle: () => 'Example',
      isLoading: () => false,
      loadURL,
      session: fakeSession,
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners.set(event, cb);
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };

    const { webContents, shell } = await import('electron');
    vi.mocked(webContents.fromId).mockReturnValueOnce(
      fakeWc as unknown as Electron.WebContents
    );

    await controller.handleRpc('open', {
      tabId: 'tab-post-safe',
      url: 'https://example.com',
      profileId: 'default',
    });
    controller.attachWebContents({ tabId: 'tab-post-safe', webContentsId: 101 });

    // Permission handlers deny untrusted Host Browser webview requests
    expect(permissionCheckHandler?.()).toBe(false);
    const permCb = vi.fn();
    permissionRequestHandler?.(fakeWc, 'media', permCb);
    expect(permCb).toHaveBeenCalledWith(false);

    // will-navigate does NOT preventDefault or replay via GET loadURL for http(s)
    const postNavEvent = { preventDefault: vi.fn() };
    listeners.get('will-navigate')!(postNavEvent, 'https://example.com/submit');
    expect(postNavEvent.preventDefault).not.toHaveBeenCalled();
    expect(loadURL).not.toHaveBeenCalled();

    // webRequest.onBeforeRequest allows normal URL without cancelling
    expect(beforeRequestHandler).toBeDefined();
    const allowRes = await new Promise<{ cancel?: boolean }>((resolve) => {
      beforeRequestHandler!(
        { url: 'https://example.com/submit', webContentsId: 101 },
        resolve
      );
    });
    expect(allowRes).toEqual({ cancel: false });

    // webRequest.onBeforeRequest cancels blocked URL (including 3xx redirect targets)
    const blockRes = await new Promise<{ cancel?: boolean }>((resolve) => {
      beforeRequestHandler!(
        { url: 'https://blocked.test/landing', webContentsId: 101 },
        resolve
      );
    });
    expect(blockRes).toEqual({ cancel: true });
    expect(events).toContainEqual({
      kind: 'navigation.blocked',
      tabId: 'tab-post-safe',
      url: 'https://blocked.test/landing',
    });

    // webRequest.onBeforeRequest hands preferSystem URLs off to shell.openExternal
    const sysRes = await new Promise<{ cancel?: boolean }>((resolve) => {
      beforeRequestHandler!(
        { url: 'https://system.test/oauth', webContentsId: 101 },
        resolve
      );
    });
    expect(sysRes).toEqual({ cancel: true });
    expect(shell.openExternal).toHaveBeenCalledWith('https://system.test/oauth');
  });

  it('deduplicates colliding download filenames cleanly without overwriting existing files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-dl-'));
    try {
      // Pure helper deduplication + path traversal stripping
      fs.writeFileSync(path.join(dir, 'report.pdf'), 'existing', 'utf8');
      const reserved = new Set<string>([path.join(dir, 'report (1).pdf')]);
      const resolved = resolveUniqueDownloadPath(dir, '../../report.pdf', reserved);
      expect(resolved.filename).toBe('report (2).pdf');
      expect(resolved.savePath).toBe(path.join(dir, 'report (2).pdf'));

      // Live session will-download hook deduplicates simultaneous in-flight downloads
      const events: Array<Record<string, unknown>> = [];
      const controller = new ElectronBrowserController({
        onEvent: (ev) => events.push(ev),
        getDownloadsDir: () => dir,
      });

      let willDownloadHandler:
        | ((ev: unknown, item: unknown, wc: unknown) => void)
        | undefined;
      const fakeSession = {
        on: vi.fn((event: string, cb: (ev: unknown, item: unknown, wc: unknown) => void) => {
          if (event === 'will-download') {
            willDownloadHandler = cb;
          }
        }),
      };
      const fakeWc = {
        id: 202,
        isDestroyed: () => false,
        getURL: () => 'https://example.com',
        getTitle: () => 'Downloads',
        isLoading: () => false,
        session: fakeSession,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      };

      const { webContents } = await import('electron');
      vi.mocked(webContents.fromId).mockReturnValueOnce(
        fakeWc as unknown as Electron.WebContents
      );
      await controller.handleRpc('open', {
        tabId: 'tab-dl',
        url: 'https://example.com',
      });
      controller.attachWebContents({ tabId: 'tab-dl', webContentsId: 202 });

      const makeItem = (name: string) => {
        let savedPath = '';
        let doneCb: ((ev: unknown, state: string) => void) | undefined;
        return {
          getFilename: () => name,
          getURL: () => `https://example.com/${name}`,
          getTotalBytes: () => 100,
          getReceivedBytes: () => 100,
          isPaused: () => false,
          setSavePath: vi.fn((p: string) => {
            savedPath = p;
          }),
          getSavePath: () => savedPath,
          on: vi.fn(),
          once: vi.fn((ev: string, cb: (e: unknown, s: string) => void) => {
            if (ev === 'done') doneCb = cb;
          }),
          finish: () => doneCb?.({}, 'completed'),
        };
      };

      const item1 = makeItem('report.pdf');
      const item2 = makeItem('report.pdf');
      willDownloadHandler!({}, item1, fakeWc);
      willDownloadHandler!({}, item2, fakeWc);

      expect(item1.setSavePath).toHaveBeenCalledWith(path.join(dir, 'report (1).pdf'));
      expect(item2.setSavePath).toHaveBeenCalledWith(path.join(dir, 'report (2).pdf'));
      item1.finish();
      item2.finish();
      expect(
        events.filter((e) => e.kind === 'download' && e.state === 'completed')
      ).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
