import fs from 'node:fs';
import path from 'node:path';

import { app, protocol, session } from 'electron';

import {
  DEFAULT_APP_USER_MODEL_ID,
  SIDECAR_EXITED_EVENT,
  SIDECAR_RESTARTED_EVENT,
  isHostWindowLabel,
} from '../shared/ipcContract';
import { ElectronBrowserController } from './browser/controller';
import { NativeTabsRpcClient } from './browser/nativeTabsRpc';
import { DesktopChromeManager } from './chrome';
import { createCrashRecorder, installCrashHandlers } from './crashReporter';
import { DeepLinkManager } from './deeplink';
import { DesktopToastManager } from './desktopToast';
import { registerIpcHandlers } from './ipc';
import {
  PreviewAssetScope,
  registerPrivilegedSchemes,
  registerProtocolHandlers,
  registerProtocolHandlersForSession,
} from './protocol';
import {
  SidecarManager,
  resolveDefaultDataDir,
  resolveEnvDataDir,
} from './sidecar';
import { DesktopUpdaterManager } from './updater';
import {
  installSessionPermissionHandlers,
  resolveDefaultIconPath,
  WindowManager,
} from './windows';

function resolveRepoRoot(): string | undefined {
  if (app.isPackaged) {
    return undefined;
  }
  // `electron/dist/main/index.js` -> repo root is 3 levels up.
  const candidate = path.resolve(__dirname, '..', '..', '..');
  if (fs.existsSync(path.join(candidate, 'pnpm-workspace.yaml'))) {
    return candidate;
  }
  return undefined;
}

function resolveCurrentDefaultDataDir(repoRoot?: string): string {
  return resolveDefaultDataDir({
    isPackaged: app.isPackaged,
    repoRoot,
  });
}

function applyRenderingAccelerationMode(dataDir: string): void {
  let mode = 'auto';
  try {
    const settingsPath = path.join(dataDir, 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      system?: { rendering?: { acceleration_mode?: unknown } };
    };
    const candidate = parsed.system?.rendering?.acceleration_mode;
    if (candidate === 'disable_gpu' || candidate === 'force_gpu' || candidate === 'auto') {
      mode = candidate;
    }
  } catch {
    // Ignore when settings.json does not exist yet.
  }

  if (mode === 'disable_gpu') {
    app.disableHardwareAcceleration();
  } else if (mode === 'force_gpu') {
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
  }
}

const APP_USER_MODEL_ID = app.isPackaged
  ? DEFAULT_APP_USER_MODEL_ID
  : `${DEFAULT_APP_USER_MODEL_ID}.dev`;

// Must execute synchronously before `app.whenReady()`.
app.setName('Dimo');
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
registerPrivilegedSchemes(protocol);
applyRenderingAccelerationMode(resolveCurrentDefaultDataDir(resolveRepoRoot()));

// Enable smooth Wayland/X11 Ozone detection on Linux when not explicitly set.
if (process.platform === 'linux' && !process.env.ELECTRON_OZONE_PLATFORM_HINT) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

function resolveFrontendDistDir(repoRoot?: string): string {
  if (process.env.DIMO_FRONTEND_DIST) {
    return process.env.DIMO_FRONTEND_DIST;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'frontend-dist');
  }
  if (repoRoot) {
    return path.join(repoRoot, 'frontend', 'dist');
  }
  return path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist');
}

function resolvePreloadPath(): string {
  return path.resolve(__dirname, '..', 'preload', 'index.js');
}

function resolveResourcesDir(repoRoot?: string): string | undefined {
  if (process.env.DIMO_RESOURCES_DIR) {
    return process.env.DIMO_RESOURCES_DIR;
  }
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return repoRoot;
}

const smokeMode = process.env.DIMO_ELECTRON_SMOKE === '1';
const allowMultiInstance = process.env.DIMO_ALLOW_MULTI_INSTANCE === '1';
const gotLock = allowMultiInstance ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  const sidecar = new SidecarManager();
  const assetScope = new PreviewAssetScope();
  const deeplinks = new DeepLinkManager();
  const getDownloadsDir = () => {
    try {
      return app.getPath('downloads');
    } catch {
      return undefined;
    }
  };
  let browserRpc: NativeTabsRpcClient | null = null;
  const browser = new ElectronBrowserController({
    onEvent: (payload) => {
      browserRpc?.sendEvent(payload);
    },
    getDownloadsDir,
    checkNavigation: (url) =>
      browserRpc
        ? browserRpc.checkNavigation(url)
        : Promise.resolve({ allowed: true, preferSystem: false }),
  });
  browser.installWebviewSecurity(app);
  browserRpc = new NativeTabsRpcClient({
    getConnection: () => sidecar.getConnection(),
    controller: browser,
    getDownloadsDir,
  });

  let windows: WindowManager | null = null;
  let toast: DesktopToastManager | null = null;
  let chrome: DesktopChromeManager | null = null;
  let isQuitting = false;
  let installingUpdate = false;
  let exitPrepPromise: Promise<void> | null = null;
  let activeDataDir: string | undefined = resolveEnvDataDir();

  deeplinks.registerProtocolClient(app);

  // Capture macOS `open-url` events even if they arrive before `app.whenReady()`.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deeplinks.handleUrl(url);
  });

  const crashReporterOptions = {
    sidecar,
    appVersion: app.getVersion(),
    getDataDir: () =>
      sidecar.getDataDir() ?? activeDataDir ?? resolveCurrentDefaultDataDir(resolveRepoRoot()),
  };
  const recordCrash = createCrashRecorder(crashReporterOptions);
  const uninstallCrashHandlers = installCrashHandlers(crashReporterOptions);

  const prepareForExit = async (): Promise<void> => {
    if (exitPrepPromise) {
      return exitPrepPromise;
    }
    isQuitting = true;
    exitPrepPromise = (async () => {
      uninstallCrashHandlers();
      browserRpc?.stop();
      browser.destroy();
      windows?.setQuitting(true);
      toast?.destroy();
      chrome?.destroy();
      for (const win of windows?.allWindows() ?? []) {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      }
      await sidecar.shutdown();
    })();
    return exitPrepPromise;
  };

  const prepareForUpdateInstall = async (): Promise<void> => {
    installingUpdate = true;
    await prepareForExit();
  };

  const gracefulExit = async () => {
    try {
      await prepareForExit();
    } finally {
      app.quit();
    }
  };

  app.on('second-instance', (_event, argv) => {
    deeplinks.handleProcessArgs(argv, { isStartup: false });
  });

  app.on('before-quit', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      void gracefulExit();
    }
  });

  app.on('window-all-closed', () => {
    if (isQuitting || installingUpdate) {
      return;
    }
    if (process.platform !== 'darwin' && !windows?.isTrayEnabled()) {
      void gracefulExit();
    }
  });

  app.on('activate', () => {
    if (windows && !windows.getMainWindow()) {
      windows.createMainWindow();
    } else {
      windows?.showMainWindow();
    }
  });

  const handleSignal = () => {
    void gracefulExit();
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  void app
    .whenReady()
    .then(async () => {
      const repoRoot = resolveRepoRoot();
      const frontendDistDir = resolveFrontendDistDir(repoRoot);
      const preloadPath = resolvePreloadPath();
      const resourcesDir = resolveResourcesDir(repoRoot);
      const devUrl = process.env.DIMO_DEV_URL?.trim() || undefined;
      activeDataDir = resolveEnvDataDir();
      const appVersion = app.getVersion();

      registerProtocolHandlers({
        protocol,
        frontendDistDir,
        assetScope,
      });

      await sidecar.start({
        repoRoot,
        resourcesDir,
        dataDir: activeDataDir,
        appVersion,
        onUnexpectedExit: (info) => {
          const summary = `dimo-server exited unexpectedly (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'}, willRestart=${info.willRestart})`;
          recordCrash('electron-sidecar:unexpected-exit', summary);
          windows?.broadcastEvent(SIDECAR_EXITED_EVENT, info);
        },
        onRestarted: (connection, attempt) => {
          activeDataDir =
            sidecar.getDataDir() ?? activeDataDir ?? resolveCurrentDefaultDataDir(repoRoot);
          browserRpc?.stop();
          browserRpc?.start();
          windows?.broadcastEvent(SIDECAR_RESTARTED_EVENT, {
            backend: connection,
            attempt,
          });
        },
        onRestartFailed: (error, attempt, exhausted) => {
          recordCrash(
            `electron-sidecar:restart-failed-${attempt}`,
            error.message || String(error),
            error.stack
          );
          if (exhausted) {
            windows?.broadcastEvent(SIDECAR_EXITED_EVENT, {
              code: null,
              signal: null,
              willRestart: false,
              attempt,
              maxAttempts: attempt,
              exhausted: true,
            });
          }
        },
      });
      activeDataDir =
        sidecar.getDataDir() ?? activeDataDir ?? resolveCurrentDefaultDataDir(repoRoot);

      browserRpc?.start();

      const iconPath = resolveDefaultIconPath({ resourcesDir, repoRoot });
      windows = new WindowManager({
        preloadPath,
        devUrl,
        iconPath,
        appUserModelId: APP_USER_MODEL_ID,
        smokeMode,
        registerSessionProtocols: (targetSession) => {
          registerProtocolHandlersForSession(targetSession, {
            frontendDistDir,
            assetScope,
          });
        },
        onMainWindowLoaded: () => {
          deeplinks.markMainWindowReady();
        },
        onMainWindowClosed: () => {
          deeplinks.resetMainWindowReady();
        },
        onMainWindowClosedWithoutTray: () => {
          toast?.destroy();
        },
        onWindowClosed: (label, windowStillOpen) => {
          void sidecar.notifyWindowDestroyed(label, windowStillOpen).then(() => {
            if (isHostWindowLabel(label)) {
              windows?.broadcastEvent('host-client-changed', undefined);
            }
          });
        },
      });

      installSessionPermissionHandlers(
        session.defaultSession,
        windows.getAllowedAppOrigin()
      );

      toast = new DesktopToastManager({
        preloadPath,
        windows,
      });

      chrome = new DesktopChromeManager({
        windows,
        resourcesDir,
        repoRoot,
        dataDir: activeDataDir,
        defaultIconPath: iconPath,
        onExitRequested: gracefulExit,
      });
      chrome.install();

      const updater = new DesktopUpdaterManager({
        currentVersion: appVersion,
        deferInstall: true,
        beforeQuitForUpdate: prepareForUpdateInstall,
      });

      // Hydrate persisted developer_mode from shared settings.json.
      const savedDeveloperMode = Boolean(
        await sidecar
          .invokeDesktopCommand('get_developer_mode', {}, 'main')
          .catch(() => false)
      );
      windows.applyDeveloperMode(savedDeveloperMode);

      registerIpcHandlers({
        appVersion,
        windows,
        sidecar,
        assetScope,
        toast,
        deeplinks,
        chrome,
        browser,
        browserRpc: browserRpc!,
        updater,
        onExitRequested: gracefulExit,
      });

      const mainWin = windows.createMainWindow();

      deeplinks.attachHandlers({
        showMainWindow: () => windows?.showMainWindow(),
        openSettingsWindow: (routePath) => {
          windows?.openSettingsWindow('main', { path: routePath });
        },
        openAppWindow: () => {
          windows?.openAppWindow();
        },
        broadcastEvent: (event, payload) => {
          windows?.broadcastEvent(event, payload);
        },
      });
      deeplinks.handleProcessArgs(process.argv, { isStartup: true });

      // Optional smoke-test hook: exits cleanly once the renderer boots and proves bridge + backend + M3/M4 IPC & browser connectivity.
      if (smokeMode) {
        mainWin.webContents.once('did-finish-load', () => {
          void (async () => {
            try {
              const bridgeConnected =
                (await browserRpc?.waitUntilConnected(3_000)) ?? false;

              // Verify real Electron BrowserController + CDP eval & PNG capture
              const smokeTabId = 'smoke-tab-1';
              await browser.handleRpc('open', {
                tabId: smokeTabId,
                url: 'about:blank',
                profileId: 'ephemeral',
              });
              const evalOut = await browser.handleRpc('eval', {
                tabId: smokeTabId,
                expression: 'String(21 * 2)',
              });
              const pngB64 = (await browser.handleRpc('capture_png', {
                tabId: smokeTabId,
              })) as string;
              const pngBytes = Buffer.from(pngB64, 'base64');
              const isValidPng =
                pngBytes.length > 16 &&
                pngBytes[0] === 0x89 &&
                pngBytes[1] === 0x50 &&
                pngBytes[2] === 0x4e &&
                pngBytes[3] === 0x47;
              await browser.handleRpc('close', { tabId: smokeTabId });

              const probe = await mainWin.webContents.executeJavaScript(`(async () => {
                const bridge = window.dimoDesktop;
                if (!bridge) throw new Error('window.dimoDesktop missing');
                const health = await bridge.invoke('health_check');
                const label = bridge.getWindowLabel();
                const devMode = await bridge.invoke('get_developer_mode');
                const pendingImport = await bridge.invoke('take_pending_model_router_import');
                const focused = await bridge.invoke('is_main_window_focused');
                const bridgeStatus = await bridge.invoke('electron_browser_bridge_status');
                await bridge.invoke('update_tray_badge', { count: 3 });
                await bridge.invoke('update_tray_badge', { count: 0 });
                await bridge.invoke('set_app_icon', { style: 'default', theme: 'dark' });
                let devToolsBlocked = false;
                if (!devMode) {
                  try {
                    await bridge.invoke('open_developer_tools');
                  } catch (err) {
                    devToolsBlocked = String(err).includes('Developer mode is off');
                  }
                }
                const res = await fetch(bridge.backend.baseUrl + '/api/v1/capabilities', {
                  headers: {
                    Authorization: 'Bearer ' + bridge.backend.token,
                    'X-Dimo-Protocol-Version': '1.0',
                  },
                });
                if (!res.ok) throw new Error('capabilities HTTP ' + res.status);
                const caps = await res.json();
                return {
                  origin: window.location.origin,
                  label,
                  health,
                  devMode,
                  devToolsBlocked,
                  pendingImport,
                  focusedType: typeof focused,
                  browserBridgeConnected: Boolean(bridgeStatus?.connected),
                  protocolVersion: caps.protocol_version,
                  capabilityCount: Array.isArray(caps.capabilities) ? caps.capabilities.length : 0,
                };
              })()`);
              console.log(
                JSON.stringify({
                  type: 'dimo-electron-smoke-ok',
                  ...probe,
                  bridgeConnected,
                  browserEvalResult: evalOut,
                  browserCaptureValidPng: isValidPng,
                  browserCaptureBytes: pngBytes.length,
                })
              );
              await gracefulExit();
            } catch (error) {
              console.error('[electron:smoke] failed:', error);
              browserRpc?.stop();
              browser.destroy();
              toast?.destroy();
              chrome?.destroy();
              await sidecar.shutdown();
              app.exit(1);
            }
          })();
        });
      }
    })
    .catch(async (error) => {
      console.error('[electron:main] startup failed:', error);
      browserRpc?.stop();
      browser.destroy();
      toast?.destroy();
      chrome?.destroy();
      await sidecar.shutdown();
      app.exit(1);
    });
}
