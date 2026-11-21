import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';

import { app } from 'electron';

import type {
  DesktopUpdateCheckResult,
  DesktopUpdateDownloadEventPayload,
} from '../shared/ipcContract';

export interface UpdaterProgressInfo {
  total?: number;
  delta?: number;
  transferred?: number;
  percent?: number;
}

export interface UpdaterReleaseNoteInfo {
  version?: string;
  note?: string | null;
}

export interface UpdaterUpdateInfo {
  version: string;
  releaseDate?: string | null;
  releaseNotes?: string | UpdaterReleaseNoteInfo[] | null;
}

export interface UpdaterCancellationTokenLike {
  cancel(): void;
}

export interface UpdaterCheckResultLike {
  updateInfo?: UpdaterUpdateInfo | null;
  cancellationToken?: UpdaterCancellationTokenLike;
}

export interface AutoUpdaterLike extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade?: boolean;
  channel?: string | null;
  forceDevUpdateConfig?: boolean;
  updateConfigPath?: string | null;
  checkForUpdates(): Promise<UpdaterCheckResultLike | null>;
  downloadUpdate(
    cancellationToken?: UpdaterCancellationTokenLike
  ): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface PendingUpdateSession {
  token: string;
  version: string;
  downloaded: boolean;
  downloading: boolean;
  cancellationToken?: UpdaterCancellationTokenLike;
}

export interface DesktopUpdaterManagerOptions {
  currentVersion: string;
  beforeQuitForUpdate: () => Promise<void>;
  isPackaged?: () => boolean;
  loadAutoUpdater?: () => AutoUpdaterLike;
  relaunchApp?: () => void;
  exitApp?: (code?: number) => void;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 15_000;

export function normalizeReleaseNotes(
  raw: UpdaterUpdateInfo['releaseNotes']
): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(raw)) {
    const parts = raw
      .map((entry) => {
        const note = typeof entry?.note === 'string' ? entry.note.trim() : '';
        if (!note) return '';
        return entry.version ? `## ${entry.version}\n${note}` : note;
      })
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
  return null;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = cleaned.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Returns true if `candidate` is strictly newer than `current` per SemVer 2.0.
 */
export function isUpdateNewer(candidate: string, current: string): boolean {
  const next = parseSemver(candidate);
  const curr = parseSemver(current);
  if (!next || !curr) {
    return candidate.trim() !== '' && candidate.trim() !== current.trim();
  }
  if (next.major !== curr.major) return next.major > curr.major;
  if (next.minor !== curr.minor) return next.minor > curr.minor;
  if (next.patch !== curr.patch) return next.patch > curr.patch;

  if (next.prerelease.length === 0 && curr.prerelease.length === 0) {
    return false;
  }
  if (next.prerelease.length === 0) return true;
  if (curr.prerelease.length === 0) return false;

  const len = Math.max(next.prerelease.length, curr.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const a = next.prerelease[i];
    const b = curr.prerelease[i];
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a === b) continue;
    const aNum = /^\d+$/.test(a) ? Number(a) : null;
    const bNum = /^\d+$/.test(b) ? Number(b) : null;
    if (aNum !== null && bNum !== null) {
      return aNum > bNum;
    }
    if (aNum !== null) return false;
    if (bNum !== null) return true;
    return a > b;
  }
  return false;
}

export class ProgressDeltaTracker {
  private started = false;
  private lastTransferred = 0;
  private totalBytes: number | undefined;

  handleProgress(
    token: string,
    progress: UpdaterProgressInfo
  ): DesktopUpdateDownloadEventPayload[] {
    const events: DesktopUpdateDownloadEventPayload[] = [];
    const total =
      typeof progress.total === 'number' && progress.total > 0
        ? progress.total
        : undefined;
    if (total !== undefined) {
      this.totalBytes = total;
    }

    if (!this.started) {
      this.started = true;
      events.push({
        token,
        event: 'Started',
        data:
          this.totalBytes !== undefined
            ? { contentLength: this.totalBytes }
            : {},
      });
    }

    const transferred =
      typeof progress.transferred === 'number' && progress.transferred >= 0
        ? progress.transferred
        : undefined;
    let chunkLength = 0;
    if (transferred !== undefined) {
      chunkLength = Math.max(0, transferred - this.lastTransferred);
      this.lastTransferred = Math.max(this.lastTransferred, transferred);
    } else if (typeof progress.delta === 'number' && progress.delta > 0) {
      chunkLength = progress.delta;
      this.lastTransferred += chunkLength;
    }

    if (chunkLength > 0) {
      events.push({
        token,
        event: 'Progress',
        data: { chunkLength },
      });
    }

    return events;
  }

  finish(token: string): DesktopUpdateDownloadEventPayload[] {
    const events: DesktopUpdateDownloadEventPayload[] = [];
    if (!this.started) {
      this.started = true;
      events.push({
        token,
        event: 'Started',
        data:
          this.totalBytes !== undefined
            ? { contentLength: this.totalBytes }
            : {},
      });
    }
    if (
      this.totalBytes !== undefined &&
      this.totalBytes > this.lastTransferred
    ) {
      const remaining = this.totalBytes - this.lastTransferred;
      this.lastTransferred = this.totalBytes;
      events.push({
        token,
        event: 'Progress',
        data: { chunkLength: remaining },
      });
    }
    events.push({ token, event: 'Finished' });
    return events;
  }
}

function defaultLoadAutoUpdater(): AutoUpdaterLike {
  // Lazy require keeps non-packaged dev startup light and avoids eager
  // app-update.yml lookups during unit tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
  return mod.autoUpdater;
}

export class DesktopUpdaterManager {
  private readonly options: DesktopUpdaterManagerOptions;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly pending = new Map<string, PendingUpdateSession>();
  private updater: AutoUpdaterLike | null = null;
  private installStarted = false;

  constructor(options: DesktopUpdaterManagerOptions) {
    this.options = options;
    this.logger = options.logger ?? console;
  }

  private isPackaged(): boolean {
    return this.options.isPackaged ? this.options.isPackaged() : app.isPackaged;
  }

  private getUpdater(): AutoUpdaterLike {
    if (!this.updater) {
      const loader = this.options.loadAutoUpdater ?? defaultLoadAutoUpdater;
      const instance = loader();
      instance.autoDownload = false;
      instance.autoInstallOnAppQuit = false;
      instance.allowDowngrade = false;
      if (process.platform === 'win32' && process.arch === 'arm64') {
        instance.channel = 'latest-arm64';
      }
      const devConfig = process.env.DIMO_UPDATER_DEV_CONFIG?.trim();
      if (devConfig) {
        instance.forceDevUpdateConfig = true;
        instance.updateConfigPath = devConfig;
      }
      this.updater = instance;
    }
    return this.updater;
  }

  async check(options?: {
    timeout?: number;
  }): Promise<DesktopUpdateCheckResult | null> {
    if (!this.isPackaged() && !process.env.DIMO_UPDATER_DEV_CONFIG?.trim()) {
      return null;
    }

    const updater = this.getUpdater();
    const timeoutMs =
      typeof options?.timeout === 'number' && options.timeout > 0
        ? options.timeout
        : DEFAULT_CHECK_TIMEOUT_MS;

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Update check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    let result: UpdaterCheckResultLike | null;
    try {
      result = await Promise.race([updater.checkForUpdates(), timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    const info = result?.updateInfo;
    if (!info || typeof info.version !== 'string') {
      return null;
    }
    if (!isUpdateNewer(info.version, this.options.currentVersion)) {
      return null;
    }

    const token = crypto.randomUUID();
    this.pending.set(token, {
      token,
      version: info.version,
      downloaded: false,
      downloading: false,
      cancellationToken: result?.cancellationToken,
    });

    return {
      token,
      version: info.version,
      currentVersion: this.options.currentVersion,
      body: normalizeReleaseNotes(info.releaseNotes),
      date: typeof info.releaseDate === 'string' ? info.releaseDate : null,
    };
  }

  async download(
    token: string,
    emitEvent: (payload: DesktopUpdateDownloadEventPayload) => void
  ): Promise<void> {
    const session = this.pending.get(token);
    if (!session) {
      throw new Error('Update handle is no longer valid');
    }
    if (session.downloaded) {
      emitEvent({ token, event: 'Finished' });
      return;
    }
    if (session.downloading) {
      throw new Error('Update download is already in progress');
    }

    const updater = this.getUpdater();
    const tracker = new ProgressDeltaTracker();
    session.downloading = true;

    const onProgress = (progress: UpdaterProgressInfo) => {
      for (const payload of tracker.handleProgress(token, progress)) {
        emitEvent(payload);
      }
    };

    updater.on('download-progress', onProgress);
    try {
      await updater.downloadUpdate(session.cancellationToken);
      session.downloaded = true;
      for (const payload of tracker.finish(token)) {
        emitEvent(payload);
      }
    } finally {
      session.downloading = false;
      updater.removeListener('download-progress', onProgress);
    }
  }

  async install(token: string): Promise<void> {
    const session = this.pending.get(token);
    if (!session) {
      throw new Error('Update handle is no longer valid');
    }
    if (!session.downloaded) {
      throw new Error('Update must be downloaded before installation');
    }
    if (this.installStarted) {
      return;
    }

    this.installStarted = true;
    this.pending.delete(token);
    const updater = this.getUpdater();

    try {
      await this.options.beforeQuitForUpdate();
      this.logger.info(
        `[electron:updater] installing version ${session.version} via quitAndInstall`
      );
      updater.quitAndInstall(false, true);
    } catch (error) {
      this.installStarted = false;
      throw error;
    }
  }

  async close(token: string): Promise<void> {
    const session = this.pending.get(token);
    if (!session) {
      return;
    }
    this.pending.delete(token);
    if (session.downloading && session.cancellationToken) {
      try {
        session.cancellationToken.cancel();
      } catch {
        // Best-effort cancellation only.
      }
    }
  }

  async relaunch(): Promise<void> {
    if (this.installStarted) {
      // `quitAndInstall` is already restarting the app cleanly.
      return;
    }
    this.installStarted = true;
    await this.options.beforeQuitForUpdate();
    const doRelaunch = this.options.relaunchApp ?? (() => app.relaunch());
    const doExit = this.options.exitApp ?? ((code = 0) => app.exit(code));
    doRelaunch();
    doExit(0);
  }
}
