import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SidecarManager,
  generateDesktopToken,
  parseReadyLine,
  resolveSidecarBinaryPath,
  serverBinaryFilename,
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
