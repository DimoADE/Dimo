import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  exposeInMainWorld: vi.fn(),
  ipcSendSync: vi.fn(() => ({
    windowLabel: 'main',
    platform: process.platform,
    appVersion: '0.5.2',
    backend: { baseUrl: 'http://127.0.0.1:1234', token: 'tok' },
  })),
  ipcSend: vi.fn(),
  ipcInvoke: vi.fn(),
  ipcOn: vi.fn(),
  ipcRemoveListener: vi.fn(),
  getPathForFile: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog,
  },
  shell: {
    openExternal: electronMocks.openExternal,
    openPath: electronMocks.openPath,
    showItemInFolder: electronMocks.showItemInFolder,
  },
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    sendSync: electronMocks.ipcSendSync,
    send: electronMocks.ipcSend,
    invoke: electronMocks.ipcInvoke,
    on: electronMocks.ipcOn,
    removeListener: electronMocks.ipcRemoveListener,
  },
  webUtils: {
    getPathForFile: electronMocks.getPathForFile,
  },
}));

import {
  ALLOWED_EXTERNAL_SCHEMES,
  AuthorizedLocalPathRegistry,
  INTERNAL_FS_AUTHORIZE_DROPPED_PATHS_CHANNEL,
  MAX_LOCAL_FILE_READ_BYTES,
  isValidAbsolutePath,
  openExternalTarget,
  readLocalFile,
  revealInFileManager,
  showOpenDialog,
  showSaveDialog,
  stripWindowsVerbatimPrefix,
  writeLocalFile,
  writeLocalTextFile,
} from './osBridge';
import { PreviewAssetScope } from './protocol';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('openExternalTarget external schemes & local paths', () => {
  it('allows remote SSH editor schemes including vscode-insiders: and antigravity:', async () => {
    expect(ALLOWED_EXTERNAL_SCHEMES.has('vscode-insiders:')).toBe(true);
    expect(ALLOWED_EXTERNAL_SCHEMES.has('antigravity:')).toBe(true);

    await openExternalTarget('vscode-insiders://vscode-remote/ssh-remote+dev/workspace');
    await openExternalTarget('antigravity://vscode-remote/ssh-remote+dev/workspace');

    expect(electronMocks.openExternal).toHaveBeenNthCalledWith(
      1,
      'vscode-insiders://vscode-remote/ssh-remote+dev/workspace'
    );
    expect(electronMocks.openExternal).toHaveBeenNthCalledWith(
      2,
      'antigravity://vscode-remote/ssh-remote+dev/workspace'
    );
  });

  it('rejects unsupported schemes such as javascript: or file:', async () => {
    await expect(openExternalTarget('javascript:alert(1)')).rejects.toThrow(
      /Refused to open unsupported external target/
    );
    await expect(openExternalTarget('file:///etc/passwd')).rejects.toThrow(
      /Refused to open unsupported external target/
    );
    expect(electronMocks.openExternal).not.toHaveBeenCalled();
  });

  it('normalizes forward-slash Windows paths for shell.openPath and shell.showItemInFolder and rejects drive-relative paths on win32', async () => {
    electronMocks.openPath.mockResolvedValue('');
    await openExternalTarget('C:/Users/Alice/docs/report.pdf', 'win32');
    expect(electronMocks.openPath).toHaveBeenCalledWith(
      'C:\\Users\\Alice\\docs\\report.pdf'
    );

    await expect(openExternalTarget('/drive-relative/foo', 'win32')).rejects.toThrow(
      /Refused to open unsupported external target/
    );
    await expect(revealInFileManager('/drive-relative/foo', 'win32')).rejects.toThrow(
      /Path must be absolute/
    );

    if (process.platform === 'win32') {
      const root = makeTempDir('dimo-reveal-');
      const file = path.join(root, 'sample.txt');
      fs.writeFileSync(file, 'hello');
      const forwardSlashFile = file.replace(/\\/g, '/');
      const forwardSlashDir = root.replace(/\\/g, '/');

      await revealInFileManager(forwardSlashFile, 'win32');
      expect(electronMocks.showItemInFolder).toHaveBeenCalledWith(
        path.win32.normalize(file)
      );

      await revealInFileManager(forwardSlashDir, 'win32');
      expect(electronMocks.openPath).toHaveBeenCalledWith(
        path.win32.normalize(root)
      );
    }
  });
});

describe('AuthorizedLocalPathRegistry & gated local FS operations', () => {
  it('blocks unauthorized reads and writes and does not create directories for unauthorized writes', async () => {
    const root = makeTempDir('dimo-fs-auth-');
    const secretFile = path.join(root, 'secret.txt');
    fs.writeFileSync(secretFile, 'top-secret');
    const unauthorizedWriteTarget = path.join(root, 'unauth-dir', 'evil.txt');

    const registry = new AuthorizedLocalPathRegistry();

    await expect(readLocalFile(secretFile, registry)).rejects.toThrow(
      /Refused unauthorized local file read/
    );
    await expect(
      writeLocalTextFile(unauthorizedWriteTarget, 'pwned', registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);
    await expect(
      writeLocalFile(unauthorizedWriteTarget, new Uint8Array([1, 2, 3]), registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);

    expect(fs.existsSync(path.dirname(unauthorizedWriteTarget))).toBe(false);
  });

  it('grants exact file read access via showOpenDialog without granting write or sibling access', async () => {
    const root = makeTempDir('dimo-fs-open-file-');
    const chosenFile = path.join(root, 'chosen.txt');
    const siblingFile = path.join(root, 'sibling.txt');
    fs.writeFileSync(chosenFile, 'hello-open');
    fs.writeFileSync(siblingFile, 'do-not-read');

    const registry = new AuthorizedLocalPathRegistry();
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [chosenFile],
    });

    const selected = await showOpenDialog(undefined, { directory: false }, registry);
    expect(selected).toBe(chosenFile);

    const bytes = await readLocalFile(chosenFile, registry);
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello-open');

    // Sibling file remains unreadable, and chosen file is not writable.
    await expect(readLocalFile(siblingFile, registry)).rejects.toThrow(
      /Refused unauthorized local file read/
    );
    await expect(
      writeLocalTextFile(chosenFile, 'overwrite', registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);
  });

  it('grants directory read+write access via showOpenDialog({ directory: true }) while blocking traversal and sibling dirs', async () => {
    const root = makeTempDir('dimo-fs-open-dir-');
    const exportDir = path.join(root, 'export');
    const siblingDir = path.join(root, 'export-other');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });

    const registry = new AuthorizedLocalPathRegistry();
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [exportDir],
    });

    const selected = await showOpenDialog(undefined, { directory: true }, registry);
    expect(selected).toBe(exportDir);

    const exportedFile = path.join(exportDir, 'session-1.md');
    await writeLocalTextFile(exportedFile, '# Session 1', registry);
    expect(fs.readFileSync(exportedFile, 'utf8')).toBe('# Session 1');

    const readBack = await readLocalFile(exportedFile, registry);
    expect(Buffer.from(readBack).toString('utf8')).toBe('# Session 1');

    // Path traversal and prefix-matching sibling directory must be rejected.
    await expect(
      writeLocalTextFile(
        path.join(exportDir, '..', 'export-other', 'escape.md'),
        'nope',
        registry
      )
    ).rejects.toThrow(/Refused unauthorized local file write/);
    await expect(
      writeLocalTextFile(path.join(siblingDir, 'escape.md'), 'nope', registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);
  });

  it('grants exact write access for non-existent target via showSaveDialog', async () => {
    const root = makeTempDir('dimo-fs-save-');
    const saveTarget = path.join(root, 'snapshot.png');
    const siblingTarget = path.join(root, 'other.png');

    const registry = new AuthorizedLocalPathRegistry();
    electronMocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: saveTarget,
    });

    const selected = await showSaveDialog(undefined, { defaultPath: 'snapshot.png' }, registry);
    expect(selected).toBe(saveTarget);

    await writeLocalFile(saveTarget, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), registry);
    expect(Array.from(fs.readFileSync(saveTarget))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    await expect(
      writeLocalFile(siblingTarget, new Uint8Array([1]), registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);
  });

  it('allows dropped regular files (ignoring directories) and PreviewAssetScope-authorized files for read', async () => {
    const root = makeTempDir('dimo-fs-drop-scope-');
    const droppedImg = path.join(root, 'shot.png');
    const droppedDir = path.join(root, 'folder');
    const hiddenInFolder = path.join(droppedDir, 'inside.txt');
    const previewDir = path.join(root, 'preview');
    const previewFile = path.join(previewDir, 'chart.svg');

    fs.mkdirSync(droppedDir, { recursive: true });
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(droppedImg, 'img-bytes');
    fs.writeFileSync(hiddenInFolder, 'secret');
    fs.writeFileSync(previewFile, '<svg/>');

    const assetScope = new PreviewAssetScope();
    assetScope.allow({ directories: [previewDir] });

    const registry = new AuthorizedLocalPathRegistry({
      extraReadPredicate: (filePath) => assetScope.isAllowed(filePath),
    });

    const grantedCount = registry.grantReadFiles([droppedImg, droppedDir]);
    expect(grantedCount).toBe(1);

    expect(Buffer.from(await readLocalFile(droppedImg, registry)).toString()).toBe('img-bytes');
    expect(Buffer.from(await readLocalFile(previewFile, registry)).toString()).toBe('<svg/>');
    await expect(readLocalFile(hiddenInFolder, registry)).rejects.toThrow(
      /Refused unauthorized local file read/
    );
  });

  it('rejects symlink escapes and dangling symlinks inside an authorized writable directory', async () => {
    const root = makeTempDir('dimo-fs-symlink-');
    const exportDir = path.join(root, 'export');
    const outsideDir = path.join(root, 'outside');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const outsideTarget = path.join(outsideDir, 'target.txt');
    fs.writeFileSync(outsideTarget, 'original');
    const symlinkEscape = path.join(exportDir, 'escape.txt');
    const danglingEscape = path.join(exportDir, 'dangling.txt');

    try {
      fs.symlinkSync(outsideTarget, symlinkEscape);
      fs.symlinkSync(path.join(outsideDir, 'new-file.txt'), danglingEscape);
    } catch (error) {
      // Unprivileged Windows environments without Developer Mode cannot create symlinks.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }

    const registry = new AuthorizedLocalPathRegistry();
    registry.grantDirectory(exportDir, { writable: true });

    await expect(
      writeLocalTextFile(symlinkEscape, 'pwned', registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);
    await expect(
      writeLocalTextFile(danglingEscape, 'pwned', registry)
    ).rejects.toThrow(/Refused unauthorized local file write/);
    expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('original');
  });

  it('strips Windows verbatim prefixes, rejects drive-relative paths, enforces max read size, and writes Uint8Array views cleanly', async () => {
    expect(stripWindowsVerbatimPrefix('\\\\?\\C:\\temp\\a.txt', 'win32')).toBe(
      'C:\\temp\\a.txt'
    );
    expect(stripWindowsVerbatimPrefix('\\\\?\\UNC\\srv\\share\\a.txt', 'win32')).toBe(
      '\\\\srv\\share\\a.txt'
    );
    expect(isValidAbsolutePath('/foo', 'win32')).toBe(false);
    expect(isValidAbsolutePath('\\foo', 'win32')).toBe(false);
    expect(isValidAbsolutePath('C:foo', 'win32')).toBe(false);
    expect(isValidAbsolutePath('\\\\?\\C:\\foo', 'win32')).toBe(true);
    expect(isValidAbsolutePath('/foo', 'linux')).toBe(true);
    expect(MAX_LOCAL_FILE_READ_BYTES).toBe(64 * 1024 * 1024);

    const root = makeTempDir('dimo-fs-bounds-');
    const dataFile = path.join(root, 'payload.bin');
    fs.writeFileSync(dataFile, Buffer.alloc(64, 0x41));

    const registry = new AuthorizedLocalPathRegistry();
    expect(registry.grantDirectory(root, { writable: true })).toBe(true);

    // Enforces max byte limit before reading into memory.
    await expect(readLocalFile(dataFile, registry, 32)).rejects.toThrow(
      /Refused to read local file exceeding 32 bytes/
    );
    const okBytes = await readLocalFile(dataFile, registry, 64);
    expect(okBytes.byteLength).toBe(64);

    // Zero-copy subarray view writes only the selected byte slice.
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6]);
    const slice = backing.subarray(2, 5);
    const outFile = path.join(root, 'slice.bin');
    await writeLocalFile(outFile, slice, registry);
    expect(Array.from(fs.readFileSync(outFile))).toEqual([2, 3, 4]);

    if (process.platform === 'win32') {
      const verbatimFile = `\\\\?\\${dataFile}`;
      const verbatimOut = `\\\\?\\${path.join(root, 'verbatim-write.bin')}`;
      expect(registry.canRead(verbatimFile)).toBe(true);
      expect(registry.canWrite(verbatimOut)).toBe(true);

      const verbatimRegistry = new AuthorizedLocalPathRegistry({ platform: 'win32' });
      expect(verbatimRegistry.grantReadFile(verbatimFile)).toBe(true);
      expect(verbatimRegistry.canRead(dataFile)).toBe(true);
      expect(verbatimRegistry.grantReadFile('/drive-relative/file.bin')).toBe(false);
    }
  });
});

describe('preload drag-and-drop guard and listener cleanup', () => {
  it('skips duplicate drop when defaultPrevented, authorizes only trusted drops, and detaches window listeners when empty', async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const fakeWindow = {
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      }),
    };

    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: fakeWindow,
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      await import('../preload/index');
      expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith(
        'dimoDesktop',
        expect.any(Object)
      );
      const bridge = electronMocks.exposeInMainWorld.mock.calls[0][1] as {
        window: {
          onDragDropEvent: (
            cb: (event: { payload: unknown }) => void
          ) => Promise<() => void>;
        };
      };

      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      const unsubA = await bridge.window.onDragDropEvent((ev) => receivedA.push(ev.payload));
      const unsubB = await bridge.window.onDragDropEvent((ev) => receivedB.push(ev.payload));

      // Attached exactly once across multiple subscribers.
      expect(listeners.get('drop')?.size).toBe(1);
      expect(listeners.get('dragenter')?.size).toBe(1);
      expect(listeners.get('dragover')?.size).toBe(1);
      expect(listeners.get('dragleave')?.size).toBe(1);

      const dropHandler = Array.from(listeners.get('drop')!)[0];
      const fakeFile = { name: 'photo.png' };
      electronMocks.getPathForFile.mockReturnValue('/tmp/photo.png');
      const makeDropEvent = (opts: {
        defaultPrevented: boolean;
        isTrusted: boolean;
      }) => ({
        defaultPrevented: opts.defaultPrevented,
        isTrusted: opts.isTrusted,
        preventDefault: vi.fn(),
        clientX: 120,
        clientY: 240,
        dataTransfer: {
          types: ['Files'],
          files: {
            length: 1,
            item: (i: number) => (i === 0 ? fakeFile : null),
          },
        },
      });

      // 1. Already-handled drop (`defaultPrevented: true`) must NOT dispatch or authorize.
      dropHandler(makeDropEvent({ defaultPrevented: true, isTrusted: true }));
      expect(receivedA).toHaveLength(0);
      expect(electronMocks.ipcSend).not.toHaveBeenCalled();

      // 2. Untrusted synthetic drop must NOT authorize local FS paths.
      dropHandler(makeDropEvent({ defaultPrevented: false, isTrusted: false }));
      expect(electronMocks.ipcSend).not.toHaveBeenCalled();
      expect(receivedA).toHaveLength(1);

      // 3. Trusted unhandled OS drop authorizes paths via internal channel and dispatches once.
      dropHandler(makeDropEvent({ defaultPrevented: false, isTrusted: true }));
      expect(electronMocks.ipcSend).toHaveBeenCalledWith(
        INTERNAL_FS_AUTHORIZE_DROPPED_PATHS_CHANNEL,
        ['/tmp/photo.png']
      );
      expect(receivedA).toHaveLength(2);
      expect(receivedB).toHaveLength(2);

      // Removing one subscriber keeps global listeners attached.
      unsubA();
      expect(listeners.get('drop')?.size).toBe(1);

      // Removing the last subscriber detaches all 4 global listeners cleanly.
      unsubB();
      expect(listeners.get('dragenter')?.size).toBe(0);
      expect(listeners.get('dragover')?.size).toBe(0);
      expect(listeners.get('dragleave')?.size).toBe(0);
      expect(listeners.get('drop')?.size).toBe(0);

      // Subscribing again re-attaches listeners cleanly.
      const unsubC = await bridge.window.onDragDropEvent(() => {});
      expect(listeners.get('drop')?.size).toBe(1);
      unsubC();
      expect(listeners.get('drop')?.size).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });
});
