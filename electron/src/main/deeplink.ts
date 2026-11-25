import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from 'electron';

import type { PendingModelRouterImport } from '../shared/ipcContract';
import { DESKTOP_TOAST_ACTIVATED_EVENT } from './desktopToast';

export const MODEL_ROUTER_IMPORT_EVENT = 'dimo://modelrouter-import';
export const DESKTOP_OPEN_FILE_EVENT = 'desktop-open-file';
export const LAUNCH_ARG_NEW_WINDOW = '--new-window';
export const LAUNCH_ARG_OPEN_SETTINGS = '--open-settings';

export type LaunchAction = 'new-window' | 'open-settings';

export interface ParsedModelRouterImport {
  ticket: string;
  agentId: string | null;
  hostId: string | null;
}

export interface ParsedSessionActivation {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

export interface DesktopOpenFilePayload {
  paths: string[];
}

export interface DeepLinkRoutingHandlers {
  showMainWindow: () => void;
  openSettingsWindow: (routePath?: string) => void;
  openAppWindow: () => void;
  broadcastEvent: (event: string, payload?: unknown) => void;
}

export interface ExtractFilePathsOptions {
  workingDirectory?: string;
  hasDefaultAppArg?: boolean;
  isExistingFile?: (filePath: string) => boolean;
}

export interface HandleProcessArgsOptions {
  isStartup?: boolean;
  workingDirectory?: string;
  hasDefaultAppArg?: boolean;
}

export interface DeepLinkManagerOptions {
  isExistingFile?: (filePath: string) => boolean;
}

function defaultIsExistingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isAbsoluteFileCandidate(candidate: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(candidate) ||
    candidate.startsWith('\\\\') ||
    candidate.startsWith('/')
  );
}

function normalizeCandidateFilePath(
  raw: string,
  workingDirectory?: string
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return null;
  }

  if (isAbsoluteFileCandidate(trimmed)) {
    return trimmed;
  }

  if (workingDirectory && workingDirectory.trim().length > 0) {
    return path.resolve(workingDirectory, trimmed);
  }

  return path.resolve(trimmed);
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

  const hostRaw =
    parsed.searchParams.get('hostId') ??
    parsed.searchParams.get('host_id') ??
    parsed.searchParams.get('targetHostId');
  const hostId = hostRaw?.trim() ? hostRaw.trim() : null;

  return { ticket, agentId, hostId };
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

export function extractFilePathsFromArgs(
  args: readonly string[],
  options: ExtractFilePathsOptions = {}
): string[] {
  const startIndex = options.hasDefaultAppArg ? 2 : 1;
  const isExistingFile = options.isExistingFile ?? defaultIsExistingFile;
  const seen = new Set<string>();
  const files: string[] = [];
  let afterDoubleDash = false;

  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') {
      continue;
    }
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    if (!afterDoubleDash && trimmed === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && trimmed.startsWith('-')) {
      continue;
    }

    const candidate = normalizeCandidateFilePath(
      trimmed,
      options.workingDirectory
    );
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    if (!isExistingFile(candidate)) {
      continue;
    }
    seen.add(candidate);
    files.push(candidate);
  }

  return files;
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
  private pendingSessionBroadcasted = false;
  private readonly pendingOpenFiles: string[] = [];
  private pendingOpenFilesBroadcasted = false;
  private mainWindowReady = false;
  private rendererSessionActivationReady = false;
  private rendererOpenFilesReady = false;
  private readonly coldStartUrls: string[] = [];
  private readonly coldStartFilePaths: string[] = [];
  private readonly pendingActions: PendingProcessAction[] = [];
  private handlers: DeepLinkRoutingHandlers | null = null;
  private readonly isExistingFile: (filePath: string) => boolean;

  constructor(options: DeepLinkManagerOptions = {}) {
    this.isExistingFile = options.isExistingFile ?? defaultIsExistingFile;
  }

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
    if (this.coldStartFilePaths.length > 0) {
      const files = this.coldStartFilePaths.splice(0);
      this.routeOpenFiles(files);
    }
  }

  markMainWindowReady(): void {
    this.mainWindowReady = true;
    if (
      this.pendingSessionActivation &&
      !this.pendingSessionBroadcasted &&
      this.handlers
    ) {
      // Broadcast for any listener already attached, but keep
      // `pendingSessionActivation` stored until explicitly drained via
      // `takePendingSessionActivation()` because `did-finish-load` fires
      // before async `i18nReady` + React mount completes.
      this.pendingSessionBroadcasted = true;
      this.handlers.broadcastEvent(
        DESKTOP_TOAST_ACTIVATED_EVENT,
        this.pendingSessionActivation
      );
    }
    if (
      this.pendingOpenFiles.length > 0 &&
      !this.pendingOpenFilesBroadcasted &&
      this.handlers
    ) {
      // Keep `pendingOpenFiles` stored until explicitly drained via
      // `takePendingOpenFiles()` so cold-start mounts never miss the file.
      this.pendingOpenFilesBroadcasted = true;
      this.handlers.broadcastEvent(DESKTOP_OPEN_FILE_EVENT, {
        paths: [...this.pendingOpenFiles],
      } satisfies DesktopOpenFilePayload);
    }
  }

  resetMainWindowReady(): void {
    this.mainWindowReady = false;
    this.pendingSessionBroadcasted = false;
    this.pendingOpenFilesBroadcasted = false;
    this.rendererSessionActivationReady = false;
    this.rendererOpenFilesReady = false;
  }

  takePendingModelRouterImport(): PendingModelRouterImport | null {
    const value = this.pendingImport;
    this.pendingImport = null;
    return value;
  }

  takePendingSessionActivation(): ParsedSessionActivation | null {
    this.rendererSessionActivationReady = true;
    const value = this.pendingSessionActivation;
    this.pendingSessionActivation = null;
    this.pendingSessionBroadcasted = false;
    return value;
  }

  takePendingOpenFiles(): string[] {
    this.rendererOpenFilesReady = true;
    const files = this.pendingOpenFiles.splice(0);
    this.pendingOpenFilesBroadcasted = false;
    return files;
  }

  handleUrl(rawUrl: string): void {
    if (!this.handlers) {
      this.coldStartUrls.push(rawUrl);
      return;
    }
    this.routeUrl(rawUrl);
  }

  handleOpenFile(rawPath: string): void {
    const candidate = normalizeCandidateFilePath(rawPath);
    if (!candidate || !this.isExistingFile(candidate)) {
      return;
    }
    this.handleOpenFiles([candidate]);
  }

  handleOpenFiles(filePaths: readonly string[]): void {
    const unique = Array.from(
      new Set(filePaths.filter((entry) => typeof entry === 'string' && entry.length > 0))
    );
    if (unique.length === 0) {
      return;
    }
    if (!this.handlers) {
      for (const filePath of unique) {
        if (!this.coldStartFilePaths.includes(filePath)) {
          this.coldStartFilePaths.push(filePath);
        }
      }
      return;
    }
    this.routeOpenFiles(unique);
  }

  handleProcessArgs(
    args: readonly string[],
    options: HandleProcessArgsOptions = {}
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

    const filePaths = extractFilePathsFromArgs(args, {
      workingDirectory: options.workingDirectory,
      hasDefaultAppArg: options.hasDefaultAppArg,
      isExistingFile: this.isExistingFile,
    });
    if (filePaths.length > 0) {
      this.handleOpenFiles(filePaths);
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

  private routeOpenFiles(filePaths: readonly string[]): void {
    const handlers = this.handlers;
    if (!handlers || filePaths.length === 0) {
      return;
    }

    handlers.showMainWindow();

    if (this.mainWindowReady) {
      if (!this.rendererOpenFilesReady) {
        for (const filePath of filePaths) {
          if (!this.pendingOpenFiles.includes(filePath)) {
            this.pendingOpenFiles.push(filePath);
          }
        }
        this.pendingOpenFilesBroadcasted = true;
      }
      handlers.broadcastEvent(DESKTOP_OPEN_FILE_EVENT, {
        paths: [...filePaths],
      } satisfies DesktopOpenFilePayload);
    } else {
      for (const filePath of filePaths) {
        if (!this.pendingOpenFiles.includes(filePath)) {
          this.pendingOpenFiles.push(filePath);
        }
      }
      this.pendingOpenFilesBroadcasted = false;
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
        hostId: modelRouterImport.hostId,
      };
      this.pendingImport = payload;
      handlers.openSettingsWindow('/settings/agents');
      handlers.broadcastEvent(MODEL_ROUTER_IMPORT_EVENT, payload);
      return;
    }

    const session = parseSessionActivation(rawUrl);
    if (session) {
      if (this.mainWindowReady) {
        if (!this.rendererSessionActivationReady) {
          this.pendingSessionActivation = session;
          this.pendingSessionBroadcasted = true;
        }
        handlers.broadcastEvent(DESKTOP_TOAST_ACTIVATED_EVENT, session);
      } else {
        this.pendingSessionActivation = session;
        this.pendingSessionBroadcasted = false;
      }
    }
  }
}
