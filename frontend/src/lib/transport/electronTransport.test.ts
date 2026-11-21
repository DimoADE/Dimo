import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopShellBridge } from '@/lib/desktopShell';
import type { RemoteEvent, ServerCapabilities } from './backendTransport';
import {
  ElectronTransport,
  resetElectronBackendTransportForTests,
  setElectronBackendTransportForTests,
} from './electronTransport';
import {
  electronRemoteDesktopBridge,
  resetRemoteDesktopMultiplexersForTests,
} from './remoteDesktopTransport';
import {
  configuredBackendTransport,
  getLocalDesktopTransport,
} from './transportRegistry';
import type { WebTransport } from './webTransport';

function createMockWebTransport(): {
  transport: WebTransport;
  emitWsEvent: (event: string, payload: unknown) => void;
} {
  const wsListeners = new Map<string, Set<(payload: unknown) => void>>();
  const transport = {
    environment: 'web',
    origin: 'http://127.0.0.1:4100',
    call: vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      via: 'web',
      command,
      args,
    })),
    capabilities: vi.fn(
      async (): Promise<ServerCapabilities> => ({
        protocol_version: '1.0',
        server_version: '0.5.2',
        minimum_client_version: '0.5.0',
        capabilities: ['host_events'],
      })
    ),
    listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
      let set = wsListeners.get(event);
      if (!set) {
        set = new Set();
        wsListeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    }),
    subscribe: vi.fn(function* () {
      // empty async generator mock
    } as unknown as WebTransport['subscribe']),
    artifactPreviewUrl: vi.fn(
      (lease: { leaseId: string; capabilityToken: string }) =>
        `http://127.0.0.1:4100/api/v1/previews/${lease.leaseId}/c/${lease.capabilityToken}/`
    ),
    destroy: vi.fn(),
  } as unknown as WebTransport;

  return {
    transport,
    emitWsEvent(event: string, payload: unknown) {
      for (const handler of wsListeners.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

function createMockShell(): {
  shell: DesktopShellBridge;
  emitIpcEvent: (event: string, payload: unknown) => void;
} {
  const ipcListeners = new Map<string, Set<(payload: unknown) => void>>();
  const shell = {
    kind: 'electron',
    invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => ({
      via: 'shell',
      command,
      args,
    })),
    events: {
      listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
        let set = ipcListeners.get(event);
        if (!set) {
          set = new Set();
          ipcListeners.set(event, set);
        }
        set.add(handler);
        return () => {
          set?.delete(handler);
        };
      }),
      emit: vi.fn(async () => undefined),
    },
    getWindowLabel: () => 'main',
  } as unknown as DesktopShellBridge;

  return {
    shell,
    emitIpcEvent(event: string, payload: unknown) {
      for (const handler of ipcListeners.get(event) ?? []) {
        handler(payload);
      }
    },
  };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).dimoDesktop;
  resetRemoteDesktopMultiplexersForTests();
  resetElectronBackendTransportForTests();
});

describe('ElectronTransport', () => {
  it('routes HOST_COMMANDS to WebTransport and DESKTOP_SHELL_COMMANDS to DesktopShell', async () => {
    const web = createMockWebTransport();
    const shell = createMockShell();
    const transport = new ElectronTransport({
      backend: { baseUrl: 'http://127.0.0.1:4100', token: 'a'.repeat(64) },
      webTransport: web.transport,
      shell: shell.shell,
    });

    const hostResult = await transport.call('agent_connect', { id: 'a1' });
    expect(hostResult).toEqual({
      via: 'web',
      command: 'agent_connect',
      args: { id: 'a1' },
    });
    expect(shell.shell.invoke).not.toHaveBeenCalled();

    const shellResult = await transport.call('host_client_status', {});
    expect(shellResult).toEqual({
      via: 'shell',
      command: 'host_client_status',
      args: {},
    });
    expect(web.transport.call).toHaveBeenCalledTimes(1);
    expect(shell.shell.invoke).toHaveBeenCalledWith('host_client_status', {});
  });

  it('partitions server HostEventBus channels, shell-only events, and dual-bus theme-changed', async () => {
    const web = createMockWebTransport();
    const shell = createMockShell();
    const transport = new ElectronTransport({
      backend: { baseUrl: 'http://127.0.0.1:4100', token: 'a'.repeat(64) },
      webTransport: web.transport,
      shell: shell.shell,
    });

    const serverReceived: unknown[] = [];
    const unlistenServer = await transport.listen('host-client-changed', (payload) => {
      serverReceived.push(payload);
    });
    const browserReceived: unknown[] = [];
    const unlistenBrowser = await transport.listen('plugin:browser:tab', (payload) => {
      browserReceived.push(payload);
    });

    const themeReceived: unknown[] = [];
    const unlistenTheme = await transport.listen('theme-changed', (payload) => {
      themeReceived.push(payload);
    });
    const toastReceived: unknown[] = [];
    const unlistenToast = await transport.listen('desktop-toast', (payload) => {
      toastReceived.push(payload);
    });

    expect(web.transport.listen).toHaveBeenCalledWith('host-client-changed', expect.any(Function));
    expect(web.transport.listen).toHaveBeenCalledWith('plugin:browser:tab', expect.any(Function));
    expect(web.transport.listen).toHaveBeenCalledWith('theme-changed', expect.any(Function));
    expect(web.transport.listen).not.toHaveBeenCalledWith('desktop-toast', expect.any(Function));

    expect(shell.shell.events.listen).toHaveBeenCalledWith('theme-changed', expect.any(Function));
    expect(shell.shell.events.listen).toHaveBeenCalledWith('desktop-toast', expect.any(Function));
    expect(shell.shell.events.listen).not.toHaveBeenCalledWith(
      'host-client-changed',
      expect.any(Function)
    );

    web.emitWsEvent('host-client-changed', { source: 'ws' });
    shell.emitIpcEvent('host-client-changed', { source: 'ipc-ignored' });
    web.emitWsEvent('plugin:browser:tab', { tabId: 't1' });
    shell.emitIpcEvent('theme-changed', { theme: 'DARK' });
    web.emitWsEvent('theme-changed', { theme: 'LIGHT' });
    shell.emitIpcEvent('desktop-toast', { title: 'Hi' });

    expect(serverReceived).toEqual([{ source: 'ws' }]);
    expect(browserReceived).toEqual([{ tabId: 't1' }]);
    expect(themeReceived).toEqual([{ theme: 'DARK' }, { theme: 'LIGHT' }]);
    expect(toastReceived).toEqual([{ title: 'Hi' }]);

    unlistenServer();
    unlistenBrowser();
    unlistenTheme();
    unlistenToast();

    web.emitWsEvent('host-client-changed', { source: 'ws-after' });
    shell.emitIpcEvent('theme-changed', { theme: 'SYSTEM' });
    web.emitWsEvent('theme-changed', { theme: 'DARK' });
    expect(serverReceived).toEqual([{ source: 'ws' }]);
    expect(themeReceived).toEqual([{ theme: 'DARK' }, { theme: 'LIGHT' }]);
  });

  it('delegates server host stream() calls to WebTransport.stream when available and falls back otherwise', async () => {
    const web = createMockWebTransport();
    const webStream = vi.fn(
      async (
        command: string,
        args: Record<string, unknown>,
        onMessage: (message: unknown) => void
      ) => {
        onMessage({ delta: 'hello' });
        return { streamed: true, command, args };
      }
    );
    (web.transport as unknown as { stream?: typeof webStream }).stream = webStream;

    const shell = createMockShell();
    const transport = new ElectronTransport({
      backend: { baseUrl: 'http://127.0.0.1:4100', token: 'a'.repeat(64) },
      webTransport: web.transport,
      shell: shell.shell,
    });

    const hostMessages: unknown[] = [];
    const hostRes = await transport.stream(
      'agent_connect',
      { id: 'a1' },
      (msg) => hostMessages.push(msg)
    );
    expect(webStream).toHaveBeenCalledWith(
      'agent_connect',
      { id: 'a1' },
      expect.any(Function)
    );
    expect(hostMessages).toEqual([{ delta: 'hello' }]);
    expect(hostRes).toEqual({
      streamed: true,
      command: 'agent_connect',
      args: { id: 'a1' },
    });

    const shellInvoke = shell.shell.invoke as ReturnType<typeof vi.fn>;
    shellInvoke.mockResolvedValueOnce({ events: [{ step: 1 }], done: true });
    const shellMessages: unknown[] = [];
    const shellRes = await transport.stream(
      'host_client_status',
      {},
      (msg) => shellMessages.push(msg)
    );
    expect(shellMessages).toEqual([{ step: 1 }]);
    expect(shellRes).toEqual({ events: [{ step: 1 }], done: true });
  });

  it('delegates emit, capabilities, and artifactPreviewUrl', async () => {
    const web = createMockWebTransport();
    const shell = createMockShell();
    const transport = new ElectronTransport({
      backend: { baseUrl: 'http://127.0.0.1:4100', token: 'a'.repeat(64) },
      webTransport: web.transport,
      shell: shell.shell,
    });

    await transport.emit('dimo:test', { ok: true });
    expect(shell.shell.events.emit).toHaveBeenCalledWith('dimo:test', { ok: true });

    const caps = await transport.capabilities();
    expect(caps.protocol_version).toBe('1.0');
    expect(caps.capabilities).toContain('desktop.electron');
    expect(
      transport.artifactPreviewUrl({ leaseId: 'L1', capabilityToken: 'T1' })
    ).toContain('/api/v1/previews/L1/c/T1/');
  });
});

describe('getLocalDesktopTransport & electronRemoteDesktopBridge', () => {
  it('selects ElectronTransport automatically when window.dimoDesktop.backend is present and forwards origin', () => {
    const tauriDefault = getLocalDesktopTransport();
    expect(tauriDefault.environment).toBe('desktop');
    expect(tauriDefault).not.toBeInstanceOf(ElectronTransport);

    (window as unknown as Record<string, unknown>).dimoDesktop = {
      platform: 'win32',
      getWindowLabel: () => 'main',
      getAppVersion: async () => '0.5.2',
      backend: {
        baseUrl: 'http://127.0.0.1:43210',
        token: 'b'.repeat(64),
        protocolVersion: '1.0',
      },
      invoke: vi.fn(),
      events: { listen: vi.fn(async () => () => undefined), emit: vi.fn() },
      window: {},
      dialog: {},
      fs: {},
      path: {},
      shell: {},
      assets: { convertFileSrc: (p: string) => p },
      updater: {},
    };
    resetElectronBackendTransportForTests();

    const electronTransport = getLocalDesktopTransport();
    expect(electronTransport).toBeInstanceOf(ElectronTransport);
    expect(electronTransport.environment).toBe('desktop');
    expect(configuredBackendTransport.origin).toBe('http://127.0.0.1:43210');
  });

  it('filters remote host events, normalizes sequence to bigint, and handles subscription close/error via electronRemoteDesktopBridge', async () => {
    const web = createMockWebTransport();
    const shell = createMockShell();
    const shellInvoke = shell.shell.invoke as ReturnType<typeof vi.fn>;
    shellInvoke.mockImplementation(async () => ({ ok: true }));

    (window as unknown as Record<string, unknown>).dimoDesktop = {
      platform: 'win32',
      getWindowLabel: () => 'host-abc',
      getAppVersion: async () => '0.5.2',
      backend: {
        baseUrl: 'http://127.0.0.1:43210',
        token: 'c'.repeat(64),
        protocolVersion: '1.0',
      },
      invoke: shellInvoke,
      events: shell.shell.events,
      window: {},
      dialog: {},
      fs: {},
      path: {},
      shell: {},
      assets: { convertFileSrc: (p: string) => p },
      updater: {},
    };

    const transport = new ElectronTransport({
      backend: { baseUrl: 'http://127.0.0.1:43210', token: 'c'.repeat(64) },
      webTransport: web.transport,
      shell: shell.shell,
    });
    setElectronBackendTransportForTests(transport);

    const received: unknown[] = [];
    const unlisten = await electronRemoteDesktopBridge.listen(
      'profile-1',
      'workspace-updated',
      (payload) => received.push(payload)
    );

    // Wrong target window is ignored
    web.emitWsEvent('dimo://remote-host-event', {
      windowLabel: 'host-other',
      targets: ['host-other'],
      channel: 'remote-desktop:profile-1:workspace-updated',
      payload: { ignored: true },
    });
    // Matching target window is delivered
    web.emitWsEvent('dimo://remote-host-event', {
      windowLabel: 'host-abc',
      targets: ['host-abc', 'settings-host-abc'],
      channel: 'remote-desktop:profile-1:workspace-updated',
      payload: { workspaceId: 'ws-1' },
    });
    expect(received).toEqual([{ workspaceId: 'ws-1' }]);
    unlisten();
    expect(shellInvoke).toHaveBeenCalledWith(
      'remote_desktop_cancel_subscription',
      expect.objectContaining({ subscriptionId: expect.any(String) })
    );

    // Subscription stream normalizes JSON number sequence to bigint and closes on subscription_closed
    const stream = electronRemoteDesktopBridge.subscribe('profile-1', {
      subscription_id: 'sub-req-1',
      resource: 'host_event',
      channel: 'test',
      after_sequence: 0n,
    });
    const iter = stream[Symbol.asyncIterator]();
    const firstPromise = iter.next();
    await vi.waitFor(() => {
      expect(shellInvoke).toHaveBeenCalledWith(
        'remote_desktop_subscribe',
        expect.objectContaining({ profileId: 'profile-1' })
      );
    });
    const subCall = shellInvoke.mock.calls.find(
      (call) => call[0] === 'remote_desktop_subscribe'
    );
    const subId = (subCall?.[1] as { subscriptionId: string } | undefined)?.subscriptionId;
    expect(subId).toBeTruthy();

    web.emitWsEvent('dimo://remote-subscription-event', {
      subscriptionId: subId,
      event: {
        kind: 'host_event',
        payload: { hello: 'world' },
        sequence: 1,
      },
    });
    const expectedEvent: RemoteEvent = {
      kind: 'host_event',
      payload: { hello: 'world' },
      sequence: 1n,
    };
    expect(await firstPromise).toEqual({ value: expectedEvent, done: false });

    const donePromise = iter.next();
    web.emitWsEvent('dimo://remote-subscription-event', {
      subscriptionId: subId,
      event: { kind: 'subscription_closed', payload: null, sequence: 0 },
    });
    expect(await donePromise).toEqual({ value: undefined, done: true });

    // Subscription stream rejects on subscription_error
    const errStream = electronRemoteDesktopBridge.subscribe('profile-1', {
      subscription_id: 'sub-req-err',
      resource: 'host_event',
      channel: 'test-err',
      after_sequence: 0n,
    });
    const errIter = errStream[Symbol.asyncIterator]();
    const errPromise = errIter.next();
    await vi.waitFor(() => {
      expect(
        shellInvoke.mock.calls.filter((call) => call[0] === 'remote_desktop_subscribe')
          .length
      ).toBe(2);
    });
    const errSubCall = shellInvoke.mock.calls.filter(
      (call) => call[0] === 'remote_desktop_subscribe'
    )[1];
    const errSubId = (errSubCall?.[1] as { subscriptionId: string } | undefined)
      ?.subscriptionId;
    web.emitWsEvent('dimo://remote-subscription-event', {
      subscriptionId: errSubId,
      event: {
        kind: 'subscription_error',
        payload: { message: 'Remote host rejected subscription' },
        sequence: 0,
      },
    });
    await expect(errPromise).rejects.toThrow('Remote host rejected subscription');
  });
});
