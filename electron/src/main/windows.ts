import fs from "node:fs";
import path from "node:path";

import {
  BrowserWindow,
  Menu,
  nativeImage,
  session,
  type BrowserWindowConstructorOptions,
  type Input,
  type NativeImage,
  type Session,
  type WebContents,
  shell,
} from "electron";

import {
  DEFAULT_APP_USER_MODEL_ID,
  DESKTOP_APP_ORIGIN,
  IPC_CHANNELS,
  hostAppWindowLabel,
  hostSettingsWindowForApp,
  hostWindowLabel,
  hostWindowTitle,
  isHostWindowLabel,
  isLocalDesktopWindowLabel,
  settingsWindowLabelForCaller,
  type HostClientProfileView,
} from "../shared/ipcContract";

const MAIN_WINDOW_LABEL = "main";
const DESKTOP_TOAST_WINDOW_LABEL = "desktop-toast";
const REVEAL_FALLBACK_MS = 2_500;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_APP_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "notifications",
  "media",
  "pointerLock",
  "window-management",
]);
const PERMISSION_HOOKED_SESSIONS = new WeakSet<Session>();

export interface WindowManagerOptions {
  preloadPath: string;
  devUrl?: string;
  iconPath?: string;
  appUserModelId?: string;
  smokeMode?: boolean;
  platform?: NodeJS.Platform;
  onWindowClosed?: (label: string, windowStillOpen: boolean) => void;
  onMainWindowLoaded?: () => void;
  onMainWindowClosed?: () => void;
  onMainWindowClosedWithoutTray?: () => void;
  registerSessionProtocols?: (targetSession: Session) => void;
}

export interface OpenSettingsWindowOptions {
  title?: string;
  path?: string;
}

function normalizeUrlOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin && parsed.origin !== "null") {
      return parsed.origin;
    }
    if (parsed.protocol && parsed.host) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function evaluatePermissionRequest(params: {
  origin: string;
  allowedAppOrigin: string;
  permission: string;
  isWebview?: boolean;
}): boolean {
  if (params.isWebview) {
    return false;
  }
  if (!SAFE_APP_PERMISSIONS.has(params.permission)) {
    return false;
  }
  const normalizedOrigin = normalizeUrlOrigin(params.origin);
  const normalizedAllowed = normalizeUrlOrigin(params.allowedAppOrigin);
  return (
    normalizedOrigin !== null &&
    normalizedAllowed !== null &&
    normalizedOrigin === normalizedAllowed
  );
}

export function installSessionPermissionHandlers(
  targetSession: Session,
  allowedAppOrigin: string,
  options: { isWebviewSession?: boolean } = {},
): void {
  if (PERMISSION_HOOKED_SESSIONS.has(targetSession)) {
    return;
  }
  PERMISSION_HOOKED_SESSIONS.add(targetSession);

  targetSession.setPermissionRequestHandler?.(
    (webContents, permission, callback, details) => {
      const isWebview = Boolean(
        options.isWebviewSession || webContents?.getType?.() === "webview",
      );
      const origin = details?.requestingUrl || webContents?.getURL?.() || "";
      callback(
        evaluatePermissionRequest({
          origin,
          allowedAppOrigin,
          permission,
          isWebview,
        }),
      );
    },
  );

  targetSession.setPermissionCheckHandler?.(
    (webContents, permission, requestingOrigin) => {
      const isWebview = Boolean(
        options.isWebviewSession || webContents?.getType?.() === "webview",
      );
      const origin = requestingOrigin || webContents?.getURL?.() || "";
      return evaluatePermissionRequest({
        origin,
        allowedAppOrigin,
        permission,
        isWebview,
      });
    },
  );
}

function normalizeSettingsPath(rawPath?: string | null): string {
  const trimmed = (rawPath ?? "/settings").trim();
  if (
    trimmed === "/settings" ||
    trimmed.startsWith("/settings/") ||
    trimmed === "/plugins" ||
    trimmed.startsWith("/plugins/")
  ) {
    return trimmed;
  }
  return "/settings";
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function isDevToolsShortcut(
  input: Pick<
    Input,
    | "type"
    | "key"
    | "code"
    | "control"
    | "shift"
    | "alt"
    | "meta"
    | "isAutoRepeat"
  >,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type !== "keyDown" || input.isAutoRepeat) {
    return false;
  }
  const f12 =
    (input.key === "F12" || input.code === "F12") &&
    !input.control &&
    !input.shift &&
    !input.alt &&
    !input.meta;
  if (f12) {
    return true;
  }
  const isKeyI = input.code === "KeyI" || input.key.toLowerCase() === "i";
  if (!isKeyI) {
    return false;
  }
  if (platform === "darwin") {
    return input.meta && input.alt && !input.control && !input.shift;
  }
  return input.control && input.shift && !input.alt && !input.meta;
}

export function matchReloadShortcut(
  input: Pick<
    Input,
    | "type"
    | "key"
    | "code"
    | "control"
    | "shift"
    | "alt"
    | "meta"
    | "isAutoRepeat"
  >,
  platform: NodeJS.Platform = process.platform,
): "reload" | "force-reload" | null {
  if (input.type !== "keyDown" || input.isAutoRepeat) {
    return null;
  }
  const isF5 = input.key === "F5" || input.code === "F5";
  if (isF5 && !input.alt && !input.meta) {
    return input.control || input.shift ? "force-reload" : "reload";
  }
  const isKeyR = input.code === "KeyR" || input.key.toLowerCase() === "r";
  if (!isKeyR) {
    return null;
  }
  if (platform === "darwin") {
    if (input.meta && !input.control && !input.alt) {
      return input.shift ? "force-reload" : "reload";
    }
    return null;
  }
  if (input.control && input.shift && !input.alt && !input.meta) {
    return "force-reload";
  }
  return null;
}

const HIDDEN_SETTINGS_IDLE_DESTROY_MS = 15 * 60_000;
const RESIZE_NOTIFY_COALESCE_MS = 32;

export class WindowManager {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly hiddenIdleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly labelsByWebContents = new WeakMap<WebContents, string>();
  private readonly auxiliaryWebContents = new Set<WebContents>();
  private readonly pendingFullscreenHide = new WeakMap<
    BrowserWindow,
    () => void
  >();
  private readonly prewarmingWindows = new WeakSet<BrowserWindow>();
  private readonly prewarmedReadyWindows = new WeakSet<BrowserWindow>();
  private readonly pendingSettingsRoutes = new WeakMap<BrowserWindow, string>();
  private readonly options: WindowManagerOptions;
  private readonly platform: NodeJS.Platform;
  private appWindowCounter = 1;
  private quitting = false;
  private trayEnabled = false;
  private developerModeEnabled = false;
  private zoomFactor = 1.0;
  private currentAppIcon: NativeImage | null = null;
  private currentAppIconIcoPath: string | null = null;

  constructor(options: WindowManagerOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
  }

  private clearHiddenIdleTimer(label: string): void {
    const timer = this.hiddenIdleTimers.get(label);
    if (timer) {
      clearTimeout(timer);
      this.hiddenIdleTimers.delete(label);
    }
  }

  private scheduleHiddenIdleDestroy(label: string, win: BrowserWindow): void {
    this.clearHiddenIdleTimer(label);
    const timer = setTimeout(() => {
      this.hiddenIdleTimers.delete(label);
      if (
        this.windows.get(label) !== win ||
        win.isDestroyed() ||
        win.isVisible()
      ) {
        return;
      }
      win.destroy();
    }, HIDDEN_SETTINGS_IDLE_DESTROY_MS);
    timer.unref?.();
    this.hiddenIdleTimers.set(label, timer);
  }

  cancelPendingFullscreenHide(win: BrowserWindow): void {
    const cancel = this.pendingFullscreenHide.get(win);
    if (cancel) {
      this.pendingFullscreenHide.delete(win);
      cancel();
    }
  }

  showWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) {
      return;
    }
    if (this.prewarmingWindows.has(win)) {
      this.prewarmedReadyWindows.add(win);
      return;
    }
    this.cancelPendingFullscreenHide(win);
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
  }

  focusWindow(win: BrowserWindow): void {
    if (win.isDestroyed() || this.prewarmingWindows.has(win)) {
      return;
    }
    win.focus();
  }

  /**
   * Hides a window safely across platforms. On macOS, calling `win.hide()`
   * directly on a native fullscreen window strands the user on a black empty
   * Space, so we exit fullscreen first and hide once `leave-full-screen` fires.
   */
  private hideWindowSafely(win: BrowserWindow, onHidden?: () => void): void {
    if (win.isDestroyed()) {
      return;
    }
    if (this.platform === "darwin" && win.isFullScreen?.()) {
      if (this.pendingFullscreenHide.has(win)) {
        return;
      }
      const handleLeaveFullScreen = () => {
        this.pendingFullscreenHide.delete(win);
        if (!win.isDestroyed()) {
          win.hide();
          onHidden?.();
        }
      };
      this.pendingFullscreenHide.set(win, () => {
        if (!win.isDestroyed()) {
          win.removeListener("leave-full-screen", handleLeaveFullScreen);
        }
      });
      win.once("leave-full-screen", handleLeaveFullScreen);
      win.setFullScreen(false);
      return;
    }
    win.hide();
    onHidden?.();
  }

  setQuitting(quitting: boolean): void {
    this.quitting = quitting;
  }

  setTrayEnabled(enabled: boolean): void {
    this.trayEnabled = enabled;
  }

  isTrayEnabled(): boolean {
    return this.trayEnabled;
  }

  isDevSession(): boolean {
    return Boolean(this.options.devUrl) && !this.options.smokeMode;
  }

  isDeveloperModeEnabled(): boolean {
    return this.developerModeEnabled;
  }

  isDeveloperContextEnabled(): boolean {
    return this.developerModeEnabled || this.isDevSession();
  }

  applyDeveloperMode(enabled: boolean): void {
    this.developerModeEnabled = enabled;
    if (!this.isDeveloperContextEnabled()) {
      for (const win of this.allWindows()) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        }
      }
    }
  }

  registerAuxiliaryWebContents(webContents: WebContents, label: string): void {
    this.labelsByWebContents.set(webContents, label);
    this.auxiliaryWebContents.add(webContents);
    webContents.once?.("destroyed", () => {
      this.auxiliaryWebContents.delete(webContents);
    });
  }

  unregisterAuxiliaryWebContents(webContents: WebContents): void {
    this.auxiliaryWebContents.delete(webContents);
  }

  getWindow(label: string): BrowserWindow | undefined {
    const win = this.windows.get(label);
    if (!win || win.isDestroyed()) {
      this.windows.delete(label);
      return undefined;
    }
    return win;
  }

  getMainWindow(): BrowserWindow | undefined {
    return this.getWindow(MAIN_WINDOW_LABEL);
  }

  getLabelForWebContents(webContents: WebContents): string {
    return this.labelsByWebContents.get(webContents) ?? MAIN_WINDOW_LABEL;
  }

  getFocusedWindowLabel(): string {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) {
      return this.getLabelForWebContents(focused.webContents);
    }
    return MAIN_WINDOW_LABEL;
  }

  setZoomFactor(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) {
      return;
    }
    this.zoomFactor = scale;
    for (const win of this.allWindows()) {
      win.webContents.setZoomFactor(scale);
    }
  }

  getZoomFactor(): number {
    return this.zoomFactor;
  }

  getWindowForWebContents(webContents: WebContents): BrowserWindow | undefined {
    const fromElectron = BrowserWindow.fromWebContents(webContents);
    if (fromElectron && !fromElectron.isDestroyed()) {
      return fromElectron;
    }
    const label = this.labelsByWebContents.get(webContents);
    return label ? this.getWindow(label) : undefined;
  }

  isMainWindowFocused(): boolean {
    for (const [label, win] of this.windows.entries()) {
      if (label === DESKTOP_TOAST_WINDOW_LABEL || win.isDestroyed()) {
        continue;
      }
      if (win.isFocused()) {
        return true;
      }
    }
    return false;
  }

  showMainWindow(): void {
    const main = this.getMainWindow() ?? this.createMainWindow();
    this.cancelPendingFullscreenHide(main);
    if (main.isMinimized()) {
      main.restore();
    }
    main.show();
    main.focus();
  }

  hideMainWindow(): void {
    const main = this.getMainWindow();
    if (main && !main.isDestroyed()) {
      this.hideWindowSafely(main);
    }
  }

  applyWindowsAppDetails(win: BrowserWindow, icoPath?: string): void {
    if (process.platform !== "win32" || win.isDestroyed()) {
      return;
    }
    const candidateIco =
      icoPath && fs.existsSync(icoPath)
        ? icoPath
        : this.currentAppIconIcoPath &&
            fs.existsSync(this.currentAppIconIcoPath)
          ? this.currentAppIconIcoPath
          : this.options.iconPath &&
              this.options.iconPath.toLowerCase().endsWith(".ico") &&
              fs.existsSync(this.options.iconPath)
            ? this.options.iconPath
            : undefined;
    try {
      win.setAppDetails({
        appId: this.options.appUserModelId ?? DEFAULT_APP_USER_MODEL_ID,
        ...(candidateIco ? { appIconPath: candidateIco, appIconIndex: 0 } : {}),
        relaunchDisplayName: this.options.devUrl ? "Dimo Dev" : "Dimo",
      });
    } catch {
      // Ignore on environments where setAppDetails is unavailable.
    }
  }

  applyIconToLocalWindows(icon: NativeImage, icoPath?: string): void {
    this.currentAppIcon = icon;
    if (icoPath) {
      this.currentAppIconIcoPath = icoPath;
    }
    if (process.platform === "darwin") {
      return;
    }
    for (const [label, win] of this.windows.entries()) {
      if (!win.isDestroyed() && isLocalDesktopWindowLabel(label)) {
        win.setIcon(icon);
        this.applyWindowsAppDetails(win, icoPath);
      }
    }
  }

  resolveAppUrl(routePath = "/"): string {
    const cleanPath = routePath.startsWith("/") ? routePath : `/${routePath}`;
    if (this.options.devUrl) {
      const base = this.options.devUrl.replace(/\/+$/, "");
      return `${base}${cleanPath}`;
    }
    return `${DESKTOP_APP_ORIGIN}${cleanPath}`;
  }

  getAllowedAppOrigin(): string {
    if (this.options.devUrl) {
      try {
        return new URL(this.options.devUrl).origin;
      } catch {
        // Fall through to custom scheme origin.
      }
    }
    return DESKTOP_APP_ORIGIN;
  }

  private resolveWindowIcon(label: string): NativeImage | string | undefined {
    if (this.currentAppIcon && isLocalDesktopWindowLabel(label)) {
      return this.currentAppIcon;
    }
    if (this.options.iconPath && fs.existsSync(this.options.iconPath)) {
      const loaded = nativeImage.createFromPath(this.options.iconPath);
      if (!loaded.isEmpty()) {
        return loaded;
      }
      return this.options.iconPath;
    }
    return undefined;
  }

  private baseChromeOptions(
    label: string,
  ): Partial<BrowserWindowConstructorOptions> {
    const icon = this.resolveWindowIcon(label);

    if (process.platform === "darwin") {
      return {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 14 },
        backgroundColor: "#121316",
        ...(icon ? { icon } : {}),
      };
    }

    return {
      frame: false,
      backgroundColor: "#121316",
      ...(icon ? { icon } : {}),
    };
  }

  createMainWindow(): BrowserWindow {
    const existing = this.getMainWindow();
    if (existing) {
      this.cancelPendingFullscreenHide(existing);
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      return existing;
    }

    const win = this.createWindowInternal(MAIN_WINDOW_LABEL, {
      title: this.options.devUrl ? "Dimo Dev" : "Dimo",
      width: 1400,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      routePath: "/",
      hideOnClose: "when-tray-enabled",
    });

    this.scheduleRevealFallback(win);
    return win;
  }

  openAppWindow(): string {
    let label = `app-${this.appWindowCounter}`;
    while (this.windows.has(label)) {
      this.appWindowCounter += 1;
      label = `app-${this.appWindowCounter}`;
    }
    this.appWindowCounter += 1;

    const win = this.createWindowInternal(label, {
      title: this.options.devUrl ? "Dimo Dev" : "Dimo",
      width: 1400,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      routePath: "/",
      hideOnClose: "never",
    });
    this.scheduleRevealFallback(win);
    return label;
  }

  openOrFocusHostWindow(profile: HostClientProfileView): string {
    const label = hostWindowLabel(profile.id);
    const title = hostWindowTitle(profile.name);
    const existing = this.getWindow(label);
    if (existing) {
      this.cancelPendingFullscreenHide(existing);
      existing.setTitle(title);
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      return label;
    }

    const win = this.createWindowInternal(label, {
      title,
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      routePath: "/",
      hideOnClose: "never",
      partition: `persist:${label}`,
    });
    this.scheduleRevealFallback(win);
    return label;
  }

  closeHostFamily(windowLabel: string): void {
    const hostLabel = hostAppWindowLabel(windowLabel);
    if (!hostLabel) {
      return;
    }
    const labels: string[] = [];
    const settingsLabel = hostSettingsWindowForApp(hostLabel);
    if (settingsLabel) {
      labels.push(settingsLabel);
    }
    labels.push(hostLabel);
    this.closeWindowsByLabels(labels);
  }

  prewarmSettingsWindow(): BrowserWindow | undefined {
    if (this.quitting || this.options.smokeMode || !this.getMainWindow()) {
      return undefined;
    }
    const existing = this.getWindow("settings");
    if (existing) {
      return existing;
    }

    const win = this.createWindowInternal("settings", {
      title: "Settings",
      width: 1100,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      routePath: "/settings",
      hideOnClose: "always",
    });
    this.prewarmingWindows.add(win);
    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed()) {
        return;
      }
      const pendingRoute = this.pendingSettingsRoutes.get(win);
      if (pendingRoute) {
        this.pendingSettingsRoutes.delete(win);
        this.navigateSettingsWindow(win, pendingRoute);
      }
    });
    this.scheduleHiddenIdleDestroy("settings", win);
    return win;
  }

  openSettingsWindow(
    callerLabel: string,
    options: OpenSettingsWindowOptions = {},
  ): BrowserWindow {
    const label = settingsWindowLabelForCaller(callerLabel);
    const hostLabel = hostAppWindowLabel(label);
    let defaultTitle = "Settings";
    if (hostLabel) {
      const hostWin = this.getWindow(hostLabel);
      const hostTitle = hostWin?.getTitle()?.trim() ?? "";
      const hostName = hostTitle.startsWith("Dimo — ")
        ? hostTitle.slice("Dimo — ".length).trim()
        : "";
      if (hostName.length > 0) {
        defaultTitle = `Settings — ${hostName}`;
      }
    }
    const title = (options.title ?? "").trim() || defaultTitle;
    const routePath = normalizeSettingsPath(options.path);

    const existing = this.getWindow(label);
    if (existing) {
      const wasPrewarming = this.prewarmingWindows.delete(existing);
      const isPrewarmedReady = this.prewarmedReadyWindows.has(existing);
      this.cancelPendingFullscreenHide(existing);
      this.clearHiddenIdleTimer(label);
      existing.setTitle(title);

      if (wasPrewarming && !isPrewarmedReady) {
        if (routePath !== "/settings") {
          this.pendingSettingsRoutes.set(existing, routePath);
          this.navigateSettingsWindow(existing, routePath);
        }
        this.scheduleRevealFallback(existing);
        return existing;
      }

      this.prewarmedReadyWindows.delete(existing);
      this.pendingSettingsRoutes.delete(existing);
      this.navigateSettingsWindow(existing, routePath);
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      return existing;
    }

    const win = this.createWindowInternal(label, {
      title,
      width: 1100,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      routePath,
      hideOnClose: "always",
      ...(hostLabel ? { partition: `persist:${hostLabel}` } : {}),
    });
    this.scheduleRevealFallback(win);
    return win;
  }

  revealWindow(label: string): void {
    const win = this.getWindow(label);
    if (!win) {
      return;
    }
    this.cancelPendingFullscreenHide(win);
    this.clearHiddenIdleTimer(label);
    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }

  closeWindowsByLabels(labels: readonly string[]): void {
    for (const label of labels) {
      this.clearHiddenIdleTimer(label);
      const win = this.getWindow(label);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  broadcastEvent(
    event: string,
    payload?: unknown,
    excludeWebContentsId?: number,
  ): void {
    const sentWebContentsIds = new Set<number>();
    for (const win of this.windows.values()) {
      if (win.isDestroyed()) {
        continue;
      }
      const wc = win.webContents;
      if (
        excludeWebContentsId !== undefined &&
        wc.id === excludeWebContentsId
      ) {
        continue;
      }
      sentWebContentsIds.add(wc.id);
      wc.send(IPC_CHANNELS.EVENTS_MESSAGE, { event, payload });
    }

    for (const wc of Array.from(this.auxiliaryWebContents)) {
      if (wc.isDestroyed?.()) {
        this.auxiliaryWebContents.delete(wc);
        continue;
      }
      if (
        (excludeWebContentsId !== undefined &&
          wc.id === excludeWebContentsId) ||
        sentWebContentsIds.has(wc.id)
      ) {
        continue;
      }
      sentWebContentsIds.add(wc.id);
      wc.send(IPC_CHANNELS.EVENTS_MESSAGE, { event, payload });
    }
  }

  allWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).filter(
      (win) => !win.isDestroyed(),
    );
  }

  private createWindowInternal(
    label: string,
    config: {
      title: string;
      width: number;
      height: number;
      minWidth: number;
      minHeight: number;
      routePath: string;
      hideOnClose: "never" | "always" | "when-tray-enabled";
      partition?: string;
    },
  ): BrowserWindow {
    const allowedOrigin = this.getAllowedAppOrigin();
    if (config.partition) {
      const targetSession = session.fromPartition(config.partition);
      this.options.registerSessionProtocols?.(targetSession);
      installSessionPermissionHandlers(targetSession, allowedOrigin);
    }

    const win = new BrowserWindow({
      ...this.baseChromeOptions(label),
      title: config.title,
      width: config.width,
      height: config.height,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      resizable: true,
      show: false,
      center: true,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        webviewTag: true,
        ...(config.partition ? { partition: config.partition } : {}),
      },
    });

    this.windows.set(label, win);
    this.labelsByWebContents.set(win.webContents, label);
    this.applyWindowsAppDetails(win);
    if (this.zoomFactor !== 1.0) {
      win.webContents.setZoomFactor(this.zoomFactor);
    }

    if (label === MAIN_WINDOW_LABEL) {
      win.webContents.once("did-finish-load", () => {
        this.options.onMainWindowLoaded?.();
      });
    }

    let resizeNotifyTimer: ReturnType<typeof setTimeout> | null = null;
    const clearResizeNotifyTimer = () => {
      if (resizeNotifyTimer !== null) {
        clearTimeout(resizeNotifyTimer);
        resizeNotifyTimer = null;
      }
    };
    const notifyResizedImmediate = () => {
      clearResizeNotifyTimer();
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.WINDOW_RESIZED);
      }
    };
    const notifyResizedCoalesced = () => {
      if (resizeNotifyTimer !== null) {
        return;
      }
      resizeNotifyTimer = setTimeout(() => {
        resizeNotifyTimer = null;
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.WINDOW_RESIZED);
        }
      }, RESIZE_NOTIFY_COALESCE_MS);
    };
    win.on("resize", notifyResizedCoalesced);
    win.on("maximize", notifyResizedImmediate);
    win.on("unmaximize", notifyResizedImmediate);
    win.on("enter-full-screen", notifyResizedImmediate);
    win.on("leave-full-screen", notifyResizedImmediate);
    win.on("show", () => {
      this.clearHiddenIdleTimer(label);
    });

    if (config.hideOnClose !== "never") {
      win.on("close", (event) => {
        if (this.quitting || this.options.smokeMode) {
          return;
        }
        if (
          label === "settings" &&
          !this.trayEnabled &&
          !this.getMainWindow()
        ) {
          return;
        }
        if (
          config.hideOnClose === "always" ||
          (config.hideOnClose === "when-tray-enabled" && this.trayEnabled)
        ) {
          event.preventDefault();
          this.hideWindowSafely(win, () => {
            if (config.hideOnClose === "always") {
              this.scheduleHiddenIdleDestroy(label, win);
            }
          });
        }
      });
    }

    win.on("closed", () => {
      clearResizeNotifyTimer();
      this.clearHiddenIdleTimer(label);
      if (this.windows.get(label) === win) {
        this.windows.delete(label);
      }
      if (label === MAIN_WINDOW_LABEL) {
        this.options.onMainWindowClosed?.();
        if (!this.trayEnabled) {
          const localSettings = this.getWindow("settings");
          if (localSettings && !localSettings.isDestroyed()) {
            localSettings.destroy();
          }
          this.options.onMainWindowClosedWithoutTray?.();
        }
      }
      if (isHostWindowLabel(label)) {
        const pairedSettingsLabel = hostSettingsWindowForApp(label);
        const pairedSettings = pairedSettingsLabel
          ? this.getWindow(pairedSettingsLabel)
          : undefined;
        if (pairedSettings && !pairedSettings.isDestroyed()) {
          pairedSettings.destroy();
        }
      }
      this.options.onWindowClosed?.(label, this.windows.has(label));
    });

    // Gate DevTools & reload shortcuts on Dev desktop or developer mode.
    win.webContents.on("before-input-event", (event, input) => {
      if (isDevToolsShortcut(input, this.platform)) {
        event.preventDefault();
        if (!this.isDeveloperContextEnabled()) {
          return;
        }
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: "detach" });
        }
        return;
      }

      const reloadKind = matchReloadShortcut(input, this.platform);
      if (reloadKind) {
        event.preventDefault();
        if (!this.isDeveloperContextEnabled()) {
          return;
        }
        if (reloadKind === "force-reload") {
          win.webContents.reloadIgnoringCache();
        } else {
          win.webContents.reload();
        }
      }
    });

    // Fallback native developer context menu when the renderer does not intercept
    // `contextmenu` (e.g., blank error screen or crashed Vite dev bundle).
    win.webContents.on("context-menu", (_event, params) => {
      if (!this.isDeveloperContextEnabled()) {
        return;
      }
      const menu = Menu?.buildFromTemplate?.([
        {
          label: "Reload",
          click: () => {
            if (!win.isDestroyed()) {
              win.webContents.reload();
            }
          },
        },
        {
          label: "Force Reload",
          click: () => {
            if (!win.isDestroyed()) {
              win.webContents.reloadIgnoringCache();
            }
          },
        },
        { type: "separator" },
        {
          label: "Inspect Element",
          click: () => {
            if (!win.isDestroyed()) {
              win.webContents.inspectElement(params.x, params.y);
            }
          },
        },
        {
          label: "Toggle Developer Tools",
          click: () => {
            if (win.isDestroyed()) return;
            if (win.webContents.isDevToolsOpened()) {
              win.webContents.closeDevTools();
            } else {
              win.webContents.openDevTools({ mode: "detach" });
            }
          },
        },
      ]);
      menu?.popup?.({ window: win });
    });

    // Guard against untrusted popups or top-level navigations away from app origin.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    win.webContents.on("will-navigate", (event, targetUrl) => {
      const targetOrigin = normalizeUrlOrigin(targetUrl);
      const expectedOrigin = normalizeUrlOrigin(allowedOrigin);
      if (targetOrigin && expectedOrigin && targetOrigin === expectedOrigin) {
        return;
      }
      event.preventDefault();
      if (isSafeExternalUrl(targetUrl)) {
        void shell.openExternal(targetUrl);
      }
    });

    void win.loadURL(this.resolveAppUrl(config.routePath));
    return win;
  }

  private scheduleRevealFallback(win: BrowserWindow): void {
    const timer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) {
        win.show();
        win.focus();
      }
    }, REVEAL_FALLBACK_MS);
    win.once("show", () => clearTimeout(timer));
    win.once("closed", () => clearTimeout(timer));
  }

  private navigateSettingsWindow(win: BrowserWindow, routePath: string): void {
    const encoded = JSON.stringify(routePath);
    const script = `(() => {
      const target = ${encoded};
      const current = location.pathname + location.search;
      if (current === target || (target === '/settings' && location.pathname === '/settings/general' && !location.search)) return;
      const ev = new CustomEvent('dimo:settings-navigate', { cancelable: true, detail: { path: target } });
      if (window.dispatchEvent(ev)) location.replace(target);
    })();`;
    void win.webContents.executeJavaScript(script).catch(() => {
      // Window may not have finished initial load yet.
    });
  }
}

export function resolveDefaultIconPath(options: {
  resourcesDir?: string;
  repoRoot?: string;
}): string | undefined {
  const filename =
    process.platform === "win32"
      ? "icon.ico"
      : process.platform === "darwin"
        ? "icon.icns"
        : "icon.png";

  const candidates: string[] = [];
  if (options.resourcesDir) {
    candidates.push(path.join(options.resourcesDir, "icons", filename));
    candidates.push(path.join(options.resourcesDir, filename));
  }
  if (options.repoRoot) {
    candidates.push(
      path.join(options.repoRoot, "electron", "build", "icons", filename),
    );
    candidates.push(
      path.join(options.repoRoot, "electron", "build", "icons", "icon.png"),
    );
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}
