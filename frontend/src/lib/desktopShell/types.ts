export type DesktopShellKind = 'electron' | 'web';

export interface DesktopDialogFilter {
  name: string;
  extensions: string[];
}

export interface DesktopOpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: DesktopDialogFilter[];
}

export interface DesktopSaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DesktopDialogFilter[];
}

export interface DesktopDragDropPosition {
  x: number;
  y: number;
}

export type DesktopDragDropPayload =
  | {
      type: 'enter';
      paths: string[];
      position: DesktopDragDropPosition;
    }
  | {
      type: 'over';
      position: DesktopDragDropPosition;
    }
  | {
      type: 'drop';
      paths: string[];
      position: DesktopDragDropPosition;
    }
  | {
      type: 'leave';
    };

export interface DesktopDragDropEvent {
  payload: DesktopDragDropPayload;
}

export interface DesktopUpdateDownloadEvent {
  event: 'Started' | 'Progress' | 'Finished';
  data?: {
    contentLength?: number;
    chunkLength?: number;
  };
}

export interface DesktopUpdateHandle {
  version: string;
  body?: string | null;
  date?: string | null;
  download?: (
    onEvent: (event: DesktopUpdateDownloadEvent) => void
  ) => Promise<void>;
  install?: () => Promise<void>;
  downloadAndInstall: (
    onEvent: (event: DesktopUpdateDownloadEvent) => void
  ) => Promise<void>;
  close?: () => Promise<void>;
}

export interface DesktopShellWindowApi {
  getLabel(): Promise<string>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  setTitle(title: string): Promise<void>;
  startDragging(): Promise<void>;
  onResized(callback: () => void): Promise<() => void>;
  setZoom(scale: number): Promise<void>;
  onDragDropEvent(
    callback: (event: DesktopDragDropEvent) => void
  ): Promise<() => void>;
}

export interface DesktopShellDialogApi {
  open(options?: DesktopOpenDialogOptions): Promise<string | string[] | null>;
  save(options?: DesktopSaveDialogOptions): Promise<string | null>;
}

export interface DesktopShellFsApi {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
  writeTextFile(path: string, contents: string): Promise<void>;
}

export interface DesktopShellPathApi {
  join(...parts: string[]): Promise<string>;
}

export interface DesktopShellExternalApi {
  openExternal(target: string): Promise<void>;
}

export interface DesktopShellAssetsApi {
  convertFileSrc(filePath: string, protocol?: string): string;
}

export interface DesktopShellEventsApi {
  listen<T = unknown>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void>;
  emit(event: string, payload?: unknown): Promise<void>;
}

export interface DesktopShellUpdaterApi {
  check(options?: { timeout?: number }): Promise<DesktopUpdateHandle | null>;
  relaunch(): Promise<void>;
}

export interface DesktopShellDesktopToastApi {
  setIgnoreMouseEvents?: (ignore: boolean) => Promise<void>;
  setContentHeight?: (height: number) => Promise<void>;
}

export interface DesktopShellBridge {
  readonly kind: DesktopShellKind;
  getAppVersion(): Promise<string>;
  getWindowLabel(): string;
  readonly window: DesktopShellWindowApi;
  readonly dialog: DesktopShellDialogApi;
  readonly fs: DesktopShellFsApi;
  readonly path: DesktopShellPathApi;
  readonly shell: DesktopShellExternalApi;
  readonly assets: DesktopShellAssetsApi;
  readonly events: DesktopShellEventsApi;
  readonly updater: DesktopShellUpdaterApi;
  readonly desktopToast?: DesktopShellDesktopToastApi;
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

export interface ElectronBackendConnectionInfo {
  baseUrl: string;
  token: string;
  dataDir?: string;
}

/**
 * Preload API exposed by Electron's `contextBridge.exposeInMainWorld('dimoDesktop', ...)`.
 */
export interface ElectronDesktopBridge {
  readonly platform?: string;
  readonly backend?: ElectronBackendConnectionInfo;
  getAppVersion(): Promise<string>;
  getWindowLabel(): string;
  readonly window: Omit<DesktopShellWindowApi, 'getLabel'> & {
    getLabel?: () => Promise<string>;
  };
  readonly dialog: DesktopShellDialogApi;
  readonly fs: DesktopShellFsApi;
  readonly path: DesktopShellPathApi;
  readonly shell: DesktopShellExternalApi;
  readonly assets: DesktopShellAssetsApi;
  readonly events: DesktopShellEventsApi;
  readonly updater: DesktopShellUpdaterApi;
  readonly desktopToast?: DesktopShellDesktopToastApi;
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    dimoDesktop?: ElectronDesktopBridge;
  }
}
