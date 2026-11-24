import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const handleHandlers = new Map<string, (...args: unknown[]) => unknown>();
const onHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      onHandlers.set(channel, handler);
    }),
  },
}));

import {
  IPC_CHANNELS,
  type BootstrapPayload,
  type CachedServerCapabilities,
  type HostRpcProxyResponse,
} from '../shared/ipcContract';
import {
  isTrustedLocalHostSender,
  registerIpcHandlers,
  type IpcContext,
} from './ipc';

function createFakeSender(
  id: number,
  options: { type?: string } = {}
): EventEmitter & { id: number; getType: () => string } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    id,
    getType: () => options.type ?? 'window',
  });
}

function createInvokeEvent(params: {
  sender: EventEmitter & { id: number; getType: () => string };
  frameUrl?: string;
  frameParent?: unknown;
  omitFrame?: boolean;
}) {
  return {
    sender: params.sender,
    senderFrame: params.omitFrame
      ? null
      : {
          url: params.frameUrl ?? 'dimo://app/settings/general',
          parent: params.frameParent ?? null,
        },
  } as unknown as Electron.IpcMainInvokeEvent;
}

describe('isTrustedLocalHostSender security boundary', () => {
  it('allows registered main and settings top-level frames matching custom dimo://app origin', () => {
    const mainSender = createFakeSender(1);
    const settingsSender = createFakeSender(2);
    const labels = new Map<unknown, string>([
      [mainSender, 'main'],
      [settingsSender, 'settings'],
    ]);
    const windows = {
      getRegisteredLabelForWebContents: (wc: unknown) => labels.get(wc) ?? null,
      getAllowedAppOrigin: () => 'dimo://app',
    };

    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({
          sender: mainSender,
          frameUrl: 'dimo://app/workspace/1',
        }),
        windows
      )
    ).toBe(true);

    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({
          sender: settingsSender,
          frameUrl: 'dimo://app/settings/general',
        }),
        windows
      )
    ).toBe(true);
  });

  it('rejects unregistered senders, webviews, subframes, missing frames, wrong origins, and remote/toast windows', () => {
    const mainSender = createFakeSender(10);
    const remoteSender = createFakeSender(11);
    const remoteSettingsSender = createFakeSender(12);
    const toastSender = createFakeSender(13);
    const webviewSender = createFakeSender(14, { type: 'webview' });
    const unknownSender = createFakeSender(15);

    const labels = new Map<unknown, string>([
      [mainSender, 'main'],
      [remoteSender, 'host-remote-1'],
      [remoteSettingsSender, 'settings-host-remote-1'],
      [toastSender, 'desktop-toast'],
      [webviewSender, 'main'],
    ]);
    const windows = {
      getRegisteredLabelForWebContents: (wc: unknown) => labels.get(wc) ?? null,
      getAllowedAppOrigin: () => 'dimo://app',
    };

    // Unregistered webContents
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({ sender: unknownSender }),
        windows
      )
    ).toBe(false);

    // Webview sender even if label map were spoofed
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({ sender: webviewSender }),
        windows
      )
    ).toBe(false);

    // Remote host & remote settings & desktop toast windows
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({ sender: remoteSender }),
        windows
      )
    ).toBe(false);
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({ sender: remoteSettingsSender }),
        windows
      )
    ).toBe(false);
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({ sender: toastSender }),
        windows
      )
    ).toBe(false);

    // Subframe inside main window
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({
          sender: mainSender,
          frameParent: { url: 'dimo://app/' },
        }),
        windows
      )
    ).toBe(false);

    // Missing / detached senderFrame fails closed
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({
          sender: mainSender,
          omitFrame: true,
        }),
        windows
      )
    ).toBe(false);

    // Different scheme or origin (including another custom scheme whose URL.origin is "null")
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({
          sender: mainSender,
          frameUrl: 'https://evil.example/settings',
        }),
        windows
      )
    ).toBe(false);
    expect(
      isTrustedLocalHostSender(
        createInvokeEvent({
          sender: mainSender,
          frameUrl: 'evil://app/settings',
        }),
        windows
      )
    ).toBe(false);
  });
});

describe('registerIpcHandlers Host RPC proxy & bootstrap capabilities', () => {
  afterEach(() => {
    handleHandlers.clear();
    onHandlers.clear();
    vi.clearAllMocks();
  });

  function setupIpcHarness(cachedCaps: CachedServerCapabilities | null) {
    const mainSender = createFakeSender(100);
    const settingsSender = createFakeSender(101);
    const remoteSender = createFakeSender(102);
    const labels = new Map<unknown, string>([
      [mainSender, 'main'],
      [settingsSender, 'settings'],
      [remoteSender, 'host-remote-1'],
    ]);

    const proxyHostCommand = vi.fn();
    const fetchCapabilities = vi.fn();
    const getCachedCapabilities = vi.fn(() => cachedCaps);

    const context = {
      appVersion: '0.5.4',
      windows: {
        getLabelForWebContents: (wc: unknown) => labels.get(wc) ?? 'main',
        getRegisteredLabelForWebContents: (wc: unknown) =>
          labels.get(wc) ?? null,
        getAllowedAppOrigin: () => 'dimo://app',
        isDeveloperModeEnabled: () => false,
        isDevSession: () => false,
      },
      sidecar: {
        getConnectionOrNull: () => ({
          baseUrl: 'http://127.0.0.1:41234',
          token: 'secret-token',
          dataDir: '/tmp/dimo',
        }),
        getStatus: () => 'running',
        getCachedCapabilities,
        fetchCapabilities,
        proxyHostCommand,
      },
      assetScope: {},
      toast: {},
      deeplinks: {},
      chrome: {},
      browser: {},
      browserRpc: {},
      updater: {},
      onExitRequested: vi.fn(async () => undefined),
    } as unknown as IpcContext;

    registerIpcHandlers(context);

    return {
      mainSender,
      settingsSender,
      remoteSender,
      proxyHostCommand,
      fetchCapabilities,
      getCachedCapabilities,
    };
  }

  it('injects O(1) cached capabilities in BOOTSTRAP_SYNC only for local windows without network fetch', () => {
    const cachedCaps: CachedServerCapabilities = {
      protocol_version: '1.0',
      server_version: '0.5.4',
      minimum_client_version: '0.5.0',
      capabilities: ['application.call', 'desktop.electron', 'plugin.read'],
    };
    const {
      mainSender,
      settingsSender,
      remoteSender,
      fetchCapabilities,
      getCachedCapabilities,
    } = setupIpcHarness(cachedCaps);

    const bootstrapHandler = onHandlers.get(IPC_CHANNELS.BOOTSTRAP_SYNC);
    expect(bootstrapHandler).toBeTypeOf('function');

    const settingsEvent = { sender: settingsSender, returnValue: undefined as unknown };
    bootstrapHandler!(settingsEvent);
    expect((settingsEvent.returnValue as BootstrapPayload).capabilities).toEqual(
      cachedCaps
    );

    const mainEvent = { sender: mainSender, returnValue: undefined as unknown };
    bootstrapHandler!(mainEvent);
    expect((mainEvent.returnValue as BootstrapPayload).capabilities).toEqual(
      cachedCaps
    );

    const remoteEvent = { sender: remoteSender, returnValue: undefined as unknown };
    bootstrapHandler!(remoteEvent);
    expect((remoteEvent.returnValue as BootstrapPayload).capabilities).toBeNull();

    const unknownEvent = {
      sender: createFakeSender(999),
      returnValue: undefined as unknown,
    };
    bootstrapHandler!(unknownEvent);
    expect((unknownEvent.returnValue as BootstrapPayload).capabilities).toBeNull();

    expect(getCachedCapabilities).toHaveBeenCalledTimes(2);
    expect(fetchCapabilities).not.toHaveBeenCalled();
  });

  it('rejects non-allowlisted commands, path traversal, and untrusted senders on HOST_CALL', async () => {
    const { mainSender, remoteSender, proxyHostCommand } = setupIpcHarness(null);
    const hostCallHandler = handleHandlers.get(IPC_CHANNELS.HOST_CALL)!;

    // Non-allowlisted / path-traversal / shell command names
    for (const badCommand of [
      '../shutdown',
      'get_projects/../../etc',
      'arbitrary_unlisted_cmd',
      'reveal_main_window',
      'UPPER_CASE',
      '',
    ]) {
      const response = (await hostCallHandler(
        createInvokeEvent({ sender: mainSender }),
        { requestId: 'req-bad', command: badCommand }
      )) as HostRpcProxyResponse;
      expect(response).toMatchObject({
        ok: false,
        status: 403,
        code: 'forbidden',
        retryable: false,
      });
    }

    // Remote host window cannot use local sidecar RPC proxy
    const remoteRes = (await hostCallHandler(
      createInvokeEvent({ sender: remoteSender }),
      { requestId: 'req-remote', command: 'get_projects' }
    )) as HostRpcProxyResponse;
    expect(remoteRes).toMatchObject({
      ok: false,
      status: 403,
      code: 'forbidden',
    });

    expect(proxyHostCommand).not.toHaveBeenCalled();
  });

  it('forwards allowlisted HOST_CALL and aborts on HOST_CALL_CANCEL or sender destroyed', async () => {
    const { settingsSender, proxyHostCommand } = setupIpcHarness(null);
    const hostCallHandler = handleHandlers.get(IPC_CHANNELS.HOST_CALL)!;
    const cancelHandler = onHandlers.get(IPC_CHANNELS.HOST_CALL_CANCEL)!;

    const capturedSignals: AbortSignal[] = [];
    proxyHostCommand.mockImplementation(
      (params: { signal: AbortSignal }) =>
        new Promise<HostRpcProxyResponse>((resolve) => {
          capturedSignals.push(params.signal);
          params.signal.addEventListener('abort', () => {
            resolve({
              ok: false,
              status: 0,
              code: 'aborted',
              message: 'aborted',
              retryable: true,
            });
          });
        })
    );

    // 1. Explicit HOST_CALL_CANCEL aborts the matching in-flight request
    const call1 = hostCallHandler(
      createInvokeEvent({ sender: settingsSender }),
      {
        requestId: 'req-cancel-1',
        command: 'get_projects',
        args: { includeArchived: false },
        operationId: 'op-1',
      }
    );
    expect(capturedSignals).toHaveLength(1);
    expect(capturedSignals[0]!.aborted).toBe(false);

    cancelHandler({ sender: settingsSender }, 'req-cancel-1');
    expect(capturedSignals[0]!.aborted).toBe(true);
    await expect(call1).resolves.toMatchObject({ ok: false, code: 'aborted' });

    // 2. Window destruction aborts all remaining in-flight calls for that sender
    const call2 = hostCallHandler(
      createInvokeEvent({ sender: settingsSender }),
      {
        requestId: 'req-destroy-2',
        command: 'get_projects',
      }
    );
    expect(capturedSignals).toHaveLength(2);
    expect(capturedSignals[1]!.aborted).toBe(false);

    settingsSender.emit('destroyed');
    expect(capturedSignals[1]!.aborted).toBe(true);
    await expect(call2).resolves.toMatchObject({ ok: false, code: 'aborted' });
  });

  it('enforces trusted local sender on HOST_CAPABILITIES and forwards forceRefresh', async () => {
    const expected: CachedServerCapabilities = {
      protocol_version: '1.0',
      server_version: '0.5.4',
      minimum_client_version: '0.5.0',
      capabilities: ['application.call', 'desktop.electron'],
    };
    const { settingsSender, remoteSender, fetchCapabilities } =
      setupIpcHarness(null);
    fetchCapabilities.mockResolvedValue(expected);

    const capsHandler = handleHandlers.get(IPC_CHANNELS.HOST_CAPABILITIES)!;

    await expect(
      capsHandler(createInvokeEvent({ sender: remoteSender }), {
        forceRefresh: false,
      })
    ).rejects.toThrow(/restricted to trusted local windows/);

    await expect(
      capsHandler(createInvokeEvent({ sender: settingsSender }), {
        forceRefresh: true,
      })
    ).resolves.toEqual(expected);

    expect(fetchCapabilities).toHaveBeenCalledWith({ forceRefresh: true });
  });
});
