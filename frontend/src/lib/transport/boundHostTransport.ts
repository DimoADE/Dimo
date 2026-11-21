import { DESKTOP_SHELL_COMMANDS, HOST_COMMANDS } from 'shared/hostCommands';

import type {
  BackendTransport,
  RemoteEvent,
  ServerCapabilities,
  SubscriptionRequest,
} from './backendTransport';
import type { RemoteDesktopTransport } from './remoteDesktopTransport';
import { getLocalDesktopTransport } from './transportRegistry';

const HOST_COMMAND_SET = new Set<string>(HOST_COMMANDS);
const DESKTOP_SHELL_COMMAND_SET = new Set<string>(DESKTOP_SHELL_COMMANDS);

const HOST_PUSH_EVENT_PREFIXES = [
  'conversation-events',
  'conversation-rate-limit',
  'workspace-sessions-changed',
  'workspace-focus-conversation',
  'agent-management-event',
  'agent-management-snapshot-invalidated',
  'agent-management-discovery-progress',
  'agent-terminal-events',
  'desktop-session-attention',
  'file-tree-stream',
  'projects-stream',
  'project-workspaces-stream',
  'execution-processes-stream',
  'diff-stream',
  'conversation-stream',
  'scratch-stream',
  'slash-commands-stream',
  'log-stream',
  'dimo://settings-file-changed',
  'dimo://local-app-data-cleared',
  'dimo://collaboration-space-changed',
  'dimo://collaboration-receipts-changed',
  'vibex://pulse-deck-changed',
  'log-settings://changed',
  'logs://appended',
  'local-history-import-progress',
  'local-history-scan-progress',
  'agent-events',
  'terminal-output',
  'terminal-exit',
  'plugin:browser',
  'plugin-contributions-changed',
  'plugin-conversation-draft-insert',
  'plugin-internal-message',
  'conversation-after-turn',
  'conversation-runtime-event',
  'plugin-notify-toast',
  'plugin-updates-changed',
  'plugin-updates-available',
  'provider-bind-confirm',
] as const;

function isHostPushEvent(event: string): boolean {
  return HOST_PUSH_EVENT_PREFIXES.some(
    (prefix) => event === prefix || event.startsWith(`${prefix}:`)
  );
}

/**
 * App-shell transport: Host product commands go to the connected Server,
 * desktop chrome stays on the local desktop shell process (Electron or Tauri).
 *
 * `environment` is the Host data plane. The process is still local desktop;
 * chrome that needs the local window should use `isDesktopShell()`, not this flag.
 */
export class BoundHostTransport implements BackendTransport {
  readonly environment = 'remote-desktop' as const;

  constructor(private readonly remote: RemoteDesktopTransport) {}

  call(
    command: string,
    args?: Record<string, unknown>,
    options?: { operationId?: string }
  ): Promise<unknown> {
    if (
      HOST_COMMAND_SET.has(command) ||
      !DESKTOP_SHELL_COMMAND_SET.has(command)
    ) {
      return this.remote.call(command, args, options);
    }
    return getLocalDesktopTransport().call(command, args, options);
  }

  stream<T>(
    command: string,
    args: Record<string, unknown>,
    onMessage: (message: unknown) => void
  ): Promise<T> {
    if (
      HOST_COMMAND_SET.has(command) ||
      !DESKTOP_SHELL_COMMAND_SET.has(command)
    ) {
      return this.remote.stream(command, args, onMessage);
    }
    const localTransport = getLocalDesktopTransport();
    if (!localTransport.stream) {
      return this.call(command, args) as Promise<T>;
    }
    return localTransport.stream(command, args, onMessage);
  }

  capabilities(): Promise<ServerCapabilities> {
    return this.remote.capabilities();
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> {
    if (isHostPushEvent(event)) {
      return this.remote.listen(event, handler);
    }
    const localTransport = getLocalDesktopTransport();
    if (!localTransport.listen) {
      return () => undefined;
    }
    return localTransport.listen(event, handler);
  }

  async emit(event: string, payload?: unknown): Promise<void> {
    const localTransport = getLocalDesktopTransport();
    if (localTransport.emit) {
      await localTransport.emit(event, payload);
    }
  }

  subscribe(request: SubscriptionRequest): AsyncIterable<RemoteEvent> {
    return this.remote.subscribe(request);
  }

  artifactPreviewUrl(lease: {
    leaseId: string;
    capabilityToken: string;
    loopbackPort: number;
  }): string {
    if (this.remote.artifactPreviewUrl) {
      return this.remote.artifactPreviewUrl(lease);
    }
    return getLocalDesktopTransport().artifactPreviewUrl?.(lease) ?? '';
  }
}
