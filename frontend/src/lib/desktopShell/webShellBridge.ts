import type { DesktopShellBridge } from './types';

function unsupportedCapability(name: string): Error {
  const err = new Error(`Desktop ability ${name} is not available`);
  err.name = 'DesktopCapabilityError';
  (err as Error & { code: string }).code = 'capability_unavailable';
  return err;
}

const noopUnlisten = () => undefined;

/**
 * Fallback shell bridge used when running in a plain browser (no Electron
 * preload bridge on `window.dimoDesktop`).
 */
export const webShellBridge: DesktopShellBridge = {
  kind: 'web',

  async getAppVersion() {
    return '0.0.0';
  },

  getWindowLabel() {
    return 'main';
  },

  window: {
    async getLabel() {
      return 'main';
    },
    async minimize() {},
    async toggleMaximize() {},
    async isMaximized() {
      return false;
    },
    async close() {},
    async show() {},
    async hide() {},
    async setFocus() {},
    async setTitle(title: string) {
      if (typeof document !== 'undefined') {
        document.title = title;
      }
    },
    async startDragging() {},
    async onResized() {
      return noopUnlisten;
    },
    async setZoom() {},
    async onDragDropEvent() {
      return noopUnlisten;
    },
  },

  dialog: {
    async open() {
      return null;
    },
    async save() {
      return null;
    },
  },

  fs: {
    async readFile() {
      throw unsupportedCapability('fs.readFile');
    },
    async writeFile() {
      throw unsupportedCapability('fs.writeFile');
    },
    async writeTextFile() {
      throw unsupportedCapability('fs.writeTextFile');
    },
  },

  path: {
    async join(...parts: string[]) {
      return parts
        .filter((part) => part.length > 0)
        .join('/')
        .replace(/\/+/g, '/');
    },
  },

  shell: {
    async openExternal(target: string) {
      if (typeof window !== 'undefined') {
        window.open(target, '_blank', 'noopener,noreferrer');
      }
    },
  },

  assets: {
    convertFileSrc(filePath: string) {
      return filePath;
    },
  },

  events: {
    async listen() {
      return noopUnlisten;
    },
    async emit() {},
  },

  updater: {
    async check() {
      return null;
    },
    async relaunch() {
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    },
  },

  async invoke<T = unknown>(cmd: string): Promise<T> {
    throw unsupportedCapability(cmd);
  },
};
