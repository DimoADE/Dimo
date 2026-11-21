import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import type { ElectronBackendConnectionInfo } from '../shared/ipcContract';

export interface ServerReadyMessage {
  type: 'dimo-server-ready';
  listen_addr: string;
  port: number;
  pid: number;
  protocol_version: string;
  data_dir?: string;
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
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const STDERR_RING_LIMIT = 40;

export function generateDesktopToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function serverBinaryFilename(
  platform: NodeJS.Platform = process.platform
): string {
  return platform === 'win32' ? 'dimo-server.exe' : 'dimo-server';
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
  private shutdownPromise: Promise<void> | null = null;
  private logger: Pick<Console, 'info' | 'warn' | 'error'> = console;

  getConnection(): ElectronBackendConnectionInfo {
    if (!this.connection) {
      throw new Error('dimo-server sidecar has not started yet');
    }
    return this.connection;
  }

  getReadyInfo(): ServerReadyMessage | null {
    return this.readyInfo;
  }

  getDataDir(): string | undefined {
    return this.connection?.dataDir ?? this.readyInfo?.data_dir;
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async start(
    options: SidecarStartOptions
  ): Promise<ElectronBackendConnectionInfo> {
    if (this.connection && this.isRunning()) {
      return this.connection;
    }
    this.logger = options.logger ?? console;
    this.shuttingDown = false;
    this.shutdownPromise = null;

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

    const childEnv: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      DIMO_DESKTOP_TOKEN: token,
    };
    if (options.dataDir) {
      childEnv.DIMO_DATA_DIR = options.dataDir;
    }

    this.logger.info(
      `[electron:sidecar] spawning ${binaryPath} ${args.join(' ')}`
    );

    const child = spawn(binaryPath, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

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
          cleanupListeners();
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
      await this.forceKillChild(child);
      this.child = null;
      throw error;
    });

    child.on('exit', (code, signal) => {
      if (!this.shuttingDown) {
        this.logger.error(
          `[electron:sidecar] dimo-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
        );
      }
      if (this.child === child) {
        this.child = null;
      }
    });

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

  async healthCheck(): Promise<{
    status: string;
    desktop_mode: boolean;
    pid: number;
    version: string;
  }> {
    const conn = this.getConnection();
    const response = await fetch(`${conn.baseUrl}/api/v1/desktop/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${conn.token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Desktop health check failed with HTTP ${response.status}`);
    }
    return (await response.json()) as {
      status: string;
      desktop_mode: boolean;
      pid: number;
      version: string;
    };
  }

  async invokeDesktopCommand(
    command: string,
    args: Record<string, unknown> | undefined,
    windowLabel: string
  ): Promise<unknown> {
    const conn = this.getConnection();
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
  }

  async notifyWindowDestroyed(
    label: string,
    windowStillOpen = false
  ): Promise<void> {
    if (!this.connection || !this.isRunning() || this.shuttingDown) {
      return;
    }
    try {
      await fetch(`${this.connection.baseUrl}/api/v1/desktop/window-destroyed`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label, windowStillOpen }),
      });
    } catch {
      // Sidecar may already be shutting down during app quit.
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const child = this.child;
    const conn = this.connection;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }

    const exitPromise = new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });

    if (conn) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        await fetch(`${conn.baseUrl}/api/v1/desktop/shutdown`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${conn.token}`,
          },
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
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
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
      ),
    ]);

    if (!exitedCleanly && child.exitCode === null) {
      this.logger.warn(
        '[electron:sidecar] dimo-server did not exit within grace period; terminating'
      );
      await this.forceKillChild(child);
    }

    this.child = null;
  }

  private async forceKillChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) {
      return;
    }
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5000,
        });
      } else {
        child.kill('SIGTERM');
        const exited = await Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 1500)
          ),
        ]);
        if (!exited && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }
    } catch {
      // Best-effort process cleanup.
    }

    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}
