import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  isValidHostCommandName,
  type CachedServerCapabilities,
  type ElectronBackendConnectionInfo,
  type HostRpcProxyResponse,
  type SidecarRuntimeStatus,
} from '../shared/ipcContract';

export interface ServerReadyMessage {
  type: 'dimo-server-ready';
  listen_addr: string;
  port: number;
  pid: number;
  protocol_version: string;
  data_dir?: string;
}

export interface SidecarUnexpectedExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string[];
  willRestart: boolean;
  attempt: number;
  maxAttempts: number;
  restartDelayMs: number | null;
}

export interface SidecarStartOptions {
  binaryPath?: string;
  repoRoot?: string;
  resourcesDir?: string;
  dataDir?: string;
  appVersion: string;
  port?: number;
  readyTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  maxRestartAttempts?: number;
  restartWindowMs?: number;
  restartBaseDelayMs?: number;
  onUnexpectedExit?: (info: SidecarUnexpectedExitInfo) => void;
  onRestarted?: (
    connection: ElectronBackendConnectionInfo,
    attempt: number
  ) => void;
  onRestartFailed?: (error: Error, attempt: number, exhausted: boolean) => void;
  spawnProcess?: typeof spawn;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 1_500;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const WINDOW_DESTROYED_TIMEOUT_MS = 5_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const STDERR_RING_LIMIT = 40;
const DEFAULT_MAX_RESTART_ATTEMPTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 1_000;
const HOST_PROTOCOL_VERSION = '1.0';
const HOST_CAPABILITIES_TIMEOUT_MS = 30_000;

export function generateDesktopToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function serverBinaryFilename(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? 'dimo-server.exe' : 'dimo-server';
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

export function resolveSidecarStdio(
  platform: NodeJS.Platform = process.platform
): ['ignore' | 'pipe', 'pipe', 'pipe'] {
  // On Windows, `--parent-pid` handles parent-exit monitoring and the stdin
  // watchdog is disabled; inheriting/piping stdin can deadlock child processes.
  return platform === 'win32'
    ? ['ignore', 'pipe', 'pipe']
    : ['pipe', 'pipe', 'pipe'];
}

/**
 * Strips or restores AppImage-injected `LD_LIBRARY_PATH` on Linux so external
 * editors, browsers, and terminals spawned by `dimo-server` do not load
 * incompatible libraries from the mounted AppImage squashfs tree.
 */
export function sanitizeSidecarEnv(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (platform === 'linux' && baseEnv.APPIMAGE?.trim()) {
    const origLdPath = baseEnv.APPIMAGE_ORIG_LD_LIBRARY_PATH?.trim();
    if (origLdPath) {
      env.LD_LIBRARY_PATH = origLdPath;
    } else {
      delete env.LD_LIBRARY_PATH;
    }
  }
  return env;
}

async function killProcessTreeWindows(
  pid: number,
  timeoutMs = TASKKILL_TIMEOUT_MS
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    let killer: ChildProcess;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best-effort cleanup of timed-out taskkill process.
      }
      done();
    }, timeoutMs);
    timer.unref?.();

    killer.once('error', done);
    killer.once('exit', done);
    killer.once('close', done);
  });
}

export function resolveClaudeDriverScript(
  resourcesDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (env.DIMO_CLAUDE_DRIVER_SCRIPT?.trim()) {
    return env.DIMO_CLAUDE_DRIVER_SCRIPT.trim();
  }
  if (!resourcesDir) {
    return undefined;
  }
  const candidate = path.join(
    resourcesDir,
    'scripts',
    'claude-native-driver.mjs'
  );
  return fs.existsSync(candidate) ? candidate : undefined;
}

function isAppBundleSegment(segment: string): boolean {
  return segment.length > 4 && segment.toLowerCase().endsWith('.app');
}

/**
 * Mirrors Rust `utils::assets::is_inside_macos_app_bundle`: writing runtime
 * data inside a `.app` bundle breaks macOS code signatures and loses data on
 * in-app updates.
 */
export function isInsideMacosAppBundle(
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const segments = targetPath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  if (platform === 'darwin' && segments.some(isAppBundleSegment)) {
    return true;
  }
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (
      isAppBundleSegment(segments[i]) &&
      segments[i + 1].toLowerCase() === 'contents'
    ) {
      return true;
    }
  }
  return false;
}

export function resolveBootstrapConfigPath(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const home = options?.homedir ?? os.homedir();

  const explicit = env.DIMO_BOOTSTRAP_CONFIG_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'dimo', 'dimo', 'config', 'bootstrap.json');
  }
  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'app.dimo.dimo',
      'bootstrap.json'
    );
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdgConfig, 'dimo', 'bootstrap.json');
}

export function resolvePreRenameBootstrapConfigPath(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const home = options?.homedir ?? os.homedir();

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'vibex', 'vibex', 'config', 'bootstrap.json');
  }
  if (platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'app.vibex.vibex',
      'bootstrap.json'
    );
  }
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdgConfig, 'vibex', 'bootstrap.json');
}

function readCustomDataDirFromFile(
  bootstrapPath: string,
  platform: NodeJS.Platform
): string | undefined {
  try {
    const raw = fs.readFileSync(bootstrapPath, 'utf8');
    const parsed = JSON.parse(raw) as { custom_data_dir?: unknown };
    if (typeof parsed.custom_data_dir !== 'string') {
      return undefined;
    }
    const trimmed = parsed.custom_data_dir.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const isAbsolute =
      platform === 'win32'
        ? path.win32.isAbsolute(trimmed)
        : path.posix.isAbsolute(trimmed);
    if (!isAbsolute || isInsideMacosAppBundle(trimmed, platform)) {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

export function resolveEnvDataDir(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string | undefined {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const candidate =
    env.DIMO_DATA_DIR?.trim() || env.VIBEX_DATA_DIR?.trim() || '';
  if (!candidate || isInsideMacosAppBundle(candidate, platform)) {
    return undefined;
  }
  return candidate;
}

export function resolveDefaultDataDir(options?: {
  repoRoot?: string;
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
}): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const home = options?.homedir ?? os.homedir();

  const envDataDir = resolveEnvDataDir({ env, platform });
  if (envDataDir) {
    return envDataDir;
  }

  const currentBootstrap = resolveBootstrapConfigPath({
    env,
    platform,
    homedir: home,
  });
  const fromCurrent = readCustomDataDirFromFile(currentBootstrap, platform);
  if (fromCurrent) {
    return fromCurrent;
  }

  const preRenameBootstrap = resolvePreRenameBootstrapConfigPath({
    env,
    platform,
    homedir: home,
  });
  if (preRenameBootstrap !== currentBootstrap) {
    const fromPreRename = readCustomDataDirFromFile(
      preRenameBootstrap,
      platform
    );
    if (fromPreRename) {
      return fromPreRename;
    }
  }

  if (!options?.isPackaged && options?.repoRoot) {
    return path.join(options.repoRoot, 'dev_assets');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'dimo', 'dimo', 'data');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'app.dimo.dimo');
  }
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgData, 'dimo');
}

export function resolveSidecarBinaryPath(options: {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  resourcesDir?: string;
  repoRoot?: string;
  platform?: NodeJS.Platform;
}): string {
  const platform = options.platform ?? process.platform;
  const binName = serverBinaryFilename(platform);
  const env = options.env ?? process.env;

  const candidates: string[] = [];
  if (options.explicitPath) {
    candidates.push(options.explicitPath);
  }
  if (env.DIMO_SERVER_BIN) {
    candidates.push(env.DIMO_SERVER_BIN);
  }
  if (options.resourcesDir) {
    candidates.push(path.join(options.resourcesDir, 'bin', binName));
    candidates.push(path.join(options.resourcesDir, binName));
  }
  if (options.repoRoot) {
    candidates.push(path.join(options.repoRoot, 'target', 'debug', binName));
    candidates.push(path.join(options.repoRoot, 'target', 'release', binName));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate ${binName}. Checked: ${candidates.join(', ') || '(none)'}`
  );
}

export function parseReadyLine(line: string): ServerReadyMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<ServerReadyMessage>;
    if (
      parsed.type === 'dimo-server-ready' &&
      typeof parsed.listen_addr === 'string' &&
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.pid === 'number'
    ) {
      return {
        type: 'dimo-server-ready',
        listen_addr: parsed.listen_addr,
        port: parsed.port,
        pid: parsed.pid,
        protocol_version:
          typeof parsed.protocol_version === 'string'
            ? parsed.protocol_version
            : '1.0',
        ...(typeof parsed.data_dir === 'string' &&
        parsed.data_dir.trim().length > 0
          ? { data_dir: parsed.data_dir.trim() }
          : {}),
      };
    }
  } catch {
    // Non-JSON diagnostic line on stdout; ignore while waiting for handshake.
  }
  return null;
}

export class SidecarManager {
  private child: ChildProcess | null = null;
  private connection: ElectronBackendConnectionInfo | null = null;
  private readyInfo: ServerReadyMessage | null = null;
  private shuttingDown = false;
  private restarting = false;
  private startPromise: Promise<ElectronBackendConnectionInfo> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDeferred: {
    promise: Promise<ElectronBackendConnectionInfo>;
    resolve: (conn: ElectronBackendConnectionInfo) => void;
    reject: (error: Error) => void;
  } | null = null;
  private restartTimestamps: number[] = [];
  private lastStartOptions: SidecarStartOptions | null = null;
  private logger: Pick<Console, 'info' | 'warn' | 'error'> = console;
  private cachedCapabilities: CachedServerCapabilities | null = null;
  private capabilitiesInflight: Promise<CachedServerCapabilities> | null = null;

  getConnection(): ElectronBackendConnectionInfo {
    if (!this.connection) {
      throw new Error('dimo-server sidecar has not started yet');
    }
    return this.connection;
  }

  getConnectionOrNull(): ElectronBackendConnectionInfo | null {
    return this.isRunning() ? this.connection : null;
  }

  getCachedCapabilities(): CachedServerCapabilities | null {
    return this.isRunning() && this.connection ? this.cachedCapabilities : null;
  }

  private clearCapabilitiesCache(): void {
    this.cachedCapabilities = null;
    this.capabilitiesInflight = null;
  }

  async waitForReady(): Promise<ElectronBackendConnectionInfo> {
    if (this.connection && this.isRunning()) {
      return this.connection;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    throw new Error('dimo-server sidecar has not started yet');
  }

  getStatus(): SidecarRuntimeStatus {
    if (this.isRunning() && this.connection) {
      return 'running';
    }
    if (this.restarting) {
      return 'restarting';
    }
    if (this.startPromise) {
      return 'starting';
    }
    return 'stopped';
  }

  getReadyInfo(): ServerReadyMessage | null {
    return this.readyInfo;
  }

  getDataDir(): string | undefined {
    return this.connection?.dataDir ?? this.readyInfo?.data_dir;
  }

  isRunning(): boolean {
    return this.child !== null && !hasChildExited(this.child);
  }

  async start(
    options: SidecarStartOptions
  ): Promise<ElectronBackendConnectionInfo> {
    if (this.shuttingDown) {
      throw new Error('dimo-server sidecar is shutting down');
    }
    if (this.connection && this.isRunning()) {
      return this.connection;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.cancelPendingRestart();
    this.restartTimestamps = [];
    this.restarting = false;
    this.lastStartOptions = options;
    const promise = this.spawnAndAwaitReady(options).finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = null;
      }
    });
    this.startPromise = promise;
    return promise;
  }

  private async spawnAndAwaitReady(
    options: SidecarStartOptions
  ): Promise<ElectronBackendConnectionInfo> {
    this.logger = options.logger ?? console;
    if (this.shuttingDown) {
      throw new Error('dimo-server sidecar is shutting down');
    }

    const binaryPath = resolveSidecarBinaryPath({
      explicitPath: options.binaryPath,
      env: options.env,
      resourcesDir: options.resourcesDir,
      repoRoot: options.repoRoot,
    });

    const token = generateDesktopToken();
    const args: string[] = [
      '--desktop',
      '--parent-pid',
      String(process.pid),
      '--app-version',
      options.appVersion,
    ];
    if (typeof options.port === 'number' && options.port > 0) {
      args.push('--port', String(options.port));
    }
    if (options.resourcesDir) {
      args.push('--resources-dir', options.resourcesDir);
    }

    const baseEnv = options.env ?? process.env;
    const childEnv: NodeJS.ProcessEnv = {
      ...sanitizeSidecarEnv(baseEnv),
      DIMO_DESKTOP_TOKEN: token,
    };
    if (options.dataDir) {
      childEnv.DIMO_DATA_DIR = options.dataDir;
    }
    const claudeDriverScript = resolveClaudeDriverScript(
      options.resourcesDir,
      childEnv
    );
    if (claudeDriverScript) {
      childEnv.DIMO_CLAUDE_DRIVER_SCRIPT = claudeDriverScript;
    }

    this.logger.info(
      `[electron:sidecar] spawning ${binaryPath} ${args.join(' ')}`
    );

    const spawnFn = options.spawnProcess ?? spawn;
    const child = spawnFn(binaryPath, args, {
      env: childEnv,
      stdio: resolveSidecarStdio(),
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    this.child = child;

    // Prevent uncaught EPIPE / stream-destroyed errors if stdin is closed after
    // the sidecar has already exited (Unix piped stdin watchdog).
    child.stdin?.on('error', () => {
      // Best-effort ignore; exit handling drives supervision.
    });

    const stderrTail: string[] = [];
    const stderrReader = child.stderr
      ? readline.createInterface({ input: child.stderr })
      : null;
    stderrReader?.on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > STDERR_RING_LIMIT) {
        stderrTail.shift();
      }
      this.logger.info(`[dimo-server] ${line}`);
    });

    const drainStdout = () => {
      if (!child.stdout) return;
      child.stdout.on('data', (chunk: Buffer | string) => {
        const text =
          typeof chunk === 'string'
            ? chunk.trim()
            : chunk.toString('utf8').trim();
        if (text.length > 0) {
          this.logger.info(`[dimo-server:stdout] ${text}`);
        }
      });
      child.stdout.resume();
    };

    const onPostReadyError = (error: Error) => {
      this.logger.error(
        `[electron:sidecar] dimo-server process error: ${error.message}`
      );
    };

    const onPostReadyExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ) => {
      stderrReader?.close();
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.connection = null;
      this.readyInfo = null;

      if (this.shuttingDown) {
        return;
      }

      this.logger.error(
        `[electron:sidecar] dimo-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      );
      this.handleUnexpectedExit(code, signal, [...stderrTail]);
    };

    const ready = await new Promise<ServerReadyMessage>((resolve, reject) => {
      let settled = false;
      const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for dimo-server ready handshake.\n${stderrTail.join('\n')}`
          )
        );
      }, timeoutMs);

      const stdoutReader = child.stdout
        ? readline.createInterface({ input: child.stdout })
        : null;

      const onStdoutLine = (line: string) => {
        const parsed = parseReadyLine(line);
        if (parsed && !settled) {
          settled = true;
          clearTimeout(timer);
          // Attach persistent post-ready error/exit handlers before removing
          // startup listeners so `child` is never left without an error handler.
          child.on('error', onPostReadyError);
          child.on('exit', onPostReadyExit);
          cleanupListeners();
          // Resume draining stdout synchronously so OS pipe buffers (4 KiB on Windows)
          // never stall dimo-server or inherited children even for a single tick.
          drainStdout();
          resolve(parsed);
        }
      };

      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        reject(new Error(`Failed to spawn dimo-server: ${error.message}`));
      };

      const onExit = (
        code: number | null,
        signal: NodeJS.Signals | null
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        reject(
          new Error(
            `dimo-server exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).\n${stderrTail.join('\n')}`
          )
        );
      };

      const cleanupListeners = () => {
        stdoutReader?.off('line', onStdoutLine);
        stdoutReader?.close();
        child.off('error', onError);
        child.off('exit', onExit);
      };

      stdoutReader?.on('line', onStdoutLine);
      child.on('error', onError);
      child.on('exit', onExit);
    }).catch(async (error) => {
      // Keep an error listener attached during cleanup so force-kill never
      // emits an unhandled 'error' event on `child`.
      child.on('error', onPostReadyError);
      stderrReader?.close();
      await this.forceKillChild(child);
      if (this.child === child) {
        this.child = null;
      }
      throw error;
    });

    if (this.child !== child || hasChildExited(child) || this.shuttingDown) {
      const superseded = this.child !== child;
      stderrReader?.close();
      if (!hasChildExited(child)) {
        await this.forceKillChild(child);
      }
      if (this.child === child) {
        this.child = null;
      }
      if (this.shuttingDown) {
        throw new Error('dimo-server sidecar is shutting down');
      }
      if (superseded) {
        throw new Error('dimo-server sidecar instance was superseded before ready');
      }
      throw new Error(
        `dimo-server exited immediately after ready (code=${child.exitCode}, signal=${child.signalCode})`
      );
    }

    this.clearCapabilitiesCache();
    this.readyInfo = ready;
    this.connection = {
      baseUrl: `http://127.0.0.1:${ready.port}`,
      token,
      dataDir: options.dataDir ?? ready.data_dir,
    };

    this.logger.info(
      `[electron:sidecar] ready at ${this.connection.baseUrl} (pid=${ready.pid})`
    );
    return this.connection;
  }

  private ensureRestartPromise(): void {
    if (this.restartDeferred) {
      return;
    }
    let resolve!: (conn: ElectronBackendConnectionInfo) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ElectronBackendConnectionInfo>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Prevent unhandled rejection when no caller is currently awaiting waitForReady()/start().
    promise.catch(() => undefined);
    this.restartDeferred = { promise, resolve, reject };
    this.startPromise = promise;
  }

  private resolveRestartPromise(conn: ElectronBackendConnectionInfo): void {
    const deferred = this.restartDeferred;
    if (!deferred) {
      return;
    }
    this.restartDeferred = null;
    if (this.startPromise === deferred.promise) {
      this.startPromise = null;
    }
    deferred.resolve(conn);
  }

  private rejectRestartPromise(error: Error): void {
    const deferred = this.restartDeferred;
    if (!deferred) {
      return;
    }
    this.restartDeferred = null;
    if (this.startPromise === deferred.promise) {
      this.startPromise = null;
    }
    deferred.reject(error);
  }

  private handleUnexpectedExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string[]
  ): void {
    this.clearCapabilitiesCache();
    const opts = this.lastStartOptions;
    const maxAttempts = opts?.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    const windowMs = opts?.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    const baseDelayMs = opts?.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;

    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => now - ts < windowMs
    );

    if (opts && maxAttempts > 0 && this.restartTimestamps.length < maxAttempts) {
      const attempt = this.restartTimestamps.length + 1;
      const restartDelayMs = baseDelayMs * 2 ** (attempt - 1);
      this.restartTimestamps.push(now);
      this.restarting = true;
      this.ensureRestartPromise();

      opts.onUnexpectedExit?.({
        code,
        signal,
        stderrTail,
        willRestart: true,
        attempt,
        maxAttempts,
        restartDelayMs,
      });

      this.scheduleRestart(attempt, maxAttempts, restartDelayMs);
      return;
    }

    this.restarting = false;
    opts?.onUnexpectedExit?.({
      code,
      signal,
      stderrTail,
      willRestart: false,
      attempt: this.restartTimestamps.length,
      maxAttempts,
      restartDelayMs: null,
    });
  }

  private scheduleRestart(
    attempt: number,
    maxAttempts: number,
    delayMs: number
  ): void {
    this.clearRestartTimer();
    this.ensureRestartPromise();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown || !this.lastStartOptions) {
        this.restarting = false;
        this.rejectRestartPromise(
          new Error('dimo-server sidecar is shutting down')
        );
        return;
      }

      const opts = this.lastStartOptions;
      this.logger.warn(
        `[electron:sidecar] attempting auto-restart ${attempt}/${maxAttempts} after ${delayMs}ms`
      );

      void this.spawnAndAwaitReady(opts)
        .then((conn) => {
          if (this.shuttingDown) {
            this.restarting = false;
            this.rejectRestartPromise(
              new Error('dimo-server sidecar is shutting down')
            );
            return;
          }
          this.restarting = false;
          this.resolveRestartPromise(conn);
          opts.onRestarted?.(conn, attempt);
        })
        .catch((err) => {
          if (this.shuttingDown) {
            this.restarting = false;
            this.rejectRestartPromise(
              new Error('dimo-server sidecar is shutting down')
            );
            return;
          }
          const error = err instanceof Error ? err : new Error(String(err));
          this.logger.error(
            `[electron:sidecar] auto-restart ${attempt}/${maxAttempts} failed: ${error.message}`
          );

          const windowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
          const baseDelayMs =
            opts.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
          const now = Date.now();
          this.restartTimestamps = this.restartTimestamps.filter(
            (ts) => now - ts < windowMs
          );

          if (this.restartTimestamps.length < maxAttempts) {
            opts.onRestartFailed?.(error, attempt, false);
            const nextAttempt = this.restartTimestamps.length + 1;
            const nextDelayMs = baseDelayMs * 2 ** (nextAttempt - 1);
            this.restartTimestamps.push(now);
            this.scheduleRestart(nextAttempt, maxAttempts, nextDelayMs);
          } else {
            this.restarting = false;
            this.rejectRestartPromise(error);
            opts.onRestartFailed?.(error, attempt, true);
          }
        });
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private cancelPendingRestart(): void {
    this.clearRestartTimer();
    this.rejectRestartPromise(new Error('dimo-server sidecar is shutting down'));
  }

  private async withAbortTimeout<T>(
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<{
    status: string;
    desktop_mode: boolean;
    pid: number;
    version: string;
  }> {
    const conn = await this.waitForReady();
    return this.withAbortTimeout(HEALTH_CHECK_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${conn.baseUrl}/api/v1/desktop/health`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${conn.token}`,
        },
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Desktop health check failed with HTTP ${response.status}`
        );
      }
      return (await response.json()) as {
        status: string;
        desktop_mode: boolean;
        pid: number;
        version: string;
      };
    });
  }

  async invokeDesktopCommand(
    command: string,
    args: Record<string, unknown> | undefined,
    windowLabel: string,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const conn = await this.waitForReady();
    const run = async (signal?: AbortSignal): Promise<unknown> => {
      const response = await fetch(
        `${conn.baseUrl}/api/v1/desktop/invoke/${encodeURIComponent(command)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${conn.token}`,
            'Content-Type': 'application/json',
            'X-Dimo-Window-Label': windowLabel || 'main',
          },
          body: JSON.stringify(args ?? {}),
          ...(signal ? { signal } : {}),
        }
      );

      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        const message =
          typeof parsed === 'object' &&
          parsed !== null &&
          'message' in parsed &&
          typeof (parsed as { message?: unknown }).message === 'string'
            ? (parsed as { message: string }).message
            : typeof parsed === 'string' && parsed.length > 0
              ? parsed
              : `Desktop command "${command}" failed with HTTP ${response.status}`;
        throw new Error(message);
      }

      return parsed;
    };

    const timeoutMs = options?.timeoutMs;
    if (
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
    ) {
      return this.withAbortTimeout(timeoutMs, (signal) => run(signal));
    }
    return run();
  }

  async fetchCapabilities(options?: {
    forceRefresh?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<CachedServerCapabilities> {
    const conn = await this.waitForReady();
    if (!options?.forceRefresh && this.cachedCapabilities && this.connection === conn) {
      return this.cachedCapabilities;
    }
    if (!options?.forceRefresh && !options?.signal && this.capabilitiesInflight) {
      return this.capabilitiesInflight;
    }

    const effectiveTimeoutMs =
      typeof options?.timeoutMs === 'number' &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : HOST_CAPABILITIES_TIMEOUT_MS;

    const run = async (): Promise<CachedServerCapabilities> => {
      const controller = new AbortController();
      let timedOut = false;
      const externalSignal = options?.signal;
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
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, effectiveTimeoutMs);
      timer.unref?.();

      try {
        const response = await fetch(`${conn.baseUrl}/api/v1/capabilities`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${conn.token}`,
            'Content-Type': 'application/json',
            'X-Dimo-Protocol-Version': HOST_PROTOCOL_VERSION,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `Dimo Server capabilities request failed with HTTP ${response.status}`
          );
        }
        const caps = (await response.json()) as CachedServerCapabilities;
        if (this.connection === conn) {
          this.cachedCapabilities = caps;
        }
        return caps;
      } catch (error) {
        if (timedOut) {
          throw new Error(
            `Dimo Server capabilities request timed out after ${effectiveTimeoutMs}ms`
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (externalSignal && onExternalAbort) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    };

    if (options?.signal) {
      return run();
    }

    const pending = run().finally(() => {
      if (this.capabilitiesInflight === pending) {
        this.capabilitiesInflight = null;
      }
    });
    this.capabilitiesInflight = pending;
    return pending;
  }

  async proxyHostCommand(request: {
    command: string;
    args?: Record<string, unknown>;
    operationId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<HostRpcProxyResponse> {
    if (!isValidHostCommandName(request.command)) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'Invalid host command name',
        retryable: false,
      };
    }

    const externalSignal = request.signal;
    if (externalSignal?.aborted) {
      return {
        ok: false,
        code: 'request_aborted',
        message: 'Dimo Server request was cancelled',
        retryable: true,
      };
    }

    let conn: ElectronBackendConnectionInfo;
    try {
      if (externalSignal) {
        let onReadyAbort: (() => void) | undefined;
        const abortWhileStarting = new Promise<never>((_resolve, reject) => {
          onReadyAbort = () => reject(new Error('__host_rpc_aborted__'));
          externalSignal.addEventListener('abort', onReadyAbort, {
            once: true,
          });
        });
        try {
          conn = await Promise.race([this.waitForReady(), abortWhileStarting]);
        } finally {
          if (onReadyAbort) {
            externalSignal.removeEventListener('abort', onReadyAbort);
          }
        }
      } else {
        conn = await this.waitForReady();
      }
    } catch (error) {
      if (externalSignal?.aborted) {
        return {
          ok: false,
          code: 'request_aborted',
          message: 'Dimo Server request was cancelled',
          retryable: true,
        };
      }
      return {
        ok: false,
        code: 'sidecar_unavailable',
        message:
          error instanceof Error
            ? error.message
            : 'dimo-server sidecar is unavailable',
        retryable: true,
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    let abortedExternally = false;
    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortedExternally = true;
        controller.abort(externalSignal.reason);
      } else {
        onExternalAbort = () => {
          abortedExternally = true;
          controller.abort(externalSignal.reason);
        };
        externalSignal.addEventListener('abort', onExternalAbort, {
          once: true,
        });
      }
    }

    const effectiveTimeoutMs =
      typeof request.timeoutMs === 'number' &&
      Number.isFinite(request.timeoutMs) &&
      request.timeoutMs > 0
        ? request.timeoutMs
        : null;
    const timer =
      effectiveTimeoutMs !== null
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, effectiveTimeoutMs)
        : undefined;
    timer?.unref?.();

    const operationId = request.operationId || crypto.randomUUID();
    try {
      const response = await fetch(
        `${conn.baseUrl}/api/v1/call/${request.command}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${conn.token}`,
            'Content-Type': 'application/json',
            'X-Dimo-Protocol-Version': HOST_PROTOCOL_VERSION,
          },
          body: JSON.stringify({
            operation_id: operationId,
            args: request.args ?? {},
          }),
          signal: controller.signal,
        }
      );

      // Zero-parse pass-through on success so Electron Main never spends CPU
      // JSON-parsing large conversation/file responses.
      const bodyText = await response.text();
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          bodyText,
        };
      }

      let envelope: {
        code?: string;
        message?: string;
        retryable?: boolean;
        operation_id?: string;
        details?: unknown;
      } = {};
      if (bodyText.length > 0) {
        try {
          envelope = JSON.parse(bodyText) as typeof envelope;
        } catch {
          // Preserve a stable error envelope if an intermediary returned HTML/text.
        }
      }

      return {
        ok: false,
        status: response.status,
        code: envelope.code ?? 'remote_http_error',
        message:
          envelope.message ?? `Dimo Server returned HTTP ${response.status}`,
        retryable: Boolean(envelope.retryable ?? false),
        operationId: envelope.operation_id,
        details: envelope.details,
      };
    } catch (error) {
      if (timedOut) {
        return {
          ok: false,
          code: 'request_timeout',
          message: `Dimo Server request timed out after ${effectiveTimeoutMs}ms`,
          retryable: true,
        };
      }
      if (abortedExternally) {
        return {
          ok: false,
          code: 'request_aborted',
          message: 'Dimo Server request was cancelled',
          retryable: true,
        };
      }
      return {
        ok: false,
        code: 'network_error',
        message:
          error instanceof Error ? error.message : String(error ?? 'Network error'),
        retryable: true,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async notifyWindowDestroyed(
    label: string,
    windowStillOpen = false
  ): Promise<void> {
    if (!this.connection || !this.isRunning() || this.shuttingDown) {
      return;
    }
    const conn = this.connection;
    try {
      await this.withAbortTimeout(WINDOW_DESTROYED_TIMEOUT_MS, (signal) =>
        fetch(`${conn.baseUrl}/api/v1/desktop/window-destroyed`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${conn.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ label, windowStillOpen }),
          signal,
        })
      );
    } catch {
      // Sidecar may already be shutting down during app quit.
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.restarting = false;
    this.clearCapabilitiesCache();
    this.cancelPendingRestart();
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const child = this.child;
    const conn = this.connection;
    if (!child || hasChildExited(child)) {
      this.child = null;
      this.connection = null;
      this.readyInfo = null;
      return;
    }

    if (!conn && !child.stdin) {
      await this.forceKillChild(child);
      if (this.child === child) {
        this.child = null;
      }
      this.connection = null;
      this.readyInfo = null;
      return;
    }

    const exitPromise = new Promise<void>((resolve) => {
      if (hasChildExited(child)) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    if (conn) {
      try {
        await this.withAbortTimeout(SHUTDOWN_HTTP_TIMEOUT_MS, (signal) =>
          fetch(`${conn.baseUrl}/api/v1/desktop/shutdown`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${conn.token}`,
            },
            signal,
          })
        );
      } catch {
        // Fallback to closing stdin and signaling.
      }
    }

    try {
      child.stdin?.end();
    } catch {
      // Ignore already-closed stdin.
    }

    const exitedCleanly = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
        timer.unref?.();
      }),
    ]);

    if (!exitedCleanly && !hasChildExited(child)) {
      this.logger.warn(
        '[electron:sidecar] dimo-server did not exit within grace period; terminating'
      );
      await this.forceKillChild(child);
    }

    this.child = null;
    this.connection = null;
    this.readyInfo = null;
  }

  private async forceKillChild(child: ChildProcess): Promise<void> {
    if (hasChildExited(child)) {
      return;
    }
    const exitPromise = new Promise<void>((resolve) => {
      if (hasChildExited(child)) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    const signalUnixChild = (signal: NodeJS.Signals) => {
      if (child.pid && child.pid > 0) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Child may not be a process-group leader (e.g. non-detached test mock).
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    };

    try {
      if (process.platform === 'win32' && child.pid) {
        await killProcessTreeWindows(child.pid, TASKKILL_TIMEOUT_MS);
      } else {
        signalUnixChild('SIGTERM');
        const exited = await Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 1_500);
            timer.unref?.();
          }),
        ]);
        if (!exited && !hasChildExited(child)) {
          signalUnixChild('SIGKILL');
        }
      }
    } catch {
      // Best-effort process cleanup.
    }

    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
  }
}
