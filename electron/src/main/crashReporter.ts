import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { SidecarManager } from './sidecar';

const CRASH_FILE_PREFIX = 'crash-';
const CRASH_FILE_SUFFIX = '.txt';
const MAX_KEPT_REPORTS = 20;

export function isValidCrashReportFilename(name: string): boolean {
  if (!name.startsWith(CRASH_FILE_PREFIX) || !name.endsWith(CRASH_FILE_SUFFIX)) {
    return false;
  }
  const stem = name.slice(
    CRASH_FILE_PREFIX.length,
    name.length - CRASH_FILE_SUFFIX.length
  );
  return stem.length > 0 && /^\d+$/.test(stem);
}

export function formatShellCrashReport(input: {
  source: string;
  message: string;
  stack?: string;
  appVersion: string;
  now?: Date;
}): string {
  const timestamp = (input.now ?? new Date()).toISOString();
  const source = input.source.trim() || 'desktop-shell';
  const stack = input.stack?.trim() || '<no stack trace>';
  return [
    'Dimo crash report',
    '==================',
    `time (UTC): ${timestamp}`,
    `app version: ${input.appVersion}`,
    `os: ${process.platform} (${process.arch})`,
    `source: ${source}`,
    '',
    'error message:',
    input.message.trim(),
    '',
    'stack:',
    stack,
    '',
  ].join('\n');
}

export function writeFallbackCrashReport(options: {
  dataDir: string;
  source: string;
  message: string;
  stack?: string;
  appVersion: string;
  nowMs?: number;
}): string {
  const dir = path.join(options.dataDir, 'crashes');
  fs.mkdirSync(dir, { recursive: true });

  let millis = options.nowMs ?? Date.now();
  let filename = `${CRASH_FILE_PREFIX}${millis}${CRASH_FILE_SUFFIX}`;
  let targetPath = path.join(dir, filename);
  while (fs.existsSync(targetPath)) {
    millis += 1;
    filename = `${CRASH_FILE_PREFIX}${millis}${CRASH_FILE_SUFFIX}`;
    targetPath = path.join(dir, filename);
  }

  const content = formatShellCrashReport({
    source: options.source,
    message: options.message,
    stack: options.stack,
    appVersion: options.appVersion,
    now: new Date(millis),
  });
  fs.writeFileSync(targetPath, content, 'utf8');
  pruneCrashReportsDir(dir);
  return filename;
}

export function pruneCrashReportsDir(dir: string): void {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter(isValidCrashReportFilename)
      .sort()
      .reverse();
  } catch {
    return;
  }

  if (entries.length <= MAX_KEPT_REPORTS) {
    return;
  }

  for (const stale of entries.slice(MAX_KEPT_REPORTS)) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch {
      // Best-effort cleanup.
    }
  }
}

export interface InstallCrashHandlersOptions {
  sidecar: SidecarManager;
  appVersion: string;
  getDataDir: () => string | undefined;
  onGpuProcessGone?: (details: Electron.Details) => void;
}

export type CrashRecorder = (
  source: string,
  message: string,
  stack?: string
) => void;

export function createCrashRecorder(
  options: InstallCrashHandlersOptions
): CrashRecorder {
  return (source: string, message: string, stack?: string) => {
    const tryFallback = () => {
      const dataDir = options.getDataDir();
      if (!dataDir) {
        return;
      }
      try {
        writeFallbackCrashReport({
          dataDir,
          source,
          message,
          stack,
          appVersion: options.appVersion,
        });
      } catch {
        // Best-effort only: crash reporting must never throw.
      }
    };

    if (options.sidecar.isRunning()) {
      void options.sidecar
        .invokeDesktopCommand(
          'record_shell_crash',
          { source, message, stack: stack ?? null },
          'main'
        )
        .catch(() => {
          tryFallback();
        });
    } else {
      tryFallback();
    }
  };
}

export function installCrashHandlers(
  options: InstallCrashHandlersOptions
): () => void {
  const recordCrash = createCrashRecorder(options);

  const onUncaughtException = (error: Error) => {
    console.error('[electron:crash] uncaughtException:', error);
    recordCrash(
      'electron-main:uncaughtException',
      error.message || String(error),
      error.stack
    );
  };

  const onUnhandledRejection = (reason: unknown) => {
    const error = reason instanceof Error ? reason : null;
    const message = error ? error.message : String(reason);
    console.error('[electron:crash] unhandledRejection:', reason);
    recordCrash('electron-main:unhandledRejection', message, error?.stack);
  };

  const onRenderProcessGone = (
    _event: Electron.Event,
    _webContents: Electron.WebContents,
    details: Electron.RenderProcessGoneDetails
  ) => {
    if (details.reason === 'clean-exit') {
      return;
    }
    const message = `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`;
    console.error('[electron:crash]', message);
    recordCrash('electron-renderer:render-process-gone', message);
  };

  const onChildProcessGone = (
    _event: Electron.Event,
    details: Electron.Details
  ) => {
    if (details.reason === 'clean-exit') {
      return;
    }
    if (details.type === 'GPU') {
      let featureSummary = '';
      try {
        featureSummary = ` gpuFeatureStatus=${JSON.stringify(app.getGPUFeatureStatus())}`;
      } catch {
        featureSummary = '';
      }
      const message = `GPU process gone: reason=${details.reason}, exitCode=${details.exitCode}${featureSummary}`;
      console.error('[electron:crash]', message);
      recordCrash('electron-gpu:child-process-gone', message);
      options.onGpuProcessGone?.(details);
    }
  };

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  app.on('render-process-gone', onRenderProcessGone);
  app.on('child-process-gone', onChildProcessGone);

  return () => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
    app.off('render-process-gone', onRenderProcessGone);
    app.off('child-process-gone', onChildProcessGone);
  };
}
