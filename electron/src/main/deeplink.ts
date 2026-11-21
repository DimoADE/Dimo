import type { App } from 'electron';

import type { PendingModelRouterImport } from '../shared/ipcContract';
import { DESKTOP_TOAST_ACTIVATED_EVENT } from './desktopToast';

export const MODEL_ROUTER_IMPORT_EVENT = 'dimo://modelrouter-import';
export const LAUNCH_ARG_NEW_WINDOW = '--new-window';
export const LAUNCH_ARG_OPEN_SETTINGS = '--open-settings';

export type LaunchAction = 'new-window' | 'open-settings';

export interface ParsedModelRouterImport {
  ticket: string;
  agentId: string | null;
}

export interface ParsedSessionActivation {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

export interface DeepLinkRoutingHandlers {
  showMainWindow: () => void;
  openSettingsWindow: (routePath?: string) => void;
  openAppWindow: () => void;
  broadcastEvent: (event: string, payload?: unknown) => void;
}

export function isDimoScheme(scheme: string): boolean {
  const normalized = scheme.replace(/:$/, '').toLowerCase();
  return (
    normalized === 'dimo' ||
    normalized === 'dimo-dev' ||
    normalized.startsWith('dimo-dev-')
  );
}

export function parseModelRouterImport(
  rawUrl: string
): ParsedModelRouterImport | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!isDimoScheme(parsed.protocol)) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  const isImportRoute =
    (host === 'modelrouter' && (pathname === '' || pathname === 'import')) ||
    host === 'import-modelrouter' ||
    pathname === 'modelrouter/import';
  if (!isImportRoute) {
    return null;
  }

  const ticket = parsed.searchParams.get('ticket')?.trim() ?? '';
  if (!ticket) {
    return null;
  }

  const agentRaw =
    parsed.searchParams.get('agent') ??
    parsed.searchParams.get('agentId') ??
    parsed.searchParams.get('agent_id');
  const agentId = agentRaw?.trim() ? agentRaw.trim() : null;

  return { ticket, agentId };
}

export function parseSessionActivation(
  rawUrl: string
): ParsedSessionActivation | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!isDimoScheme(parsed.protocol)) {
    return null;
  }

  const projectId = parsed.searchParams.get('project')?.trim();
  const workspaceId = parsed.searchParams.get('workspace')?.trim();
  const sessionId = parsed.searchParams.get('session')?.trim();

  if (!projectId || !workspaceId || !sessionId) {
    return null;
  }

  return { projectId, workspaceId, sessionId };
}

export function extractDimoUrlsFromArgs(args: readonly string[]): string[] {
  const urls: string[] = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.includes('://')) {
      continue;
    }
    try {
      const parsed = new URL(arg);
      if (isDimoScheme(parsed.protocol)) {
        urls.push(arg);
      }
    } catch {
      // Ignore non-URL arguments.
    }
  }
  return urls;
}

export function extractLaunchActionFromArgs(
  args: readonly string[]
): LaunchAction | null {
  if (args.includes(LAUNCH_ARG_OPEN_SETTINGS)) {
    return 'open-settings';
  }
  if (args.includes(LAUNCH_ARG_NEW_WINDOW)) {
    return 'new-window';
  }
  return null;
}

type PendingProcessAction = 'open-settings' | 'new-window' | 'show-main';

export class DeepLinkManager {
  private nextImportId = 1;
  private pendingImport: PendingModelRouterImport | null = null;
  private pendingSessionActivation: ParsedSessionActivation | null = null;
  private mainWindowReady = false;
  private readonly coldStartUrls: string[] = [];
  private readonly pendingActions: PendingProcessAction[] = [];
  private handlers: DeepLinkRoutingHandlers | null = null;

  registerProtocolClient(app: App): void {
    if (!app.isPackaged) {
      return;
    }
    try {
      app.setAsDefaultProtocolClient('dimo');
    } catch {
      // Best-effort protocol registration (may fail in restricted sandboxes).
    }
  }

  attachHandlers(handlers: DeepLinkRoutingHandlers): void {
    this.handlers = handlers;
    while (this.pendingActions.length > 0) {
      const action = this.pendingActions.shift();
      if (action === 'open-settings') {
        handlers.openSettingsWindow();
      } else if (action === 'new-window') {
        handlers.openAppWindow();
      } else if (action === 'show-main') {
        handlers.showMainWindow();
      }
    }
    while (this.coldStartUrls.length > 0) {
      const next = this.coldStartUrls.shift();
      if (next) {
        this.routeUrl(next);
      }
    }
  }

  markMainWindowReady(): void {
    this.mainWindowReady = true;
    if (this.pendingSessionActivation && this.handlers) {
      const pending = this.pendingSessionActivation;
      this.pendingSessionActivation = null;
      this.handlers.broadcastEvent(DESKTOP_TOAST_ACTIVATED_EVENT, pending);
    }
  }

  resetMainWindowReady(): void {
    this.mainWindowReady = false;
  }

  takePendingModelRouterImport(): PendingModelRouterImport | null {
    const value = this.pendingImport;
    this.pendingImport = null;
    return value;
  }

  takePendingSessionActivation(): ParsedSessionActivation | null {
    const value = this.pendingSessionActivation;
    this.pendingSessionActivation = null;
    return value;
  }

  handleUrl(rawUrl: string): void {
    if (!this.handlers) {
      this.coldStartUrls.push(rawUrl);
      return;
    }
    this.routeUrl(rawUrl);
  }

  handleProcessArgs(
    args: readonly string[],
    options: { isStartup?: boolean } = {}
  ): void {
    const action = extractLaunchActionFromArgs(args);
    if (action === 'open-settings') {
      if (this.handlers) {
        this.handlers.openSettingsWindow();
      } else {
        this.pendingActions.push('open-settings');
      }
      return;
    }
    if (action === 'new-window' && !options.isStartup) {
      if (this.handlers) {
        this.handlers.openAppWindow();
      } else {
        this.pendingActions.push('new-window');
      }
      return;
    }

    const urls = extractDimoUrlsFromArgs(args);
    if (urls.length > 0) {
      for (const url of urls) {
        this.handleUrl(url);
      }
      return;
    }

    if (!options.isStartup) {
      if (this.handlers) {
        this.handlers.showMainWindow();
      } else {
        this.pendingActions.push('show-main');
      }
    }
  }

  private routeUrl(rawUrl: string): void {
    const handlers = this.handlers;
    if (!handlers) {
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }

    if (!isDimoScheme(parsed.protocol)) {
      return;
    }

    handlers.showMainWindow();

    const modelRouterImport = parseModelRouterImport(rawUrl);
    if (modelRouterImport) {
      const payload: PendingModelRouterImport = {
        id: this.nextImportId++,
        ticket: modelRouterImport.ticket,
        agentId: modelRouterImport.agentId,
      };
      this.pendingImport = payload;
      handlers.openSettingsWindow('/settings/agents');
      handlers.broadcastEvent(MODEL_ROUTER_IMPORT_EVENT, payload);
      return;
    }

    const session = parseSessionActivation(rawUrl);
    if (session) {
      if (this.mainWindowReady) {
        handlers.broadcastEvent(DESKTOP_TOAST_ACTIVATED_EVENT, session);
      } else {
        this.pendingSessionActivation = session;
      }
    }
  }
}
