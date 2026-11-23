import type { DesktopShellBridge, ElectronDesktopBridge } from './types';

/**
 * Returns true when running inside the Electron shell where `preload.ts`
 * exposed `window.dimoDesktop`.
 */
export function hasElectronDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.dimoDesktop);
}

let cachedElectronSource: ElectronDesktopBridge | undefined;
let cachedElectronBridge: DesktopShellBridge | null = null;

export function getElectronShellBridge(
  source: ElectronDesktopBridge
): DesktopShellBridge {
  if (cachedElectronBridge && cachedElectronSource === source) {
    return cachedElectronBridge;
  }

  const bridge: DesktopShellBridge = {
    kind: 'electron',

    getAppVersion: () => source.getAppVersion(),
    getWindowLabel: () => source.getWindowLabel(),

    window: {
      getLabel: () =>
        typeof source.window.getLabel === 'function'
          ? source.window.getLabel()
          : Promise.resolve(source.getWindowLabel()),
      minimize: () => source.window.minimize(),
      toggleMaximize: () => source.window.toggleMaximize(),
      isMaximized: () => source.window.isMaximized(),
      close: () => source.window.close(),
      show: () => source.window.show(),
      hide: () => source.window.hide(),
      setFocus: () => source.window.setFocus(),
      setTitle: (title: string) => source.window.setTitle(title),
      startDragging: () => source.window.startDragging(),
      onResized: (callback: () => void) => source.window.onResized(callback),
      setZoom: (scale: number) => source.window.setZoom(scale),
      onDragDropEvent: (callback) => source.window.onDragDropEvent(callback),
    },

    dialog: {
      open: (options) => source.dialog.open(options),
      save: (options) => source.dialog.save(options),
    },

    fs: {
      readFile: (path: string) => source.fs.readFile(path),
      writeFile: (path: string, contents: Uint8Array) =>
        source.fs.writeFile(path, contents),
      writeTextFile: (path: string, contents: string) =>
        source.fs.writeTextFile(path, contents),
    },

    path: {
      join: (...parts: string[]) => source.path.join(...parts),
    },

    shell: {
      openExternal: (target: string) => source.shell.openExternal(target),
    },

    assets: {
      convertFileSrc: (filePath: string, protocol?: string) =>
        source.assets.convertFileSrc(filePath, protocol),
    },

    events: {
      listen: (event, handler) => source.events.listen(event, handler),
      emit: (event, payload) => source.events.emit(event, payload),
    },

    updater: {
      check: (options) => source.updater.check(options),
      relaunch: () => source.updater.relaunch(),
    },

    desktopToast: source.desktopToast
      ? {
          setIgnoreMouseEvents:
            typeof source.desktopToast.setIgnoreMouseEvents === 'function'
              ? (ignore: boolean) =>
                  source.desktopToast!.setIgnoreMouseEvents!(ignore)
              : undefined,
          setContentHeight:
            typeof source.desktopToast.setContentHeight === 'function'
              ? (height: number) =>
                  source.desktopToast!.setContentHeight!(height)
              : undefined,
        }
      : undefined,

    invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) =>
      args === undefined ? source.invoke<T>(cmd) : source.invoke<T>(cmd, args),
  };

  cachedElectronSource = source;
  cachedElectronBridge = bridge;
  return bridge;
}
