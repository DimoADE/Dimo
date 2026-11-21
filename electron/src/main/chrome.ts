import fs from 'node:fs';
import path from 'node:path';

import {
  app,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import { isLocalDesktopWindowLabel } from '../shared/ipcContract';
import { LAUNCH_ARG_NEW_WINDOW, LAUNCH_ARG_OPEN_SETTINGS } from './deeplink';
import type { WindowManager } from './windows';

export const APP_ICON_ASSET_FILES = {
  default: {
    light: 'app-logo-light-default.png',
    dark: 'app-logo-dark.png',
  },
  lite: {
    light: 'app-logo-light-lite.png',
    dark: 'app-logo-dark-lite.png',
  },
} as const;

export function resolveAppIconAssetPath(options: {
  style: string;
  theme: string;
  resourcesDir?: string;
  repoRoot?: string;
}): string | undefined {
  const styleKey = options.style.trim().toLowerCase() === 'lite' ? 'lite' : 'default';
  const themeKey = options.theme.trim().toLowerCase() === 'dark' ? 'dark' : 'light';
  const filename = APP_ICON_ASSET_FILES[styleKey][themeKey];

  const candidates: string[] = [];
  if (options.resourcesDir) {
    candidates.push(path.join(options.resourcesDir, 'icons', filename));
    candidates.push(path.join(options.resourcesDir, 'assets', filename));
    candidates.push(path.join(options.resourcesDir, filename));
  }
  if (options.repoRoot) {
    candidates.push(
      path.join(options.repoRoot, 'frontend', 'src', 'assets', filename)
    );
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}

// Minimal 3x5 bitmap glyphs for rendering crisp 16x16 Windows taskbar badge overlays.
const BADGE_DIGITS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/**
 * Generates an RGBA bitmap buffer for a Windows taskbar overlay badge
 * (red circular pill with white unread count or `9+`).
 */
export function createBadgeOverlayRgba(count: number, size = 16): Buffer {
  const buf = Buffer.alloc(size * size * 4, 0);
  const center = (size - 1) / 2;
  const radius = size / 2 - 0.5;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.hypot(dx, dy);
      if (dist <= radius + 0.5) {
        const alpha =
          dist <= radius - 0.5
            ? 255
            : Math.max(0, Math.min(255, Math.round((radius + 0.5 - dist) * 255)));
        const idx = (y * size + x) * 4;
        // BGRA on Windows nativeImage.createFromBitmap; RGBA for createFromBuffer.
        // We emit RGBA here and convert if needed.
        buf[idx] = 229; // R
        buf[idx + 1] = 57; // G
        buf[idx + 2] = 53; // B
        buf[idx + 3] = alpha;
      }
    }
  }

  const label = count > 9 ? '9+' : String(Math.max(1, count));
  const glyphs = Array.from(label)
    .map((ch) => BADGE_DIGITS[ch])
    .filter((g): g is readonly string[] => Boolean(g));

  const totalWidth = glyphs.length * 3 + Math.max(0, glyphs.length - 1);
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = Math.floor((size - 5) / 2);

  glyphs.forEach((glyph, glyphIdx) => {
    const offsetX = startX + glyphIdx * 4;
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === '1') {
          const px = offsetX + col;
          const py = startY + row;
          if (px >= 0 && px < size && py >= 0 && py < size) {
            const idx = (py * size + px) * 4;
            buf[idx] = 255;
            buf[idx + 1] = 255;
            buf[idx + 2] = 255;
            buf[idx + 3] = 255;
          }
        }
      }
    }
  });

  return buf;
}

function rgbaToBgra(rgba: Buffer): Buffer {
  const bgra = Buffer.from(rgba);
  for (let i = 0; i < bgra.length; i += 4) {
    const r = bgra[i];
    bgra[i] = bgra[i + 2];
    bgra[i + 2] = r;
  }
  return bgra;
}

export function encodeSinglePngIco(pngBytes: Buffer): Buffer {
  const headerAndEntrySize = 6 + 16;
  const out = Buffer.allocUnsafe(headerAndEntrySize + pngBytes.length);
  // ICONDIR header: reserved=0, type=1 (ICO), count=1
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(1, 4);
  // ICONDIRENTRY: width=0 (256px), height=0 (256px), colors=0, reserved=0, planes=1, bpp=32
  out.writeUInt8(0, 6);
  out.writeUInt8(0, 7);
  out.writeUInt8(0, 8);
  out.writeUInt8(0, 9);
  out.writeUInt16LE(1, 10);
  out.writeUInt16LE(32, 12);
  out.writeUInt32LE(pngBytes.length, 14);
  out.writeUInt32LE(headerAndEntrySize, 18);
  pngBytes.copy(out, headerAndEntrySize);
  return out;
}

export interface DesktopChromeManagerOptions {
  windows: WindowManager;
  resourcesDir?: string;
  repoRoot?: string;
  dataDir?: string;
  defaultIconPath?: string;
  onExitRequested: () => Promise<void>;
}

export class DesktopChromeManager {
  private readonly options: DesktopChromeManagerOptions;
  private tray: Tray | null = null;
  private currentAppIcon: NativeImage | null = null;

  constructor(options: DesktopChromeManagerOptions) {
    this.options = options;
  }

  install(): void {
    this.installTray();
    if (process.platform === 'darwin') {
      this.installMacOsMenu();
      this.installMacOsDockMenu();
    } else {
      Menu.setApplicationMenu(null);
      if (process.platform === 'win32') {
        this.installWindowsJumpList();
      }
    }
  }

  updateTrayBadge(count: number): void {
    const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

    if (process.platform === 'darwin') {
      this.tray?.setTitle(normalized > 0 ? String(normalized) : '');
      app.dock?.setBadge(normalized > 0 ? String(normalized) : '');
      return;
    }

    if (process.platform === 'linux') {
      try {
        app.setBadgeCount(normalized);
      } catch {
        // Not all Linux desktops expose Unity badge counts.
      }
      return;
    }

    if (process.platform === 'win32') {
      const main = this.options.windows.getMainWindow();
      if (!main || main.isDestroyed()) {
        return;
      }
      if (normalized <= 0) {
        main.setOverlayIcon(null, '');
        return;
      }
      try {
        const size = 16;
        const bitmap = rgbaToBgra(createBadgeOverlayRgba(normalized, size));
        const overlay = nativeImage.createFromBitmap(bitmap, {
          width: size,
          height: size,
        });
        main.setOverlayIcon(overlay, `${normalized} unread notifications`);
      } catch {
        // Best-effort overlay icon only.
      }
    }
  }

  setAppIcon(callerLabel: string, style: string, theme: string): void {
    const styleKey = style.trim().toLowerCase() === 'lite' ? 'lite' : 'default';
    const themeKey = theme.trim().toLowerCase() === 'dark' ? 'dark' : 'light';
    const assetPath = resolveAppIconAssetPath({
      style: styleKey,
      theme: themeKey,
      resourcesDir: this.options.resourcesDir,
      repoRoot: this.options.repoRoot,
    });
    if (!assetPath) {
      return;
    }
    const image = nativeImage.createFromPath(assetPath);
    if (image.isEmpty()) {
      return;
    }
    const windowIcon = this.prepareWindowIcon(image);
    const windowsIcoPath =
      process.platform === 'win32'
        ? this.writeWindowsTaskbarIco(styleKey, themeKey, windowIcon)
        : undefined;

    const callerWin = this.options.windows.getWindow(callerLabel);
    if (callerWin && !callerWin.isDestroyed() && process.platform !== 'darwin') {
      callerWin.setIcon(windowIcon);
      this.options.windows.applyWindowsAppDetails(callerWin, windowsIcoPath);
    }

    if (isLocalDesktopWindowLabel(callerLabel)) {
      this.currentAppIcon = image;
      this.options.windows.applyIconToLocalWindows(windowIcon, windowsIcoPath);
      if (this.tray && !this.tray.isDestroyed()) {
        this.tray.setImage(this.prepareTrayIcon(image));
      }
      if (process.platform === 'darwin') {
        app.dock?.setIcon(image);
      }
    }
  }

  getCurrentAppIcon(): NativeImage | null {
    return this.currentAppIcon;
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
    }
    this.tray = null;
    this.options.windows.setTrayEnabled(false);
  }

  private prepareWindowIcon(image: NativeImage): NativeImage {
    const { width, height } = image.getSize();
    if (width > 256 || height > 256) {
      return image.resize({ width: 256, height: 256, quality: 'best' });
    }
    return image;
  }

  private writeWindowsTaskbarIco(
    styleKey: 'default' | 'lite',
    themeKey: 'light' | 'dark',
    windowIcon: NativeImage
  ): string | undefined {
    const baseDir = this.options.dataDir;
    if (!baseDir) {
      return this.options.defaultIconPath?.toLowerCase().endsWith('.ico')
        ? this.options.defaultIconPath
        : undefined;
    }
    try {
      const iconDir = path.join(baseDir, 'taskbar-icons');
      fs.mkdirSync(iconDir, { recursive: true });
      const icoPath = path.join(iconDir, `app-logo-${styleKey}-${themeKey}.ico`);
      const pngBytes = windowIcon.toPNG();
      if (pngBytes.length === 0) {
        return this.options.defaultIconPath;
      }
      const icoBytes = encodeSinglePngIco(pngBytes);
      fs.writeFileSync(icoPath, icoBytes);
      return icoPath;
    } catch {
      return this.options.defaultIconPath?.toLowerCase().endsWith('.ico')
        ? this.options.defaultIconPath
        : undefined;
    }
  }

  private prepareTrayIcon(image: NativeImage): NativeImage {
    const targetSize = process.platform === 'darwin' ? 18 : 16;
    return image.resize({ width: targetSize, height: targetSize });
  }

  private loadInitialTrayIcon(): NativeImage | null {
    const candidates: Array<string | undefined> = [
      this.options.defaultIconPath,
      resolveAppIconAssetPath({
        style: 'default',
        theme: 'light',
        resourcesDir: this.options.resourcesDir,
        repoRoot: this.options.repoRoot,
      }),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        const img = nativeImage.createFromPath(candidate);
        if (!img.isEmpty()) {
          return this.prepareTrayIcon(img);
        }
      }
    }
    return null;
  }

  private installTray(): void {
    const icon = this.loadInitialTrayIcon();
    if (!icon) {
      return;
    }

    try {
      const tray = new Tray(icon);
      tray.setToolTip('Dimo');
      const contextMenu = Menu.buildFromTemplate([
        {
          label: '新建窗口',
          click: () => {
            this.options.windows.openAppWindow();
          },
        },
        {
          label: '打开设置',
          click: () => {
            this.options.windows.openSettingsWindow('main');
          },
        },
        { type: 'separator' },
        {
          label: '显示 Dimo',
          click: () => {
            this.options.windows.showMainWindow();
          },
        },
        {
          label: '隐藏窗口',
          click: () => {
            this.options.windows.hideMainWindow();
          },
        },
        { type: 'separator' },
        {
          label: '退出 Dimo',
          click: () => {
            void this.options.onExitRequested();
          },
        },
      ]);

      tray.setContextMenu(contextMenu);
      tray.on('click', () => {
        this.options.windows.showMainWindow();
      });

      this.tray = tray;
      this.options.windows.setTrayEnabled(true);
    } catch {
      // Headless / Linux environments without StatusNotifierWatcher.
      this.tray = null;
      this.options.windows.setTrayEnabled(false);
    }
  }

  private installMacOsMenu(): void {
    const template = buildMacOsMenuTemplate({
      appName: app.name || 'Dimo',
      onNewWindow: () => this.options.windows.openAppWindow(),
      onOpenSettings: () =>
        this.options.windows.openSettingsWindow(
          this.options.windows.getFocusedWindowLabel()
        ),
      onExitRequested: () => {
        void this.options.onExitRequested();
      },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  private installMacOsDockMenu(): void {
    if (!app.dock) {
      return;
    }
    const dockMenu = Menu.buildFromTemplate([
      {
        label: '新建窗口',
        click: () => this.options.windows.openAppWindow(),
      },
      {
        label: '打开设置',
        click: () =>
          this.options.windows.openSettingsWindow(
            this.options.windows.getFocusedWindowLabel()
          ),
      },
    ]);
    app.dock.setMenu(dockMenu);
  }

  private installWindowsJumpList(): void {
    if (!app.isPackaged) {
      return;
    }
    try {
      app.setUserTasks([
        {
          program: process.execPath,
          arguments: LAUNCH_ARG_NEW_WINDOW,
          iconPath: process.execPath,
          iconIndex: 0,
          title: '新建窗口',
          description: '打开新的 Dimo 窗口',
        },
        {
          program: process.execPath,
          arguments: LAUNCH_ARG_OPEN_SETTINGS,
          iconPath: process.execPath,
          iconIndex: 0,
          title: '打开设置',
          description: '打开 Dimo 设置窗口',
        },
      ]);
    } catch {
      // Best-effort jump list registration.
    }
  }
}

export interface MacOsMenuTemplateOptions {
  appName: string;
  onNewWindow: () => void;
  onOpenSettings: () => void;
  onExitRequested: () => void;
}

export function buildMacOsMenuTemplate(
  options: MacOsMenuTemplateOptions
): MenuItemConstructorOptions[] {
  return [
    {
      label: options.appName || 'Dimo',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          click: options.onNewWindow,
        },
        {
          label: '打开设置',
          accelerator: 'CmdOrCtrl+,',
          click: options.onOpenSettings,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: '退出 Dimo',
          accelerator: 'CmdOrCtrl+Q',
          click: options.onExitRequested,
        },
      ],
    },
    {
      label: '文件',
      submenu: [
        {
          label: '新建窗口',
          click: options.onNewWindow,
        },
        {
          label: '打开设置',
          click: options.onOpenSettings,
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [{ role: 'togglefullscreen' }],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
}
