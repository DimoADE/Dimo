#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { withNativeBuildEnv } = require('./cargo-path');
const { applyLocalEnvFile } = require('./load-local-env');
const { getPorts } = require('./setup-dev-environment');
const { applySidecarDevEnv } = require('./watch-host-sidecars');

const WORKSPACE_ROOT = path.join(__dirname, '..');
const ELECTRON_DIR = path.join(WORKSPACE_ROOT, 'electron');
const LOCAL_ENV_FILE = path.join(WORKSPACE_ROOT, '.env.local');
const SQLX_OFFLINE_DIR = path.join(WORKSPACE_ROOT, 'crates', 'db', '.sqlx');

function spawnShell(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', command, ...args],
      { ...options, windowsHide: true }
    );
  }
  return spawn(command, args, options);
}

function runSyncOrThrow(command, args, options = {}) {
  const result =
    process.platform === 'win32'
      ? spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', command, ...args],
          { stdio: 'inherit', ...options }
        )
      : spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}: ${command} ${args.join(' ')}`
    );
  }
}

function resolveElectronBinary() {
  const entry = require.resolve('electron', { paths: [ELECTRON_DIR] });
  const binaryPath = require(entry);
  if (typeof binaryPath !== 'string' || !fs.existsSync(binaryPath)) {
    throw new Error(`Electron binary not found at ${String(binaryPath)}`);
  }
  return binaryPath;
}

function ensureWindowsElectronIntegrity(electronBinary) {
  if (process.platform !== 'win32') {
    return;
  }
  const distDir = path.dirname(electronBinary);
  const inspect = spawnSync('icacls', [electronBinary], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (inspect.status === 0 && /Low Mandatory Level/i.test(inspect.stdout || '')) {
    console.log(
      '[electron:dev] Repairing Low Mandatory Level integrity on Electron dist directory...'
    );
    spawnSync('icacls', [distDir, '/setintegritylevel', '(OI)(CI)Medium', '/T', '/Q'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
}

function resolveDimoserverBinary() {
  const exeName = process.platform === 'win32' ? 'dimo-server.exe' : 'dimo-server';
  return path.join(WORKSPACE_ROOT, 'target', 'debug', exeName);
}

const RUST_WATCH_EXTENSIONS = new Set(['.rs', '.toml', '.sql', '.json']);
const RUST_SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'dist', 'build']);

function hasNewerSourceFile(dirPath, targetMtimeMs) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (RUST_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (hasNewerSourceFile(fullPath, targetMtimeMs)) {
        return true;
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!RUST_WATCH_EXTENSIONS.has(ext)) {
      continue;
    }
    try {
      if (fs.statSync(fullPath).mtimeMs > targetMtimeMs) {
        return true;
      }
    } catch {
      // Ignore transient files disappearing during scan.
    }
  }
  return false;
}

function isDimoserverStale(serverBin) {
  if (!fs.existsSync(serverBin)) {
    return true;
  }
  let binMtimeMs;
  try {
    binMtimeMs = fs.statSync(serverBin).mtimeMs;
  } catch {
    return true;
  }
  for (const rootFile of ['Cargo.toml', 'Cargo.lock']) {
    const candidate = path.join(WORKSPACE_ROOT, rootFile);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).mtimeMs > binMtimeMs) {
        return true;
      }
    } catch {
      // Ignore unreadable root manifest.
    }
  }
  return hasNewerSourceFile(path.join(WORKSPACE_ROOT, 'crates'), binMtimeMs);
}

function waitForHttpReady(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for dev server at ${url}`));
        return;
      }
      setTimeout(probe, 250);
    };
    probe();
  });
}

function terminateTree(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore termination errors for already-exited processes.
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const forceRebuildServer =
    args.has('--rebuild-server') || process.env.DIMO_REBUILD_SERVER === '1';
  const skipServerBuild =
    args.has('--skip-server-build') || process.env.DIMO_SKIP_SERVER_BUILD === '1';

  const baseEnv = applyLocalEnvFile(LOCAL_ENV_FILE, process.env);
  const ports = await getPorts();
  const env = applySidecarDevEnv(
    withNativeBuildEnv({
      ...baseEnv,
      FRONTEND_PORT: String(ports.frontend),
      BACKEND_PORT: String(ports.backend),
      SQLX_OFFLINE: baseEnv.SQLX_OFFLINE || 'true',
      SQLX_OFFLINE_DIR: baseEnv.SQLX_OFFLINE_DIR || SQLX_OFFLINE_DIR,
    }),
    { repo: WORKSPACE_ROOT }
  );

  const serverBin = env.DIMO_SERVER_BIN || resolveDimoserverBinary();
  const usingDefaultServerBin = !env.DIMO_SERVER_BIN;
  const shouldBuildServer =
    forceRebuildServer ||
    !fs.existsSync(serverBin) ||
    (!skipServerBuild && usingDefaultServerBin && isDimoserverStale(serverBin));
  if (shouldBuildServer) {
    console.log('[electron:dev] Building dimo-server sidecar binary...');
    runSyncOrThrow('cargo', ['build', '-p', 'server', '--bin', 'dimo-server'], {
      cwd: WORKSPACE_ROOT,
      env,
    });
  }

  console.log('[electron:dev] Building @dimo/electron main & preload...');
  runSyncOrThrow('pnpm', ['--filter', '@dimo/electron', 'build'], {
    cwd: WORKSPACE_ROOT,
    env,
  });

  const devUrl = `http://127.0.0.1:${ports.frontend}`;
  console.log(`[electron:dev] Starting Vite dev server on ${devUrl}...`);
  const viteProc = spawnShell(
    'pnpm',
    [
      '--filter',
      'dimo',
      'run',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(ports.frontend),
      '--strictPort',
    ],
    {
      cwd: WORKSPACE_ROOT,
      env,
      stdio: 'inherit',
    }
  );

  let electronProc = null;
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminateTree(electronProc);
    terminateTree(viteProc);
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  viteProc.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[electron:dev] Vite dev server exited unexpectedly (code=${code})`);
      cleanup();
      process.exit(code ?? 1);
    }
  });

  try {
    await waitForHttpReady(devUrl);
  } catch (error) {
    cleanup();
    throw error;
  }

  const electronBinary = resolveElectronBinary();
  ensureWindowsElectronIntegrity(electronBinary);

  const electronEnv = {
    ...env,
    DIMO_DEV_URL: devUrl,
    DIMO_DEV_MODE: '1',
    DIMO_SERVER_BIN: serverBin,
    DIMO_ALLOW_MULTI_INSTANCE: env.DIMO_ALLOW_MULTI_INSTANCE || '1',
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  console.log(`[electron:dev] Launching Electron (${electronBinary})...`);
  electronProc = spawn(electronBinary, [ELECTRON_DIR], {
    cwd: WORKSPACE_ROOT,
    env: electronEnv,
    stdio: 'inherit',
    windowsHide: false,
  });

  electronProc.once('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[electron:dev] Failed:', error);
    process.exit(1);
  });
}

module.exports = {
  resolveElectronBinary,
  ensureWindowsElectronIntegrity,
  resolveDimoserverBinary,
};
