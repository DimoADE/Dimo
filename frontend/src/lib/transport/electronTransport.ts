import {
  DESKTOP_SHELL_COMMANDS,
  HOST_COMMANDS,
  HOST_EVENT_CHANNELS,
} from 'shared/hostCommands';

import {
  getDesktopShell,
  hasElectronDesktopRuntime,
  type ElectronBackendConnectionInfo,
} from '@/lib/desktopShell';

import type {
  BackendTransport,
  CreateDevicePairingRequest,
  DevicePairingChallenge,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import { WebTransport } from './webTransport';

const HOST_COMMAND_SET = new Set<string>(HOST_COMMANDS);
const DESKTOP_SHELL_COMMAND_SET = new Set<string>(DESKTOP_SHELL_COMMANDS);
const SHELL_ONLY_EVENTS = new Set<string>([
  'desktop-toast',
  'desktop-toast-activated',
  'dimo://modelrouter-import',
]);
const DUAL_BUS_EVENTS = new Set<string>(['theme-changed']);

function isServerHostEvent(event: string): boolean {
  if (SHELL_ONLY_EVENTS.has(event)) {
    return false;
  }
  return HOST_EVENT_CHANNELS.some(
    (channel) => event === channel.prefix || event.startsWith(`${channel.prefix}:`)
  );
}

export interface ElectronTransportOptions {
  backend: ElectronBackendConnectionInfo;
  webTransport?: WebTransport;
  shell?: ReturnType<typeof getDesktopShell>;
}

/**
 * Local desktop transport for the Electron shell.
 *
 * - `HOST_COMMANDS` and durable/patch/host-event subscriptions go directly to
 *   the co-spawned `dimo-server --desktop` process over loopback HTTP/WS via
 *   `WebTransport`.
 * - `DESKTOP_SHELL_COMMANDS` go through `window.dimoDesktop.invoke`, which
 *   handles native GUI operations in Electron Main and proxies migrated
 *   desktop business commands to `dimo-server /api/v1/desktop/invoke/*`.
 */
export class ElectronTransport implements BackendTransport {
  readonly environment = 'desktop' as const;
  private readonly web: WebTransport;
  private readonly shellOverride?: ReturnType<typeof getDesktopShell>;

  constructor(options: ElectronTransportOptions) {
    this.web =
      options.webTransport ??
      new WebTransport({
        baseUrl: options.backend.baseUrl,
        token: options.backend.token,
      });
    this.shellOverride = options.shell;
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
    return this.web.origin;
  }

  async call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    if (this.isServerHostCommand(command)) {
      return this.web.call(command, args, options);
    }
    return this.getShell().invoke(command, args);
  }

  async stream<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T> {
    const webStream = (this.web as BackendTransport).stream;
    if (
      this.isServerHostCommand(command) &&
      typeof webStream === 'function'
    ) {
      return webStream.call(this.web, command, args, onMessage) as Promise<T>;
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

  async capabilities(): Promise<ServerCapabilities> {
    const serverCaps = await this.web.capabilities();
    const capabilities = serverCaps.capabilities.includes('desktop.electron')
      ? serverCaps.capabilities
      : [...serverCaps.capabilities, 'desktop.electron'];
    return {
      ...serverCaps,
      capabilities,
    };
  }

  createDevicePairing(
    request: CreateDevicePairingRequest
  ): Promise<DevicePairingChallenge> {
    return this.web.createDevicePairing(request);
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return this.web.subscribe(request);
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    if (DUAL_BUS_EVENTS.has(event)) {
      const [unlistenShell, unlistenWeb] = await Promise.all([
        this.getShell().events.listen<T>(event, handler),
        this.web.listen<T>(event, handler).catch(() => () => undefined),
      ]);
      return () => {
        unlistenShell();
        unlistenWeb();
      };
    }
    if (isServerHostEvent(event)) {
      return this.web.listen<T>(event, handler);
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
    return this.web.artifactPreviewUrl(lease);
  }

  destroy(): void {
    this.web.destroy();
  }
}

let cachedBackendKey: string | null = null;
let cachedTransport: ElectronTransport | null = null;
let testTransportOverride: ElectronTransport | null = null;

export function setElectronBackendTransportForTests(
  transport: ElectronTransport | null
): void {
  testTransportOverride = transport;
}

export function resetElectronBackendTransportForTests(): void {
  testTransportOverride = null;
  cachedTransport?.destroy();
  cachedTransport = null;
  cachedBackendKey = null;
}

export function getElectronBackendTransport(): ElectronTransport {
  if (testTransportOverride) {
    return testTransportOverride;
  }
  if (!hasElectronDesktopRuntime() || !window.dimoDesktop?.backend) {
    throw new Error(
      'Electron backend connection info is unavailable on window.dimoDesktop'
    );
  }
  const backend = window.dimoDesktop.backend;
  const key = `${backend.baseUrl}|${backend.token}`;
  if (cachedTransport && cachedBackendKey === key) {
    return cachedTransport;
  }
  cachedTransport?.destroy();
  cachedBackendKey = key;
  cachedTransport = new ElectronTransport({ backend });
  return cachedTransport;
}
