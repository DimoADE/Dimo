import { randomUUID } from '@/utils/randomUUID';
import type {
  BackendTransport,
  CreateDevicePairingRequest,
  DevicePairingChallenge,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';

const PROTOCOL_VERSION = '1.0';
export const WEB_SOCKET_KEEPALIVE_MS = 15_000;
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_PLUGIN_CALLS = 2;

const SLOW_ISOLATED_COMMANDS = new Set([
  'plugin_invoke_contribution',
  'plugin_command_invoke',
  'conversation_ensure_session_controls',
  'conversation_rebind_session',
]);

export interface WebTransportOptions {
  baseUrl: string;
  token: string;
  onAuthError?: (error: WebTransportError) => void;
  requestTimeoutMs?: number;
}

type CommandResponse = {
  operation_id: string;
  data: unknown;
};

type ErrorEnvelope = {
  code?: string;
  message?: string;
  retryable?: boolean;
  operation_id?: string;
  details?: unknown;
};

export class WebTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly operationId?: string,
    readonly status?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'WebTransportError';
  }
}

type WireRemoteEvent = Omit<RemoteEvent, 'sequence'> & { sequence: number };

type WireServerMessage =
  | { type: 'ready'; subscription_id: string }
  | {
      type: 'snapshot';
      subscription_id: string;
      snapshot: {
        through_sequence: number;
        payload: RemoteEvent['payload'];
      };
    }
  | {
      type: 'event';
      subscription_id: string;
      event: WireRemoteEvent;
    }
  | {
      type: 'live';
      subscription_id: string;
      high_water_mark: number;
    }
  | { type: 'detached'; subscription_id: string; reason: string }
  | { type: 'pong' }
  | { type: 'error'; error: unknown; subscription_id?: string };

const MAX_ASYNC_EVENT_QUEUE_SIZE = 4096;

class AsyncEventQueue {
  private values: Array<RemoteEvent | undefined> = [];
  private head = 0;
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<RemoteEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown = null;

  private compactIfNeeded(): void {
    if (this.head === 0) return;
    if (this.head >= this.values.length) {
      this.values.length = 0;
      this.head = 0;
    } else if (this.head >= 256 && this.head * 2 >= this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
  }

  push(value: RemoteEvent): void {
    if (this.ended || this.failure !== null) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.values.length - this.head >= MAX_ASYNC_EVENT_QUEUE_SIZE) {
      this.values[this.head] = undefined;
      this.head += 1;
      this.compactIfNeeded();
    }
    this.values.push(value);
  }

  next(): Promise<IteratorResult<RemoteEvent>> {
    if (this.head < this.values.length) {
      const value = this.values[this.head]!;
      this.values[this.head] = undefined;
      this.head += 1;
      this.compactIfNeeded();
      return Promise.resolve({ done: false, value });
    }
    if (this.failure !== null) {
      const err = this.failure;
      this.failure = null;
      this.ended = true;
      return Promise.reject(err);
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject })
    );
  }

  error(err: unknown): void {
    if (this.ended || this.failure !== null) {
      return;
    }
    const normalized =
      err instanceof Error ? err : new Error(String(err ?? 'Stream error'));
    if (this.waiters.length > 0) {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(normalized);
      }
      return;
    }
    this.failure = normalized;
  }

  close(): void {
    this.ended = true;
    this.values.length = 0;
    this.head = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

type ActiveSubscription = {
  request: SubscriptionRequest;
  cursor: bigint;
  queue: AsyncEventQueue;
};

export class WebTransport implements BackendTransport {
  readonly environment = 'web' as const;
  private baseUrl: string;
  private token: string;
  private readonly onAuthError?: (error: WebTransportError) => void;
  private readonly requestTimeoutMs: number | null;
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private awaitingPong = false;
  private destroyed = false;
  private visibilityListener: (() => void) | undefined;
  private onlineListener: (() => void) | undefined;
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly readyResolvers = new Map<string, () => void>();
  private capabilitiesCache: ServerCapabilities | undefined;
  private capabilitiesPromise: Promise<ServerCapabilities> | undefined;
  private activePluginCalls = 0;
  private readonly pluginCallWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(options: WebTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.onAuthError = options.onAuthError;
    this.requestTimeoutMs = options.requestTimeoutMs ?? null;
  }

  get origin(): string {
    return this.baseUrl;
  }

  reconfigure(options: { baseUrl: string; token: string }): void {
    if (this.destroyed) {
      return;
    }
    const nextBaseUrl = options.baseUrl.replace(/\/+$/, '');
    const nextToken = options.token;
    if (!nextBaseUrl || !nextToken) {
      return;
    }
    this.baseUrl = nextBaseUrl;
    this.token = nextToken;
    this.capabilitiesCache = undefined;
    this.capabilitiesPromise = undefined;
    this.reconnectAttempts = 0;
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      const staleSocket = this.socket;
      this.socket = undefined;
      this.detachSocketHandlers(staleSocket);
      try {
        staleSocket.close();
      } catch {
        // Ignore errors closing an already dead socket.
      }
    }
    if (this.subscriptions.size > 0) {
      this.connectSocket();
    }
  }

  private acquirePluginCallSlot(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(
        new WebTransportError('transport destroyed', 'transport_closed', true)
      );
    }
    if (this.activePluginCalls < MAX_CONCURRENT_PLUGIN_CALLS) {
      this.activePluginCalls += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.pluginCallWaiters.push({ resolve, reject });
    });
  }

  private releasePluginCallSlot(): void {
    const next = this.pluginCallWaiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.activePluginCalls = Math.max(0, this.activePluginCalls - 1);
  }

  async call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    const isolated = SLOW_ISOLATED_COMMANDS.has(command);
    if (isolated) {
      await this.acquirePluginCallSlot();
    }
    try {
      const response = await this.request(
        `/api/v1/call/${encodeURIComponent(command)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            operation_id: options?.operationId ?? randomUUID(),
            args: args ?? {},
          }),
        }
      );
      const envelope = (await response.json()) as CommandResponse;
      return envelope.data;
    } finally {
      if (isolated) {
        this.releasePluginCallSlot();
      }
    }
  }

  getCachedCapabilities(): ServerCapabilities | null {
    return this.capabilitiesCache ?? null;
  }

  async capabilities(): Promise<ServerCapabilities> {
    if (this.capabilitiesCache) {
      return this.capabilitiesCache;
    }
    if (this.capabilitiesPromise) {
      return this.capabilitiesPromise;
    }
    const pending = this.request(
      '/api/v1/capabilities',
      {},
      this.requestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS
    )
      .then((response) => response.json() as Promise<ServerCapabilities>)
      .then((caps) => {
        if (this.capabilitiesPromise === pending) {
          this.capabilitiesCache = caps;
          this.capabilitiesPromise = undefined;
        }
        return caps;
      })
      .catch((error) => {
        if (this.capabilitiesPromise === pending) {
          this.capabilitiesPromise = undefined;
        }
        throw error;
      });
    this.capabilitiesPromise = pending;
    return pending;
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    return this.listenHostEvent(event, handler);
  }

  async createDevicePairing(
    request: CreateDevicePairingRequest
  ): Promise<DevicePairingChallenge> {
    const response = await this.request(
      '/api/v1/auth/pairings',
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
      this.requestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS
    );
    return response.json() as Promise<DevicePairingChallenge>;
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
  }): string {
    return `${this.baseUrl}/api/v1/previews/${encodeURIComponent(
      lease.leaseId
    )}/c/${encodeURIComponent(lease.capabilityToken)}/`;
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RemoteEvent> => {
        let subscription: ActiveSubscription | undefined;
        let closed = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (!subscription) return;
          this.resolveReady(request.subscription_id);
          subscription.queue.close();
          if (
            this.subscriptions.get(request.subscription_id) === subscription
          ) {
            this.subscriptions.delete(request.subscription_id);
            this.safeSend(
              this.socket,
              JSON.stringify({
                type: 'detach',
                subscription_id: request.subscription_id,
              })
            );
          }
        };

        return {
          next: async (): Promise<IteratorResult<RemoteEvent>> => {
            if (closed) {
              return { value: undefined, done: true };
            }
            if (!subscription) {
              subscription = {
                request,
                cursor:
                  'after_sequence' in request ? request.after_sequence : 0n,
                queue: new AsyncEventQueue(),
              };
              this.subscriptions.set(request.subscription_id, subscription);
              this.connectSocket();
              if (this.socket?.readyState === WebSocket.OPEN) {
                this.sendAttach(subscription);
              }
            }
            try {
              const next = await subscription.queue.next();
              if (next.done || closed) {
                cleanup();
                return { value: undefined, done: true };
              }
              return next;
            } catch (err) {
              cleanup();
              throw err;
            }
          },
          async return(): Promise<IteratorResult<RemoteEvent>> {
            cleanup();
            return { value: undefined, done: true };
          },
          async throw(err?: unknown): Promise<IteratorResult<RemoteEvent>> {
            cleanup();
            throw err;
          },
        };
      },
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.stopKeepalive();
    this.detachLifecycleListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      this.detachSocketHandlers(socket);
      try {
        socket.close();
      } catch {
        // Ignore errors closing an already dead socket.
      }
    }
    for (const waiter of this.pluginCallWaiters.splice(0)) {
      waiter.reject(
        new WebTransportError('transport destroyed', 'transport_closed', true)
      );
    }
    for (const resolve of this.readyResolvers.values()) {
      resolve();
    }
    this.readyResolvers.clear();
    for (const subscription of this.subscriptions.values()) {
      subscription.queue.close();
    }
    this.subscriptions.clear();
  }

  private resolveReady(subscriptionId: string): void {
    const resolver = this.readyResolvers.get(subscriptionId);
    if (resolver) {
      this.readyResolvers.delete(subscriptionId);
      resolver();
    }
  }

  private async request(
    path: string,
    init: Omit<RequestInit, 'headers'> = {},
    timeoutMs: number | null = this.requestTimeoutMs
  ): Promise<Response> {
    const effectiveTimeoutMs =
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? timeoutMs
        : null;
    const controller = new AbortController();
    const externalSignal = init.signal;
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        onExternalAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', onExternalAbort, {
          once: true,
        });
      }
    }
    let timedOut = false;
    const timeoutTimer =
      effectiveTimeoutMs !== null
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, effectiveTimeoutMs)
        : undefined;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-Dimo-Protocol-Version': PROTOCOL_VERSION,
        },
      });
    } catch (err) {
      if (timedOut) {
        throw new WebTransportError(
          `Dimo Server request timed out after ${effectiveTimeoutMs}ms`,
          'request_timeout',
          true
        );
      }
      throw err;
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }

    if (!response.ok) {
      let envelope: ErrorEnvelope = {};
      try {
        envelope = (await response.json()) as ErrorEnvelope;
      } catch {
        // Preserve a stable local error even if an intermediary returned HTML.
      }
      const err = new WebTransportError(
        envelope.message ?? `Dimo Server returned HTTP ${response.status}`,
        envelope.code ?? 'remote_http_error',
        envelope.retryable ?? false,
        envelope.operation_id,
        response.status,
        envelope.details
      );
      if (response.status === 401 || err.code === 'unauthorized') {
        this.onAuthError?.(err);
      }
      throw err;
    }
    return response;
  }

  private connectSocket(): void {
    if (this.destroyed || this.socket || this.subscriptions.size === 0) {
      return;
    }
    const socket = new WebSocket(this.webSocketUrl(), [
      'dimo.v1',
      `dimo.token.${base64UrlEncode(this.token)}`,
    ]);
    this.socket = socket;
    this.attachLifecycleListeners();
    socket.onopen = () => {
      if (this.socket !== socket || this.destroyed) {
        return;
      }
      this.reconnectAttempts = 0;
      this.awaitingPong = false;
      this.startKeepalive();
      for (const subscription of this.subscriptions.values()) {
        // Process-scoped streams restart their HostEventBus sequence from zero.
        if (
          subscription.request.resource === 'host_event' ||
          subscription.request.resource === 'patch_stream'
        ) {
          subscription.cursor = 0n;
        }
        this.sendAttach(subscription);
      }
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || this.destroyed) {
        return;
      }
      try {
        this.handleServerMessage(JSON.parse(message.data) as WireServerMessage);
      } catch {
        // Unknown or malformed frames are ignored without damaging siblings.
      }
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        this.handleBrokenSocket(socket);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.stopKeepalive();
      this.socket = undefined;
      if (!this.destroyed && this.subscriptions.size > 0) {
        this.scheduleReconnect();
      }
    };
  }

  private sendAttach(subscription: ActiveSubscription): void {
    this.safeSend(
      this.socket,
      JSON.stringify({
        type: 'attach',
        request: {
          ...subscription.request,
          after_sequence: sequenceToWire(subscription.cursor),
        },
      })
    );
  }

  private handleServerMessage(message: WireServerMessage): void {
    if (message.type === 'pong') {
      this.awaitingPong = false;
      return;
    }
    if (message.type === 'error') {
      const envelope =
        typeof message.error === 'object' && message.error !== null
          ? (message.error as ErrorEnvelope)
          : undefined;
      const err = new WebTransportError(
        envelope?.message ?? 'Subscription stream failed',
        envelope?.code ?? 'subscription_error',
        envelope?.retryable ?? false,
        envelope?.operation_id,
        undefined,
        envelope?.details
      );
      if (err.code === 'unauthorized') {
        this.onAuthError?.(err);
      }
      if (!message.subscription_id) {
        for (const resolve of this.readyResolvers.values()) {
          resolve();
        }
        this.readyResolvers.clear();
        for (const [id, active] of this.subscriptions.entries()) {
          this.subscriptions.delete(id);
          active.queue.error(err);
        }
        return;
      }
      this.resolveReady(message.subscription_id);
      const failed = this.subscriptions.get(message.subscription_id);
      if (!failed) {
        return;
      }
      this.subscriptions.delete(message.subscription_id);
      failed.queue.error(err);
      return;
    }
    this.resolveReady(message.subscription_id);
    const subscription = this.subscriptions.get(message.subscription_id);
    if (!subscription || message.type === 'ready') {
      return;
    }
    if (message.type === 'detached') {
      this.subscriptions.delete(message.subscription_id);
      subscription.queue.error(
        new WebTransportError(
          `Subscription detached: ${message.reason || 'unknown reason'}`,
          'subscription_detached',
          true
        )
      );
      return;
    }
    if (message.type === 'snapshot') {
      const sequence = sequenceFromWire(message.snapshot.through_sequence);
      if (sequence >= subscription.cursor) {
        subscription.cursor = sequence;
        subscription.queue.push({
          sequence,
          kind: 'subscription_snapshot',
          payload: message.snapshot.payload,
        });
      }
      return;
    }
    if (message.type === 'live') {
      const sequence = sequenceFromWire(message.high_water_mark);
      if (sequence > subscription.cursor) {
        subscription.cursor = sequence;
      }
      return;
    }
    const sequence = sequenceFromWire(message.event.sequence);
    if (sequence <= subscription.cursor) {
      return;
    }
    subscription.cursor = sequence;
    subscription.queue.push({ ...message.event, sequence });
  }

  private async listenHostEvent<T>(
    channel: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempts = 0;
    let currentIterator: AsyncIterator<RemoteEvent> | undefined;

    const createIterator = (subscriptionId = randomUUID()) =>
      this.subscribe({
        subscription_id: subscriptionId,
        resource: 'host_event',
        channel,
        after_sequence: 0n,
      } as SubscriptionRequest)[Symbol.asyncIterator]();

    const initialSubscriptionId = randomUUID();
    const shouldAwaitReady = this.socket?.readyState === WebSocket.OPEN;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const readyPromise = shouldAwaitReady
      ? new Promise<void>((resolve) => {
          const finish = () => {
            if (readyTimer !== undefined) {
              clearTimeout(readyTimer);
              readyTimer = undefined;
            }
            this.readyResolvers.delete(initialSubscriptionId);
            resolve();
          };
          this.readyResolvers.set(initialSubscriptionId, finish);
          readyTimer = setTimeout(finish, 500);
        })
      : Promise.resolve();

    currentIterator = createIterator(initialSubscriptionId);

    const isNonRetriableError = (err: unknown): boolean => {
      if (!(err instanceof WebTransportError)) {
        return false;
      }
      if (
        err.status === 400 ||
        err.status === 401 ||
        err.status === 403 ||
        err.status === 404
      ) {
        return true;
      }
      return (
        err.code === 'unauthorized' ||
        err.code === 'forbidden' ||
        err.code === 'not_found' ||
        err.code === 'bad_request' ||
        err.code === 'invalid_request'
      );
    };

    const run = async (initialIterator: AsyncIterator<RemoteEvent>) => {
      let iterator: AsyncIterator<RemoteEvent> | undefined = initialIterator;
      while (!stopped && !this.destroyed) {
        try {
          if (!iterator) {
            iterator = createIterator();
            currentIterator = iterator;
          }
          const next = await iterator.next();
          if (stopped || this.destroyed) {
            return;
          }
          if (next.done) {
            throw new WebTransportError(
              `Host event stream "${channel}" ended unexpectedly`,
              'stream_ended',
              true
            );
          }
          retryAttempts = 0;
          handler(next.value.payload as T);
        } catch (err) {
          if (stopped || this.destroyed) {
            return;
          }
          void iterator?.return?.();
          if (currentIterator === iterator) {
            currentIterator = undefined;
          }
          iterator = undefined;
          console.warn(
            `[WebTransport] Host event listener "${channel}" interrupted:`,
            err
          );
          if (isNonRetriableError(err)) {
            return;
          }
          const baseDelay = Math.min(500 * 2 ** retryAttempts, 8_000);
          const delay = applyBackoffJitter(baseDelay);
          retryAttempts += 1;
          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              resolve();
            }, delay);
          });
        }
      }
    };

    void run(currentIterator);
    await readyPromise;

    return () => {
      stopped = true;
      this.resolveReady(initialSubscriptionId);
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const active = currentIterator;
      currentIterator = undefined;
      void active?.return?.();
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (this.awaitingPong) {
        try {
          socket.close();
        } catch {
          this.handleBrokenSocket(socket);
        }
        return;
      }
      this.awaitingPong = true;
      this.safeSend(socket, JSON.stringify({ type: 'ping' }));
    }, WEB_SOCKET_KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (!this.pingTimer) {
      return;
    }
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.awaitingPong = false;
  }

  private attachLifecycleListeners(): void {
    if (this.visibilityListener || typeof document === 'undefined') {
      return;
    }
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible') {
        this.probeOrReconnect();
      }
    };
    this.onlineListener = () => this.probeOrReconnect();
    document.addEventListener('visibilitychange', this.visibilityListener);
    window.addEventListener('online', this.onlineListener);
  }

  private detachLifecycleListeners(): void {
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = undefined;
    }
    if (this.onlineListener) {
      window.removeEventListener('online', this.onlineListener);
      this.onlineListener = undefined;
    }
  }

  private probeOrReconnect(): void {
    if (this.destroyed || this.subscriptions.size === 0) {
      return;
    }
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      // Restart the keepalive interval before marking awaitingPong so an
      // imminent timer tick cannot mistake this fresh probe for a missed pong.
      this.startKeepalive();
      this.awaitingPong = true;
      this.safeSend(socket, JSON.stringify({ type: 'ping' }));
      return;
    }
    if (!socket) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      this.connectSocket();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const baseDelay = Math.min(250 * 2 ** this.reconnectAttempts, 8_000);
    const delay = applyBackoffJitter(baseDelay);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectSocket();
    }, delay);
  }

  private safeSend(socket: WebSocket | undefined, payload: string): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(payload);
      return true;
    } catch {
      this.handleBrokenSocket(socket);
      return false;
    }
  }

  private handleBrokenSocket(socket: WebSocket): void {
    if (this.socket !== socket) {
      try {
        socket.close();
      } catch {
        // Ignore secondary close errors on a stale socket.
      }
      return;
    }
    this.stopKeepalive();
    this.socket = undefined;
    this.detachSocketHandlers(socket);
    try {
      socket.close();
    } catch {
      // Ignore secondary close errors on a broken socket.
    }
    if (!this.destroyed && this.subscriptions.size > 0) {
      this.scheduleReconnect();
    }
  }

  private detachSocketHandlers(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private webSocketUrl(): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`;
  }
}

function applyBackoffJitter(baseDelayMs: number): number {
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.max(1, Math.round(baseDelayMs * jitterFactor));
}

function sequenceToWire(sequence: bigint): number {
  if (
    sequence < BigInt(Number.MIN_SAFE_INTEGER) ||
    sequence > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Conversation sequence exceeds JSON-safe integer range');
  }
  return Number(sequence);
}

function sequenceFromWire(sequence: number): bigint {
  if (!Number.isSafeInteger(sequence)) {
    throw new Error('Server returned a non-JSON-safe conversation sequence');
  }
  return BigInt(sequence);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
