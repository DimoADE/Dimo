import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SidecarManager,
  generateDesktopToken,
  isInsideMacosAppBundle,
  parseReadyLine,
  resolveClaudeDriverScript,
  resolveDefaultDataDir,
  resolveSidecarBinaryPath,
  resolveSidecarStdio,
  sanitizeSidecarEnv,
  serverBinaryFilename,
  type SidecarUnexpectedExitInfo,
} from './sidecar';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEBUG_SERVER_BIN = path.join(
  REPO_ROOT,
  'target',
  'debug',
  serverBinaryFilename()
);

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

describe('sidecar helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates 32-byte hex desktop tokens', () => {
    const token = generateDesktopToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses dimo-server-ready handshake lines and ignores diagnostic output', () => {
    expect(parseReadyLine('INFO starting server...')).toBeNull();
    expect(parseReadyLine('{"type":"other"}')).toBeNull();
    expect(
      parseReadyLine(
        '{"type":"dimo-server-ready","listen_addr":"127.0.0.1:41234","port":41234,"pid":9999,"protocol_version":"1.0"}'
      )
    ).toEqual({
      type: 'dimo-server-ready',
      listen_addr: '127.0.0.1:41234',
      port: 41234,
      pid: 9999,
      protocol_version: '1.0',
    });
  });

  it('throws a clear error when sidecar binary cannot be located', () => {
    expect(() =>
      resolveSidecarBinaryPath({
        explicitPath: path.join(os.tmpdir(), 'definitely-missing-dimo-server-bin'),
        env: {},
      })
    ).toThrow(/Could not locate/);
  });

  it('uses ignored stdin on Windows and piped stdin on POSIX', () => {
    expect(resolveSidecarStdio('win32')).toEqual(['ignore', 'pipe', 'pipe']);
    expect(resolveSidecarStdio('darwin')).toEqual(['pipe', 'pipe', 'pipe']);
    expect(resolveSidecarStdio('linux')).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('resolves bundled claude-native-driver.mjs from resourcesDir unless overridden by env', () => {
    const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-res-'));
    tempDirs.push(resourcesDir);
    expect(resolveClaudeDriverScript(resourcesDir, {})).toBeUndefined();

    const scriptPath = path.join(resourcesDir, 'scripts', 'claude-native-driver.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '// driver\n', 'utf8');

    expect(resolveClaudeDriverScript(resourcesDir, {})).toBe(scriptPath);
    expect(
      resolveClaudeDriverScript(resourcesDir, {
        DIMO_CLAUDE_DRIVER_SCRIPT: '/custom/driver.mjs',
      })
    ).toBe('/custom/driver.mjs');
  });

  it('aligns default data dir and bootstrap.json resolution with Rust assets.rs (VIBEX fallback & .app rejection)', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-home-'));
    tempDirs.push(fakeHome);

    expect(
      isInsideMacosAppBundle('/Applications/Dimo.app/Contents/MacOS/data', 'darwin')
    ).toBe(true);
    expect(
      isInsideMacosAppBundle('/Users/alice/Library/Application Support/app.dimo.dimo', 'darwin')
    ).toBe(false);

    // VIBEX_DATA_DIR fallback when DIMO_DATA_DIR is unset
    expect(
      resolveDefaultDataDir({
        platform: 'linux',
        homedir: fakeHome,
        isPackaged: true,
        env: { VIBEX_DATA_DIR: '/var/tmp/vibex-legacy' },
      })
    ).toBe('/var/tmp/vibex-legacy');

    // Rejects macOS .app bundle paths in env and falls back safely
    expect(
      resolveDefaultDataDir({
        platform: 'darwin',
        homedir: fakeHome,
        isPackaged: true,
        env: { DIMO_DATA_DIR: '/Applications/Dimo.app/Contents/Resources/data' },
      })
    ).toBe(path.join(fakeHome, 'Library', 'Application Support', 'app.dimo.dimo'));

    // Pre-rename VibeX bootstrap.json fallback on macOS
    const vibexBootstrapDir = path.join(
      fakeHome,
      'Library',
      'Application Support',
      'app.vibex.vibex'
    );
    fs.mkdirSync(vibexBootstrapDir, { recursive: true });
    fs.writeFileSync(
      path.join(vibexBootstrapDir, 'bootstrap.json'),
      JSON.stringify({ custom_data_dir: '/Users/alice/dimo-custom' }),
      'utf8'
    );
    expect(
      resolveDefaultDataDir({
        platform: 'darwin',
        homedir: fakeHome,
        isPackaged: true,
        env: {},
      })
    ).toBe('/Users/alice/dimo-custom');
  });
});

describe('SidecarManager stdout draining & crash supervision', () => {
  const tempDirs: string[] = [];
  const managers: SidecarManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      await managers.pop()!.shutdown();
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('continuously drains child stdout after ready handshake and passes DIMO_CLAUDE_DRIVER_SCRIPT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-drain-'));
    tempDirs.push(dir);
    const driverPath = path.join(dir, 'scripts', 'claude-native-driver.mjs');
    fs.mkdirSync(path.dirname(driverPath), { recursive: true });
    fs.writeFileSync(driverPath, '// mock\n', 'utf8');
    const doneMarker = path.join(dir, 'drained.json');
    const fakeBin = path.join(dir, 'fake-server');
    fs.writeFileSync(fakeBin, '', 'utf8');

    const childScript = `
      const fs = require('node:fs');
      process.stdout.write(JSON.stringify({
        type: 'dimo-server-ready',
        listen_addr: '127.0.0.1:41235',
        port: 41235,
        pid: process.pid,
        protocol_version: '1.0',
      }) + '\\n');
      setTimeout(() => {
        const chunk = 'x'.repeat(1024) + '\\n';
        let remaining = 128;
        function writeMore() {
          while (remaining > 0) {
            remaining -= 1;
            if (!process.stdout.write(chunk)) {
              process.stdout.once('drain', writeMore);
              return;
            }
          }
          fs.writeFileSync(${JSON.stringify(doneMarker)}, JSON.stringify({
            driver: process.env.DIMO_CLAUDE_DRIVER_SCRIPT || null,
          }));
        }
        writeMore();
      }, 20);
      setInterval(() => {}, 1000);
    `;

    const manager = new SidecarManager();
    managers.push(manager);

    await manager.start({
      binaryPath: fakeBin,
      resourcesDir: dir,
      appVersion: '0.5.2-test',
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      spawnProcess: ((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) =>
        spawn(process.execPath, ['-e', childScript], opts)) as unknown as typeof spawn,
    });

    // Wait up to 3s for 128 KiB stdout burst to finish without pipe deadlock.
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(doneMarker) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(doneMarker)).toBe(true);
    const written = JSON.parse(fs.readFileSync(doneMarker, 'utf8')) as {
      driver: string | null;
    };
    expect(written.driver).toBe(driverPath);
  });

  it('invalidates dead connection on unexpected exit and performs bounded auto-restart with backoff', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-supervise-'));
    tempDirs.push(dir);
    const fakeBin = path.join(dir, 'fake-server');
    fs.writeFileSync(fakeBin, '', 'utf8');

    let spawnCount = 0;
    const exits: SidecarUnexpectedExitInfo[] = [];
    const restarts: Array<{ port: string; attempt: number }> = [];

    const manager = new SidecarManager();
    managers.push(manager);

    await manager.start({
      binaryPath: fakeBin,
      appVersion: '0.5.2-test',
      maxRestartAttempts: 2,
      restartBaseDelayMs: 40,
      restartWindowMs: 10_000,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      onUnexpectedExit: (info) => exits.push(info),
      onRestarted: (conn, attempt) => restarts.push({ port: conn.baseUrl, attempt }),
      spawnProcess: ((_cmd: string, _args: readonly string[], opts: Record<string, unknown>) => {
        spawnCount += 1;
        const port = 42000 + spawnCount;
        const crashQuickly = spawnCount === 1;
        const script = crashQuickly
          ? `
            process.stdout.write(JSON.stringify({
              type: 'dimo-server-ready',
              listen_addr: '127.0.0.1:${port}',
              port: ${port},
              pid: process.pid,
              protocol_version: '1.0',
            }) + '\\n');
            setTimeout(() => process.exit(1), 30);
          `
          : `
            process.stdout.write(JSON.stringify({
              type: 'dimo-server-ready',
              listen_addr: '127.0.0.1:${port}',
              port: ${port},
              pid: process.pid,
              protocol_version: '1.0',
            }) + '\\n');
            setInterval(() => {}, 1000);
          `;
        return spawn(process.execPath, ['-e', script], opts);
      }) as unknown as typeof spawn,
    });

    expect(manager.getStatus()).toBe('running');
    expect(manager.getConnectionOrNull()?.baseUrl).toBe('http://127.0.0.1:42001');

    // Wait for crash + auto-restart
    const deadline = Date.now() + 3_000;
    while (restarts.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      code: 1,
      willRestart: true,
      attempt: 1,
      maxAttempts: 2,
      restartDelayMs: 40,
    });
    expect(restarts).toEqual([{ port: 'http://127.0.0.1:42002', attempt: 1 }]);
    expect(manager.getStatus()).toBe('running');
    expect(manager.getConnectionOrNull()?.baseUrl).toBe('http://127.0.0.1:42002');
  });

  it('sanitizes Linux AppImage LD_LIBRARY_PATH while preserving non-AppImage and non-Linux envs', () => {
    const stripped = sanitizeSidecarEnv(
      {
        APPIMAGE: '/tmp/Dimo.AppImage',
        LD_LIBRARY_PATH: '/tmp/.mount_Dimo/usr/lib',
        PATH: '/usr/bin',
      },
      'linux'
    );
    expect(stripped.LD_LIBRARY_PATH).toBeUndefined();
    expect(stripped.PATH).toBe('/usr/bin');

    const restored = sanitizeSidecarEnv(
      {
        APPIMAGE: '/tmp/Dimo.AppImage',
        LD_LIBRARY_PATH: '/tmp/.mount_Dimo/usr/lib:/usr/local/lib',
        APPIMAGE_ORIG_LD_LIBRARY_PATH: '/usr/local/lib',
      },
      'linux'
    );
    expect(restored.LD_LIBRARY_PATH).toBe('/usr/local/lib');

    const nonAppImage = sanitizeSidecarEnv(
      { LD_LIBRARY_PATH: '/custom/lib' },
      'linux'
    );
    expect(nonAppImage.LD_LIBRARY_PATH).toBe('/custom/lib');

    const nonLinux = sanitizeSidecarEnv(
      { APPIMAGE: '/tmp/fake', LD_LIBRARY_PATH: '/custom/lib' },
      'darwin'
    );
    expect(nonLinux.LD_LIBRARY_PATH).toBe('/custom/lib');
  });

  it('deduplicates concurrent start() calls, keeps persistent child/stdin error listeners, and passes AbortSignal to fetch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-dedup-'));
    tempDirs.push(dir);
    const fakeBin = path.join(dir, 'fake-server');
    fs.writeFileSync(fakeBin, '', 'utf8');

    let spawnCount = 0;
    let fakeChild!: EventEmitter & {
      pid: number;
      exitCode: number | null;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };

    const manager = new SidecarManager();
    managers.push(manager);

    const startOpts = {
      binaryPath: fakeBin,
      appVersion: '0.5.2-test',
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      spawnProcess: (() => {
        spawnCount += 1;
        const emitter = new EventEmitter();
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        fakeChild = Object.assign(emitter, {
          pid: 55555,
          exitCode: null as number | null,
          stdin,
          stdout,
          stderr,
          kill: vi.fn(() => {
            fakeChild.exitCode = 0;
            fakeChild.emit('exit', 0, null);
            return true;
          }),
        });
        setTimeout(() => {
          stdout.write(
            JSON.stringify({
              type: 'dimo-server-ready',
              listen_addr: '127.0.0.1:42111',
              port: 42111,
              pid: 55555,
              protocol_version: '1.0',
            }) + '\n'
          );
        }, 25);
        return fakeChild as unknown as ChildProcess;
      }) as unknown as typeof spawn,
    };

    const [conn1, conn2] = await Promise.all([
      manager.start(startOpts),
      manager.start(startOpts),
    ]);
    expect(spawnCount).toBe(1);
    expect(conn1).toEqual(conn2);
    expect(conn1.baseUrl).toBe('http://127.0.0.1:42111');

    // Post-ready child 'error' and stdin 'error' must not throw unhandled errors
    expect(() => fakeChild.emit('error', new Error('late child error'))).not.toThrow();
    expect(() => fakeChild.stdin.emit('error', new Error('EPIPE'))).not.toThrow();

    // Verify healthCheck & notifyWindowDestroyed always pass AbortSignal, while
    // invokeDesktopCommand only applies an AbortSignal when timeoutMs is opted in.
    const signals: Array<AbortSignal | undefined> = [];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        signals.push(init?.signal ?? undefined);
        return new Response(
          JSON.stringify({ status: 'ok', desktop_mode: true, pid: 55555, version: '0.5.2' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
    try {
      await manager.healthCheck();
      await manager.invokeDesktopCommand('get_developer_mode', {}, 'main');
      await manager.invokeDesktopCommand('get_developer_mode', {}, 'main', {
        timeoutMs: 2500,
      });
      await manager.notifyWindowDestroyed('main', false);
      expect(signals).toHaveLength(4);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeUndefined();
      expect(signals[2]).toBeInstanceOf(AbortSignal);
      expect(signals[3]).toBeInstanceOf(AbortSignal);
    } finally {
      fetchSpy.mockRestore();
    }

    // Mark child exited so afterEach shutdown doesn't invoke taskkill on fake PID
    fakeChild.exitCode = 0;
  });
});

describe.skipIf(!fs.existsSync(DEBUG_SERVER_BIN))(
  'SidecarManager live dimo-server --desktop lifecycle',
  () => {
    const tempDirs: string[] = [];
    const managers: SidecarManager[] = [];

    afterEach(async () => {
      while (managers.length > 0) {
        const manager = managers.pop()!;
        await manager.shutdown();
      }
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it(
      'starts dimo-server --desktop, verifies auth/commands, and shuts down cleanly without orphans',
      async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dimo-sidecar-test-'));
        tempDirs.push(dataDir);

        const manager = new SidecarManager();
        managers.push(manager);

        const connection = await manager.start({
          binaryPath: DEBUG_SERVER_BIN,
          dataDir,
          appVersion: '0.5.2-test',
          readyTimeoutMs: 25_000,
          logger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
        });

        expect(connection.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(connection.token).toMatch(/^[0-9a-f]{64}$/);
        const readyInfo = manager.getReadyInfo();
        expect(readyInfo).not.toBeNull();
        expect(readyInfo!.pid).toBeGreaterThan(0);

        // Unauthenticated desktop health endpoint must reject with 401.
        const unauthRes = await fetch(`${connection.baseUrl}/api/v1/desktop/health`);
        expect(unauthRes.status).toBe(401);

        // Authenticated desktop health check succeeds.
        const health = await manager.healthCheck();
        expect(health.status).toBe('ok');
        expect(health.desktop_mode).toBe(true);

        // Standard server capabilities endpoint responds with Bearer token.
        const capsRes = await fetch(`${connection.baseUrl}/api/v1/capabilities`, {
          headers: { Authorization: `Bearer ${connection.token}` },
        });
        expect(capsRes.status).toBe(200);

        // Desktop command proxy works end-to-end.
        const hostClientStatus = (await manager.invokeDesktopCommand(
          'host_client_status',
          {},
          'main'
        )) as { profiles?: unknown[] };
        expect(hostClientStatus).toBeTruthy();
        expect(Array.isArray(hostClientStatus.profiles)).toBe(true);

        const webStatus = (await manager.invokeDesktopCommand(
          'get_web_server_status',
          {},
          'main'
        )) as { running?: boolean };
        expect(typeof webStatus.running).toBe('boolean');

        // Persisted developer_mode round-trips via settings.json system.developer_mode.
        expect(
          await manager.invokeDesktopCommand('get_developer_mode', {}, 'main')
        ).toBe(false);
        expect(
          await manager.invokeDesktopCommand(
            'set_developer_mode',
            { enabled: true },
            'main'
          )
        ).toBe(true);
        expect(
          await manager.invokeDesktopCommand('get_developer_mode', {}, 'main')
        ).toBe(true);
        const settingsJson = JSON.parse(
          fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')
        ) as { system?: { developer_mode?: boolean } };
        expect(settingsJson.system?.developer_mode).toBe(true);
        expect(
          await manager.invokeDesktopCommand(
            'set_developer_mode',
            { enabled: false },
            'main'
          )
        ).toBe(false);

        // Shell crash report recording writes a valid crash-<millis>.txt file.
        const crashRes = (await manager.invokeDesktopCommand(
          'record_shell_crash',
          {
            source: 'electron-main:test',
            message: 'Simulated shell exception',
            stack: 'Error: Simulated\n  at test:1:1',
          },
          'main'
        )) as { id?: string };
        expect(crashRes.id).toMatch(/^crash-\d+\.txt$/);
        const crashContent = fs.readFileSync(
          path.join(dataDir, 'crashes', crashRes.id!),
          'utf8'
        );
        expect(crashContent).toContain('source: electron-main:test');
        expect(crashContent).toContain('Simulated shell exception');

        // Graceful shutdown leaves no orphan process.
        const pid = readyInfo!.pid;
        await manager.shutdown();
        expect(manager.isRunning()).toBe(false);
        expect(isPidAlive(pid)).toBe(false);
      },
      30_000
    );
  }
);
