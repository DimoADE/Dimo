import {
  DESKTOP_SHELL_COMMANDS,
  HOST_COMMANDS,
  HOST_EVENT_CHANNELS,
} from 'shared/hostCommands';

import {
  getDesktopShell,
  hasElectronDesktopRuntime,
  type ElectronBackendConnectionInfo,
  type ElectronHostRpcBridge,
} from '@/lib/desktopShell';
import { randomUUID } from '@/utils/randomUUID';

import type {
  BackendTransport,
  CreateDevicePairingRequest,
  DevicePairingChallenge,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import { WebTransport, WebTransportError } from './webTransport';

const HOST_COMMAND_SET = new Set<string>(HOST_COMMANDS);
const DESKTOP_SHELL_COMMAND_SET = new Set<string>(DESKTOP_SHELL_COMMANDS);
const SIDECAR_READY_EVENT = 'sidecar-ready';
const SIDECAR_EXITED_EVENT = 'sidecar-exited';
const SIDECAR_RESTARTED_EVENT = 'sidecar-restarted';
const SHELL_ONLY_EVENTS = new Set<string>([
  'desktop-toast',
  'desktop-toast-activated',
  'dimo://modelrouter-import',
  SIDECAR_READY_EVENT,
  SIDECAR_EXITED_EVENT,
  SIDECAR_RESTARTED_EVENT,
  'system-power-resumed',
]);
const DUAL_BUS_EVENTS = new Set<string>(['theme-changed']);

type ElectronDesktopBridgeWithGetBackend = NonNullable<
  Window['dimoDesktop']
> & {
  getBackend?: () => ElectronBackendConnectionInfo | undefined;
};

type SidecarRestartedEventPayload = {
  backend?: Partial<ElectronBackendConnectionInfo> | null;
  attempt?: number;
};

type SidecarExitedEventPayload = {
  willRestart?: boolean;
};

function isValidBackendConnectionInfo(
  candidate: unknown
): candidate is ElectronBackendConnectionInfo {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const record = candidate as Partial<ElectronBackendConnectionInfo>;
  return (
    typeof record.baseUrl === 'string' &&
    record.baseUrl.length > 0 &&
    typeof record.token === 'string' &&
    record.token.length > 0
  );
}

function readCurrentElectronBackend():
  | ElectronBackendConnectionInfo
  | undefined {
  if (typeof window === 'undefined' || !window.dimoDesktop) {
    return undefined;
  }
  const desktop = window.dimoDesktop as ElectronDesktopBridgeWithGetBackend;
  const candidate =
    typeof desktop.getBackend === 'function'
      ? desktop.getBackend()
      : desktop.backend;
  return isValidBackendConnectionInfo(candidate) ? candidate : undefined;
}

function isElectronSidecarStarting(): boolean {
  if (typeof window === 'undefined' || !window.dimoDesktop) {
    return false;
  }
  const desktop = window.dimoDesktop;
  const status =
    typeof desktop.getSidecarStatus === 'function'
      ? desktop.getSidecarStatus()
      : desktop.sidecarStatus;
  return status === 'starting' || status === 'restarting';
}

function extractBackendFromRestartPayload(
  payload: unknown
): ElectronBackendConnectionInfo | undefined {
  if (payload && typeof payload === 'object') {
    const candidate =
      'backend' in payload
        ? (payload as SidecarRestartedEventPayload).backend
        : payload;
    if (isValidBackendConnectionInfo(candidate)) {
      return {
        baseUrl: candidate.baseUrl,
        token: candidate.token,
        ...(typeof candidate.dataDir === 'string'
          ? { dataDir: candidate.dataDir }
          : {}),
      };
    }
  }
  return readCurrentElectronBackend();
}

function isServerHostEvent(event: string): boolean {
  if (SHELL_ONLY_EVENTS.has(event)) {
    return false;
  }
  return HOST_EVENT_CHANNELS.some(
    (channel) =>
      event === channel.prefix || event.startsWith(`${channel.prefix}:`)
  );
}

function normalizeElectronCapabilities(
  serverCaps: ServerCapabilities
): ServerCapabilities {
  const capabilities = serverCaps.capabilities.includes('desktop.electron')
    ? serverCaps.capabilities
    : [...serverCaps.capabilities, 'desktop.electron'];
  return {
    ...serverCaps,
    capabilities,
  };
}

function readCachedElectronCapabilities(): ServerCapabilities | null {
  if (typeof window === 'undefined' || !window.dimoDesktop) {
    return null;
  }
  const cached = window.dimoDesktop.getCachedCapabilities?.();
  if (!cached || !Array.isArray(cached.capabilities)) {
    return null;
  }
  return normalizeElectronCapabilities(cached as ServerCapabilities);
}

function readElectronHostRpc(): ElectronHostRpcBridge | undefined {
  if (typeof window === 'undefined' || !window.dimoDesktop) {
    return undefined;
  }
  const hostRpc = window.dimoDesktop.hostRpc;
  if (!hostRpc || typeof hostRpc.call !== 'function') {
    return undefined;
  }
  return hostRpc;
}

export interface ElectronTransportOptions {
  backend?: ElectronBackendConnectionInfo | null;
  webTransport?: WebTransport;
  shell?: ReturnType<typeof getDesktopShell>;
  onReconfigure?: (backend: ElectronBackendConnectionInfo) => void;
}

/**
 * Local desktop transport for the Electron shell.
 *
 * - `HOST_COMMANDS` and `capabilities` go through Electron Main's whitelisted
 *   IPC proxy (`window.dimoDesktop.hostRpc`) over Node.js's connection pool so
 *   long-running commands can never exhaust Chromium's 6-connection HTTP/1.1
 *   origin limit shared across main + settings windows.
 * - Durable/patch/host-event WebSocket subscriptions go directly to the
 *   co-spawned `dimo-server --desktop` process via `WebTransport`.
 * - `DESKTOP_SHELL_COMMANDS` go through `window.dimoDesktop.invoke`, which
 *   handles native GUI operations in Electron Main immediately and proxies
 *   migrated desktop business commands to `dimo-server /api/v1/desktop/invoke/*`.
 */
export class ElectronTransport implements BackendTransport {
  readonly environment = 'desktop' as const;
  private web: WebTransport | null;
  private readonly usesCustomWebTransport: boolean;
  private readonly shellOverride?: ReturnType<typeof getDesktopShell>;
  private readonly onReconfigure?: (
    backend: ElectronBackendConnectionInfo
  ) => void;
  private capabilitiesCache: ServerCapabilities | null = null;
  private capabilitiesPromise: Promise<ServerCapabilities> | null = null;
  private readonly activeProxyRequestIds = new Set<string>();
  private destroyed = false;
  private readonly unlistenSidecarEvents: Array<() => void> = [];
  private readonly readyWaiters: Array<{
    resolve: (web: WebTransport) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(options: ElectronTransportOptions = {}) {
    this.usesCustomWebTransport = Boolean(options.webTransport);
    if (options.webTransport) {
      this.web = options.webTransport;
    } else if (isValidBackendConnectionInfo(options.backend)) {
      this.web = new WebTransport({
        baseUrl: options.backend.baseUrl,
        token: options.backend.token,
      });
    } else {
      const liveBackend = readCurrentElectronBackend();
      this.web = liveBackend
        ? new WebTransport({
            baseUrl: liveBackend.baseUrl,
            token: liveBackend.token,
          })
        : null;
    }
    this.shellOverride = options.shell;
    this.onReconfigure = options.onReconfigure;
    this.subscribeToSidecarLifecycle();
  }

  private registerSidecarEvent(
    event: string,
    handler: (payload: unknown) => void,
    afterAttached?: () => void
  ): void {
    const shell = this.getShell();
    const listenPromise = shell?.events?.listen?.<unknown>(event, handler);
    if (!listenPromise) {
      return;
    }
    void listenPromise
      .then((unlisten) => {
        if (this.destroyed) {
          unlisten();
        } else {
          this.unlistenSidecarEvents.push(unlisten);
          afterAttached?.();
        }
      })
      .catch(() => {
        // Ignore listener setup failures in non-Electron test environments.
      });
  }

  private subscribeToSidecarLifecycle(): void {
    const handleBackendUpdate = (payload: unknown) => {
      if (this.destroyed) {
        return;
      }
      const nextBackend = extractBackendFromRestartPayload(payload);
      if (!nextBackend) {
        return;
      }
      this.applyBackend(nextBackend);
    };

    this.registerSidecarEvent(SIDECAR_READY_EVENT, handleBackendUpdate, () => {
      if (!this.web && !this.destroyed) {
        const liveBackend = readCurrentElectronBackend();
        if (liveBackend) {
          this.applyBackend(liveBackend);
        }
      }
    });
    this.registerSidecarEvent(SIDECAR_RESTARTED_EVENT, handleBackendUpdate);
    this.registerSidecarEvent(SIDECAR_EXITED_EVENT, (payload) => {
      if (this.destroyed || this.web) {
        return;
      }
      const willRestart = Boolean(
        (payload as SidecarExitedEventPayload | undefined)?.willRestart
      );
      if (!willRestart) {
        this.rejectReadyWaiters(
          new Error('dimo-server sidecar exited before becoming ready')
        );
      }
    });
  }

  private resolveReadyWaiters(web: WebTransport): void {
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const waiter of waiters) {
      waiter.resolve(web);
    }
  }

  private rejectReadyWaiters(error: Error): void {
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private applyBackend(backend: ElectronBackendConnectionInfo): WebTransport {
    if (!this.web) {
      const created = new WebTransport({
        baseUrl: backend.baseUrl,
        token: backend.token,
      });
      this.web = created;
      this.onReconfigure?.(backend);
      this.resolveReadyWaiters(created);
      return created;
    }
    this.reconfigure(backend);
    return this.web;
  }

  private ensureWebTransport(): Promise<WebTransport> {
    if (this.web) {
      return Promise.resolve(this.web);
    }
    if (this.destroyed) {
      return Promise.reject(
        new Error('ElectronTransport was destroyed before sidecar became ready')
      );
    }
    const liveBackend = readCurrentElectronBackend();
    if (liveBackend) {
      return Promise.resolve(this.applyBackend(liveBackend));
    }
    return new Promise<WebTransport>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  reconfigure(backend: ElectronBackendConnectionInfo): void {
    if (this.destroyed) {
      return;
    }
    this.capabilitiesCache = null;
    this.capabilitiesPromise = null;
    if (!this.web) {
      this.applyBackend(backend);
      return;
    }
    if (typeof this.web.reconfigure === 'function') {
      this.web.reconfigure({
        baseUrl: backend.baseUrl,
        token: backend.token,
      });
    }
    this.onReconfigure?.(backend);
  }

  private getShell() {
    return this.shellOverride ?? getDesktopShell();
  }

  private isServerHostCommand(command: string): boolean {
    return (
      HOST_COMMAND_SET.has(command) || !DESKTOP_SHELL_COMMAND_SET.has(command)
    );
  }

  get origin(): string {
    if (this.web) {
      return this.web.origin;
    }
    return readCurrentElectronBackend()?.baseUrl ?? '';
  }

  async call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    if (this.isServerHostCommand(command)) {
      const hostRpc = !this.usesCustomWebTransport
        ? readElectronHostRpc()
        : undefined;
      if (hostRpc && HOST_COMMAND_SET.has(command)) {
        if (this.destroyed) {
          throw new WebTransportError(
            'transport destroyed',
            'transport_closed',
            true
          );
        }
        const requestId = randomUUID();
        this.activeProxyRequestIds.add(requestId);
        try {
          const response = await hostRpc.call({
            command,
            args,
            operationId: options?.operationId ?? randomUUID(),
            requestId,
          });
          if (!response.ok) {
            throw new WebTransportError(
              response.message,
              response.code,
              response.retryable,
              response.operationId,
              response.status,
              response.details
            );
          }
          const envelope = JSON.parse(response.bodyText) as {
            data: unknown;
          };
          return envelope.data;
        } finally {
          this.activeProxyRequestIds.delete(requestId);
        }
      }
      const web = await this.ensureWebTransport();
      return web.call(command, args, options);
    }
    return this.getShell().invoke(command, args);
  }

  async stream<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T> {
    if (this.isServerHostCommand(command)) {
      const web = await this.ensureWebTransport();
      const webStream = (web as BackendTransport).stream;
      if (typeof webStream === 'function') {
        return webStream.call(web, command, args, onMessage) as Promise<T>;
      }
    }
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

  getCachedCapabilities(): ServerCapabilities | null {
    if (this.capabilitiesCache) {
      return this.capabilitiesCache;
    }
    if (!this.usesCustomWebTransport) {
      const cached = readCachedElectronCapabilities();
      if (cached) {
        this.capabilitiesCache = cached;
        return cached;
      }
    }
    const webCached = this.web?.getCachedCapabilities?.();
    if (webCached) {
      const normalized = normalizeElectronCapabilities(webCached);
      this.capabilitiesCache = normalized;
      return normalized;
    }
    return null;
  }

  async capabilities(): Promise<ServerCapabilities> {
    if (this.capabilitiesCache) {
      return this.capabilitiesCache;
    }
    if (!this.usesCustomWebTransport) {
      const preloaded = readCachedElectronCapabilities();
      if (preloaded) {
        this.capabilitiesCache = preloaded;
        return preloaded;
      }
      if (this.capabilitiesPromise) {
        return this.capabilitiesPromise;
      }
      const hostRpc = readElectronHostRpc();
      if (typeof hostRpc?.capabilities === 'function') {
        const pending = hostRpc
          .capabilities()
          .then((serverCaps) => {
            const normalized = normalizeElectronCapabilities(
              serverCaps as ServerCapabilities
            );
            if (this.capabilitiesPromise === pending) {
              this.capabilitiesCache = normalized;
              this.capabilitiesPromise = null;
            }
            return normalized;
          })
          .catch((error: unknown) => {
            if (this.capabilitiesPromise === pending) {
              this.capabilitiesPromise = null;
            }
            throw error;
          });
        this.capabilitiesPromise = pending;
        return pending;
      }
    }
    const web = await this.ensureWebTransport();
    const serverCaps = await web.capabilities();
    const normalized = normalizeElectronCapabilities(serverCaps);
    this.capabilitiesCache = normalized;
    return normalized;
  }

  createDevicePairing(
    request: CreateDevicePairingRequest
  ): Promise<DevicePairingChallenge> {
    return this.getShell().invoke<DevicePairingChallenge>(
      'create_host_device_pairing',
      { request }
    );
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    if (this.web) {
      return this.web.subscribe(request);
    }
    const ensure = () => this.ensureWebTransport();
    return {
      async *[Symbol.asyncIterator]() {
        const web = await ensure();
        yield* web.subscribe(request);
      },
    };
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    if (DUAL_BUS_EVENTS.has(event)) {
      let unsubscribed = false;
      const unlistenShell = await this.getShell().events.listen<T>(
        event,
        handler
      );
      let unlistenWeb: (() => void) | undefined;
      if (this.web) {
        unlistenWeb = await this.web
          .listen<T>(event, handler)
          .catch(() => undefined);
      } else {
        void this.ensureWebTransport()
          .then(async (web) => {
            if (unsubscribed || this.destroyed) {
              return;
            }
            const detach = await web
              .listen<T>(event, handler)
              .catch(() => undefined);
            if (unsubscribed || this.destroyed) {
              detach?.();
            } else {
              unlistenWeb = detach;
            }
          })
          .catch(() => undefined);
      }
      return () => {
        unsubscribed = true;
        unlistenShell();
        unlistenWeb?.();
      };
    }
    if (isServerHostEvent(event)) {
      const web = await this.ensureWebTransport();
      if (this.destroyed) {
        return () => undefined;
      }
      return web.listen<T>(event, handler);
    }
    return this.getShell().events.listen<T>(event, handler);
  }

  async emit(event: string, payload?: unknown): Promise<void> {
    await this.getShell().events.emit(event, payload);
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
    loopbackPort?: number;
  }): string {
    if (this.web) {
      return this.web.artifactPreviewUrl(lease);
    }
    const liveBackend = readCurrentElectronBackend();
    if (liveBackend) {
      return this.applyBackend(liveBackend).artifactPreviewUrl(lease);
    }
    throw new Error('Electron backend connection is still starting');
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.capabilitiesCache = null;
    this.capabilitiesPromise = null;
    const hostRpc = !this.usesCustomWebTransport
      ? readElectronHostRpc()
      : undefined;
    if (hostRpc?.cancel && this.activeProxyRequestIds.size > 0) {
      for (const requestId of Array.from(this.activeProxyRequestIds)) {
        hostRpc.cancel(requestId);
      }
    }
    this.activeProxyRequestIds.clear();
    const listeners = this.unlistenSidecarEvents.splice(
      0,
      this.unlistenSidecarEvents.length
    );
    for (const unlisten of listeners) {
      unlisten();
    }
    this.rejectReadyWaiters(
      new Error('ElectronTransport was destroyed before sidecar became ready')
    );
    this.web?.destroy();
  }
}

let cachedBackendKey: string | null = null;
let cachedTransport: ElectronTransport | null = null;
let testTransportOverride: ElectronTransport | null = null;
let unloadTeardownAttached = false;

function handleWindowPageHide(event: PageTransitionEvent): void {
  if (event.persisted) {
    return;
  }
  disposeElectronBackendTransport();
}

function attachUnloadTeardown(): void {
  if (unloadTeardownAttached || typeof window === 'undefined') {
    return;
  }
  unloadTeardownAttached = true;
  window.addEventListener('pagehide', handleWindowPageHide);
}

export function disposeElectronBackendTransport(): void {
  if (unloadTeardownAttached && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', handleWindowPageHide);
    unloadTeardownAttached = false;
  }
  cachedTransport?.destroy();
  cachedTransport = null;
  cachedBackendKey = null;
}

export function setElectronBackendTransportForTests(
  transport: ElectronTransport | null
): void {
  testTransportOverride = transport;
}

export function resetElectronBackendTransportForTests(): void {
  testTransportOverride = null;
  disposeElectronBackendTransport();
}

export function getElectronBackendTransport(): ElectronTransport {
  if (testTransportOverride) {
    return testTransportOverride;
  }
  if (!hasElectronDesktopRuntime()) {
    throw new Error(
      'Electron backend connection info is unavailable on window.dimoDesktop'
    );
  }
  const backend = readCurrentElectronBackend();
  if (!backend) {
    if (!isElectronSidecarStarting()) {
      throw new Error(
        'Electron backend connection info is unavailable on window.dimoDesktop'
      );
    }
    if (cachedTransport) {
      return cachedTransport;
    }
    cachedBackendKey = null;
    cachedTransport = new ElectronTransport({
      onReconfigure: (nextBackend) => {
        cachedBackendKey = `${nextBackend.baseUrl}|${nextBackend.token}`;
      },
    });
    attachUnloadTeardown();
    return cachedTransport;
  }
  const key = `${backend.baseUrl}|${backend.token}`;
  if (cachedTransport) {
    if (cachedBackendKey !== key) {
      cachedBackendKey = key;
      cachedTransport.reconfigure(backend);
    }
    return cachedTransport;
  }
  cachedBackendKey = key;
  cachedTransport = new ElectronTransport({
    backend,
    onReconfigure: (nextBackend) => {
      cachedBackendKey = `${nextBackend.baseUrl}|${nextBackend.token}`;
    },
  });
  attachUnloadTeardown();
  return cachedTransport;
}
