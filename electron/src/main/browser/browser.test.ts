import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  MAX_DIMO_PICK_QUEUE_LENGTH,
  applyDevicePreset,
  buildInjectedScriptWithPickerShim,
  captureFreezeFrame,
  capturePngBase64,
  deviceMetricsForPreset,
  serializeEvalResult,
} from './cdp';
import {
  BrowserRpcError,
  ElectronBrowserController,
  isAllowedBrowserUrl,
  isAllowedWebviewPartition,
  isIgnoredLoadUrlError,
  isLoopbackCertificateUrl,
  isSafeBrowserPermission,
  isUiOwnedBounds,
  matchHostBrowserShortcut,
  normalizeConsoleLevel,
  partitionForProfile,
  resolveUniqueDownloadPath,
} from './controller';
import { NativeTabsRpcClient } from './nativeTabsRpc';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

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

describe('ElectronBrowserController concurrency, security & lifecycle hardening', () => {
  function makeMockHeadlessBrowserWindow(
    id: number,
    options?: {
      loadUrlPromise?: Promise<void>;
      evalResult?: unknown;
    }
  ) {
    let destroyed = false;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of Array.from(listeners.get(event) ?? [])) {
        fn(...args);
      }
    };
    const fakeWc = {
      id,
      isDestroyed: () => destroyed,
      getURL: () => 'https://example.com',
      getTitle: () => 'Headless',
      isLoading: () => false,
      session: { on: vi.fn() },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
      setFrameRate: vi.fn(),
      executeJavaScript: vi.fn(async () => options?.evalResult ?? 'ok'),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(cb);
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const wrapper = (...args: unknown[]) => {
          listeners.get(event)?.delete(wrapper);
          cb(...args);
        };
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(wrapper);
      }),
      removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(cb);
      }),
      setWindowOpenHandler: vi.fn(),
    };
    const win = {
      webContents: fakeWc,
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => {
        if (!destroyed) {
          destroyed = true;
          emit('destroyed');
        }
      }),
      loadURL: vi.fn(() => options?.loadUrlPromise ?? Promise.resolve()),
      setContentSize: vi.fn(),
    };
    return { win, fakeWc };
  }

  it('deduplicates concurrent waitForOrCreateWebContents calls so only one offscreen BrowserWindow is created', async () => {
    vi.useFakeTimers();
    const { BrowserWindow, webContents } = await import('electron');
    const created: Array<ReturnType<typeof makeMockHeadlessBrowserWindow>> = [];

    vi.mocked(BrowserWindow).mockImplementation(() => {
      const mock = makeMockHeadlessBrowserWindow(500 + created.length, {
        evalResult: '42',
      });
      created.push(mock);
      return mock.win as unknown as Electron.BrowserWindow;
    });
    vi.mocked(webContents.fromId).mockImplementation((id: number) => {
      const match = created.find((c) => c.fakeWc.id === id);
      return (match?.fakeWc ?? null) as unknown as Electron.WebContents;
    });

    const controller = new ElectronBrowserController({ onEvent: () => {} });
    await controller.handleRpc('open', {
      tabId: 'tab-dedupe',
      url: 'https://example.com',
    });

    const p1 = controller.handleRpc('eval', {
      tabId: 'tab-dedupe',
      expression: '1 + 1',
    });
    const p2 = controller.handleRpc('eval', {
      tabId: 'tab-dedupe',
      expression: '2 + 2',
    });

    await vi.advanceTimersByTimeAsync(400);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('42');
    expect(r2).toBe('42');
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);
  });

  it('never creates a zombie BrowserWindow when rpcClose or destroy runs while waiting or mid-load', async () => {
    vi.useFakeTimers();
    const { BrowserWindow } = await import('electron');

    // Case 1: rpcClose while awaiting attach -> never constructs BrowserWindow
    vi.mocked(BrowserWindow).mockImplementation(() => {
      return makeMockHeadlessBrowserWindow(601).win as unknown as Electron.BrowserWindow;
    });
    const controller1 = new ElectronBrowserController({ onEvent: () => {} });
    await controller1.handleRpc('open', {
      tabId: 'tab-close-early',
      url: 'https://example.com',
    });
    const pendingEval1 = controller1.handleRpc('eval', {
      tabId: 'tab-close-early',
      expression: '1',
    });
    await controller1.handleRpc('close', { tabId: 'tab-close-early' });
    await expect(pendingEval1).rejects.toMatchObject({ code: 'browser_no_such_tab' });
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(BrowserWindow)).not.toHaveBeenCalled();

    // Case 2: destroy() while awaiting attach -> never constructs BrowserWindow
    const controller2 = new ElectronBrowserController({ onEvent: () => {} });
    await controller2.handleRpc('open', {
      tabId: 'tab-destroy-early',
      url: 'https://example.com',
    });
    const pendingEval2 = controller2.handleRpc('eval', {
      tabId: 'tab-destroy-early',
      expression: '1',
    });
    controller2.destroy();
    await expect(pendingEval2).rejects.toMatchObject({ code: 'browser_no_such_tab' });
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(BrowserWindow)).not.toHaveBeenCalled();

    // Case 3: rpcClose mid-loadURL -> destroys created headless window immediately and rejects cleanly
    let resolveLoad!: () => void;
    const hangingLoad = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const midLoadMock = makeMockHeadlessBrowserWindow(603, {
      loadUrlPromise: hangingLoad,
    });
    vi.mocked(BrowserWindow).mockImplementationOnce(
      () => midLoadMock.win as unknown as Electron.BrowserWindow
    );

    const controller3 = new ElectronBrowserController({ onEvent: () => {} });
    await controller3.handleRpc('open', {
      tabId: 'tab-mid-load',
      url: 'https://example.com',
    });
    const pendingEval3 = controller3.handleRpc('eval', {
      tabId: 'tab-mid-load',
      expression: '1',
    });
    // Advance past ATTACH_WAIT_TIMEOUT_MS so headless window starts loading.
    await vi.advanceTimersByTimeAsync(400);
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);

    await controller3.handleRpc('close', { tabId: 'tab-mid-load' });
    await expect(pendingEval3).rejects.toMatchObject({ code: 'browser_no_such_tab' });
    expect(midLoadMock.win.destroy).toHaveBeenCalled();
    resolveLoad();
  });

  it('hooks session security in will-attach-webview and enforces checkNavigation BEFORE attachWebContents', async () => {
    const events: Array<Record<string, unknown>> = [];
    const checkNavigation = vi.fn(async (url: string) => ({
      allowed: !url.includes('evil.example'),
      preferSystem: false,
    }));
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
    let permissionCheckHandler: (() => boolean) | undefined;
    const fakePartitionSession = {
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn((fn: () => boolean) => {
        permissionCheckHandler = fn;
      }),
      webRequest: {
        onBeforeRequest: vi.fn((_filter, handler) => {
          beforeRequestHandler = handler;
        }),
      },
    };
    const { session } = await import('electron');
    vi.mocked(session.fromPartition).mockReturnValueOnce(
      fakePartitionSession as unknown as Electron.Session
    );

    let webContentsCreatedHandler:
      | ((event: unknown, contents: unknown) => void)
      | undefined;
    controller.installWebviewSecurity({
      on: (ev: string, cb: (e: unknown, c: unknown) => void) => {
        if (ev === 'web-contents-created') webContentsCreatedHandler = cb;
      },
    } as unknown as Electron.App);

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
        on: (ev: string, cb: unknown) => {
          if (ev === 'will-attach-webview') {
            willAttachHandler = cb as typeof willAttachHandler;
          }
        },
      }
    );

    // Trigger will-attach-webview BEFORE any electron_browser_attach IPC occurs.
    const ev = { preventDefault: vi.fn() };
    willAttachHandler!(
      ev,
      {},
      {
        partition: 'dimo-browser-ephemeral-tab-early',
        src: 'https://evil.example/initial',
      }
    );
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(permissionCheckHandler?.()).toBe(false);
    expect(beforeRequestHandler).toBeDefined();

    // Even with an unattached webContentsId, checkNavigation MUST be enforced!
    const res = await new Promise<{ cancel?: boolean }>((resolve) => {
      beforeRequestHandler!(
        { url: 'https://evil.example/initial', webContentsId: 9999 },
        resolve
      );
    });
    expect(res).toEqual({ cancel: true });
    expect(checkNavigation).toHaveBeenCalledWith('https://evil.example/initial');
    expect(events).toContainEqual({
      kind: 'navigation.blocked',
      tabId: 'tab-early',
      url: 'https://evil.example/initial',
    });
  });

  it('settles rpcFind cleanly when webContents is destroyed without calling removeListener on destroyed wc', async () => {
    const controller = new ElectronBrowserController({ onEvent: () => {} });
    let destroyed = false;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const removeListener = vi.fn(() => {
      if (destroyed) {
        throw new Error('Object has been destroyed');
      }
    });
    const fakeWc = {
      id: 707,
      isDestroyed: () => destroyed,
      getURL: () => 'https://example.com',
      getTitle: () => 'Find',
      isLoading: () => false,
      session: { on: vi.fn() },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(cb);
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(cb);
      }),
      removeListener,
      setWindowOpenHandler: vi.fn(),
      findInPage: vi.fn(),
      stopFindInPage: vi.fn(),
    };

    const { webContents } = await import('electron');
    vi.mocked(webContents.fromId).mockReturnValue(
      fakeWc as unknown as Electron.WebContents
    );

    await controller.handleRpc('open', {
      tabId: 'tab-find',
      url: 'https://example.com',
    });
    controller.attachWebContents({ tabId: 'tab-find', webContentsId: 707 });

    const findPromise = controller.handleRpc('find', {
      tabId: 'tab-find',
      query: 'needle',
    });

    destroyed = true;
    for (const cb of Array.from(listeners.get('destroyed') ?? [])) {
      cb();
    }

    await expect(findPromise).resolves.toBe(false);
    expect(removeListener).not.toHaveBeenCalled();
  });

  it('throttles rapid will-download updated events while immediately emitting state changes', async () => {
    vi.useFakeTimers();
    const events: Array<Record<string, unknown>> = [];
    const controller = new ElectronBrowserController({
      onEvent: (ev) => events.push(ev),
    });

    let willDownloadHandler:
      | ((ev: unknown, item: unknown, wc: unknown) => void)
      | undefined;
    const fakeSession = {
      on: vi.fn((event: string, cb: (ev: unknown, item: unknown, wc: unknown) => void) => {
        if (event === 'will-download') willDownloadHandler = cb;
      }),
    };
    const fakeWc = {
      id: 808,
      isDestroyed: () => false,
      getURL: () => 'https://example.com',
      getTitle: () => 'DL',
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
      tabId: 'tab-throttle',
      url: 'https://example.com',
    });
    controller.attachWebContents({ tabId: 'tab-throttle', webContentsId: 808 });

    let updatedCb: (() => void) | undefined;
    let paused = false;
    let receivedBytes = 0;
    const fakeItem = {
      getFilename: () => 'big.bin',
      getURL: () => 'https://example.com/big.bin',
      getTotalBytes: () => 1000,
      getReceivedBytes: () => receivedBytes,
      isPaused: () => paused,
      setSavePath: vi.fn(),
      getSavePath: () => '',
      on: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'updated') updatedCb = cb;
      }),
      once: vi.fn(),
    };

    willDownloadHandler!({}, fakeItem, fakeWc);
    // Initial download event emitted
    expect(events.filter((e) => e.kind === 'download')).toHaveLength(1);

    // 3 rapid progressing updates within 50ms -> throttled
    receivedBytes = 100;
    updatedCb!();
    vi.advanceTimersByTime(50);
    receivedBytes = 200;
    updatedCb!();
    vi.advanceTimersByTime(50);
    receivedBytes = 300;
    updatedCb!();
    expect(events.filter((e) => e.kind === 'download')).toHaveLength(1);

    // State change (progressing -> paused) emits immediately even within throttle window
    paused = true;
    updatedCb!();
    expect(events.filter((e) => e.kind === 'download')).toHaveLength(2);
    expect(events[events.length - 1]).toMatchObject({ state: 'paused' });

    // After 200ms, same state emits again
    vi.advanceTimersByTime(250);
    receivedBytes = 400;
    updatedCb!();
    expect(events.filter((e) => e.kind === 'download')).toHaveLength(3);
  });
});

describe('CDP refcounting, timeout rejection handling & picker queue cap', () => {
  function makeMockCdpWebContents(initialAttached = false) {
    let attached = initialAttached;
    const pendingCommands: Array<{
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }> = [];
    const dbg = {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi.fn((method: string) => {
        return new Promise<unknown>((resolve, reject) => {
          pendingCommands.push({ method, resolve, reject });
        });
      }),
    };
    const wc = {
      isDestroyed: () => false,
      debugger: dbg,
      capturePage: vi.fn(async () => ({
        toPNG: () => Buffer.alloc(0),
        toJPEG: () => Buffer.alloc(0),
      })),
    };
    return {
      wc: wc as unknown as Electron.WebContents,
      dbg,
      pendingCommands,
      isAttached: () => attached,
    };
  }

  it('prefers native capturePage without attaching debugger and temporarily disables background throttling', async () => {
    let throttled = true;
    const dbg = {
      isAttached: vi.fn(() => false),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
    };
    const wc = {
      isDestroyed: () => false,
      debugger: dbg,
      getBackgroundThrottling: vi.fn(() => throttled),
      setBackgroundThrottling: vi.fn((next: boolean) => {
        throttled = next;
      }),
      capturePage: vi.fn(async () => {
        expect(throttled).toBe(false);
        return {
          toPNG: () => Buffer.from('native-png'),
          toJPEG: () => Buffer.from('native-jpeg'),
        };
      }),
    } as unknown as Electron.WebContents;

    expect(await capturePngBase64(wc)).toBe(
      Buffer.from('native-png').toString('base64')
    );
    expect(await captureFreezeFrame(wc)).toEqual({
      mime: 'image/jpeg',
      data: Buffer.from('native-jpeg').toString('base64'),
    });
    expect(dbg.attach).not.toHaveBeenCalled();
    expect(dbg.sendCommand).not.toHaveBeenCalled();
    expect(throttled).toBe(true);
  });

  it('refcounts overlapping CDP fallback calls so debugger is never detached while another call is in-flight', async () => {
    const { wc, dbg, pendingCommands, isAttached } = makeMockCdpWebContents(false);

    const p1 = capturePngBase64(wc);
    const p2 = captureFreezeFrame(wc);
    await new Promise((resolve) => setImmediate(resolve));

    expect(dbg.attach).toHaveBeenCalledTimes(1);
    expect(pendingCommands).toHaveLength(2);

    // First call finishes: debugger MUST remain attached for second call
    pendingCommands[0].resolve({ data: 'cG5nMQ==' });
    expect(await p1).toBe('cG5nMQ==');
    expect(dbg.detach).not.toHaveBeenCalled();
    expect(isAttached()).toBe(true);

    // Second call finishes: now refcount drops to 0 and debugger detaches
    pendingCommands[1].resolve({ data: 'anBlZzI=' });
    expect(await p2).toEqual({ mime: 'image/jpeg', data: 'anBlZzI=' });
    expect(dbg.detach).toHaveBeenCalledTimes(1);
    expect(isAttached()).toBe(false);
  });

  it('never detaches a debugger that was already attached externally and preserves emulation attachment', async () => {
    const ext = makeMockCdpWebContents(true);
    const p = capturePngBase64(ext.wc);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ext.dbg.attach).not.toHaveBeenCalled();
    ext.pendingCommands[0].resolve({ data: 'ZXh0' });
    expect(await p).toBe('ZXh0');
    expect(ext.dbg.detach).not.toHaveBeenCalled();

    // Device preset keeps debugger attached until desktop reset
    const emu = makeMockCdpWebContents(false);
    const phonePromise = applyDevicePreset(emu.wc, 'phone');
    emu.pendingCommands[0].resolve({});
    await Promise.resolve();
    emu.pendingCommands[1].resolve({});
    await phonePromise;
    expect(emu.dbg.attach).toHaveBeenCalledTimes(1);
    expect(emu.dbg.detach).not.toHaveBeenCalled();

    const resetPromise = applyDevicePreset(emu.wc, 'desktop');
    emu.pendingCommands[2].resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    emu.pendingCommands[3].resolve({});
    await resetPromise;
    expect(emu.dbg.detach).toHaveBeenCalledTimes(1);
  });

  it('handles CDP fallback command timeout and subsequent detach rejection without UnhandledPromiseRejection', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { wc, dbg, pendingCommands } = makeMockCdpWebContents(false);
      // Simulate Electron rejecting the in-flight sendCommand when detach() runs
      dbg.detach.mockImplementation(() => {
        for (const cmd of pendingCommands) {
          cmd.reject(new Error('Debugger detached'));
        }
      });

      const capturePromise = captureFreezeFrame(wc);
      await vi.advanceTimersByTimeAsync(4_500);
      const frame = await capturePromise;

      expect(frame).toBeNull();
      expect(dbg.detach).toHaveBeenCalledTimes(1);
      // Flush microtasks to verify no unhandledRejection fired
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('caps globalThis.__dimoPickQueue at MAX_DIMO_PICK_QUEUE_LENGTH entries dropping oldest', () => {
    const g = globalThis as Record<string, unknown>;
    const prevQueue = g.__dimoPickQueue;
    const prevSend = g.__codegSend;
    delete g.__dimoPickQueue;
    delete g.__codegSend;

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const script = buildInjectedScriptWithPickerShim('');
      // Evaluate the generated shim in the current realm.
      new Function(script)();

      const send = g.__codegSend as (msg: string) => void;
      expect(typeof send).toBe('function');

      const total = MAX_DIMO_PICK_QUEUE_LENGTH + 50;
      for (let i = 0; i < total; i += 1) {
        send(`msg-${i}`);
      }

      const queue = g.__dimoPickQueue as string[];
      expect(queue).toHaveLength(MAX_DIMO_PICK_QUEUE_LENGTH);
      expect(queue[0]).toBe('msg-50');
      expect(queue[queue.length - 1]).toBe(`msg-${total - 1}`);
    } finally {
      debugSpy.mockRestore();
      if (prevQueue === undefined) {
        delete g.__dimoPickQueue;
      } else {
        g.__dimoPickQueue = prevQueue;
      }
      if (prevSend === undefined) {
        delete g.__codegSend;
      } else {
        g.__codegSend = prevSend;
      }
    }
  });
});

describe('NativeTabsRpcClient lifecycle & concurrency bounds', () => {
  it('settles pending waitUntilConnected resolvers immediately on stop()', async () => {
    const controller = new ElectronBrowserController({ onEvent: () => {} });
    const client = new NativeTabsRpcClient({
      getConnection: () => {
        throw new Error('offline');
      },
      controller,
    });

    const waitPromise = client.waitUntilConnected(60_000);
    client.stop();
    await expect(waitPromise).resolves.toBe(false);
  });

  it('bounds concurrent RPC invocations, rejects queue overflow with browser_busy, and keeps policy_response unblocked', async () => {
    const listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
    const sent: Array<Record<string, unknown>> = [];
    const fakeWs = {
      readyState: 1, // OPEN
      addEventListener: vi.fn((type: string, cb: (ev: { data?: unknown }) => void) => {
        const list = listeners.get(type) ?? [];
        list.push(cb);
        listeners.set(type, list);
      }),
      send: vi.fn((raw: string) => {
        sent.push(JSON.parse(raw) as Record<string, unknown>);
      }),
      close: vi.fn(),
    };

    const OriginalWebSocket = globalThis.WebSocket;
    const MockWebSocket = Object.assign(
      vi.fn(() => fakeWs),
      { OPEN: 1 }
    );
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    try {
      const resolvers: Array<() => void> = [];
      let inFlight = 0;
      let maxObservedInFlight = 0;
      const fakeController = {
        handleRpc: vi.fn(async (_method: string, params: Record<string, unknown>) => {
          inFlight += 1;
          maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          inFlight -= 1;
          return { echo: params.n };
        }),
      };

      const client = new NativeTabsRpcClient({
        getConnection: () => ({ baseUrl: 'http://127.0.0.1:9999', token: 'tok' }),
        controller: fakeController as unknown as ElectronBrowserController,
        maxConcurrentRpcs: 2,
        maxQueuedRpcs: 1,
      });
      client.start();
      for (const cb of listeners.get('open') ?? []) cb({});

      const dispatchMsg = (payload: Record<string, unknown>) => {
        for (const cb of listeners.get('message') ?? []) {
          cb({ data: JSON.stringify(payload) });
        }
      };

      // Send 4 RPCs: 2 run immediately, 1 queues, 4th overflows with browser_busy
      dispatchMsg({ type: 'rpc_request', id: 1, method: 'eval', params: { n: 1 } });
      dispatchMsg({ type: 'rpc_request', id: 2, method: 'eval', params: { n: 2 } });
      dispatchMsg({ type: 'rpc_request', id: 3, method: 'eval', params: { n: 3 } });
      dispatchMsg({ type: 'rpc_request', id: 4, method: 'eval', params: { n: 4 } });

      expect(maxObservedInFlight).toBe(2);
      expect(fakeController.handleRpc).toHaveBeenCalledTimes(2);
      expect(sent).toContainEqual({
        type: 'rpc_response',
        id: 4,
        ok: false,
        code: 'browser_busy',
        message: 'Too many concurrent browser RPC requests',
      });

      // policy_response still resolves immediately while all RPC slots are saturated
      const policyPromise = client.checkNavigation('https://example.com');
      const policyReq = sent.find((m) => m.type === 'check_navigation');
      expect(policyReq).toBeDefined();
      dispatchMsg({
        type: 'policy_response',
        id: policyReq!.id as number,
        allowed: false,
        preferSystem: false,
      });
      await expect(policyPromise).resolves.toEqual({
        allowed: false,
        preferSystem: false,
      });

      // Drain the 2 active + 1 queued RPCs
      resolvers.shift()!();
      await Promise.resolve();
      await Promise.resolve();
      expect(fakeController.handleRpc).toHaveBeenCalledTimes(3);
      expect(maxObservedInFlight).toBe(2);

      resolvers.shift()!();
      resolvers.shift()!();
      await Promise.resolve();
      await Promise.resolve();

      expect(sent).toContainEqual({
        type: 'rpc_response',
        id: 1,
        ok: true,
        result: { echo: 1 },
      });
      expect(sent).toContainEqual({
        type: 'rpc_response',
        id: 2,
        ok: true,
        result: { echo: 2 },
      });
      expect(sent).toContainEqual({
        type: 'rpc_response',
        id: 3,
        ok: true,
        result: { echo: 3 },
      });

      client.stop();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
    }
  });
});

describe('Electron browser host-slot lifecycle, security, and navigation hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates safe permissions, loopback cert URLs, ERR_ABORTED errors, UI bounds, and host shortcuts', () => {
    expect(isSafeBrowserPermission('clipboard-sanitized-write')).toBe(true);
    expect(isSafeBrowserPermission('fullscreen')).toBe(true);
    expect(isSafeBrowserPermission('pointerLock')).toBe(true);
    expect(isSafeBrowserPermission('loopback-network')).toBe(true);
    expect(isSafeBrowserPermission('media')).toBe(false);
    expect(isSafeBrowserPermission('geolocation')).toBe(false);
    expect(isSafeBrowserPermission(undefined)).toBe(false);

    expect(isLoopbackCertificateUrl('https://localhost:5173/app')).toBe(true);
    expect(isLoopbackCertificateUrl('https://127.0.0.1:8443/')).toBe(true);
    expect(isLoopbackCertificateUrl('https://sub.localhost:3000/')).toBe(true);
    expect(isLoopbackCertificateUrl('http://localhost:3000/')).toBe(false);
    expect(isLoopbackCertificateUrl('https://example.com/')).toBe(false);

    expect(isIgnoredLoadUrlError({ errno: -3 })).toBe(true);
    expect(isIgnoredLoadUrlError({ code: 'ERR_ABORTED' })).toBe(true);
    expect(isIgnoredLoadUrlError(new Error('ERR_ABORTED (-3) loading'))).toBe(true);
    expect(isIgnoredLoadUrlError(new Error('ERR_NAME_NOT_RESOLVED'))).toBe(false);

    expect(isUiOwnedBounds({ visible: true, width: 800, height: 600 })).toBe(true);
    expect(isUiOwnedBounds({ visible: false, width: 800, height: 600 })).toBe(false);
    expect(isUiOwnedBounds({ visible: true, width: 16, height: 16 })).toBe(false);
    expect(isUiOwnedBounds(undefined)).toBe(false);

    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: 'f', control: true })
    ).toBe('find');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: 'L', meta: true })
    ).toBe('focus-address');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: 'r', control: true })
    ).toBe('reload');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: 'w', meta: true })
    ).toBe('close-tab');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: '+', control: true })
    ).toBe('zoom-in');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: '-', control: true })
    ).toBe('zoom-out');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: '0', control: true })
    ).toBe('zoom-reset');
    expect(
      matchHostBrowserShortcut({ type: 'keyDown', key: 'f', control: true, shift: true })
    ).toBeNull();
    expect(
      matchHostBrowserShortcut({ type: 'keyUp', key: 'f', control: true })
    ).toBeNull();
  });

  it('forces whitelisted guestPreloadPath in will-attach-webview while stripping caller preload', () => {
    const controller = new ElectronBrowserController({
      onEvent: () => {},
      guestPreloadPath: '/app/dist/preload/webviewGuest.js',
    });
    let webContentsCreatedHandler:
      | ((event: unknown, contents: unknown) => void)
      | undefined;
    controller.installWebviewSecurity({
      on: (event: string, cb: (ev: unknown, c: unknown) => void) => {
        if (event === 'web-contents-created') webContentsCreatedHandler = cb;
      },
    } as unknown as Electron.App);

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

    const prefs: Record<string, unknown> = {
      preload: '/attacker/evil.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    };
    const ev = { preventDefault: vi.fn() };
    willAttachHandler!(ev, prefs, {
      partition: 'persist:dimo-browser-default',
      src: 'https://example.com',
    });

    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(prefs.preload).toBe('/app/dist/preload/webviewGuest.js');
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
  });

  it('preserves pending navigation issued before attach and replays loadURL when webview attaches', async () => {
    const controller = new ElectronBrowserController({ onEvent: () => {} });
    let loadedUrl = 'https://initial.example';
    const loadURL = vi.fn(async (nextUrl: string) => {
      loadedUrl = nextUrl;
    });
    const fakeWc = {
      id: 501,
      isDestroyed: () => false,
      getURL: () => loadedUrl,
      getTitle: () => 'Initial',
      isLoading: () => false,
      loadURL,
      session: { on: vi.fn() },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    const { webContents } = await import('electron');
    vi.mocked(webContents.fromId).mockReturnValue(
      fakeWc as unknown as Electron.WebContents
    );

    await controller.handleRpc('open', {
      tabId: 'tab-pending-nav',
      url: 'https://initial.example',
      bounds: { visible: true, width: 900, height: 600 },
    });
    // User navigates before <webview> attaches
    await controller.handleRpc('navigate', {
      tabId: 'tab-pending-nav',
      url: 'https://target.example/dashboard',
    });

    controller.attachWebContents({
      tabId: 'tab-pending-nav',
      webContentsId: 501,
      url: 'https://initial.example',
    });

    expect(loadURL).toHaveBeenCalledWith('https://target.example/dashboard');
    expect(
      await controller.handleRpc('current_url', { tabId: 'tab-pending-nav' })
    ).toBe('https://target.example/dashboard');
  });

  it('ignores ERR_ABORTED errors during rpcNavigate', async () => {
    const controller = new ElectronBrowserController({ onEvent: () => {} });
    const loadURL = vi.fn().mockRejectedValue(
      Object.assign(new Error('ERR_ABORTED (-3) loading'), {
        errno: -3,
        code: 'ERR_ABORTED',
      })
    );
    const fakeWc = {
      id: 502,
      isDestroyed: () => false,
      getURL: () => 'https://example.com',
      getTitle: () => 'Example',
      isLoading: () => false,
      loadURL,
      session: { on: vi.fn() },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    const { webContents } = await import('electron');
    vi.mocked(webContents.fromId).mockReturnValue(
      fakeWc as unknown as Electron.WebContents
    );

    await controller.handleRpc('open', {
      tabId: 'tab-abort',
      url: 'https://example.com',
    });
    controller.attachWebContents({ tabId: 'tab-abort', webContentsId: 502 });

    await expect(
      controller.handleRpc('navigate', {
        tabId: 'tab-abort',
        url: 'https://example.com/redirected',
      })
    ).resolves.toEqual({ ok: true });
  });

  it('does not spawn a duplicate headless BrowserWindow for UI-owned tabs awaiting webview attach', async () => {
    vi.useFakeTimers();
    const { BrowserWindow } = await import('electron');
    vi.mocked(BrowserWindow).mockClear();

    const controller = new ElectronBrowserController({ onEvent: () => {} });
    await controller.handleRpc('open', {
      tabId: 'tab-ui-owned',
      url: 'https://slow.example',
      bounds: { visible: true, width: 1024, height: 768 },
    });

    const evalPromise = controller
      .handleRpc('eval', { tabId: 'tab-ui-owned', script: 'document.title' })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(3_100);
    const result = await evalPromise;
    expect(result).toBeInstanceOf(BrowserRpcError);
    expect((result as BrowserRpcError).code).toBe('browser_surface_not_ready');
    expect(BrowserWindow).not.toHaveBeenCalled();
  });

  it('trusts loopback certificate errors, forwards host shortcuts, and applies permission allowlist', async () => {
    const events: Array<Record<string, unknown>> = [];
    const controller = new ElectronBrowserController({
      onEvent: (ev) => events.push(ev),
    });

    const listeners = new Map<string, (...args: unknown[]) => void>();
    let permRequestHandler:
      | ((wc: unknown, perm: string, cb: (allowed: boolean) => void) => void)
      | undefined;
    let permCheckHandler:
      | ((wc: unknown, perm: string) => boolean)
      | undefined;
    const fakeSession = {
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn((fn) => {
        permRequestHandler = fn;
      }),
      setPermissionCheckHandler: vi.fn((fn) => {
        permCheckHandler = fn;
      }),
    };
    const fakeWc = {
      id: 503,
      isDestroyed: () => false,
      getURL: () => 'https://localhost:5173',
      getTitle: () => 'Dev',
      isLoading: () => false,
      session: fakeSession,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
        listeners.set(ev, cb);
      }),
      once: vi.fn(),
      removeListener: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    const { webContents } = await import('electron');
    vi.mocked(webContents.fromId).mockReturnValue(
      fakeWc as unknown as Electron.WebContents
    );

    await controller.handleRpc('open', {
      tabId: 'tab-sec',
      url: 'https://localhost:5173',
    });
    controller.attachWebContents({ tabId: 'tab-sec', webContentsId: 503 });

    // Safe permission allowed, sensitive permission denied
    const clipCb = vi.fn();
    permRequestHandler?.(fakeWc, 'clipboard-sanitized-write', clipCb);
    expect(clipCb).toHaveBeenCalledWith(true);
    expect(permCheckHandler?.(fakeWc, 'fullscreen')).toBe(true);
    expect(permCheckHandler?.(fakeWc, 'media')).toBe(false);

    // Loopback cert trusted, remote cert rejected
    const certHandler = listeners.get('certificate-error')!;
    const localEv = { preventDefault: vi.fn() };
    const localCb = vi.fn();
    certHandler(localEv, 'https://localhost:5173/api', 'ERR_CERT_AUTHORITY_INVALID', {}, localCb);
    expect(localEv.preventDefault).toHaveBeenCalledOnce();
    expect(localCb).toHaveBeenCalledWith(true);

    const remoteEv = { preventDefault: vi.fn() };
    const remoteCb = vi.fn();
    certHandler(remoteEv, 'https://evil.example/', 'ERR_CERT_AUTHORITY_INVALID', {}, remoteCb);
    expect(remoteEv.preventDefault).not.toHaveBeenCalled();
    expect(remoteCb).toHaveBeenCalledWith(false);

    // Shortcut forwarding
    const inputHandler = listeners.get('before-input-event')!;
    const keyEv = { preventDefault: vi.fn() };
    inputHandler(keyEv, { type: 'keyDown', key: 'f', control: true });
    expect(keyEv.preventDefault).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      kind: 'tab.shortcut',
      tabId: 'tab-sec',
      action: 'find',
    });
  });

  it('installs base popup denial and scheme guards for all browser-partition webviews even when multiple pending tabs open concurrently (E2)', async () => {
    const events: Array<Record<string, unknown>> = [];
    const controller = new ElectronBrowserController({
      onEvent: (ev) => events.push(ev),
    });

    const appListeners = new Map<string, (...args: unknown[]) => void>();
    const fakeApp = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        appListeners.set(event, cb);
      }),
    };
    controller.installWebviewSecurity(fakeApp as unknown as Electron.App);

    const hostListeners = new Map<string, (...args: unknown[]) => void>();
    const fakeHostWc = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        hostListeners.set(event, cb);
      }),
    };
    appListeners.get('web-contents-created')!({}, fakeHostWc);
    const didAttach = hostListeners.get('did-attach-webview');
    expect(didAttach).toBeTypeOf('function');

    const { session, webContents } = await import('electron');
    const sharedSession = {
      on: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    };
    vi.mocked(session.fromPartition).mockReturnValue(
      sharedSession as unknown as Electron.Session
    );

    const makeGuestWc = (id: number, initialUrl: string) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      let windowOpenHandler:
        | ((details: { url: string; disposition: string }) => { action: string })
        | undefined;
      return {
        id,
        isDestroyed: () => false,
        getURL: () => initialUrl,
        getTitle: () => `Tab ${id}`,
        isLoading: () => false,
        session: sharedSession,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
          let set = listeners.get(ev);
          if (!set) {
            set = new Set();
            listeners.set(ev, set);
          }
          set.add(cb);
        }),
        once: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
          let set = listeners.get(ev);
          if (!set) {
            set = new Set();
            listeners.set(ev, set);
          }
          set.add(cb);
        }),
        removeListener: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
          listeners.get(ev)?.delete(cb);
        }),
        setWindowOpenHandler: vi.fn(
          (
            handler: (details: {
              url: string;
              disposition: string;
            }) => { action: string }
          ) => {
            windowOpenHandler = handler;
          }
        ),
        _listeners: listeners,
        _invokeWindowOpen: (url: string, disposition = 'foreground-tab') =>
          windowOpenHandler?.({ url, disposition }),
      };
    };

    // Open two concurrent pending tabs on the SAME default partition before either binds.
    await controller.handleRpc('open', {
      tabId: 'tab-concurrent-1',
      url: 'https://one.example',
    });
    await controller.handleRpc('open', {
      tabId: 'tab-concurrent-2',
      url: 'https://two.example',
    });

    const guest1 = makeGuestWc(911, 'https://one.example');
    const guest2 = makeGuestWc(912, 'https://two.example');
    didAttach!({}, guest1);
    didAttach!({}, guest2);

    // Both webviews must immediately deny uncontrolled native popups and block disallowed schemes.
    expect(guest1.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(guest2.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(guest1._invokeWindowOpen('https://popup-a.example')).toEqual({
      action: 'deny',
    });
    expect(guest2._invokeWindowOpen('https://popup-b.example')).toEqual({
      action: 'deny',
    });

    for (const guest of [guest1, guest2]) {
      const navEv = { preventDefault: vi.fn() };
      for (const cb of guest._listeners.get('will-navigate') ?? []) {
        cb(navEv, 'file:///C:/Windows/win.ini');
      }
      expect(navEv.preventDefault).toHaveBeenCalledOnce();

      const redirEv = { preventDefault: vi.fn() };
      for (const cb of guest._listeners.get('will-redirect') ?? []) {
        cb(redirEv, 'dimo-app://internal');
      }
      expect(redirEv.preventDefault).toHaveBeenCalledOnce();
    }

    // Once bound via attachWebContents, popups route to the bound tab without duplicating hooks.
    vi.mocked(webContents.fromId).mockImplementation((id: number) => {
      if (id === 911) return guest1 as unknown as Electron.WebContents;
      if (id === 912) return guest2 as unknown as Electron.WebContents;
      return undefined as unknown as Electron.WebContents;
    });
    controller.attachWebContents({ tabId: 'tab-concurrent-1', webContentsId: 911 });
    controller.attachWebContents({ tabId: 'tab-concurrent-2', webContentsId: 912 });
    expect(guest1.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(guest2.setWindowOpenHandler).toHaveBeenCalledTimes(1);

    expect(guest2._invokeWindowOpen('https://bound-popup.example')).toEqual({
      action: 'deny',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tab.open',
        sourceTabId: 'tab-concurrent-2',
        url: 'https://bound-popup.example',
      })
    );

    // Base guards stay active after detach until guest is destroyed or controller destroyed.
    controller.detachWebContents('tab-concurrent-1');
    expect(guest1._invokeWindowOpen('https://after-detach.example')).toEqual({
      action: 'deny',
    });

    for (const cb of Array.from(guest1._listeners.get('destroyed') ?? [])) {
      cb();
    }
    controller.destroy();
  });

  it('ignores stale WebSocket close/message/error events and closes any previous socket on reconnect (E5)', async () => {
    vi.useFakeTimers();

    interface FakeSocket {
      readyState: number;
      listeners: Map<string, Array<(ev: { data?: unknown }) => void>>;
      sent: Array<Record<string, unknown>>;
      addEventListener: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      emit: (type: string, ev?: { data?: unknown }) => void;
    }

    const sockets: FakeSocket[] = [];
    const OriginalWebSocket = globalThis.WebSocket;
    const MockWebSocket = Object.assign(
      vi.fn(() => {
        const listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>();
        const sent: Array<Record<string, unknown>> = [];
        const ws: FakeSocket = {
          readyState: 1,
          listeners,
          sent,
          addEventListener: vi.fn((type: string, cb: (ev: { data?: unknown }) => void) => {
            const list = listeners.get(type) ?? [];
            list.push(cb);
            listeners.set(type, list);
          }),
          send: vi.fn((raw: string) => {
            sent.push(JSON.parse(raw) as Record<string, unknown>);
          }),
          close: vi.fn(() => {
            ws.readyState = 3;
          }),
          emit(type: string, ev: { data?: unknown } = {}) {
            for (const cb of listeners.get(type) ?? []) {
              cb(ev);
            }
          },
        };
        sockets.push(ws);
        return ws;
      }),
      { OPEN: 1 }
    );
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    try {
      const controller = new ElectronBrowserController({ onEvent: () => {} });
      const client = new NativeTabsRpcClient({
        getConnection: () => ({ baseUrl: 'http://127.0.0.1:9999', token: 'tok' }),
        controller,
      });

      client.start();
      expect(sockets).toHaveLength(1);
      const ws1 = sockets[0];
      ws1.emit('open');

      // Re-invoking connect() while ws1 is active must close ws1 before opening ws2.
      (client as unknown as { connect: () => void }).connect();
      expect(ws1.close).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(2);
      const ws2 = sockets[1];
      ws2.emit('open');

      // Start a pending policy check on the active ws2 socket.
      const policyPromise = client.checkNavigation('https://blocked.example');
      const policyMsg = ws2.sent.find((m) => m.type === 'check_navigation');
      expect(policyMsg).toBeDefined();
      const policyId = policyMsg!.id as number;

      // Fire stale close/error/message events on ws1 — MUST NOT trigger reconnect storm,
      // MUST NOT clear ws2, and MUST NOT prematurely resolve ws2's pending policy check to allow.
      ws1.emit('error');
      ws1.emit('close');
      ws1.emit('message', {
        data: JSON.stringify({
          type: 'policy_response',
          id: policyId,
          allowed: true,
        }),
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(2);
      expect(client.isConnected()).toBe(true);

      // Genuine denial arriving on ws2 resolves the pending policy check accurately.
      ws2.emit('message', {
        data: JSON.stringify({
          type: 'policy_response',
          id: policyId,
          allowed: false,
          preferSystem: true,
        }),
      });
      await expect(policyPromise).resolves.toEqual({
        allowed: false,
        preferSystem: true,
      });

      client.stop();
      expect(ws2.close).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket =
        OriginalWebSocket;
    }
  });
});
