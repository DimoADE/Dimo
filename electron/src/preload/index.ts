import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  DEVELOPER_MODE_CHANGED_EVENT,
  GPU_MODE_CHANGED_EVENT,
  IPC_CHANNELS,
  SIDECAR_RESTARTED_EVENT,
  convertFileSrcToAssetUrl,
  type BootstrapPayload,
  type DesktopGpuMode,
  type DesktopUpdateCheckResult,
  type DesktopUpdateDownloadEventPayload,
  type ElectronBackendConnectionInfo,
} from '../shared/ipcContract';

interface DragDropPosition {
  x: number;
  y: number;
}

type DragDropPayload =
  | { type: 'enter'; paths: string[]; position: DragDropPosition }
  | { type: 'over'; position: DragDropPosition }
  | { type: 'drop'; paths: string[]; position: DragDropPosition }
  | { type: 'leave' };

interface DragDropEvent {
  payload: DragDropPayload;
}

function extractBackendConnectionInfo(
  payload: unknown
): ElectronBackendConnectionInfo | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const candidate =
    'backend' in payload
      ? (payload as { backend?: unknown }).backend
      : payload;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }
  const record = candidate as {
    baseUrl?: unknown;
    token?: unknown;
    dataDir?: unknown;
  };
  if (
    typeof record.baseUrl !== 'string' ||
    record.baseUrl.length === 0 ||
    typeof record.token !== 'string' ||
    record.token.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    baseUrl: record.baseUrl,
    token: record.token,
    ...(typeof record.dataDir === 'string' ? { dataDir: record.dataDir } : {}),
  });
}

const bootstrap = ipcRenderer.sendSync(
  IPC_CHANNELS.BOOTSTRAP_SYNC
) as BootstrapPayload;

let currentBackend: ElectronBackendConnectionInfo | undefined =
  extractBackendConnectionInfo(bootstrap.backend);

const getBackend = (): ElectronBackendConnectionInfo | undefined =>
  currentBackend;

let currentGpuMode: DesktopGpuMode = bootstrap.gpuMode ?? 'hardware';
let currentDeveloperMode = Boolean(bootstrap.developerMode);
function applyGpuModeAttribute(mode: DesktopGpuMode): void {
  currentGpuMode = mode;
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.gpuMode = mode;
  }
}
applyGpuModeAttribute(currentGpuMode);
if (typeof window !== 'undefined') {
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      applyGpuModeAttribute(currentGpuMode);
    },
    { once: true }
  );
}

const resizeListeners = new Set<() => void>();
ipcRenderer.on(IPC_CHANNELS.WINDOW_RESIZED, () => {
  for (const listener of Array.from(resizeListeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[dimoDesktop] window.onResized listener error:', error);
    }
  }
});

const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
ipcRenderer.on(
  IPC_CHANNELS.EVENTS_MESSAGE,
  (_ipcEvent, message: { event?: string; payload?: unknown } | undefined) => {
    if (!message || typeof message.event !== 'string') {
      return;
    }
    if (message.event === SIDECAR_RESTARTED_EVENT) {
      const nextBackend = extractBackendConnectionInfo(message.payload);
      if (nextBackend) {
        currentBackend = nextBackend;
      }
    }
    if (message.event === GPU_MODE_CHANGED_EVENT) {
      const mode = (message.payload as { mode?: unknown } | undefined)?.mode;
      if (mode === 'software' || mode === 'hardware') {
        applyGpuModeAttribute(mode);
      }
    }
    if (message.event === DEVELOPER_MODE_CHANGED_EVENT) {
      const enabled = (message.payload as { enabled?: unknown } | undefined)
        ?.enabled;
      if (typeof enabled === 'boolean') {
        currentDeveloperMode = enabled;
      }
    }
    const handlers = eventListeners.get(message.event);
    if (!handlers || handlers.size === 0) {
      return;
    }
    for (const handler of Array.from(handlers)) {
      try {
        handler(message.payload);
      } catch (error) {
        console.error(
          `[dimoDesktop] event listener error for "${message.event}":`,
          error
        );
      }
    }
  }
);

// Private preload -> main channel used only when a trusted OS drop yields native
// file paths via `webUtils.getPathForFile`. Never exposed on `window.dimoDesktop`.
const INTERNAL_FS_AUTHORIZE_DROPPED_PATHS_CHANNEL =
  'dimo:fs:authorizeDroppedPaths';

const dragDropListeners = new Set<(event: DragDropEvent) => void>();
let dragDropWired = false;
let dragDepth = 0;
let pendingDropEvent: DragEvent | null = null;

function extractFilePaths(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer || !dataTransfer.files || dataTransfer.files.length === 0) {
    return [];
  }
  const paths: string[] = [];
  for (let i = 0; i < dataTransfer.files.length; i += 1) {
    const file = dataTransfer.files.item(i);
    if (!file) continue;
    try {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        paths.push(filePath);
      }
    } catch {
      // Ignore virtual drag items without a local filesystem path.
    }
  }
  return paths;
}

function dispatchDragDrop(payload: DragDropPayload): void {
  const event: DragDropEvent = { payload };
  for (const listener of Array.from(dragDropListeners)) {
    try {
      listener(event);
    } catch (error) {
      console.error('[dimoDesktop] onDragDropEvent listener error:', error);
    }
  }
}

const handleWindowDragEnter = (event: DragEvent): void => {
  if (!event.dataTransfer?.types?.includes('Files')) {
    return;
  }
  event.preventDefault();
  dragDepth += 1;
  if (dragDepth === 1) {
    dispatchDragDrop({
      type: 'enter',
      paths: extractFilePaths(event.dataTransfer),
      position: { x: event.clientX, y: event.clientY },
    });
  }
};

const handleWindowDragOver = (event: DragEvent): void => {
  if (!event.dataTransfer?.types?.includes('Files')) {
    return;
  }
  event.preventDefault();
  dispatchDragDrop({
    type: 'over',
    position: { x: event.clientX, y: event.clientY },
  });
};

const handleWindowDragLeave = (event: DragEvent): void => {
  if (dragDepth <= 0) {
    return;
  }
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dispatchDragDrop({ type: 'leave' });
  } else if (event.relatedTarget === null) {
    dragDepth = 0;
    dispatchDragDrop({ type: 'leave' });
  }
};

const handleDocumentDropCapture = (event: DragEvent): void => {
  if (dragDepth <= 0 && !event.dataTransfer?.types?.includes('Files')) {
    return;
  }
  pendingDropEvent = event;
  // If an inner DOM drop target calls `stopPropagation()`, the bubble-phase
  // `handleWindowDrop` never fires; reset drag state on the next macrotask so
  // global drag overlays never remain stuck open. A microtask would fire
  // between capture and target/bubble listeners on native Chromium UI events.
  setTimeout(() => {
    if (pendingDropEvent !== event) {
      return;
    }
    pendingDropEvent = null;
    if (dragDepth > 0) {
      dragDepth = 0;
      dispatchDragDrop({ type: 'leave' });
    }
  }, 0);
};

const handleWindowDrop = (event: DragEvent): void => {
  if (pendingDropEvent === event) {
    pendingDropEvent = null;
  }
  const wasDragging = dragDepth > 0;
  dragDepth = 0;
  // Skip dispatching a duplicate host drop when a DOM drop target (e.g. the
  // React composer) has already handled and prevented the event, but still
  // emit `leave` if a file drag was active so global drag overlays close cleanly.
  if (event.defaultPrevented) {
    if (wasDragging) {
      dispatchDragDrop({ type: 'leave' });
    }
    return;
  }
  if (!event.dataTransfer?.types?.includes('Files')) {
    if (wasDragging) {
      dispatchDragDrop({ type: 'leave' });
    }
    return;
  }
  event.preventDefault();
  const paths = extractFilePaths(event.dataTransfer);
  if (paths.length > 0) {
    if (event.isTrusted) {
      ipcRenderer.send(INTERNAL_FS_AUTHORIZE_DROPPED_PATHS_CHANNEL, paths);
    }
    dispatchDragDrop({
      type: 'drop',
      paths,
      position: { x: event.clientX, y: event.clientY },
    });
  } else {
    dispatchDragDrop({ type: 'leave' });
  }
};

const handleWindowDragEnd = (): void => {
  pendingDropEvent = null;
  if (dragDepth > 0) {
    dragDepth = 0;
    dispatchDragDrop({ type: 'leave' });
  }
};

function attachDragDropListeners(): void {
  if (dragDropWired || typeof window === 'undefined') {
    return;
  }
  dragDropWired = true;
  dragDepth = 0;
  pendingDropEvent = null;
  window.addEventListener('dragenter', handleWindowDragEnter, true);
  window.addEventListener('dragover', handleWindowDragOver);
  window.addEventListener('dragleave', handleWindowDragLeave, true);
  window.addEventListener('drop', handleWindowDrop);
  window.addEventListener('dragend', handleWindowDragEnd, true);
  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    document.addEventListener('drop', handleDocumentDropCapture, true);
  }
}

function detachDragDropListeners(): void {
  if (!dragDropWired || typeof window === 'undefined') {
    return;
  }
  dragDropWired = false;
  dragDepth = 0;
  pendingDropEvent = null;
  window.removeEventListener('dragenter', handleWindowDragEnter, true);
  window.removeEventListener('dragover', handleWindowDragOver);
  window.removeEventListener('dragleave', handleWindowDragLeave, true);
  window.removeEventListener('drop', handleWindowDrop);
  window.removeEventListener('dragend', handleWindowDragEnd, true);
  if (
    typeof document !== 'undefined' &&
    typeof document.removeEventListener === 'function'
  ) {
    document.removeEventListener('drop', handleDocumentDropCapture, true);
  }
}

const dimoDesktopBridge = {
  platform: bootstrap.platform,
  isDev: Boolean(bootstrap.isDev),
  isDeveloperMode: (): boolean => currentDeveloperMode,
  get backend(): ElectronBackendConnectionInfo | undefined {
    return currentBackend;
  },
  getBackend,

  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),

  getWindowLabel: (): string => bootstrap.windowLabel,

  window: {
    getLabel: (): Promise<string> => Promise.resolve(bootstrap.windowLabel),
    minimize: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    toggleMaximize: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_TOGGLE_MAXIMIZE),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    close: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    show: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SHOW),
    hide: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_HIDE),
    setFocus: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_FOCUS),
    setTitle: (title: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_TITLE, title),
    startDragging: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_START_DRAGGING),
    onResized: (callback: () => void): Promise<() => void> => {
      resizeListeners.add(callback);
      return Promise.resolve(() => {
        resizeListeners.delete(callback);
      });
    },
    setZoom: (scale: number): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.WINDOW_SET_ZOOM, scale),
    onDragDropEvent: (
      callback: (event: DragDropEvent) => void
    ): Promise<() => void> => {
      dragDropListeners.add(callback);
      attachDragDropListeners();
      return Promise.resolve(() => {
        dragDropListeners.delete(callback);
        if (dragDropListeners.size === 0) {
          detachDragDropListeners();
        }
      });
    },
  },

  dialog: {
    open: (options?: Record<string, unknown>): Promise<string | string[] | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN, options),
    save: (options?: Record<string, unknown>): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE, options),
  },

  fs: {
    readFile: async (filePath: string): Promise<Uint8Array> => {
      const data = (await ipcRenderer.invoke(
        IPC_CHANNELS.FS_READ_FILE,
        filePath
      )) as Uint8Array | ArrayBuffer;
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    },
    writeFile: (filePath: string, contents: Uint8Array): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_WRITE_FILE, filePath, contents),
    writeTextFile: (filePath: string, contents: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.FS_WRITE_TEXT_FILE, filePath, contents),
  },

  path: {
    join: (...parts: string[]): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.PATH_JOIN, parts),
  },

  shell: {
    openExternal: (target: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, target),
  },

  assets: {
    convertFileSrc: (filePath: string, protocol?: string): string =>
      convertFileSrcToAssetUrl(filePath, protocol),
  },

  events: {
    listen: <T = unknown>(
      event: string,
      handler: (payload: T) => void
    ): Promise<() => void> => {
      let set = eventListeners.get(event);
      if (!set) {
        set = new Set();
        eventListeners.set(event, set);
      }
      const wrapped = (payload: unknown) => handler(payload as T);
      set.add(wrapped);
      return Promise.resolve(() => {
        const current = eventListeners.get(event);
        if (!current) return;
        current.delete(wrapped);
        if (current.size === 0) {
          eventListeners.delete(event);
        }
      });
    },
    emit: (event: string, payload?: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.EVENTS_EMIT, event, payload),
  },

  updater: {
    check: async (options?: { timeout?: number }) => {
      const result = (await ipcRenderer.invoke(
        IPC_CHANNELS.UPDATER_CHECK,
        options
      )) as DesktopUpdateCheckResult | null;
      if (!result) {
        return null;
      }

      const token = result.token;

      const download = async (
        onEvent: (event: {
          event: 'Started' | 'Progress' | 'Finished';
          data?: { contentLength?: number; chunkLength?: number };
        }) => void
      ): Promise<void> => {
        const listener = (
          _ipcEvent: Electron.IpcRendererEvent,
          payload: DesktopUpdateDownloadEventPayload
        ) => {
          if (!payload || payload.token !== token) {
            return;
          }
          try {
            onEvent({
              event: payload.event,
              ...(payload.data ? { data: payload.data } : {}),
            });
          } catch (error) {
            console.error(
              '[dimoDesktop] updater download event listener error:',
              error
            );
          }
        };

        ipcRenderer.on(IPC_CHANNELS.UPDATER_DOWNLOAD_EVENT, listener);
        try {
          await ipcRenderer.invoke(IPC_CHANNELS.UPDATER_DOWNLOAD, token);
        } finally {
          ipcRenderer.removeListener(
            IPC_CHANNELS.UPDATER_DOWNLOAD_EVENT,
            listener
          );
        }
      };

      const install = (): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.UPDATER_INSTALL, token);

      const close = (): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CLOSE, token);

      return {
        version: result.version,
        body: result.body ?? null,
        date: result.date ?? null,
        download,
        install,
        downloadAndInstall: async (
          onEvent: (event: {
            event: 'Started' | 'Progress' | 'Finished';
            data?: { contentLength?: number; chunkLength?: number };
          }) => void
        ) => {
          await download(onEvent);
          await install();
        },
        close,
      };
    },
    relaunch: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.UPDATER_RELAUNCH),
  },

  desktopToast: {
    setIgnoreMouseEvents: (ignore: boolean): Promise<void> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.DESKTOP_TOAST_SET_IGNORE_MOUSE_EVENTS,
        Boolean(ignore)
      ),
    setContentHeight: (height: number): Promise<void> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.DESKTOP_TOAST_SET_CONTENT_HEIGHT,
        Number(height)
      ),
  },

  invoke: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>
  ): Promise<T> =>
    args === undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.SHELL_INVOKE, cmd)
      : ipcRenderer.invoke(IPC_CHANNELS.SHELL_INVOKE, cmd, args),
};

// `contextBridge.exposeInMainWorld` evaluates getters once and freezes the
// snapshot, so after a sidecar auto-restart `window.dimoDesktop.backend` would
// otherwise keep returning the dead port/token. Use `executeInMainWorld` to
// attach a live `backend` getter backed by the proxied `getBackend` function
// while keeping `window.dimoDesktop` frozen and non-configurable.
if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({
    func: (
      bridgeObj: Record<string, unknown>,
      getBackendFn: () => ElectronBackendConnectionInfo | undefined
    ) => {
      const target: Record<string, unknown> = {};
      Object.keys(bridgeObj).forEach((key) => {
        if (key !== 'backend') {
          target[key] = bridgeObj[key];
        }
      });
      Object.defineProperty(target, 'backend', {
        get: () => getBackendFn(),
        enumerable: true,
        configurable: false,
      });
      Object.freeze(target);
      Object.defineProperty(globalThis, 'dimoDesktop', {
        value: target,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    },
    args: [dimoDesktopBridge, getBackend],
  });
} else {
  contextBridge.exposeInMainWorld('dimoDesktop', dimoDesktopBridge);
}
