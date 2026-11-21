import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  IPC_CHANNELS,
  convertFileSrcToAssetUrl,
  type BootstrapPayload,
  type DesktopUpdateCheckResult,
  type DesktopUpdateDownloadEventPayload,
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

const bootstrap = ipcRenderer.sendSync(
  IPC_CHANNELS.BOOTSTRAP_SYNC
) as BootstrapPayload;

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

const dragDropListeners = new Set<(event: DragDropEvent) => void>();
let dragDropWired = false;
let dragDepth = 0;

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

function ensureDragDropListeners(): void {
  if (dragDropWired || typeof window === 'undefined') {
    return;
  }
  dragDropWired = true;

  window.addEventListener('dragenter', (event) => {
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
  });

  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    dispatchDragDrop({
      type: 'over',
      position: { x: event.clientX, y: event.clientY },
    });
  });

  window.addEventListener('dragleave', (event) => {
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
  });

  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    const paths = extractFilePaths(event.dataTransfer);
    if (paths.length > 0) {
      dispatchDragDrop({
        type: 'drop',
        paths,
        position: { x: event.clientX, y: event.clientY },
      });
    } else {
      dispatchDragDrop({ type: 'leave' });
    }
  });
}

const dimoDesktopBridge = {
  platform: bootstrap.platform,
  backend: bootstrap.backend ? Object.freeze({ ...bootstrap.backend }) : undefined,

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
      ensureDragDropListeners();
      dragDropListeners.add(callback);
      return Promise.resolve(() => {
        dragDropListeners.delete(callback);
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
  },

  invoke: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>
  ): Promise<T> =>
    args === undefined
      ? ipcRenderer.invoke(IPC_CHANNELS.SHELL_INVOKE, cmd)
      : ipcRenderer.invoke(IPC_CHANNELS.SHELL_INVOKE, cmd, args),
};

contextBridge.exposeInMainWorld('dimoDesktop', dimoDesktopBridge);
