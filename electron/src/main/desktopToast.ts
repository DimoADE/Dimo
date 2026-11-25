import { BrowserWindow, screen } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopToastPayload,
} from '../shared/ipcContract';
import type { WindowManager } from './windows';

export const DESKTOP_TOAST_WINDOW_LABEL = 'desktop-toast';
export const DESKTOP_TOAST_EVENT = 'desktop-toast';
export const DESKTOP_TOAST_ACTIVATED_EVENT = 'desktop-toast-activated';
export const DESKTOP_TOAST_WIDTH = 456;
export const DESKTOP_TOAST_HEIGHT = 520;
export const DESKTOP_TOAST_MARGIN = 16;
export const DESKTOP_TOAST_IDLE_CLOSE_MS = 60_000;
export const DESKTOP_TOAST_MAX_PENDING = 50;

export interface WorkAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the top-left DIP coordinate for anchoring the floating toast overlay
 * to the bottom-right corner of the active display's work area.
 */
export function computeToastWindowPosition(
  workArea: WorkAreaRect,
  width = DESKTOP_TOAST_WIDTH,
  height = DESKTOP_TOAST_HEIGHT,
  margin = DESKTOP_TOAST_MARGIN
): { x: number; y: number } {
  return {
    x: Math.round(workArea.x + workArea.width - width - margin),
    y: Math.round(workArea.y + workArea.height - height - margin),
  };
}

/**
 * Pure state machine for coordinating pending toasts before `/desktop-toast`
 * finishes mounting and calls `desktop_toast_window_ready`.
 */
export class DesktopToastQueue {
  private ready = false;
  private pending: DesktopToastPayload[] = [];
  private readonly maxPending: number;

  constructor(maxPending = DESKTOP_TOAST_MAX_PENDING) {
    this.maxPending = Math.max(1, Math.floor(maxPending));
  }

  isReady(): boolean {
    return this.ready;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  markReady(): DesktopToastPayload[] {
    this.ready = true;
    const drained = this.pending;
    this.pending = [];
    return drained;
  }

  /**
   * Returns `true` if the toast window is ready for immediate delivery, or
   * queues the payload (bounded by `maxPending`, dropping oldest) and returns
   * `false`.
   */
  enqueueOrDeliver(payload: DesktopToastPayload): boolean {
    if (this.ready) {
      return true;
    }
    if (this.pending.length >= this.maxPending) {
      this.pending.splice(0, this.pending.length - this.maxPending + 1);
    }
    this.pending.push(payload);
    return false;
  }

  reset(): void {
    this.ready = false;
    this.pending = [];
  }
}

export interface DesktopToastManagerOptions {
  preloadPath: string;
  windows: WindowManager;
  idleCloseMs?: number;
  platform?: NodeJS.Platform;
}

export class DesktopToastManager {
  private readonly options: DesktopToastManagerOptions;
  private readonly platform: NodeJS.Platform;
  private readonly queue = new DesktopToastQueue();
  private toastWindow: BrowserWindow | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private linuxContentHeight = 148;

  constructor(options: DesktopToastManagerOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
  }

  getWindow(): BrowserWindow | null {
    if (!this.toastWindow || this.toastWindow.isDestroyed()) {
      this.toastWindow = null;
      return null;
    }
    return this.toastWindow;
  }

  markWindowReady(): DesktopToastPayload[] {
    return this.queue.markReady();
  }

  show(payload: DesktopToastPayload): void {
    this.cancelIdleCleanup();
    const win = this.ensureWindow();
    this.positionWindow(win);

    if (this.queue.enqueueOrDeliver(payload)) {
      win.webContents.send(IPC_CHANNELS.EVENTS_MESSAGE, {
        event: DESKTOP_TOAST_EVENT,
        payload,
      });
    }

    if (!win.isVisible()) {
      win.showInactive();
    }
  }

  activate(payload: DesktopToastPayload): void {
    this.options.windows.showMainWindow();
    const main = this.options.windows.getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send(IPC_CHANNELS.EVENTS_MESSAGE, {
        event: DESKTOP_TOAST_ACTIVATED_EVENT,
        payload,
      });
    }
    this.hide();
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    // Electron ignores `{ forward: true }` on Linux, so enabling click-through
    // would make toast cards permanently unclickable. On Linux we shrink the
    // window bounds to the rendered toast stack height via `setContentHeight`.
    if (this.platform === 'linux') {
      return;
    }
    const win = this.getWindow();
    if (win) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  }

  setContentHeight(height: number): void {
    if (this.platform !== 'linux') {
      return;
    }
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const clamped = Math.max(
      80,
      Math.min(DESKTOP_TOAST_HEIGHT, Math.ceil(height))
    );
    if (clamped === this.linuxContentHeight) {
      return;
    }
    this.linuxContentHeight = clamped;
    const win = this.getWindow();
    if (win) {
      this.positionWindow(win);
    }
  }

  hide(): void {
    const win = this.getWindow();
    if (win) {
      if (this.platform !== 'linux') {
        win.setIgnoreMouseEvents(true, { forward: true });
      }
      win.hide();
      this.scheduleIdleCleanup();
    }
  }

  destroy(): void {
    this.cancelIdleCleanup();
    this.queue.reset();
    const win = this.getWindow();
    if (win) {
      this.toastWindow = null;
      this.options.windows.unregisterAuxiliaryWebContents(win.webContents);
      win.destroy();
    }
  }

  private effectiveWindowHeight(): number {
    return this.platform === 'linux'
      ? this.linuxContentHeight
      : DESKTOP_TOAST_HEIGHT;
  }

  private ensureWindow(): BrowserWindow {
    const existing = this.getWindow();
    if (existing) {
      return existing;
    }

    this.queue.reset();
    const win = new BrowserWindow({
      title: 'Desktop Toasts',
      width: DESKTOP_TOAST_WIDTH,
      height: this.effectiveWindowHeight(),
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    // Pass clicks on transparent backdrop pixels through to underlying windows
    // while forwarding hover events so toast cards can opt back into input.
    // On Linux, Electron ignores `{ forward: true }`, so instead we keep mouse
    // events enabled and resize the overlay tightly to the visible toast stack.
    if (this.platform !== 'linux') {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    // Keep overlay visible across virtual desktops/fullscreen spaces on macOS.
    if (this.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    this.toastWindow = win;
    const wc = win.webContents;
    this.options.windows.registerAuxiliaryWebContents(
      wc,
      DESKTOP_TOAST_WINDOW_LABEL
    );

    win.on('closed', () => {
      this.options.windows.unregisterAuxiliaryWebContents(wc);
      if (this.toastWindow === win) {
        this.toastWindow = null;
        this.queue.reset();
      }
    });

    void win.loadURL(this.options.windows.resolveAppUrl('/desktop-toast'));
    return win;
  }

  private positionWindow(win: BrowserWindow): void {
    const main = this.options.windows.getMainWindow();
    const display =
      main && !main.isDestroyed()
        ? screen.getDisplayMatching(main.getBounds())
        : screen.getPrimaryDisplay();
    const height = this.effectiveWindowHeight();
    const { x, y } = computeToastWindowPosition(
      display.workArea,
      DESKTOP_TOAST_WIDTH,
      height
    );
    win.setBounds({
      x,
      y,
      width: DESKTOP_TOAST_WIDTH,
      height,
    });
  }

  private cancelIdleCleanup(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleCleanup(): void {
    this.cancelIdleCleanup();
    const delayMs = this.options.idleCloseMs ?? DESKTOP_TOAST_IDLE_CLOSE_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const win = this.getWindow();
      if (win && !win.isVisible() && this.queue.pendingCount() === 0) {
        this.queue.reset();
        this.toastWindow = null;
        this.options.windows.unregisterAuxiliaryWebContents(win.webContents);
        win.destroy();
      }
    }, delayMs);
    this.idleTimer.unref?.();
  }
}
