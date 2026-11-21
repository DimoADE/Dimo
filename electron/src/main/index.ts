import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, protocol } from 'electron';

import { isHostWindowLabel } from '../shared/ipcContract';
import { ElectronBrowserController } from './browser/controller';
import { NativeTabsRpcClient } from './browser/nativeTabsRpc';
import { DesktopChromeManager } from './chrome';
import { installCrashHandlers } from './crashReporter';
import { DeepLinkManager } from './deeplink';
import { DesktopToastManager } from './desktopToast';
import { registerIpcHandlers } from './ipc';
import {
  PreviewAssetScope,
  registerPrivilegedSchemes,
  registerProtocolHandlers,
  registerProtocolHandlersForSession,
} from './protocol';
import { SidecarManager } from './sidecar';
import { DesktopUpdaterManager } from './updater';
import { resolveDefaultIconPath, WindowManager } from './windows';

function resolveBootstrapConfigPath(): string {
  const explicit = process.env.DIMO_BOOTSTRAP_CONFIG_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'dimo', 'dimo', 'config', 'bootstrap.json');
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'app.dimo.dimo',
      'bootstrap.json'
    );
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'dimo', 'bootstrap.json');
}

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

function resolveDefaultDataDir(repoRoot?: string): string {
  const explicit = process.env.DIMO_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    const bootstrapRaw = fs.readFileSync(resolveBootstrapConfigPath(), 'utf8');
    const parsed = JSON.parse(bootstrapRaw) as { custom_data_dir?: unknown };
    if (
      typeof parsed.custom_data_dir === 'string' &&
      parsed.custom_data_dir.trim().length > 0 &&
      path.isAbsolute(parsed.custom_data_dir.trim())
    ) {
      return parsed.custom_data_dir.trim();
    }
  } catch {
    // Ignore missing or unreadable bootstrap.json.
  }
  if (!app.isPackaged && repoRoot) {
    return path.join(repoRoot, 'dev_assets');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'dimo', 'dimo', 'data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'app.dimo.dimo');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'dimo');
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
  ? 'com.dimo.desktop'
  : 'com.dimo.desktop.dev';

// Must execute synchronously before `app.whenReady()`.
app.setName('Dimo');
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
registerPrivilegedSchemes(protocol);
applyRenderingAccelerationMode(resolveDefaultDataDir(resolveRepoRoot()));

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
  let exitPrepPromise: Promise<void> | null = null;
  let activeDataDir: string | undefined = process.env.DIMO_DATA_DIR?.trim() || undefined;

  deeplinks.registerProtocolClient(app);

  // Capture macOS `open-url` events even if they arrive before `app.whenReady()`.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deeplinks.handleUrl(url);
  });

  const uninstallCrashHandlers = installCrashHandlers({
    sidecar,
    appVersion: app.getVersion(),
    getDataDir: () =>
      sidecar.getDataDir() ?? activeDataDir ?? resolveDefaultDataDir(resolveRepoRoot()),
  });

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
      activeDataDir = process.env.DIMO_DATA_DIR?.trim() || undefined;
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
      });
      activeDataDir = sidecar.getDataDir() ?? activeDataDir ?? resolveDefaultDataDir(repoRoot);

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
        onWindowClosed: (label, windowStillOpen) => {
          void sidecar.notifyWindowDestroyed(label, windowStillOpen).then(() => {
            if (isHostWindowLabel(label)) {
              windows?.broadcastEvent('host-client-changed', undefined);
            }
          });
        },
      });

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
        beforeQuitForUpdate: prepareForExit,
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
