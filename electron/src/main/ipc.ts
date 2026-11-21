import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  HOST_CLIENT_MUTATING_COMMANDS,
  IPC_CHANNELS,
  SERVER_DESKTOP_COMMANDS,
  hostAppWindowLabel,
  hostWindowLabel,
  type BootstrapPayload,
  type DesktopToastPayload,
  type HostClientProfileView,
} from '../shared/ipcContract';
import type { ElectronBrowserController } from './browser/controller';
import type { NativeTabsRpcClient } from './browser/nativeTabsRpc';
import type { DesktopChromeManager } from './chrome';
import type { DeepLinkManager } from './deeplink';
import type { DesktopToastManager } from './desktopToast';
import {
  joinLocalPath,
  openExternalTarget,
  readLocalFile,
  revealInFileManager,
  showOpenDialog,
  showSaveDialog,
  writeLocalFile,
  writeLocalTextFile,
  type DesktopOpenDialogOptions,
  type DesktopSaveDialogOptions,
} from './osBridge';
import type { PreviewAssetScope } from './protocol';
import type { SidecarManager } from './sidecar';
import type { DesktopUpdaterManager } from './updater';
import type { WindowManager } from './windows';

export interface IpcContext {
  appVersion: string;
  windows: WindowManager;
  sidecar: SidecarManager;
  assetScope: PreviewAssetScope;
  toast: DesktopToastManager;
  deeplinks: DeepLinkManager;
  chrome: DesktopChromeManager;
  browser: ElectronBrowserController;
  browserRpc: NativeTabsRpcClient;
  updater: DesktopUpdaterManager;
  onExitRequested: () => Promise<void>;
}

const HOST_CLIENT_CHANGED_EVENT = 'host-client-changed';

function extractHostProfile(value: unknown): HostClientProfileView | null {
  if (typeof value !== 'object' || value === null || !('profile' in value)) {
    return null;
  }
  const profile = (value as { profile?: unknown }).profile;
  if (typeof profile !== 'object' || profile === null) {
    return null;
  }
  const id = (profile as { id?: unknown }).id;
  const name = (profile as { name?: unknown }).name;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return null;
  }
  return {
    id,
    name: typeof name === 'string' ? name : '',
  };
}

function extractToastPayload(
  args?: Record<string, unknown>
): DesktopToastPayload | null {
  const candidate =
    args && typeof args.payload === 'object' && args.payload !== null
      ? (args.payload as Record<string, unknown>)
      : args;
  if (!candidate) {
    return null;
  }
  const projectId =
    typeof candidate.projectId === 'string' ? candidate.projectId : '';
  const workspaceId =
    typeof candidate.workspaceId === 'string' ? candidate.workspaceId : '';
  const sessionId =
    typeof candidate.sessionId === 'string' ? candidate.sessionId : '';
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  const description =
    typeof candidate.description === 'string' ? candidate.description : '';
  const kind =
    candidate.kind === 'error' || candidate.kind === 'success'
      ? candidate.kind
      : 'success';
  const durationMs =
    typeof candidate.durationMs === 'number' ? candidate.durationMs : null;

  return {
    projectId,
    workspaceId,
    sessionId,
    title,
    description,
    kind,
    durationMs,
  };
}

export function registerIpcHandlers(context: IpcContext): void {
  const {
    appVersion,
    windows,
    sidecar,
    assetScope,
    toast,
    deeplinks,
    chrome,
    browser,
    browserRpc,
    updater,
    onExitRequested,
  } = context;

  ipcMain.on(IPC_CHANNELS.BOOTSTRAP_SYNC, (event) => {
    const windowLabel = windows.getLabelForWebContents(event.sender);
    const payload: BootstrapPayload = {
      windowLabel,
      platform: process.platform,
      appVersion,
      backend: sidecar.getConnection(),
    };
    event.returnValue = payload;
  });

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, () => appVersion);

  // Window controls
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    windows.getWindowForWebContents(event.sender)?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = windows.getWindowForWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (event) => {
    return windows.getWindowForWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    windows.getWindowForWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_SHOW, (event) => {
    windows.getWindowForWebContents(event.sender)?.show();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_HIDE, (event) => {
    windows.getWindowForWebContents(event.sender)?.hide();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_FOCUS, (event) => {
    windows.getWindowForWebContents(event.sender)?.focus();
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_TITLE, (event, title: string) => {
    if (typeof title === 'string') {
      windows.getWindowForWebContents(event.sender)?.setTitle(title);
    }
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_START_DRAGGING, () => {
    // Window dragging in Electron is handled natively via CSS `-webkit-app-region: drag`.
  });

  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_ZOOM, (event, scale: number) => {
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) {
      event.sender.setZoomFactor(scale);
    }
  });

  // Dialogs
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_OPEN,
    (event, options?: DesktopOpenDialogOptions) =>
      showOpenDialog(windows.getWindowForWebContents(event.sender), options)
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SAVE,
    (event, options?: DesktopSaveDialogOptions) =>
      showSaveDialog(windows.getWindowForWebContents(event.sender), options)
  );

  // Local FS & path helpers
  ipcMain.handle(IPC_CHANNELS.FS_READ_FILE, (_event, filePath: string) =>
    readLocalFile(filePath)
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_WRITE_FILE,
    (_event, filePath: string, contents: Uint8Array) =>
      writeLocalFile(filePath, contents)
  );

  ipcMain.handle(
    IPC_CHANNELS.FS_WRITE_TEXT_FILE,
    (_event, filePath: string, contents: string) =>
      writeLocalTextFile(filePath, contents)
  );

  ipcMain.handle(IPC_CHANNELS.PATH_JOIN, (_event, parts: string[]) =>
    joinLocalPath(...parts)
  );

  // External shell
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, (_event, target: string) =>
    openExternalTarget(target)
  );

  // Cross-window event bus
  ipcMain.handle(
    IPC_CHANNELS.EVENTS_EMIT,
    (_event, name: string, payload?: unknown) => {
      if (typeof name === 'string' && name.length > 0) {
        windows.broadcastEvent(name, payload);
      }
    }
  );

  // Electron auto-updater handlers (electron-updater)
  ipcMain.handle(
    IPC_CHANNELS.UPDATER_CHECK,
    (_event, options?: { timeout?: number }) => updater.check(options)
  );
  ipcMain.handle(
    IPC_CHANNELS.UPDATER_DOWNLOAD,
    (event, token: string) =>
      updater.download(token, (payload) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_CHANNELS.UPDATER_DOWNLOAD_EVENT, payload);
        }
      })
  );
  ipcMain.handle(IPC_CHANNELS.UPDATER_INSTALL, (_event, token: string) =>
    updater.install(token)
  );
  ipcMain.handle(IPC_CHANNELS.UPDATER_CLOSE, (_event, token: string) =>
    updater.close(token)
  );
  ipcMain.handle(IPC_CHANNELS.UPDATER_RELAUNCH, () => updater.relaunch());

  // Shell & migrated desktop command dispatcher
  ipcMain.handle(
    IPC_CHANNELS.SHELL_INVOKE,
    async (
      event: IpcMainInvokeEvent,
      cmd: string,
      args?: Record<string, unknown>
    ) => {
      const callerLabel = windows.getLabelForWebContents(event.sender);

      if (SERVER_DESKTOP_COMMANDS.has(cmd)) {
        const result = await sidecar.invokeDesktopCommand(
          cmd,
          args,
          callerLabel
        );

        // Side effect: `host_client_connect` opens or focuses the dedicated `host-<id>` window.
        if (cmd === 'host_client_connect') {
          const profile = extractHostProfile(result);
          if (profile) {
            try {
              windows.openOrFocusHostWindow(profile);
            } catch (error) {
              await sidecar
                .invokeDesktopCommand(
                  'host_client_disconnect',
                  {},
                  hostWindowLabel(profile.id)
                )
                .catch(() => {});
              throw error;
            }
          }
        }

        // Side effect: `host_client_disconnect` from a host family window closes that host family.
        if (
          cmd === 'host_client_disconnect' &&
          hostAppWindowLabel(callerLabel) !== null
        ) {
          windows.closeHostFamily(callerLabel);
        }

        if (
          typeof result === 'object' &&
          result !== null &&
          'closedWindows' in result &&
          Array.isArray((result as { closedWindows?: unknown }).closedWindows)
        ) {
          const closedLabels = (
            result as { closedWindows: unknown[] }
          ).closedWindows.filter(
            (item): item is string => typeof item === 'string'
          );
          windows.closeWindowsByLabels(closedLabels);
        }

        if (
          cmd === 'host_client_set_sync_account' ||
          cmd === 'host_client_merge_sync_profiles'
        ) {
          const changed =
            typeof result === 'object' && result !== null && 'changed' in result
              ? Boolean((result as { changed?: unknown }).changed)
              : Boolean(result);
          if (changed) {
            windows.broadcastEvent(HOST_CLIENT_CHANGED_EVENT, undefined);
          }
          return changed;
        }

        if (cmd === 'host_client_delete') {
          windows.broadcastEvent(HOST_CLIENT_CHANGED_EVENT, undefined);
          return null;
        }

        if (HOST_CLIENT_MUTATING_COMMANDS.has(cmd)) {
          windows.broadcastEvent(HOST_CLIENT_CHANGED_EVENT, undefined);
        }
        return result;
      }

      switch (cmd) {
        case 'health_check': {
          const status = await sidecar.healthCheck();
          return status.status === 'ok' ? 'ok' : status.status;
        }
        case 'reveal_main_window': {
          windows.revealWindow(callerLabel);
          return null;
        }
        case 'exit_app': {
          await onExitRequested();
          return null;
        }
        case 'allow_preview_asset_scope': {
          const pathArg =
            typeof args?.path === 'string' ? args.path : undefined;
          const directoriesArg = Array.isArray(args?.directories)
            ? args.directories.filter(
                (entry): entry is string => typeof entry === 'string'
              )
            : undefined;
          return assetScope.allow({
            path: pathArg,
            directories: directoriesArg,
          });
        }
        case 'reveal_in_file_manager': {
          const targetPath = typeof args?.path === 'string' ? args.path : '';
          await revealInFileManager(targetPath);
          return null;
        }
        case 'open_settings_window': {
          windows.openSettingsWindow(callerLabel, {
            title: typeof args?.title === 'string' ? args.title : undefined,
            path: typeof args?.path === 'string' ? args.path : undefined,
          });
          return null;
        }
        case 'open_app_window': {
          return windows.openAppWindow();
        }
        case 'is_main_window_focused': {
          return windows.isMainWindowFocused();
        }
        case 'get_developer_mode': {
          const enabled = Boolean(
            await sidecar.invokeDesktopCommand(
              'get_developer_mode',
              {},
              callerLabel
            )
          );
          windows.applyDeveloperMode(enabled);
          return enabled;
        }
        case 'set_developer_mode': {
          const enabled = Boolean(args?.enabled);
          const persisted = Boolean(
            await sidecar.invokeDesktopCommand(
              'set_developer_mode',
              { enabled },
              callerLabel
            )
          );
          windows.applyDeveloperMode(persisted);
          return persisted;
        }
        case 'open_developer_tools':
        case 'open_devtools': {
          if (!windows.isDeveloperModeEnabled()) {
            const persisted = Boolean(
              await sidecar
                .invokeDesktopCommand('get_developer_mode', {}, callerLabel)
                .catch(() => false)
            );
            windows.applyDeveloperMode(persisted);
            if (!persisted) {
              throw new Error('Developer mode is off');
            }
          }
          event.sender.openDevTools({ mode: 'detach' });
          return null;
        }
        case 'take_pending_model_router_import': {
          return deeplinks.takePendingModelRouterImport();
        }
        case 'show_desktop_toast': {
          const payload = extractToastPayload(args);
          if (payload) {
            toast.show(payload);
          }
          return null;
        }
        case 'activate_desktop_toast': {
          const payload = extractToastPayload(args);
          if (payload) {
            toast.activate(payload);
          }
          return null;
        }
        case 'hide_desktop_toast': {
          toast.hide();
          return null;
        }
        case 'desktop_toast_window_ready': {
          return toast.markWindowReady();
        }
        case 'update_tray_badge': {
          const count = typeof args?.count === 'number' ? args.count : 0;
          chrome.updateTrayBadge(count);
          return null;
        }
        case 'set_app_icon': {
          const style = typeof args?.style === 'string' ? args.style : 'default';
          const theme = typeof args?.theme === 'string' ? args.theme : 'light';
          chrome.setAppIcon(callerLabel, style, theme);
          return null;
        }
        case 'electron_browser_attach': {
          const tabId = typeof args?.tabId === 'string' ? args.tabId : '';
          const webContentsId =
            typeof args?.webContentsId === 'number' ? args.webContentsId : -1;
          const profileId =
            typeof args?.profileId === 'string' ? args.profileId : undefined;
          const url = typeof args?.url === 'string' ? args.url : undefined;
          return browser.attachWebContents({
            tabId,
            webContentsId,
            profileId,
            url,
          });
        }
        case 'electron_browser_detach': {
          const tabId = typeof args?.tabId === 'string' ? args.tabId : '';
          const webContentsId =
            typeof args?.webContentsId === 'number'
              ? args.webContentsId
              : undefined;
          return browser.detachWebContents(tabId, webContentsId);
        }
        case 'electron_browser_capture_thumbnail': {
          const tabId = typeof args?.tabId === 'string' ? args.tabId : '';
          return browser.captureThumbnail(tabId);
        }
        case 'electron_browser_bridge_status': {
          return { connected: browserRpc.isConnected() };
        }
        default: {
          throw new Error(`Unsupported Electron shell command: ${cmd}`);
        }
      }
    }
  );
}
