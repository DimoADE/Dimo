import { randomUUID } from '@/utils/randomUUID';
import { getDesktopShell } from '@/lib/desktopShell';
import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import { getElectronBackendTransport } from './electronTransport';

const REMOTE_HOST_EVENT_CHANNEL = 'dimo://remote-host-event';
const REMOTE_SUBSCRIPTION_EVENT_CHANNEL = 'dimo://remote-subscription-event';

type RemoteHostEventEnvelope = {
  windowLabel?: string;
  targets?: string[];
  channel?: string;
  payload?: unknown;
};

type WireRemoteEvent = Omit<RemoteEvent, 'sequence'> & {
  sequence: number | bigint | string;
};

type RemoteSubscriptionEventEnvelope = {
  subscriptionId?: string;
  event?: WireRemoteEvent;
};

function normalizeRemoteSequence(
  value: number | bigint | string | undefined
): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return 0n;
}

function createSharedChannelMultiplexer<T>(channel: string) {
  const listeners = new Set<(envelope: T) => void>();
  let unlistenPromise: Promise<() => void> | null = null;
  let activeUnlisten: (() => void) | null = null;
  let epoch = 0;

  const attachIfNeeded = async () => {
    if (unlistenPromise) {
      await unlistenPromise;
      return;
    }
    const currentEpoch = ++epoch;
    unlistenPromise = getElectronBackendTransport()
      .listen<T>(channel, (envelope) => {
        for (const listener of Array.from(listeners)) {
          listener(envelope);
        }
      })
      .then((unlisten) => {
        if (currentEpoch !== epoch || listeners.size === 0) {
          unlisten();
          return () => undefined;
        }
        activeUnlisten = unlisten;
        return unlisten;
      })
      .catch((error) => {
        if (currentEpoch === epoch) {
          unlistenPromise = null;
          activeUnlisten = null;
        }
        throw error;
      });
    await unlistenPromise;
  };

  return {
    async subscribe(listener: (envelope: T) => void): Promise<() => void> {
      listeners.add(listener);
      try {
        await attachIfNeeded();
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        listeners.delete(listener);
        if (listeners.size === 0) {
          epoch += 1;
          const cleanup = activeUnlisten;
          activeUnlisten = null;
          unlistenPromise = null;
          cleanup?.();
        }
      };
    },
    resetForTests() {
      epoch += 1;
      listeners.clear();
      const cleanup = activeUnlisten;
      activeUnlisten = null;
      unlistenPromise = null;
      cleanup?.();
    },
  };
}

const remoteHostEventMux =
  createSharedChannelMultiplexer<RemoteHostEventEnvelope>(
    REMOTE_HOST_EVENT_CHANNEL
  );
const remoteSubscriptionEventMux =
  createSharedChannelMultiplexer<RemoteSubscriptionEventEnvelope>(
    REMOTE_SUBSCRIPTION_EVENT_CHANNEL
  );

export function resetRemoteDesktopMultiplexersForTests(): void {
  remoteHostEventMux.resetForTests();
  remoteSubscriptionEventMux.resetForTests();
}

export type RemoteDesktopProfile = {
  profileId: string;
  baseUrl: string;
  token: string;
};

export interface RemoteDesktopBridge {
  connect(profile: RemoteDesktopProfile): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  call(
    profileId: string,
    command: string,
    args?: Record<string, unknown>,
    operationId?: string
  ): Promise<unknown>;
  capabilities(profileId: string): Promise<ServerCapabilities>;
  listen(
    profileId: string,
    event: string,
    handler: (payload: unknown) => void
  ): Promise<() => void>;
  subscribe(
    profileId: string,
    request: SubscriptionRequest
  ): AsyncIterable<RemoteEvent>;
}

export const electronRemoteDesktopBridge: RemoteDesktopBridge = {
  async connect(profile) {
    await getDesktopShell().invoke('remote_desktop_connect', { profile });
  },
  async disconnect(profileId) {
    await getDesktopShell().invoke('remote_desktop_disconnect', { profileId });
  },
  async call(profileId, command, args, operationId) {
    return getDesktopShell().invoke('remote_desktop_call', {
      profileId,
      command,
      args: args ?? {},
      operationId,
    });
  },
  async capabilities(profileId) {
    return getDesktopShell().invoke<ServerCapabilities>(
      'remote_desktop_capabilities',
      { profileId }
    );
  },
  async listen(profileId, event, handler) {
    const expectedChannel = `remote-desktop:${profileId}:${event}`;
    const currentLabel = getDesktopShell().getWindowLabel();
    const unlisten = await remoteHostEventMux.subscribe((envelope) => {
      if (!envelope || envelope.channel !== expectedChannel) {
        return;
      }
      if (
        Array.isArray(envelope.targets) &&
        envelope.targets.length > 0 &&
        !envelope.targets.includes(currentLabel) &&
        envelope.windowLabel !== currentLabel
      ) {
        return;
      }
      handler(envelope.payload);
    });
    const subscriptionId = randomUUID();
    try {
      await getDesktopShell().invoke('remote_desktop_listen', {
        profileId,
        event,
        subscriptionId,
      });
    } catch (error) {
      unlisten();
      throw error;
    }
    return () => {
      unlisten();
      void getDesktopShell().invoke('remote_desktop_cancel_subscription', {
        subscriptionId,
      });
    };
  },
  subscribe(profileId, request) {
    return subscribeRemoteDesktopViaElectron(profileId, request);
  },
};

function getDefaultRemoteDesktopBridge(): RemoteDesktopBridge {
  return electronRemoteDesktopBridge;
}

const MAX_REMOTE_SUBSCRIPTION_QUEUE_SIZE = 4096;

function subscribeRemoteDesktopViaElectron(
  profileId: string,
  request: SubscriptionRequest
): AsyncIterable<RemoteEvent> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<RemoteEvent> => {
      const queue: RemoteEvent[] = [];
      let queueHead = 0;
      let failure: Error | null = null;
      let wake: (() => void) | undefined;
      let closed = false;
      let started = false;
      let cancelled = false;
      let remoteSubscribed = false;
      let remoteCancelSent = false;
      let unlisten: (() => void) | undefined;
      const subscriptionId = randomUUID();

      const queueSize = () => queue.length - queueHead;
      const dequeue = (): RemoteEvent | undefined => {
        if (queueHead >= queue.length) {
          return undefined;
        }
        const item = queue[queueHead];
        queueHead += 1;
        if (queueHead >= 256 && queueHead * 2 >= queue.length) {
          queue.splice(0, queueHead);
          queueHead = 0;
        } else if (queueHead === queue.length) {
          queue.length = 0;
          queueHead = 0;
        }
        return item;
      };
      const enqueue = (item: RemoteEvent) => {
        if (queueSize() >= MAX_REMOTE_SUBSCRIPTION_QUEUE_SIZE) {
          queueHead += 1;
          if (queueHead >= 256 && queueHead * 2 >= queue.length) {
            queue.splice(0, queueHead);
            queueHead = 0;
          }
        }
        queue.push(item);
      };

      const wakeConsumer = () => {
        const pendingWake = wake;
        wake = undefined;
        pendingWake?.();
      };

      const cancelSubscription = async () => {
        cancelled = true;
        closed = true;
        queue.length = 0;
        queueHead = 0;
        wakeConsumer();
        if (unlisten) {
          const fn = unlisten;
          unlisten = undefined;
          fn();
        }
        if (remoteSubscribed && !remoteCancelSent) {
          remoteCancelSent = true;
          await getDesktopShell()
            .invoke('remote_desktop_cancel_subscription', {
              subscriptionId,
            })
            .catch(() => undefined);
        }
      };

      return {
        next: async (): Promise<IteratorResult<RemoteEvent>> => {
          if (failure && queueSize() === 0) {
            const err = failure;
            failure = null;
            await cancelSubscription();
            throw err;
          }
          if (closed && queueSize() === 0) {
            return { value: undefined, done: true };
          }
          if (!started) {
            started = true;
            let acquiredUnlisten: () => void;
            try {
              acquiredUnlisten = await remoteSubscriptionEventMux.subscribe(
                (envelope) => {
                  if (!envelope || envelope.subscriptionId !== subscriptionId) {
                    return;
                  }
                  const rawEvent = envelope.event;
                  if (!rawEvent) return;
                  if (rawEvent.kind === 'subscription_closed') {
                    closed = true;
                    wakeConsumer();
                    return;
                  }
                  if (rawEvent.kind === 'subscription_error') {
                    const payload = rawEvent.payload as
                      | { message?: unknown; code?: unknown }
                      | undefined;
                    const message =
                      typeof payload?.message === 'string' &&
                      payload.message.trim().length > 0
                        ? payload.message
                        : 'Remote subscription failed';
                    failure = new Error(message);
                    closed = true;
                    wakeConsumer();
                    return;
                  }
                  if (closed) return;
                  enqueue({
                    ...rawEvent,
                    sequence: normalizeRemoteSequence(rawEvent.sequence),
                  });
                  wakeConsumer();
                }
              );
            } catch (error) {
              closed = true;
              cancelled = true;
              throw error;
            }
            unlisten = acquiredUnlisten;
            if (closed || cancelled) {
              await cancelSubscription();
              return { value: undefined, done: true };
            }
            try {
              await getDesktopShell().invoke('remote_desktop_subscribe', {
                profileId,
                subscriptionId,
                request: {
                  ...request,
                  subscription_id: subscriptionId,
                  ...('after_sequence' in request
                    ? { after_sequence: Number(request.after_sequence) }
                    : {}),
                },
              });
              remoteSubscribed = true;
            } catch (error) {
              await cancelSubscription();
              throw error;
            }
            if (cancelled) {
              await cancelSubscription();
              return { value: undefined, done: true };
            }
          }
          while (!closed || queueSize() > 0 || failure !== null) {
            const next = dequeue();
            if (next) {
              return { value: next, done: false };
            }
            if (failure) {
              const err = failure;
              failure = null;
              await cancelSubscription();
              throw err;
            }
            if (closed) break;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          await cancelSubscription();
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<RemoteEvent>> {
          await cancelSubscription();
          return { value: undefined, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<RemoteEvent>> {
          await cancelSubscription();
          throw err;
        },
      };
    },
  };
}

/**
 * A window-owned remote connection. Credentials cross the WebView boundary
 * once during `connect` and live only in the Rust adapter afterwards.
 */
export class RemoteDesktopTransport implements BackendTransport {
  readonly environment = 'remote-desktop' as const;
  readonly profileId: string;
  private readonly baseUrl: string;
  private readonly bridge: RemoteDesktopBridge;
  private destroyed = false;

  private constructor(
    profileId: string,
    baseUrl: string,
    bridge: RemoteDesktopBridge
  ) {
    this.profileId = profileId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.bridge = bridge;
  }

  static async connect(
    profile: RemoteDesktopProfile,
    bridge: RemoteDesktopBridge = getDefaultRemoteDesktopBridge()
  ): Promise<RemoteDesktopTransport> {
    await bridge.connect(profile);
    return new RemoteDesktopTransport(
      profile.profileId,
      profile.baseUrl,
      bridge
    );
  }

  static attach(
    profile: { profileId: string; baseUrl: string },
    bridge: RemoteDesktopBridge = getDefaultRemoteDesktopBridge()
  ): RemoteDesktopTransport {
    return new RemoteDesktopTransport(
      profile.profileId,
      profile.baseUrl,
      bridge
    );
  }

  call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    return this.bridge.call(
      this.profileId,
      command,
      args,
      options?.operationId
    );
  }

  async stream<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T> {
    const result = await this.call(command, args);
    if (result && typeof result === 'object' && 'events' in result) {
      const events = (result as { events?: unknown }).events;
      if (Array.isArray(events)) {
        for (const event of events) {
          onMessage(event);
        }
      }
    }
    return result as T;
  }

  capabilities(): Promise<ServerCapabilities> {
    return this.bridge.capabilities(this.profileId);
  }

  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (this.destroyed) {
      return Promise.resolve(() => undefined);
    }
    return this.bridge.listen(this.profileId, event, (payload) =>
      handler(payload as T)
    );
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return this.bridge.subscribe(this.profileId, request);
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
    loopbackPort?: number;
  }): string {
    return `${this.baseUrl}/api/v1/previews/${encodeURIComponent(
      lease.leaseId
    )}/c/${encodeURIComponent(lease.capabilityToken)}/`;
  }

  detach(): void {
    this.destroyed = true;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.bridge.disconnect(this.profileId);
  }

  toJSON(): { environment: string; profileId: string; baseUrl: string } {
    return {
      environment: this.environment,
      profileId: this.profileId,
      baseUrl: this.baseUrl,
    };
  }
}
