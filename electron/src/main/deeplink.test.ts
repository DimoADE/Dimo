import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const createdWindows: Array<{
  emitter: EventEmitter;
  webContentsEmitter: EventEmitter;
  send: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setFullscreenState: (value: boolean) => void;
}> = [];

const preloadMocks = vi.hoisted(() => ({
  ipcOnListeners: new Map<string, (...args: unknown[]) => void>(),
  ipcSendSync: vi.fn(() => ({
    platform: 'win32',
    windowLabel: 'main',
    gpuMode: 'hardware',
    backend: null,
    sidecarStatus: 'starting',
  })),
  ipcSend: vi.fn(),
  ipcInvoke: vi.fn(),
  executeInMainWorld: vi.fn(
    (opts: { func: (...args: unknown[]) => void; args?: unknown[] }) => {
      opts.func(...(opts.args ?? []));
    }
  ),
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(() => '/tmp/dropped.png'),
}));

vi.mock('electron', () => {
  const BrowserWindowMock = vi.fn(() => {
    const emitter = new EventEmitter();
    const webContentsEmitter = new EventEmitter();
    let destroyed = false;
    let visible = false;
    let fullScreen = false;
    const send = vi.fn();
    const hide = vi.fn(() => {
      visible = false;
    });
    const show = vi.fn(() => {
      visible = true;
      emitter.emit('show');
    });
    const showInactive = vi.fn(() => {
      visible = true;
      emitter.emit('show');
    });
    const setFullScreen = vi.fn((next: boolean) => {
      fullScreen = next;
    });
    const setIgnoreMouseEvents = vi.fn();
    const destroy = vi.fn(() => {
      if (!destroyed) {
        destroyed = true;
        emitter.emit('closed');
        webContentsEmitter.emit('destroyed');
      }
    });

    const record = {
      emitter,
      webContentsEmitter,
      send,
      hide,
      setFullScreen,
      setIgnoreMouseEvents,
      setFullscreenState: (value: boolean) => {
        fullScreen = value;
      },
    };
    createdWindows.push(record);

    return {
      on: (ev: string, cb: (...args: unknown[]) => void) => emitter.on(ev, cb),
      once: (ev: string, cb: (...args: unknown[]) => void) => emitter.once(ev, cb),
      emit: (ev: string, ...args: unknown[]) => emitter.emit(ev, ...args),
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => false,
      isFocused: () => false,
      isFullScreen: () => fullScreen,
      setFullScreen,
      restore: vi.fn(),
      show,
      showInactive,
      hide,
      focus: vi.fn(),
      destroy,
      setTitle: vi.fn(),
      getTitle: () => 'Dimo',
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      setIgnoreMouseEvents,
      setVisibleOnAllWorkspaces: vi.fn(),
      setAppDetails: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      webContents: {
        id: createdWindows.length,
        isDestroyed: () => destroyed,
        on: (ev: string, cb: (...args: unknown[]) => void) =>
          webContentsEmitter.on(ev, cb),
        once: (ev: string, cb: (...args: unknown[]) => void) =>
          webContentsEmitter.once(ev, cb),
        send,
        setZoomFactor: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        isDevToolsOpened: () => false,
        closeDevTools: vi.fn(),
        openDevTools: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  (BrowserWindowMock as unknown as Record<string, unknown>).getFocusedWindow =
    vi.fn(() => null);
  (BrowserWindowMock as unknown as Record<string, unknown>).fromWebContents =
    vi.fn(() => null);

  return {
    BrowserWindow: BrowserWindowMock,
    Menu: {
      buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
      setApplicationMenu: vi.fn(),
    },
    contextBridge: {
      executeInMainWorld: preloadMocks.executeInMainWorld,
      exposeInMainWorld: preloadMocks.exposeInMainWorld,
    },
    ipcRenderer: {
      sendSync: preloadMocks.ipcSendSync,
      send: preloadMocks.ipcSend,
      invoke: preloadMocks.ipcInvoke,
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        preloadMocks.ipcOnListeners.set(channel, listener);
      }),
      removeListener: vi.fn(),
    },
    webUtils: {
      getPathForFile: preloadMocks.getPathForFile,
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({ isEmpty: () => true })),
    },
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
    session: {
      fromPartition: vi.fn(() => ({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      })),
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

import {
  IPC_CHANNELS,
  SIDECAR_READY_EVENT,
  SIDECAR_RESTARTED_EVENT,
} from '../shared/ipcContract';
import { DeepLinkManager } from './deeplink';
import {
  DESKTOP_TOAST_ACTIVATED_EVENT,
  DESKTOP_TOAST_MAX_PENDING,
  DesktopToastManager,
  DesktopToastQueue,
} from './desktopToast';
import { WindowManager } from './windows';

describe('DeepLinkManager cold-start session activation race', () => {
  it('preserves pendingSessionActivation across markMainWindowReady until renderer drains it', () => {
    const manager = new DeepLinkManager();
    const broadcastEvent = vi.fn();

    manager.handleUrl('dimo://open?project=p1&workspace=w1&session=s1');
    manager.attachHandlers({
      showMainWindow: vi.fn(),
      openSettingsWindow: vi.fn(),
      openAppWindow: vi.fn(),
      broadcastEvent,
    });

    // Not broadcast before main window did-finish-load
    expect(broadcastEvent).not.toHaveBeenCalled();

    // did-finish-load fires before async i18nReady + React mount
    manager.markMainWindowReady();
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent).toHaveBeenCalledWith(DESKTOP_TOAST_ACTIVATED_EVENT, {
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
    });

    // A duplicate markMainWindowReady() does not double-broadcast
    manager.markMainWindowReady();
    expect(broadcastEvent).toHaveBeenCalledTimes(1);

    // React mounts later and calls take_pending_desktop_toast_activation -> still receives it!
    expect(manager.takePendingSessionActivation()).toEqual({
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
    });
    expect(manager.takePendingSessionActivation()).toBeNull();

    // Warm-start activation after React has drained broadcasts immediately and
    // does not leave stale pending activation for a future reload.
    manager.handleUrl('dimo://open?project=p2&workspace=w2&session=s2');
    expect(broadcastEvent).toHaveBeenLastCalledWith(
      DESKTOP_TOAST_ACTIVATED_EVENT,
      { projectId: 'p2', workspaceId: 'w2', sessionId: 's2' }
    );
    expect(manager.takePendingSessionActivation()).toBeNull();
  });

  it('captures session activations arriving between did-finish-load and React mount, and resets cleanly on window close', () => {
    const manager = new DeepLinkManager();
    const broadcastEvent = vi.fn();

    manager.attachHandlers({
      showMainWindow: vi.fn(),
      openSettingsWindow: vi.fn(),
      openAppWindow: vi.fn(),
      broadcastEvent,
    });

    // did-finish-load fired, but React has not drained yet
    manager.markMainWindowReady();
    manager.handleUrl('dimo://open?project=p3&workspace=w3&session=s3');
    expect(broadcastEvent).toHaveBeenCalledWith(DESKTOP_TOAST_ACTIVATED_EVENT, {
      projectId: 'p3',
      workspaceId: 'w3',
      sessionId: 's3',
    });
    expect(manager.takePendingSessionActivation()).toEqual({
      projectId: 'p3',
      workspaceId: 'w3',
      sessionId: 's3',
    });

    // After main window closes and resets, next activation queues until ready again
    manager.resetMainWindowReady();
    broadcastEvent.mockClear();
    manager.handleUrl('dimo://open?project=p4&workspace=w4&session=s4');
    expect(broadcastEvent).not.toHaveBeenCalled();

    manager.markMainWindowReady();
    expect(broadcastEvent).toHaveBeenCalledWith(DESKTOP_TOAST_ACTIVATED_EVENT, {
      projectId: 'p4',
      workspaceId: 'w4',
      sessionId: 's4',
    });
    expect(manager.takePendingSessionActivation()).toEqual({
      projectId: 'p4',
      workspaceId: 'w4',
      sessionId: 's4',
    });
  });
});

describe('DesktopToastQueue cap and Linux non-click-through behavior', () => {
  it('caps pending toast queue at DESKTOP_TOAST_MAX_PENDING by dropping oldest payloads', () => {
    const queue = new DesktopToastQueue();
    const total = DESKTOP_TOAST_MAX_PENDING + 12;
    for (let i = 0; i < total; i += 1) {
      expect(
        queue.enqueueOrDeliver({
          projectId: 'p1',
          workspaceId: 'w1',
          sessionId: `s-${i}`,
          title: `Toast ${i}`,
          description: '',
          kind: 'success',
        })
      ).toBe(false);
    }

    expect(queue.pendingCount()).toBe(DESKTOP_TOAST_MAX_PENDING);
    const drained = queue.markReady();
    expect(drained).toHaveLength(DESKTOP_TOAST_MAX_PENDING);
    expect(drained[0].sessionId).toBe('s-12');
    expect(drained[drained.length - 1].sessionId).toBe(`s-${total - 1}`);
  });

  it('never calls setIgnoreMouseEvents on Linux so toast cards remain clickable', () => {
    createdWindows.length = 0;
    const windows = new WindowManager({
      preloadPath: '/preload.js',
      platform: 'linux',
    });
    const toast = new DesktopToastManager({
      preloadPath: '/preload.js',
      windows,
      platform: 'linux',
    });

    toast.show({
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
      title: 'Linux toast',
      description: 'Clickable',
      kind: 'success',
    });

    expect(createdWindows).toHaveLength(1);
    const toastRecord = createdWindows[0];
    expect(toastRecord.setIgnoreMouseEvents).not.toHaveBeenCalled();

    toast.setIgnoreMouseEvents(true);
    toast.setIgnoreMouseEvents(false);
    toast.hide();
    expect(toastRecord.setIgnoreMouseEvents).not.toHaveBeenCalled();
    toast.destroy();
  });
});

describe('WindowManager macOS fullscreen hide and auxiliary webContents broadcast', () => {
  it('exits fullscreen before hiding on macOS close-to-tray to prevent a stuck black Space', () => {
    createdWindows.length = 0;
    const windows = new WindowManager({
      preloadPath: '/preload.js',
      platform: 'darwin',
    });
    windows.setTrayEnabled(true);
    windows.createMainWindow();

    const mainRecord = createdWindows[0];
    mainRecord.setFullscreenState(true);

    const closeEvent = { preventDefault: vi.fn() };
    mainRecord.emitter.emit('close', closeEvent);

    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mainRecord.setFullScreen).toHaveBeenCalledWith(false);
    expect(mainRecord.hide).not.toHaveBeenCalled();

    mainRecord.emitter.emit('leave-full-screen');
    expect(mainRecord.hide).toHaveBeenCalledTimes(1);
  });

  it('broadcasts theme-changed and gpu-mode-changed to registered auxiliary desktop-toast windows', () => {
    createdWindows.length = 0;
    const windows = new WindowManager({ preloadPath: '/preload.js' });
    windows.createMainWindow();
    const toast = new DesktopToastManager({
      preloadPath: '/preload.js',
      windows,
    });
    toast.show({
      projectId: 'p1',
      workspaceId: 'w1',
      sessionId: 's1',
      title: 'Warm toast',
      description: 'Receives broadcasts',
      kind: 'success',
    });

    const mainRecord = createdWindows[0];
    const toastRecord = createdWindows[1];

    windows.broadcastEvent('theme-changed', { theme: 'dark' });
    expect(mainRecord.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENTS_MESSAGE, {
      event: 'theme-changed',
      payload: { theme: 'dark' },
    });
    expect(toastRecord.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENTS_MESSAGE, {
      event: 'theme-changed',
      payload: { theme: 'dark' },
    });

    windows.broadcastEvent('gpu-mode-changed', { mode: 'software' });
    expect(toastRecord.send).toHaveBeenCalledWith(IPC_CHANNELS.EVENTS_MESSAGE, {
      event: 'gpu-mode-changed',
      payload: { mode: 'software' },
    });

    // After toast is destroyed, broadcasts no longer target it
    toastRecord.send.mockClear();
    toast.destroy();
    windows.broadcastEvent('theme-changed', { theme: 'light' });
    expect(toastRecord.send).not.toHaveBeenCalled();
  });
});

describe('preload sidecar-restarted live backend and drag-drop reset', () => {
  it('updates window.dimoDesktop.backend live on sidecar-restarted and resets drag overlay on defaultPrevented/stopPropagation/dragend', async () => {
    const windowListeners = new Map<string, Set<(event: unknown) => void>>();
    const docListeners = new Map<string, Set<(event: unknown) => void>>();

    const makeTarget = (map: Map<string, Set<(event: unknown) => void>>) => ({
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        let set = map.get(type);
        if (!set) {
          set = new Set();
          map.set(type, set);
        }
        set.add(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: (event: unknown) => void) => {
        map.get(type)?.delete(fn);
      }),
    });

    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', {
      value: makeTarget(windowListeners),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: {
        ...makeTarget(docListeners),
        documentElement: { dataset: {} as Record<string, string> },
      },
      configurable: true,
      writable: true,
    });

    try {
      vi.resetModules();
      await import('../preload/index');

      const dimoDesktop = (globalThis as Record<string, unknown>).dimoDesktop as {
        backend?: { baseUrl: string; token: string };
        getBackend: () => { baseUrl: string; token: string } | undefined;
        sidecarStatus: string;
        getSidecarStatus: () => string;
        window: {
          onDragDropEvent: (
            cb: (event: { payload: { type: string } }) => void
          ) => Promise<() => void>;
        };
      };

      expect(dimoDesktop.backend).toBeUndefined();
      expect(dimoDesktop.sidecarStatus).toBe('starting');
      expect(dimoDesktop.getSidecarStatus()).toBe('starting');
      expect(Object.isFrozen(dimoDesktop)).toBe(true);

      // Simulate main-process SIDECAR_READY_EVENT broadcast once parallel boot finishes
      const eventsListener = preloadMocks.ipcOnListeners.get(
        IPC_CHANNELS.EVENTS_MESSAGE
      );
      expect(eventsListener).toBeTypeOf('function');
      eventsListener?.({}, {
        event: SIDECAR_READY_EVENT,
        payload: {
          backend: {
            baseUrl: 'http://127.0.0.1:4100',
            token: 'tok-initial',
            dataDir: '/tmp/dimo',
          },
        },
      });
      expect(dimoDesktop.sidecarStatus).toBe('running');
      expect(dimoDesktop.getSidecarStatus()).toBe('running');
      expect(dimoDesktop.backend).toEqual({
        baseUrl: 'http://127.0.0.1:4100',
        token: 'tok-initial',
        dataDir: '/tmp/dimo',
      });

      // Simulate main-process SIDECAR_RESTARTED_EVENT broadcast
      eventsListener?.({}, {
        event: SIDECAR_RESTARTED_EVENT,
        payload: {
          baseUrl: 'http://127.0.0.1:5200',
          token: 'tok-restarted',
          dataDir: '/tmp/dimo',
        },
      });

      // Live getter AND getBackend() both reflect the restarted sidecar
      expect(dimoDesktop.backend).toEqual({
        baseUrl: 'http://127.0.0.1:5200',
        token: 'tok-restarted',
        dataDir: '/tmp/dimo',
      });
      expect(dimoDesktop.getBackend()).toEqual({
        baseUrl: 'http://127.0.0.1:5200',
        token: 'tok-restarted',
        dataDir: '/tmp/dimo',
      });

      // Drag-drop: defaultPrevented after dragenter emits leave
      const events: Array<{ type: string }> = [];
      const unsub = await dimoDesktop.window.onDragDropEvent((ev) => {
        events.push(ev.payload);
      });

      const dragEnter = Array.from(windowListeners.get('dragenter')!)[0];
      const windowDrop = Array.from(windowListeners.get('drop')!)[0];
      const docDropCapture = Array.from(docListeners.get('drop')!)[0];
      const dragEnd = Array.from(windowListeners.get('dragend')!)[0];

      const makeEvent = (defaultPrevented = false) => ({
        defaultPrevented,
        isTrusted: true,
        preventDefault: vi.fn(),
        clientX: 10,
        clientY: 20,
        dataTransfer: {
          types: ['Files'],
          files: {
            length: 1,
            item: (i: number) => (i === 0 ? { name: 'a.png' } : null),
          },
        },
      });

      // Case 1: inner React target handles drop (defaultPrevented = true)
      dragEnter(makeEvent());
      expect(events.map((e) => e.type)).toEqual(['enter']);
      windowDrop(makeEvent(true));
      expect(events.map((e) => e.type)).toEqual(['enter', 'leave']);

      // Case 2: inner DOM target calls stopPropagation() so windowDrop never runs.
      // Must defer to a macrotask (not microtask) so native Chromium bubble-phase
      // drop handlers still observe active drag state before fallback cleanup.
      events.length = 0;
      dragEnter(makeEvent());
      docDropCapture(makeEvent(true));
      await Promise.resolve();
      expect(events.map((e) => e.type)).toEqual(['enter']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.map((e) => e.type)).toEqual(['enter', 'leave']);

      // Case 3: dragend resets active dragDepth
      events.length = 0;
      dragEnter(makeEvent());
      dragEnd({});
      expect(events.map((e) => e.type)).toEqual(['enter', 'leave']);

      unsub();
      expect(docListeners.get('drop')?.size).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    }
  });
});
