import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BrowserWindow,
  session,
  shell,
  webContents,
  type App,
  type DownloadItem,
  type Session,
  type WebContents,
} from 'electron';

import {
  DIMO_PICK_CONSOLE_PREFIX,
  applyDevicePreset,
  captureFreezeFrame,
  capturePngBase64,
  evaluateExpression,
  injectScript,
  type FrozenFramePayload,
} from './cdp';

const PERSISTENT_PARTITION_PREFIX = 'persist:dimo-browser-';
const EPHEMERAL_PARTITION_PREFIX = 'dimo-browser-ephemeral-';
const ATTACH_WAIT_TIMEOUT_MS = 350;
const HEADLESS_LOAD_TIMEOUT_MS = 5_000;

export interface BrowserBoundsInput {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scale?: number;
  visible?: boolean;
}

export interface BrowserRpcErrorShape {
  code: string;
  message: string;
}

export class BrowserRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserRpcError';
  }
}

export function sanitizePartitionSegment(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'default';
}

export function partitionForProfile(profileId: string, tabId?: string): string {
  const trimmed = profileId.trim();
  if (trimmed === 'ephemeral') {
    return `${EPHEMERAL_PARTITION_PREFIX}${sanitizePartitionSegment(tabId ?? 'session')}`;
  }
  return `${PERSISTENT_PARTITION_PREFIX}${sanitizePartitionSegment(trimmed || 'default')}`;
}

export function isAllowedWebviewPartition(partition: string): boolean {
  const trimmed = partition.trim();
  if (trimmed.startsWith(PERSISTENT_PARTITION_PREFIX)) {
    return trimmed.length > PERSISTENT_PARTITION_PREFIX.length;
  }
  if (trimmed.startsWith(EPHEMERAL_PARTITION_PREFIX)) {
    return trimmed.length > EPHEMERAL_PARTITION_PREFIX.length;
  }
  return false;
}

export function isAllowedBrowserUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (trimmed === 'about:blank') {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveUniqueDownloadPath(
  downloadsDir: string,
  rawFilename: string,
  reserved?: ReadonlySet<string>,
  existsSync: (filePath: string) => boolean = fs.existsSync
): { savePath: string; filename: string } {
  const baseName = path.basename(rawFilename.trim() || 'download');
  const sanitized = baseName.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'download';
  const ext = path.extname(sanitized);
  const stem = ext ? sanitized.slice(0, -ext.length) : sanitized;
  let filename = sanitized;
  let savePath = path.join(downloadsDir, filename);
  let counter = 1;
  while (existsSync(savePath) || reserved?.has(savePath)) {
    filename = `${stem} (${counter})${ext}`;
    savePath = path.join(downloadsDir, filename);
    counter += 1;
  }
  return { savePath, filename };
}

export function normalizeConsoleLevel(
  rawLevel: number | string
): 'debug' | 'log' | 'info' | 'warn' | 'error' {
  if (typeof rawLevel === 'string') {
    const lower = rawLevel.trim().toLowerCase();
    if (lower === 'error') return 'error';
    if (lower === 'warning' || lower === 'warn') return 'warn';
    if (lower === 'info') return 'info';
    if (lower === 'verbose' || lower === 'debug') return 'debug';
    return 'log';
  }
  switch (rawLevel) {
    case 0:
      return 'debug';
    case 1:
      return 'info';
    case 2:
      return 'warn';
    case 3:
      return 'error';
    default:
      return 'log';
  }
}

interface TabState {
  tabId: string;
  profileId: string;
  url: string;
  bounds: BrowserBoundsInput;
  webContentsId: number | null;
  headlessWindow: BrowserWindow | null;
  zoomFactor: number;
  device: string;
  cleanupListeners: (() => void) | null;
  attachWaiters: Array<(wc: WebContents) => void>;
}

export interface BrowserNavigationPolicy {
  allowed: boolean;
  preferSystem: boolean;
}

export interface ElectronBrowserControllerOptions {
  onEvent: (payload: Record<string, unknown>) => void;
  getDownloadsDir?: () => string | undefined;
  checkNavigation?: (url: string) => Promise<BrowserNavigationPolicy>;
}

export class ElectronBrowserController {
  private readonly tabs = new Map<string, TabState>();
  private readonly tabIdByWebContentsId = new Map<number, string>();
  private readonly hookedSessions = new WeakSet<Session>();
  private readonly webRequestHookedSessions = new WeakSet<Session>();
  private readonly reservedDownloadPaths = new Set<string>();
  private readonly approvedNavigations = new Set<string>();
  private readonly onEvent: (payload: Record<string, unknown>) => void;
  private readonly getDownloadsDir: () => string | undefined;
  private readonly checkNavigation?: (url: string) => Promise<BrowserNavigationPolicy>;

  constructor(options: ElectronBrowserControllerOptions) {
    this.onEvent = options.onEvent;
    this.getDownloadsDir = options.getDownloadsDir ?? (() => undefined);
    this.checkNavigation = options.checkNavigation;
  }

  /**
   * Enforce strict `<webview>` sandboxing on every BrowserWindow created by Electron.
   */
  installWebviewSecurity(appInstance: App): void {
    appInstance.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', (event, webPreferences, params) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.allowRunningInsecureContent = false;
        webPreferences.webSecurity = true;

        const partition =
          typeof params.partition === 'string' ? params.partition.trim() : '';
        if (!isAllowedWebviewPartition(partition)) {
          event.preventDefault();
          return;
        }

        const src = typeof params.src === 'string' ? params.src.trim() : '';
        if (src.length > 0 && !isAllowedBrowserUrl(src)) {
          event.preventDefault();
        }
      });
    });
  }

  attachWebContents(params: {
    tabId: string;
    webContentsId: number;
    profileId?: string;
    url?: string;
  }): { ok: boolean } {
    const tabId = params.tabId.trim();
    if (!tabId) {
      throw new BrowserRpcError('browser_invalid', 'tabId is required');
    }
    const wc = webContents.fromId(params.webContentsId);
    if (!wc || wc.isDestroyed()) {
      return { ok: false };
    }

    let entry = this.tabs.get(tabId);
    if (!entry) {
      entry = {
        tabId,
        profileId: params.profileId?.trim() || 'default',
        url: params.url?.trim() || wc.getURL() || 'about:blank',
        bounds: {},
        webContentsId: null,
        headlessWindow: null,
        zoomFactor: 1.0,
        device: 'desktop',
        cleanupListeners: null,
        attachWaiters: [],
      };
      this.tabs.set(tabId, entry);
    }

    if (entry.webContentsId === wc.id) {
      return { ok: true };
    }

    // Tear down any previous listeners or temporary headless fallback window.
    this.detachEntryListeners(entry);
    if (entry.headlessWindow && !entry.headlessWindow.isDestroyed()) {
      entry.headlessWindow.destroy();
      entry.headlessWindow = null;
    }

    if (params.profileId?.trim()) {
      entry.profileId = params.profileId.trim();
    }
    if (params.url?.trim()) {
      entry.url = params.url.trim();
    }

    this.bindWebContentsToEntry(entry, wc);
    return { ok: true };
  }

  detachWebContents(tabId: string, webContentsId?: number): { ok: boolean } {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      return { ok: true };
    }
    if (
      webContentsId !== undefined &&
      entry.webContentsId !== null &&
      entry.webContentsId !== webContentsId
    ) {
      return { ok: true };
    }
    this.detachEntryListeners(entry);
    return { ok: true };
  }

  async captureThumbnail(tabId: string): Promise<FrozenFramePayload | null> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.webContentsId === null) {
      return null;
    }
    const wc = webContents.fromId(entry.webContentsId);
    if (!wc || wc.isDestroyed()) {
      return null;
    }
    return captureFreezeFrame(wc);
  }

  async handleRpc(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    switch (method) {
      case 'open':
        return this.rpcOpen(params);
      case 'navigate':
        return this.rpcNavigate(params);
      case 'close':
        return this.rpcClose(params);
      case 'set_bounds':
        return this.rpcSetBounds(params);
      case 'eval':
        return this.rpcEval(params);
      case 'current_url':
        return this.rpcCurrentUrl(params);
      case 'go_back':
        return this.rpcHistory(params, 'back');
      case 'go_forward':
        return this.rpcHistory(params, 'forward');
      case 'reload':
        return this.rpcReload(params);
      case 'stop':
        return this.rpcStop(params);
      case 'find':
        return this.rpcFind(params);
      case 'set_zoom':
        return this.rpcSetZoom(params);
      case 'open_devtools':
        return this.rpcOpenDevtools(params);
      case 'set_device':
        return this.rpcSetDevice(params);
      case 'inject':
        return this.rpcInject(params);
      case 'freeze_frame':
        return this.rpcFreezeFrame(params);
      case 'capture_png':
        return this.rpcCapturePng(params);
      case 'clear_profile':
        return this.rpcClearProfile(params);
      case 'remove_profile':
        return this.rpcClearProfile(params);
      case 'reset_all':
        return this.rpcResetAll();
      default:
        throw new BrowserRpcError(
          'capability_unimplemented',
          `Unknown Electron browser RPC method: ${method}`
        );
    }
  }

  destroy(): void {
    for (const entry of this.tabs.values()) {
      this.detachEntryListeners(entry);
      if (entry.headlessWindow && !entry.headlessWindow.isDestroyed()) {
        entry.headlessWindow.destroy();
      }
      entry.headlessWindow = null;
    }
    this.tabs.clear();
    this.tabIdByWebContentsId.clear();
    this.reservedDownloadPaths.clear();
  }

  private bindWebContentsToEntry(entry: TabState, wc: WebContents): void {
    entry.webContentsId = wc.id;
    this.tabIdByWebContentsId.set(wc.id, entry.tabId);
    this.ensureSessionHooks(wc.session);

    const onStartLoading = () => {
      const current = wc.isDestroyed() ? entry.url : wc.getURL() || entry.url;
      entry.url = current;
      this.onEvent({
        kind: 'tab.state',
        tabId: entry.tabId,
        url: current,
        loading: true,
      });
    };

    const onStopLoading = () => {
      if (wc.isDestroyed()) return;
      const current = wc.getURL() || entry.url;
      const title = wc.getTitle() || undefined;
      entry.url = current;
      this.onEvent({
        kind: 'tab.state',
        tabId: entry.tabId,
        url: current,
        title,
        loading: false,
      });
    };

    const onNavigate = (_event: Electron.Event, url: string) => {
      if (wc.isDestroyed()) return;
      entry.url = url;
      this.onEvent({
        kind: 'tab.chrome',
        tabId: entry.tabId,
        url,
        title: wc.getTitle() || undefined,
      });
    };

    const onTitleUpdated = (_event: Electron.Event, title: string) => {
      if (wc.isDestroyed()) return;
      this.onEvent({
        kind: 'tab.chrome',
        tabId: entry.tabId,
        url: wc.getURL() || entry.url,
        title,
      });
    };

    const onFaviconUpdated = (_event: Electron.Event, favicons: string[]) => {
      if (wc.isDestroyed()) return;
      const favicon = favicons.find((f) => typeof f === 'string' && f.trim().length > 0);
      if (!favicon) return;
      this.onEvent({
        kind: 'tab.chrome',
        tabId: entry.tabId,
        url: wc.getURL() || entry.url,
        favicon,
      });
    };

    const onConsoleMessage = (...args: unknown[]) => {
      // Support both Electron 35+ Event-object signature and legacy positional signature.
      let rawLevel: number | string = 1;
      let message = '';
      let lineNumber = 0;
      let sourceId = '';
      const first = args[0] as
        | {
            level?: number | string;
            message?: string;
            lineNumber?: number;
            sourceId?: string;
          }
        | undefined;
      if (first && typeof first === 'object' && typeof first.message === 'string') {
        rawLevel = first.level ?? 1;
        message = first.message;
        lineNumber = typeof first.lineNumber === 'number' ? first.lineNumber : 0;
        sourceId = typeof first.sourceId === 'string' ? first.sourceId : '';
      } else {
        rawLevel = (args[1] as number | string | undefined) ?? 1;
        message = typeof args[2] === 'string' ? args[2] : '';
        lineNumber = typeof args[3] === 'number' ? args[3] : 0;
        sourceId = typeof args[4] === 'string' ? args[4] : '';
      }

      if (message.startsWith(DIMO_PICK_CONSOLE_PREFIX)) {
        const rawJson = message.slice(DIMO_PICK_CONSOLE_PREFIX.length);
        try {
          const parsed = JSON.parse(rawJson) as {
            kind?: string;
            payload?: Record<string, unknown>;
          };
          if (parsed?.kind === 'pick') {
            this.onEvent({
              kind: 'pick',
              tabId: entry.tabId,
              payload: parsed.payload ?? {},
            });
          }
        } catch {
          // Ignore malformed picker message
        }
        return;
      }

      this.onEvent({
        kind: 'console',
        tabId: entry.tabId,
        line: {
          level: normalizeConsoleLevel(rawLevel),
          source: 'console',
          text: message.slice(0, 2_000),
          url: sourceId || undefined,
          line: lineNumber > 0 ? lineNumber : undefined,
          at: Date.now(),
          top: true,
        },
      });
    };

    const enforceNavigationFallback = (event: Electron.Event, url: string) => {
      if (!isAllowedBrowserUrl(url)) {
        event.preventDefault();
        this.onEvent({
          kind: 'navigation.blocked',
          tabId: entry.tabId,
          url,
        });
        return;
      }
      // When session.webRequest.onBeforeRequest is active, async policy checks
      // run at the network layer so POST form submissions and 3xx redirects are
      // never downgraded to GET via loadURL().
      if (
        !this.checkNavigation ||
        url === 'about:blank' ||
        this.webRequestHookedSessions.has(wc.session)
      ) {
        return;
      }
      const approvalKey = `${entry.tabId}\0${url}`;
      if (this.approvedNavigations.delete(approvalKey)) {
        return;
      }
      event.preventDefault();
      void this.checkNavigation(url)
        .then((policy) => {
          if (wc.isDestroyed()) {
            return;
          }
          if (policy.preferSystem) {
            void shell.openExternal(url).catch(() => undefined);
            return;
          }
          if (!policy.allowed) {
            this.onEvent({
              kind: 'navigation.blocked',
              tabId: entry.tabId,
              url,
            });
            return;
          }
          this.approvedNavigations.add(approvalKey);
          void wc.loadURL(url).catch(() => {
            this.approvedNavigations.delete(approvalKey);
          });
        })
        .catch(() => {
          if (!wc.isDestroyed()) {
            this.approvedNavigations.add(approvalKey);
            void wc.loadURL(url).catch(() => {
              this.approvedNavigations.delete(approvalKey);
            });
          }
        });
    };

    const onWillNavigate = (event: Electron.Event, url: string) => {
      enforceNavigationFallback(event, url);
    };

    const onWillRedirect = (event: Electron.Event, url: string) => {
      enforceNavigationFallback(event, url);
    };

    const onDestroyed = () => {
      this.tabIdByWebContentsId.delete(wc.id);
      if (entry.webContentsId === wc.id) {
        entry.webContentsId = null;
        entry.cleanupListeners = null;
      }
    };

    wc.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserUrl(url)) {
        this.onEvent({
          kind: 'popup.denied',
          tabId: entry.tabId,
          url,
        });
        return { action: 'deny' };
      }
      const openInTab = () => {
        const newTabId = crypto.randomUUID();
        this.onEvent({
          kind: 'tab.open',
          tabId: newTabId,
          sourceTabId: entry.tabId,
          url,
          profileId: entry.profileId,
        });
      };
      if (!this.checkNavigation || url === 'about:blank') {
        openInTab();
        return { action: 'deny' };
      }
      void this.checkNavigation(url)
        .then((policy) => {
          if (policy.preferSystem) {
            void shell.openExternal(url).catch(() => undefined);
            return;
          }
          if (!policy.allowed) {
            this.onEvent({
              kind: 'popup.denied',
              tabId: entry.tabId,
              url,
            });
            return;
          }
          openInTab();
        })
        .catch(() => {
          openInTab();
        });
      return { action: 'deny' };
    });

    wc.on('will-navigate', onWillNavigate);
    wc.on('will-redirect', onWillRedirect);
    wc.on('did-start-loading', onStartLoading);
    wc.on('did-stop-loading', onStopLoading);
    wc.on('did-navigate', onNavigate);
    wc.on('did-navigate-in-page', onNavigate);
    wc.on('page-title-updated', onTitleUpdated);
    wc.on('page-favicon-updated', onFaviconUpdated);
    // Cast avoids strict overload drift across Electron minor versions.
    (wc as unknown as NodeJS.EventEmitter).on('console-message', onConsoleMessage);
    wc.once('destroyed', onDestroyed);

    entry.cleanupListeners = () => {
      this.tabIdByWebContentsId.delete(wc.id);
      if (!wc.isDestroyed()) {
        wc.removeListener('will-navigate', onWillNavigate);
        wc.removeListener('will-redirect', onWillRedirect);
        wc.removeListener('did-start-loading', onStartLoading);
        wc.removeListener('did-stop-loading', onStopLoading);
        wc.removeListener('did-navigate', onNavigate);
        wc.removeListener('did-navigate-in-page', onNavigate);
        wc.removeListener('page-title-updated', onTitleUpdated);
        wc.removeListener('page-favicon-updated', onFaviconUpdated);
        (wc as unknown as NodeJS.EventEmitter).removeListener(
          'console-message',
          onConsoleMessage
        );
        wc.removeListener('destroyed', onDestroyed);
      }
      if (entry.webContentsId === wc.id) {
        entry.webContentsId = null;
      }
      entry.cleanupListeners = null;
    };

    if (entry.zoomFactor !== 1.0 && !wc.isDestroyed()) {
      wc.setZoomFactor(entry.zoomFactor);
    }
    if (entry.device !== 'desktop') {
      void applyDevicePreset(wc, entry.device);
    }

    // Sync initial chrome/loading state in case the page already finished before dom-ready attach.
    if (!wc.isDestroyed()) {
      const currentUrl = wc.getURL() || entry.url;
      entry.url = currentUrl;
      this.onEvent({
        kind: 'tab.state',
        tabId: entry.tabId,
        url: currentUrl,
        title: wc.getTitle() || undefined,
        loading: wc.isLoading(),
      });
    }

    const waiters = entry.attachWaiters.splice(0, entry.attachWaiters.length);
    for (const resolve of waiters) {
      resolve(wc);
    }
  }

  private detachEntryListeners(entry: TabState): void {
    entry.cleanupListeners?.();
    entry.cleanupListeners = null;
    entry.webContentsId = null;
  }

  private ensureSessionHooks(sess: Session): void {
    if (this.hookedSessions.has(sess)) {
      return;
    }
    this.hookedSessions.add(sess);

    // Deny sensitive device/OS permission prompts from untrusted Host Browser pages.
    sess.setPermissionRequestHandler?.((_wc, _permission, callback) => {
      callback(false);
    });
    sess.setPermissionCheckHandler?.(() => false);

    if (sess.webRequest?.onBeforeRequest) {
      this.webRequestHookedSessions.add(sess);
      sess.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] },
        (details, callback) => {
          const wcId = details.webContentsId;
          const tabId =
            wcId !== undefined ? this.tabIdByWebContentsId.get(wcId) : undefined;
          if (!tabId || !this.checkNavigation) {
            callback({ cancel: false });
            return;
          }
          const url = details.url;
          void this.checkNavigation(url)
            .then((policy) => {
              if (policy.preferSystem) {
                void shell.openExternal(url).catch(() => undefined);
                callback({ cancel: true });
                return;
              }
              if (!policy.allowed) {
                this.onEvent({
                  kind: 'navigation.blocked',
                  tabId,
                  url,
                });
                callback({ cancel: true });
                return;
              }
              callback({ cancel: false });
            })
            .catch(() => {
              callback({ cancel: false });
            });
        }
      );
    }

    sess.on('will-download', (_event, item: DownloadItem, wc: WebContents) => {
      const tabId = this.tabIdByWebContentsId.get(wc.id);
      const downloadId = crypto.randomUUID();
      const rawFilename = item.getFilename();
      const downloadsDir = this.getDownloadsDir();
      let filename = rawFilename;
      let reservedPath: string | null = null;
      if (downloadsDir) {
        const resolved = resolveUniqueDownloadPath(
          downloadsDir,
          rawFilename,
          this.reservedDownloadPaths
        );
        filename = resolved.filename;
        reservedPath = resolved.savePath;
        this.reservedDownloadPaths.add(reservedPath);
        item.setSavePath(resolved.savePath);
      }
      this.onEvent({
        kind: 'download',
        tabId,
        id: downloadId,
        filename,
        url: item.getURL(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: 'progressing',
      });
      item.on('updated', () => {
        this.onEvent({
          kind: 'download',
          tabId,
          id: downloadId,
          filename,
          url: item.getURL(),
          totalBytes: item.getTotalBytes(),
          receivedBytes: item.getReceivedBytes(),
          state: item.isPaused() ? 'paused' : 'progressing',
        });
      });
      item.once('done', (_doneEvent, state) => {
        if (reservedPath) {
          this.reservedDownloadPaths.delete(reservedPath);
        }
        this.onEvent({
          kind: 'download',
          tabId,
          id: downloadId,
          filename,
          path: item.getSavePath(),
          url: item.getURL(),
          totalBytes: item.getTotalBytes(),
          receivedBytes: item.getReceivedBytes(),
          state,
        });
      });
    });
  }

  private requireEntry(params: Record<string, unknown>): TabState {
    const tabId = typeof params.tabId === 'string' ? params.tabId.trim() : '';
    if (!tabId) {
      throw new BrowserRpcError('browser_invalid', 'tabId is required');
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      throw new BrowserRpcError('browser_no_such_tab', `no tab ${tabId}`);
    }
    return entry;
  }

  private getAttachedWebContents(entry: TabState): WebContents | null {
    if (entry.webContentsId === null) {
      return null;
    }
    const wc = webContents.fromId(entry.webContentsId);
    if (!wc || wc.isDestroyed()) {
      entry.webContentsId = null;
      return null;
    }
    return wc;
  }

  private async waitForOrCreateWebContents(
    entry: TabState
  ): Promise<WebContents> {
    const existing = this.getAttachedWebContents(entry);
    if (existing) {
      return existing;
    }

    const waited = await new Promise<WebContents | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const idx = entry.attachWaiters.indexOf(onAttach);
          if (idx >= 0) entry.attachWaiters.splice(idx, 1);
          resolve(null);
        }
      }, ATTACH_WAIT_TIMEOUT_MS);
      const onAttach = (wc: WebContents) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(wc);
        }
      };
      entry.attachWaiters.push(onAttach);
    });

    if (waited && !waited.isDestroyed()) {
      return waited;
    }

    // Headless fallback for agent-opened tabs with no mounted frontend <webview>.
    const width = Math.max(320, Math.round(entry.bounds.width ?? 1280));
    const height = Math.max(240, Math.round(entry.bounds.height ?? 800));
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: partitionForProfile(entry.profileId, entry.tabId),
      },
    });
    entry.headlessWindow = win;
    const wc = win.webContents;
    this.bindWebContentsToEntry(entry, wc);

    const targetUrl = isAllowedBrowserUrl(entry.url) ? entry.url : 'about:blank';
    await Promise.race([
      win.loadURL(targetUrl).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, HEADLESS_LOAD_TIMEOUT_MS)),
    ]);

    return wc;
  }

  private async rpcOpen(params: Record<string, unknown>): Promise<{ ok: true }> {
    const tabId = typeof params.tabId === 'string' ? params.tabId.trim() : '';
    const url =
      typeof params.url === 'string' && params.url.trim().length > 0
        ? params.url.trim()
        : 'about:blank';
    const profileId =
      typeof params.profileId === 'string' && params.profileId.trim().length > 0
        ? params.profileId.trim()
        : 'default';
    const bounds =
      params.bounds && typeof params.bounds === 'object'
        ? (params.bounds as BrowserBoundsInput)
        : {};

    if (!tabId) {
      throw new BrowserRpcError('browser_invalid', 'tabId is required');
    }
    if (!isAllowedBrowserUrl(url)) {
      throw new BrowserRpcError(
        'browser_bad_address',
        'only http(s) addresses or about:blank can open in a tab'
      );
    }

    const existing = this.tabs.get(tabId);
    if (existing) {
      existing.url = url;
      existing.profileId = profileId;
      existing.bounds = bounds;
      const wc = this.getAttachedWebContents(existing);
      if (wc && wc.getURL() !== url) {
        void wc.loadURL(url).catch(() => undefined);
      }
      return { ok: true };
    }

    this.tabs.set(tabId, {
      tabId,
      profileId,
      url,
      bounds,
      webContentsId: null,
      headlessWindow: null,
      zoomFactor: 1.0,
      device: 'desktop',
      cleanupListeners: null,
      attachWaiters: [],
    });
    return { ok: true };
  }

  private async rpcNavigate(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const url = typeof params.url === 'string' ? params.url.trim() : '';
    if (!isAllowedBrowserUrl(url)) {
      throw new BrowserRpcError(
        'browser_bad_address',
        'only http(s) addresses or about:blank can open in a tab'
      );
    }
    entry.url = url;
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      await wc.loadURL(url);
    }
    return { ok: true };
  }

  private async rpcClose(params: Record<string, unknown>): Promise<{ ok: true }> {
    const tabId = typeof params.tabId === 'string' ? params.tabId.trim() : '';
    const entry = this.tabs.get(tabId);
    if (!entry) {
      return { ok: true };
    }
    this.detachEntryListeners(entry);
    if (entry.headlessWindow && !entry.headlessWindow.isDestroyed()) {
      entry.headlessWindow.destroy();
      entry.headlessWindow = null;
    }
    this.tabs.delete(tabId);
    return { ok: true };
  }

  private async rpcSetBounds(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const tabId = typeof params.tabId === 'string' ? params.tabId.trim() : '';
    const entry = this.tabs.get(tabId);
    if (entry && params.bounds && typeof params.bounds === 'object') {
      entry.bounds = params.bounds as BrowserBoundsInput;
      if (entry.headlessWindow && !entry.headlessWindow.isDestroyed()) {
        const w = Math.max(320, Math.round(entry.bounds.width ?? 1280));
        const h = Math.max(240, Math.round(entry.bounds.height ?? 800));
        entry.headlessWindow.setContentSize(w, h);
      }
    }
    return { ok: true };
  }

  private async rpcEval(params: Record<string, unknown>): Promise<string> {
    const entry = this.requireEntry(params);
    const expression =
      typeof params.expression === 'string' ? params.expression : '';
    const wc = await this.waitForOrCreateWebContents(entry);
    return evaluateExpression(wc, expression);
  }

  private async rpcCurrentUrl(params: Record<string, unknown>): Promise<string> {
    const entry = this.requireEntry(params);
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      const current = wc.getURL();
      if (current) {
        entry.url = current;
      }
    }
    return entry.url || 'about:blank';
  }

  private async rpcHistory(
    params: Record<string, unknown>,
    direction: 'back' | 'forward'
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      if (direction === 'back' && wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack();
      } else if (direction === 'forward' && wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward();
      }
    }
    return { ok: true };
  }

  private async rpcReload(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      wc.reload();
    }
    return { ok: true };
  }

  private async rpcStop(params: Record<string, unknown>): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      wc.stop();
    }
    return { ok: true };
  }

  private async rpcFind(params: Record<string, unknown>): Promise<boolean> {
    const entry = this.requireEntry(params);
    const query = typeof params.query === 'string' ? params.query : '';
    const forward = params.forward !== false;
    const wc = this.getAttachedWebContents(entry);
    if (!wc) {
      return false;
    }
    if (query.trim().length === 0) {
      wc.stopFindInPage('clearSelection');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          wc.removeListener('found-in-page', onFound);
          resolve(false);
        }
      }, 1_500);
      const onFound = (
        _event: Electron.Event,
        result: Electron.Result
      ) => {
        if (result.finalUpdate && !settled) {
          settled = true;
          clearTimeout(timer);
          wc.removeListener('found-in-page', onFound);
          resolve(result.matches > 0);
        }
      };
      wc.on('found-in-page', onFound);
      wc.findInPage(query, { forward });
    });
  }

  private async rpcSetZoom(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const factor =
      typeof params.factor === 'number' && Number.isFinite(params.factor)
        ? Math.min(3.0, Math.max(0.25, params.factor))
        : 1.0;
    entry.zoomFactor = factor;
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      wc.setZoomFactor(factor);
    }
    return { ok: true };
  }

  private async rpcOpenDevtools(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const wc = await this.waitForOrCreateWebContents(entry);
    wc.openDevTools({ mode: 'detach' });
    return { ok: true };
  }

  private async rpcSetDevice(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const device = typeof params.device === 'string' ? params.device : 'desktop';
    entry.device = device;
    const wc = this.getAttachedWebContents(entry);
    if (wc) {
      await applyDevicePreset(wc, device);
    }
    return { ok: true };
  }

  private async rpcInject(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const entry = this.requireEntry(params);
    const script = typeof params.script === 'string' ? params.script : '';
    const wc = await this.waitForOrCreateWebContents(entry);
    await injectScript(wc, script);
    return { ok: true };
  }

  private async rpcFreezeFrame(
    params: Record<string, unknown>
  ): Promise<FrozenFramePayload | null> {
    const entry = this.requireEntry(params);
    const wc = await this.waitForOrCreateWebContents(entry);
    return captureFreezeFrame(wc);
  }

  private async rpcCapturePng(
    params: Record<string, unknown>
  ): Promise<string> {
    const entry = this.requireEntry(params);
    const wc = await this.waitForOrCreateWebContents(entry);
    return capturePngBase64(wc);
  }

  private async rpcClearProfile(
    params: Record<string, unknown>
  ): Promise<{ ok: true }> {
    const profileId =
      typeof params.profileId === 'string' ? params.profileId.trim() : 'default';
    const partition = partitionForProfile(profileId);
    const targetSession = session.fromPartition(partition);
    await targetSession.clearStorageData();
    await targetSession.clearCache();
    return { ok: true };
  }

  private async rpcResetAll(): Promise<{ ok: true }> {
    const seenProfiles = new Set<string>(['default']);
    for (const entry of this.tabs.values()) {
      seenProfiles.add(entry.profileId);
    }
    this.destroy();
    for (const profileId of seenProfiles) {
      const partition = partitionForProfile(profileId);
      const targetSession = session.fromPartition(partition);
      await targetSession.clearStorageData().catch(() => undefined);
      await targetSession.clearCache().catch(() => undefined);
    }
    return { ok: true };
  }
}
