import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetElectronBackendTransportForTests,
  setElectronBackendTransportForTests,
  type ElectronTransport,
} from './electronTransport';
import {
  electronRemoteDesktopBridge,
  RemoteDesktopTransport,
  resetRemoteDesktopMultiplexersForTests,
  type RemoteDesktopBridge,
} from './remoteDesktopTransport';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).dimoDesktop;
  resetRemoteDesktopMultiplexersForTests();
  resetElectronBackendTransportForTests();
});

describe('RemoteDesktopTransport', () => {
  it('keeps two windows connected to different Rust-owned profiles isolated', async () => {
    const calls: Array<[string, string]> = [];
    const bridge: RemoteDesktopBridge = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      listen: vi.fn().mockResolvedValue(() => undefined),
      subscribe: vi.fn(),
      capabilities: vi.fn().mockResolvedValue({
        server_version: '1',
        protocol_version: '1.0',
        minimum_client_version: '0.1',
        capabilities: [],
      }),
      call: vi.fn(async (profileId, command) => {
        calls.push([profileId, command]);
        if (command === 'conversation_list') return profileId;
        return {
          ready: true,
          snapshot: null,
          replay: [
            {
              sequence: 1,
              kind: `from-${profileId}`,
              payload: {},
            },
          ],
          high_water_mark: 1,
        };
      }),
    };
    const windowA = await RemoteDesktopTransport.connect(
      {
        profileId: 'profile-a',
        baseUrl: 'https://server-a.example',
        token: 'token-a',
      },
      bridge
    );
    const windowB = await RemoteDesktopTransport.connect(
      {
        profileId: 'profile-b',
        baseUrl: 'https://server-b.example',
        token: 'token-b',
      },
      bridge
    );

    await expect(windowA.call('conversation_list')).resolves.toBe('profile-a');
    await expect(windowB.call('conversation_list')).resolves.toBe('profile-b');
    expect(calls).toEqual(
      expect.arrayContaining([
        ['profile-a', 'conversation_list'],
        ['profile-b', 'conversation_list'],
      ])
    );
    expect(JSON.stringify(windowA)).not.toContain('token-a');
    expect(JSON.stringify(windowB)).not.toContain('token-b');
    await windowA.destroy();
    await windowB.destroy();
  });

  it('calls both unlisten and remote_desktop_cancel_subscription when cancelled during in-flight remote_desktop_subscribe', async () => {
    const muxUnlisten = vi.fn();
    const subscribeDeferred = deferred<void>();
    const shellInvoke = vi.fn(
      (command: string, _args?: Record<string, unknown>) => {
        if (command === 'remote_desktop_subscribe') {
          return subscribeDeferred.promise;
        }
        return Promise.resolve({ ok: true });
      }
    );

    (window as unknown as Record<string, unknown>).dimoDesktop = {
      platform: 'win32',
      getWindowLabel: () => 'host-race-1',
      getAppVersion: async () => '0.5.2',
      backend: { baseUrl: 'http://127.0.0.1:43210', token: 't'.repeat(64) },
      invoke: shellInvoke,
      events: { listen: vi.fn(async () => () => undefined), emit: vi.fn() },
      window: {},
      dialog: {},
      fs: {},
      path: {},
      shell: {},
      assets: { convertFileSrc: (p: string) => p },
      updater: {},
    };

    const mockElectronTransport = {
      listen: vi.fn(async () => muxUnlisten),
    } as unknown as ElectronTransport;
    setElectronBackendTransportForTests(mockElectronTransport);

    const stream = electronRemoteDesktopBridge.subscribe('profile-1', {
      subscription_id: 'sub-race-1',
      resource: 'host_event',
      channel: 'test',
      after_sequence: 0n,
    });
    const iter = stream[Symbol.asyncIterator]();
    const nextPromise = iter.next();

    await vi.waitFor(() => {
      expect(shellInvoke).toHaveBeenCalledWith(
        'remote_desktop_subscribe',
        expect.objectContaining({ profileId: 'profile-1' })
      );
    });
    const subId = (
      shellInvoke.mock.calls.find(
        (call) => call[0] === 'remote_desktop_subscribe'
      )?.[1] as { subscriptionId: string } | undefined
    )?.subscriptionId;
    expect(subId).toBeTruthy();

    // Cancel while remote_desktop_subscribe is still in-flight.
    const returnResult = await iter.return!();
    expect(returnResult).toEqual({ value: undefined, done: true });
    // Frontend mux listener is released immediately.
    expect(muxUnlisten).toHaveBeenCalledTimes(1);
    // Remote cancel must wait until remote_desktop_subscribe finishes registering.
    expect(shellInvoke).not.toHaveBeenCalledWith(
      'remote_desktop_cancel_subscription',
      expect.anything()
    );

    // Once remote_desktop_subscribe resolves, remote_desktop_cancel_subscription MUST fire.
    subscribeDeferred.resolve();
    await expect(nextPromise).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(shellInvoke).toHaveBeenCalledWith(
      'remote_desktop_cancel_subscription',
      { subscriptionId: subId }
    );
    expect(muxUnlisten).toHaveBeenCalledTimes(1);
  });

  it('calls unlisten and skips remote_desktop_subscribe when cancelled while mux subscribe is in-flight', async () => {
    const muxUnlisten = vi.fn();
    const listenDeferred = deferred<() => void>();
    const shellInvoke = vi.fn(async () => ({ ok: true }));

    (window as unknown as Record<string, unknown>).dimoDesktop = {
      platform: 'win32',
      getWindowLabel: () => 'host-race-2',
      getAppVersion: async () => '0.5.2',
      backend: { baseUrl: 'http://127.0.0.1:43210', token: 't'.repeat(64) },
      invoke: shellInvoke,
      events: { listen: vi.fn(async () => () => undefined), emit: vi.fn() },
      window: {},
      dialog: {},
      fs: {},
      path: {},
      shell: {},
      assets: { convertFileSrc: (p: string) => p },
      updater: {},
    };

    const mockElectronTransport = {
      listen: vi.fn(() => listenDeferred.promise),
    } as unknown as ElectronTransport;
    setElectronBackendTransportForTests(mockElectronTransport);

    const stream = electronRemoteDesktopBridge.subscribe('profile-1', {
      subscription_id: 'sub-race-2',
      resource: 'host_event',
      channel: 'test',
      after_sequence: 0n,
    });
    const iter = stream[Symbol.asyncIterator]();
    const nextPromise = iter.next();

    // Cancel before mux subscribe resolves.
    await expect(iter.return!()).resolves.toEqual({
      value: undefined,
      done: true,
    });

    // Resolve mux subscribe after cancellation was already recorded.
    listenDeferred.resolve(muxUnlisten);
    await expect(nextPromise).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(muxUnlisten).toHaveBeenCalledTimes(1);
    expect(shellInvoke).not.toHaveBeenCalledWith(
      'remote_desktop_subscribe',
      expect.anything()
    );
    expect(shellInvoke).not.toHaveBeenCalledWith(
      'remote_desktop_cancel_subscription',
      expect.anything()
    );
  });
});
